import { DurableObject } from 'cloudflare:workers';
import { Hono } from 'hono';
import {
  clearSessionCookieHeader,
  createSession,
  destroySession,
  getSession,
  requireLiveUser
} from './auth.mjs';
import { dbAll, dbFirst, dbRun } from './db.mjs';
import {
  ActionError,
  JOBS,
  buildStartingStats,
  getCurrentTickValue,
  getEffectiveUser,
  getMessages,
  getActiveWorldEvents,
  getRoomAccessState,
  getRoomEcology,
  handleAttackAction,
  handleChatAction,
  handleJobChangeAction,
  handleSkillAction,
  normalizeJob,
  payInnAccess,
  requireRoomUse,
  roomHasActiveHostiles,
  runHostileRoomAction,
  runScheduledWorldPulse,
  updatePresence,
  validateRoomCoordinates,
  validateStartingAllocation
} from './game.mjs';
import {
  createResurrectionCheckout,
  fulfillResurrectionCheckout
} from './resurrection.mjs';
import { canonicalLocalRequestUrl } from './localHost.mjs';

const app = new Hono();
const DEFAULT_RESURRECTION_PAYMENT_LINK_URL = 'https://buy.stripe.com/8x23codZs9Tj8dgertbV600';
const STRIPE_WEBHOOK_TOLERANCE_SECONDS = 300;
const NO_STORE = 'no-store';

app.use('*', async (c, next) => {
  const canonicalUrl = canonicalLocalRequestUrl(c.req.url);
  if (canonicalUrl) {
    return redirectNoStore(c, canonicalUrl, 307);
  }
  await next();

  const pathname = new URL(c.req.url).pathname;
  if (!isStaticAssetPath(pathname)) {
    c.res = noStore(c.res);
  }
});

function isHtmlRequest(c) {
  return (c.req.header('Accept') || '').includes('text/html');
}

function isStaticAssetPath(pathname) {
  return /\.(?:css|gif|ico|jpe?g|js|png|svg|webp)$/i.test(pathname);
}

function asset(c, path, options = {}) {
  const url = new URL(c.req.url);
  url.pathname = path;
  url.search = '';
  const headers = new Headers(c.req.raw.headers);
  if (options.stripCacheValidators) {
    headers.delete('If-Match');
    headers.delete('If-None-Match');
    headers.delete('If-Modified-Since');
    headers.delete('If-Unmodified-Since');
    headers.delete('If-Range');
  }
  return c.env.ASSETS.fetch(new Request(url, {
    method: 'GET',
    headers
  }));
}

async function protectedAsset(c, path) {
  return noStore(await asset(c, path, { stripCacheValidators: true }));
}

function noStore(response) {
  const next = new Response(response.body, response);
  next.headers.set('Cache-Control', NO_STORE);
  next.headers.set('Pragma', 'no-cache');
  return next;
}

function redirectNoStore(c, path, status) {
  return noStore(c.redirect(path, status));
}

function formError(c, err) {
  const statusCode = err.statusCode || 500;
  if (statusCode >= 500) {
    console.error(err);
  }
  return c.text(statusCode >= 500 ? 'Internal Server Error' : err.message, statusCode);
}

async function currentUserOrResponse(c) {
  const result = await requireLiveUser(c.env, c.req.raw);
  if (result.user) {
    return result;
  }
  if (result.dead) {
    if (isHtmlRequest(c)) {
      return redirectNoStore(c, '/you-died');
    }
    return c.json({ error: 'You died', redirect: '/you-died' }, 410);
  }
  if (isHtmlRequest(c)) {
    return redirectNoStore(c, '/');
  }
  return c.json({ error: 'Login required' }, 401);
}

function roomName(row, col) {
  return `${row}:${col}`;
}

function constantTimeEqual(left, right) {
  if (left.length !== right.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < left.length; i += 1) {
    diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
  }
  return diff === 0;
}

function bytesToHex(buffer) {
  return Array.from(new Uint8Array(buffer))
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('');
}

function parseStripeSignature(header = '') {
  const pieces = header.split(',').map(piece => piece.trim()).filter(Boolean);
  const timestamp = pieces.find(piece => piece.startsWith('t='))?.slice(2);
  const signatures = pieces
    .filter(piece => piece.startsWith('v1='))
    .map(piece => piece.slice(3));
  return { timestamp, signatures };
}

async function computeStripeSignature(payload, timestamp, secret) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signedPayload = `${timestamp}.${payload}`;
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signedPayload));
  return bytesToHex(signature);
}

async function verifyStripeWebhook(payload, signatureHeader, secret) {
  if (!secret) {
    throw new ActionError('Stripe webhook secret is not configured.', 500);
  }
  const { timestamp, signatures } = parseStripeSignature(signatureHeader);
  if (!timestamp || signatures.length === 0) {
    return false;
  }
  const timestampNumber = Number(timestamp);
  if (!Number.isFinite(timestampNumber)) {
    return false;
  }
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestampNumber) > STRIPE_WEBHOOK_TOLERANCE_SECONDS) {
    return false;
  }
  const expected = await computeStripeSignature(payload, timestamp, secret);
  return signatures.some(signature => constantTimeEqual(signature, expected));
}

async function broadcastRoom(env, row, col, payload) {
  const stub = env.ROOMS.getByName(roomName(row, col));
  await stub.broadcast({
    room: { row, col },
    ...payload
  });
}

async function startHostileLoopIfNeeded(env, row, col) {
  if (!await roomHasActiveHostiles(env.DB, row, col)) {
    return;
  }
  const stub = env.ROOMS.getByName(roomName(row, col));
  await stub.fetch(new Request(`https://room.local/hostiles/${row}/${col}/start`, { method: 'POST' }));
}

async function ensureRoomUse(c, user, row, col) {
  const roomUse = await requireRoomUse(c.env.DB, user.username, row, col);
  if (!roomUse.allowed) {
    throw new ActionError('Inn access required', 403);
  }
  return roomUse;
}

function parseCoordinates(c) {
  const coordinates = validateRoomCoordinates(c.req.param('row'), c.req.param('col'));
  if (!coordinates) {
    throw new ActionError('Invalid room coordinates', 400);
  }
  return coordinates;
}

async function parseForm(c) {
  return c.req.parseBody();
}

app.get('/', c => asset(c, '/index.html'));
app.get('/signup', c => asset(c, '/signup.html'));
app.get('/cemetery', c => asset(c, '/cemetery.html'));
app.get('/leaderboard', c => asset(c, '/leaderboard.html'));

app.post('/login', async c => {
  const body = await parseForm(c);
  const username = String(body.username || '');
  const password = String(body.password || '');
  const user = await dbFirst(c.env.DB, 'SELECT * FROM users WHERE username = ? AND password = ? AND isNpc = 0', [username, password]);

  if (user) {
    const session = await createSession(c.env, { username: user.username });
    c.header('Set-Cookie', session.cookie);
    return redirectNoStore(c, '/success');
  }

  const deadUser = await dbFirst(
    c.env.DB,
    `SELECT username
     FROM cemetery
     WHERE username = ?
       AND password = ?
     ORDER BY diedAt DESC, id DESC
     LIMIT 1`,
    [username, password]
  );

  if (deadUser) {
    const session = await createSession(c.env, { deadUsername: deadUser.username });
    c.header('Set-Cookie', session.cookie);
    return redirectNoStore(c, '/death');
  }

  return asset(c, '/index.html');
});

app.post('/signup', async c => {
  try {
    const body = await parseForm(c);
    const username = String(body.username || '').trim();
    const password = String(body.password || '');
    const job = normalizeJob(String(body.job || ''));
    const allocationResult = validateStartingAllocation({
      health: body.health,
      stamina: body.stamina,
      speed: body.speed,
      strength: body.strength,
      intelligence: body.intelligence
    });

    if (!username || !password) {
      throw new ActionError('Username and password are required.');
    }
    if (!Object.prototype.hasOwnProperty.call(JOBS, body.job)) {
      throw new ActionError('Invalid job.');
    }
    if (!allocationResult.valid) {
      throw new ActionError(allocationResult.errors[0]);
    }

    const existing = await dbFirst(c.env.DB, 'SELECT username FROM users WHERE username = ?', [username]);
    if (existing) {
      throw new ActionError('Username already taken.');
    }

    const stats = buildStartingStats(allocationResult.allocation);
    await dbRun(
      c.env.DB,
      `INSERT INTO users
        (username, password, job, health, maxHealth, stamina, maxStamina, speed, strength, intelligence, level, gold, experience, isNpc)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0)`,
      [
        username,
        password,
        job,
        stats.health,
        stats.maxHealth,
        stats.stamina,
        stats.maxStamina,
        stats.speed,
        stats.strength,
        stats.intelligence
      ]
    );

    return c.redirect('/');
  } catch (err) {
    return formError(c, err);
  }
});

app.get('/logout', async c => {
  await destroySession(c.env, c.req.raw);
  c.header('Set-Cookie', clearSessionCookieHeader());
  return redirectNoStore(c, '/');
});

app.get('/success', async c => {
  const auth = await currentUserOrResponse(c);
  if (auth instanceof Response) {
    return auth;
  }
  return protectedAsset(c, '/success.html');
});

app.get('/world-events', async c => {
  const auth = await currentUserOrResponse(c);
  if (auth instanceof Response) {
    return auth;
  }
  return c.json(await getActiveWorldEvents(c.env.DB));
});

app.get('/character', async c => {
  const auth = await currentUserOrResponse(c);
  if (auth instanceof Response) {
    return auth;
  }
  return protectedAsset(c, '/character.html');
});

app.get('/death', async c => {
  const session = await getSession(c.env, c.req.raw);
  if (!session?.deadUsername) {
    return redirectNoStore(c, '/');
  }
  return protectedAsset(c, '/death.html');
});

app.get('/you-died', async c => {
  const session = await getSession(c.env, c.req.raw);
  if (!session?.deadUsername) {
    return redirectNoStore(c, '/');
  }
  return protectedAsset(c, '/you-died.html');
});

app.get('/death-data', async c => {
  const session = await getSession(c.env, c.req.raw);
  if (!session?.deadUsername) {
    return c.json({ error: 'No dead character in this session' }, 401);
  }
  const grave = await dbFirst(
    c.env.DB,
    `SELECT username, level, gold, job, cause, roomRow, roomCol, diedAt
     FROM cemetery
     WHERE username = ?
     ORDER BY diedAt DESC, id DESC
     LIMIT 1`,
    [session.deadUsername]
  );
  if (!grave) {
    return c.json({ error: 'Grave not found' }, 404);
  }
  return c.json({ ...grave, kills: 0, achievements: [] });
});

app.post('/resurrection-link', async c => {
  const session = await getSession(c.env, c.req.raw);
  if (!session?.deadUsername) {
    return c.json({ error: 'No dead character in this session' }, 401);
  }

  const checkout = await createResurrectionCheckout(
    c.env.DB,
    session.deadUsername,
    c.env.RESURRECTION_PAYMENT_LINK_URL || DEFAULT_RESURRECTION_PAYMENT_LINK_URL
  );
  if (!checkout) {
    return c.json({ error: 'Grave not found' }, 404);
  }

  return c.json({ url: checkout.url });
});

app.get('/cemetery-data', async c => {
  const players = await dbAll(
    c.env.DB,
    'SELECT username, level, gold, job, cause, roomRow, roomCol, diedAt FROM cemetery ORDER BY diedAt DESC, id DESC'
  );
  return c.json(players);
});

app.get('/leaderboard-data', async c => {
  const players = await dbAll(c.env.DB, 'SELECT username, gold FROM users WHERE isNpc = 0 ORDER BY gold DESC');
  return c.json(players);
});

app.post('/stripe/webhook', async c => {
  try {
    const payload = await c.req.text();
    const verified = await verifyStripeWebhook(
      payload,
      c.req.header('stripe-signature') || '',
      c.env.STRIPE_WEBHOOK_SECRET
    );
    if (!verified) {
      return c.text('Invalid Stripe signature', 400);
    }

    const event = JSON.parse(payload);
    if (event.type !== 'checkout.session.completed') {
      return c.json({ received: true });
    }

    const session = event.data?.object || {};
    if (c.env.STRIPE_RESURRECTION_PAYMENT_LINK_ID && session.payment_link !== c.env.STRIPE_RESURRECTION_PAYMENT_LINK_ID) {
      return c.json({ received: true, ignored: true });
    }
    if (session.payment_status && session.payment_status !== 'paid') {
      return c.json({ received: true, ignored: true });
    }

    const resurrection = await fulfillResurrectionCheckout(
      c.env.DB,
      session.client_reference_id,
      session.id
    );
    return c.json({ received: true, resurrection });
  } catch (err) {
    if (err instanceof ActionError) {
      return formError(c, err);
    }
    console.error(err);
    return c.text('Invalid Stripe webhook payload', 400);
  }
});

app.get('/chat/:row/:col', async c => {
  const auth = await currentUserOrResponse(c);
  if (auth instanceof Response) {
    return auth;
  }

  try {
    const { row, col } = parseCoordinates(c);
    const tickValue = await getCurrentTickValue(c.env.DB);
    const access = await getRoomAccessState(c.env.DB, auth.user.username, row, col, tickValue);

    if (access.required && !access.paid) {
      return noStore(c.html(`<!DOCTYPE html>
<html>
<head><title>Inn Access</title><link rel="stylesheet" href="/styles.css"></head>
<body>
  <p>Room ${row}, ${col} is an inn today.</p>
  <p>Entry costs ${access.fee} gold. You have ${access.gold ?? 0} gold.</p>
  <form method="POST" action="/room-access/${row}/${col}/pay">
    <button type="submit" ${access.canPay ? '' : 'disabled'}>Pay and enter</button>
  </form>
  <p><a href="/success">Return to map</a></p>
</body>
</html>`));
    }

    return protectedAsset(c, '/chat.html');
  } catch (err) {
    return formError(c, err);
  }
});

app.get('/user-attributes', async c => {
  const auth = await currentUserOrResponse(c);
  if (auth instanceof Response) {
    return auth;
  }
  const user = await dbFirst(
    c.env.DB,
    'SELECT username, job, health, maxHealth, stamina, maxStamina, speed, strength, intelligence, level, gold, experience, attributePoints FROM users WHERE username = ? AND isNpc = 0',
    [auth.user.username]
  );
  if (!user) {
    return c.json({ error: 'User Not Found' }, 404);
  }
  const effective = getEffectiveUser(user);
  const achievements = await dbAll(
    c.env.DB,
    `SELECT achievementType, eventId, worldDay, earnedTick, rewardExperience, rewardGold
     FROM worldEventAchievements
     WHERE username = ?
     ORDER BY earnedTick DESC, id DESC`,
    [auth.user.username]
  );
  return c.json({
    ...user,
    job: effective.job,
    baseStats: effective.baseStats,
    jobBonuses: effective.jobBonuses,
    effectiveStats: {
      health: effective.health,
      maxHealth: effective.maxHealth,
      stamina: effective.stamina,
      maxStamina: effective.maxStamina,
      speed: effective.speed,
      strength: effective.strength,
      intelligence: effective.intelligence
    },
    skill: effective.skill,
    achievements
  });
});

app.get('/tick', async c => c.json({ tick: await getCurrentTickValue(c.env.DB) }));

app.get('/messages/:row/:col', async c => {
  const auth = await currentUserOrResponse(c);
  if (auth instanceof Response) {
    return auth;
  }

  try {
    const { row, col } = parseCoordinates(c);
    await ensureRoomUse(c, auth.user, row, col);
    return c.json(await getMessages(c.env.DB, row, col));
  } catch (err) {
    return formError(c, err);
  }
});

app.get('/room-ecology/:row/:col', async c => {
  const auth = await currentUserOrResponse(c);
  if (auth instanceof Response) {
    return auth;
  }

  try {
    const { row, col } = parseCoordinates(c);
    return c.json(await getRoomEcology(c.env.DB, auth.user.username, row, col));
  } catch (err) {
    return formError(c, err);
  }
});

app.post('/room-presence/:row/:col', async c => {
  const auth = await currentUserOrResponse(c);
  if (auth instanceof Response) {
    return auth;
  }

  try {
    const { row, col } = parseCoordinates(c);
    await ensureRoomUse(c, auth.user, row, col);
    const presence = await updatePresence(c.env.DB, auth.user.username, row, col);
    await broadcastRoom(c.env, row, col, { type: 'presence', username: auth.user.username });
    await startHostileLoopIfNeeded(c.env, row, col);
    return c.json({ ok: true, presence });
  } catch (err) {
    return formError(c, err);
  }
});

app.post('/room-access/:row/:col/pay', async c => {
  const auth = await currentUserOrResponse(c);
  if (auth instanceof Response) {
    return auth;
  }

  try {
    const { row, col } = parseCoordinates(c);
    const access = await payInnAccess(c.env.DB, auth.user.username, row, col);
    if (isHtmlRequest(c)) {
      return c.redirect(`/chat/${row}/${col}`);
    }
    return c.json({ ok: true, innAccess: access });
  } catch (err) {
    return formError(c, err);
  }
});

app.post('/chat/:row/:col', async c => {
  const auth = await currentUserOrResponse(c);
  if (auth instanceof Response) {
    return auth;
  }

  try {
    const { row, col } = parseCoordinates(c);
    await ensureRoomUse(c, auth.user, row, col);
    const body = await parseForm(c);
    const message = String(body.message || '');
    if (!message.trim()) {
      throw new ActionError('Message required.');
    }
    const result = await handleChatAction(c.env.DB, auth.user.username, row, col, message);
    await broadcastRoom(c.env, row, col, { type: 'message', username: auth.user.username, result });
    return c.redirect(`/chat/${row}/${col}`);
  } catch (err) {
    return formError(c, err);
  }
});

app.post('/attack/:row/:col', async c => {
  const auth = await currentUserOrResponse(c);
  if (auth instanceof Response) {
    return auth;
  }

  try {
    const { row, col } = parseCoordinates(c);
    await ensureRoomUse(c, auth.user, row, col);
    const body = await parseForm(c);
    const message = String(body.message || '');
    const result = await handleAttackAction(c.env.DB, auth.user.username, row, col, message);
    await broadcastRoom(c.env, row, col, { type: 'attack', username: auth.user.username, result });
    return c.redirect(`/chat/${row}/${col}`);
  } catch (err) {
    return formError(c, err);
  }
});

app.post('/skill/:row/:col', async c => {
  const auth = await currentUserOrResponse(c);
  if (auth instanceof Response) {
    return auth;
  }

  try {
    const { row, col } = parseCoordinates(c);
    const roomUse = await ensureRoomUse(c, auth.user, row, col);
    const body = await parseForm(c);
    const skillId = String(body.skillId || '');
    const targetUsername = String(body.targetUsername || body.message || '');
    const result = await handleSkillAction(
      c.env.DB,
      auth.user.username,
      row,
      col,
      skillId,
      targetUsername,
      roomUse.tickValue + 1
    );
    await broadcastRoom(c.env, row, col, { type: 'skill', username: auth.user.username, result });
    return c.redirect(`/chat/${row}/${col}`);
  } catch (err) {
    return formError(c, err);
  }
});

app.post('/job/:row/:col', async c => {
  const auth = await currentUserOrResponse(c);
  if (auth instanceof Response) {
    return auth;
  }

  try {
    const { row, col } = parseCoordinates(c);
    const roomUse = await ensureRoomUse(c, auth.user, row, col);
    const body = await parseForm(c);
    const result = await handleJobChangeAction(
      c.env.DB,
      auth.user.username,
      row,
      col,
      String(body.job || ''),
      roomUse
    );
    await broadcastRoom(c.env, row, col, { type: 'job', username: auth.user.username, result });
    return c.redirect(`/chat/${row}/${col}`);
  } catch (err) {
    return formError(c, err);
  }
});

app.get('/ws/:row/:col', async c => {
  const coordinates = validateRoomCoordinates(c.req.param('row'), c.req.param('col'));
  if (!coordinates) {
    return c.text('Invalid room coordinates', 400);
  }
  const stub = c.env.ROOMS.getByName(roomName(coordinates.row, coordinates.col));
  return stub.fetch(c.req.raw);
});

app.notFound(c => c.env.ASSETS.fetch(c.req.raw));

export class RoomObject extends DurableObject {
  async fetch(request) {
    const url = new URL(request.url);
    const hostileMatch = url.pathname.match(/^\/hostiles\/(\d+)\/(\d+)\/start$/);
    if (hostileMatch && request.method === 'POST') {
      const row = Number.parseInt(hostileMatch[1], 10);
      const col = Number.parseInt(hostileMatch[2], 10);
      await this.ctx.storage.put('hostileRoom', { row, col });
      await this.ctx.storage.setAlarm(Date.now() + 5000);
      return new Response('ok');
    }

    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected WebSocket upgrade', { status: 426 });
    }

    const auth = await requireLiveUser(this.env, request);
    if (!auth.user) {
      return new Response('Login required', { status: auth.dead ? 410 : 401 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server, [auth.user.username]);
    server.send(JSON.stringify({ type: 'connected', username: auth.user.username }));
    return new Response(null, { status: 101, webSocket: client });
  }

  async broadcast(payload) {
    const message = JSON.stringify(payload);
    for (const socket of this.ctx.getWebSockets()) {
      try {
        socket.send(message);
      } catch {
        socket.close(1011, 'Unable to deliver message');
      }
    }
  }

  async alarm() {
    const room = await this.ctx.storage.get('hostileRoom');
    if (!room) {
      return;
    }

    const result = await runHostileRoomAction(this.env.DB, room.row, room.col);
    await this.broadcast({ type: 'hostile', room, result });

    if (await roomHasActiveHostiles(this.env.DB, room.row, room.col)) {
      await this.ctx.storage.setAlarm(Date.now() + 5000);
    } else {
      await this.ctx.storage.delete('hostileRoom');
    }
  }
}

export default {
  fetch(request, env, ctx) {
    return app.fetch(request, env, ctx);
  },
  async scheduled(_event, env, ctx) {
    const pulse = runScheduledWorldPulse(env.DB);
    if (ctx && typeof ctx.waitUntil === 'function') {
      ctx.waitUntil(pulse);
      return;
    }
    await pulse;
  }
};
