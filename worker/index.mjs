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
  SIGNATURE_ITEMS_BY_JOB,
  allocateAttributePoint,
  buildStartingStats,
  createItemForOwner,
  getCurrentPosition,
  getCurrentTickValue,
  getMessages,
  getActiveWorldEvents,
  getRoomAccessState,
  getRoomEcology,
  getProgressionGrid,
  getRoomState,
  getUserState,
  handleAttackAction,
  handleChatAction,
  handleJobChangeAction,
  handleSkillAction,
  normalizeJob,
  respecProgression,
  unlockProgressionNode,
  payInnAccess,
  requireRoomUse,
  ensureSocialPopulation,
  roomHasActiveHostiles,
  roomNeedsLoop,
  runHostileRoomAction,
  runNpcAmbient,
  runNpcReply,
  runScheduledWorldPulse,
  updatePresence,
  validateMovement,
  validateRoomCoordinates,
  validateStartingAllocation
} from './game.mjs';
import {
  createResurrectionCheckout,
  fulfillResurrectionCheckout
} from './resurrection.mjs';
import { verifyStripeWebhook } from './stripe.mjs';
import { canonicalLocalRequestUrl } from './localHost.mjs';
import { wantsHtmlResponse, wantsJsonResponse } from './http.mjs';
import { elapsedMs, logEvent, measureAsync, nowMs } from './observability.mjs';

const app = new Hono();
const DEFAULT_RESURRECTION_PAYMENT_LINK_URL = 'https://buy.stripe.com/8x23codZs9Tj8dgertbV600';
const NO_STORE = 'no-store';

app.use('*', async (c, next) => {
  const requestStart = nowMs();
  const canonicalUrl = canonicalLocalRequestUrl(c.req.url);
  if (canonicalUrl) {
    return redirectNoStore(c, canonicalUrl, 307);
  }

  const pathname = new URL(c.req.url).pathname;
  try {
    await next();
  } finally {
    if (!isStaticAssetPath(pathname)) {
      logEvent({
        event: 'request.complete',
        method: c.req.method,
        path: pathname,
        status: c.res.status,
        durationMs: elapsedMs(requestStart),
        ...parseRoomFromPath(pathname)
      });
    }
  }

  if (!isStaticAssetPath(pathname)) {
    c.res = noStore(c.res);
  }
});

function isHtmlRequest(c) {
  return wantsHtmlResponse(c.req.raw);
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

function actionResponse(c, row, col, payload = {}) {
  if (wantsJsonResponse(c.req.raw)) {
    return c.json({
      ok: true,
      redirect: `/chat/${row}/${col}`,
      ...payload
    });
  }
  return redirectNoStore(c, `/chat/${row}/${col}`);
}

function parseRoomFromPath(pathname) {
  const match = pathname.match(/^\/(?:chat|attack|skill|job|messages|room-state|room-ecology|room-presence|room-access)\/(\d+)\/(\d+)/);
  if (!match) {
    return {};
  }
  return {
    roomRow: Number.parseInt(match[1], 10),
    roomCol: Number.parseInt(match[2], 10)
  };
}

function runAfterResponse(c, payload, callback) {
  const work = (async () => {
    const start = nowMs();
    try {
      await callback();
      logEvent({
        ...payload,
        event: 'background.complete',
        durationMs: elapsedMs(start)
      });
    } catch (err) {
      console.error({
        ...payload,
        event: 'background.error',
        error: err instanceof Error ? err.message : String(err)
      });
    }
  })();

  if (c.executionCtx && typeof c.executionCtx.waitUntil === 'function') {
    c.executionCtx.waitUntil(work);
    return;
  }
  work.catch(() => {});
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

async function broadcastRoom(env, row, col, payload) {
  const stub = env.ROOMS.getByName(roomName(row, col));
  await stub.broadcast({
    room: { row, col },
    ...payload
  });
}

async function startHostileLoopIfNeeded(env, row, col) {
  // Plan 013f: the room loop now also drives proactive NPC chatter, so wake it whenever a
  // room "needs" a loop (combat OR a present human + social NPCs), not just for hostiles.
  if (!await roomNeedsLoop(env.DB, row, col)) {
    return;
  }
  const stub = env.ROOMS.getByName(roomName(row, col));
  await stub.fetch(new Request(`https://room.local/hostiles/${row}/${col}/start`, { method: 'POST' }));
}

// Plan 013a: ask the room's Durable Object to let an NPC react to what a player just
// said. The DO owns env.AI (the model is never touched in a route's latency path) and
// owns broadcast + per-room serialization. Fire-and-forget from runAfterResponse.
async function npcReactInRoom(env, row, col) {
  const stub = env.ROOMS.getByName(roomName(row, col));
  await stub.fetch(new Request(`https://room.local/npc-react/${row}/${col}`, { method: 'POST' }));
}

async function wakeActiveRooms(env, pulse) {
  await Promise.all((pulse.activeRooms || []).map(async room => {
    try {
      const stub = env.ROOMS.getByName(roomName(room.row, room.col));
      await stub.fetch(new Request(`https://room.local/world-pulse/${room.row}/${room.col}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'world-pulse',
          tick: pulse.tick,
          environmental: pulse.environmental
        })
      }));
    } catch (err) {
      console.error(`Unable to wake room ${room.row}:${room.col}`, err);
    }
  }));
}

async function runScheduledWorldPulseAndWakeRooms(env) {
  const pulse = await runScheduledWorldPulse(env.DB);
  await wakeActiveRooms(env, pulse);
  return pulse;
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

    // Grant the class's signature item, equipped (silent, no room needed).
    await createItemForOwner(c.env.DB, SIGNATURE_ITEMS_BY_JOB[job], username, { equip: true });

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

app.get('/map-state', async c => {
  const auth = await currentUserOrResponse(c);
  if (auth instanceof Response) {
    return auth;
  }
  // Plan 023b: the incapacitated can't rise to survey the world — the map is denied
  // while they bleed out (they may still speak in-room).
  if (auth.user.incapacitated) {
    return c.json({ position: null, prone: true });
  }
  const position = await getCurrentPosition(c.env.DB, auth.user.username);
  return c.json({ position: position ? { row: position.row, col: position.col } : null });
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

// Plan 019: the progression grid (shared skill-tree board).
app.get('/grid', async c => {
  const auth = await currentUserOrResponse(c);
  if (auth instanceof Response) {
    return auth;
  }
  return protectedAsset(c, '/grid.html');
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
  // Plan 023a: the kill count is already written to killHistory on every kill —
  // surface it instead of the old hardcoded 0. The most recent kill of THIS player
  // (if any) gives the slayer's name for the brutal headline; the grave's `cause`
  // carries the manner, `diedAt` the time.
  const [kills, slain] = await Promise.all([
    dbFirst(c.env.DB, 'SELECT COUNT(*) AS n FROM killHistory WHERE killerUsername = ?', [grave.username]),
    dbFirst(
      c.env.DB,
      `SELECT killerUsername, roomRow, roomCol, tick
       FROM killHistory
       WHERE defeatedUsername = ? AND defeatedKind = 'player'
       ORDER BY id DESC LIMIT 1`,
      [grave.username]
    )
  ]);
  return c.json({
    ...grave,
    kills: kills?.n ?? 0,
    slayer: slain?.killerUsername ?? null,
    achievements: []
  });
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
  // Plan 022c: the corpse was eaten/destroyed — resurrection is impossible.
  if (checkout.severed) {
    return c.json({ error: 'Your corpse was destroyed. There is no coming back.' }, 410);
  }

  return c.json({ url: checkout.url });
});

app.get('/cemetery-data', async c => {
  // Plan 023a: each grave carries who felled them (the most recent killHistory row),
  // so the graveyard reads as a record of slaughter, not a flat name list.
  const players = await dbAll(
    c.env.DB,
    `SELECT cm.username, cm.level, cm.gold, cm.job, cm.cause, cm.roomRow, cm.roomCol, cm.diedAt,
            (SELECT kh.killerUsername FROM killHistory kh
             WHERE kh.defeatedUsername = cm.username AND kh.defeatedKind = 'player'
             ORDER BY kh.id DESC LIMIT 1) AS slayer
     FROM cemetery cm
     ORDER BY cm.diedAt DESC, cm.id DESC`
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

    // Adjacency gate (plan 009): only the room page is served here; the server
    // is still the authority (POST /room-presence re-checks), but render a
    // friendly page instead of a broken chat when the room is out of walking range.
    const movement = await validateMovement(c.env.DB, auth.user.username, row, col);
    if (!movement.allowed) {
      return noStore(c.html(`<!DOCTYPE html>
<html>
<head><title>Too Far</title><link rel="stylesheet" href="/styles.css"></head>
<body>
  <p>Too far to walk there — Room ${row}, ${col} is out of range from where you are standing.</p>
  <p>You can only move to an adjacent room. <a href="/success">Return to map</a></p>
</body>
</html>`));
    }

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
  try {
    return c.json(await getUserState(c.env.DB, auth.user.username));
  } catch (err) {
    return formError(c, err);
  }
});

// Plan 016: spend an attribute point on a stat. A character-sheet meta action —
// no room/stamina/tick — so it routes through its own endpoint, not /chat.
app.post('/allocate', async c => {
  const auth = await currentUserOrResponse(c);
  if (auth instanceof Response) {
    return auth;
  }
  try {
    const body = await parseForm(c);
    await allocateAttributePoint(c.env.DB, auth.user.username, String(body.stat || ''));
    return c.json(await getUserState(c.env.DB, auth.user.username));
  } catch (err) {
    return formError(c, err);
  }
});

// Plan 019: progression-grid board state for the /grid page.
app.get('/progression', async c => {
  const auth = await currentUserOrResponse(c);
  if (auth instanceof Response) {
    return auth;
  }
  try {
    return c.json(await getProgressionGrid(c.env.DB, auth.user.username));
  } catch (err) {
    return formError(c, err);
  }
});

// Unlock a node (spends 1 skill point; requires adjacency). Meta action — no
// room/stamina/tick — like /allocate. Returns the fresh board.
app.post('/grid/unlock', async c => {
  const auth = await currentUserOrResponse(c);
  if (auth instanceof Response) {
    return auth;
  }
  try {
    const body = await parseForm(c);
    return c.json(await unlockProgressionNode(c.env.DB, auth.user.username, String(body.nodeId || '')));
  } catch (err) {
    return formError(c, err);
  }
});

// Respec: gold-priced, guild-gated. Resolves the player's current room so the
// guild check uses where they actually are.
app.post('/grid/respec', async c => {
  const auth = await currentUserOrResponse(c);
  if (auth instanceof Response) {
    return auth;
  }
  try {
    const position = await getCurrentPosition(c.env.DB, auth.user.username);
    if (!position) {
      return formError(c, new ActionError('You can only respec at a guild.', 400));
    }
    return c.json(await respecProgression(c.env.DB, auth.user.username, position.row, position.col));
  } catch (err) {
    return formError(c, err);
  }
});

app.get('/tick', async c => c.json({ tick: await getCurrentTickValue(c.env.DB) }));

app.get('/messages/:row/:col', async c => {
  const auth = await currentUserOrResponse(c);
  if (auth instanceof Response) {
    return auth;
  }

  try {
    const { row, col } = parseCoordinates(c);
    const roomUse = await ensureRoomUse(c, auth.user, row, col);
    return c.json(await getMessages(c.env.DB, row, col, roomUse.tickValue));
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

app.get('/room-state/:row/:col', async c => {
  const auth = await currentUserOrResponse(c);
  if (auth instanceof Response) {
    return auth;
  }

  try {
    const { row, col } = parseCoordinates(c);
    const roomUse = await ensureRoomUse(c, auth.user, row, col);
    if (!roomUse.allowed) {
      throw new ActionError('Inn access required', 403);
    }
    return c.json(await getRoomState(c.env.DB, auth.user.username, row, col, roomUse.tickValue));
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
    const actionStart = nowMs();
    const { row, col } = parseCoordinates(c);
    const roomUse = await measureAsync(() => ensureRoomUse(c, auth.user, row, col));
    const presenceResult = await measureAsync(() => updatePresence(c.env.DB, auth.user.username, row, col));
    runAfterResponse(c, { action: 'presence', roomRow: row, roomCol: col }, async () => {
      const broadcast = await measureAsync(() => broadcastRoom(c.env, row, col, { type: 'presence', username: auth.user.username }));
      // Plan 013b/013f: populate the social cast FIRST, then wake the room loop — so
      // roomNeedsLoop sees the freshly-spawned NPCs and starts proactive chatter on the
      // very first entry (otherwise the loop check ran before anyone was in the room).
      const populated = await measureAsync(() => ensureSocialPopulation(c.env.DB, row, col));
      if (populated.value && populated.value.spawned > 0) {
        await broadcastRoom(c.env, row, col, { type: 'presence', username: auth.user.username });
      }
      const hostileLoop = await measureAsync(() => startHostileLoopIfNeeded(c.env, row, col));
      logEvent({
        event: 'action.background',
        action: 'presence',
        roomRow: row,
        roomCol: col,
        broadcastMs: broadcast.durationMs,
        hostileLoopMs: hostileLoop.durationMs
      });
    });
    logEvent({
      event: 'action.complete',
      action: 'presence',
      roomRow: row,
      roomCol: col,
      durationMs: elapsedMs(actionStart),
      roomUseMs: roomUse.durationMs,
      updatePresenceMs: presenceResult.durationMs
    });
    const presence = presenceResult.value;
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
    const actionStart = nowMs();
    const { row, col } = parseCoordinates(c);
    const roomUse = await measureAsync(() => ensureRoomUse(c, auth.user, row, col));
    const bodyResult = await measureAsync(() => parseForm(c));
    const body = bodyResult.value;
    const message = String(body.message || '');
    if (!message.trim()) {
      throw new ActionError('Message required.');
    }
    const action = await measureAsync(() => handleChatAction(c.env.DB, auth.user.username, row, col, message));
    const result = action.value;
    runAfterResponse(c, { action: 'chat', roomRow: row, roomCol: col }, async () => {
      const broadcast = await measureAsync(() => broadcastRoom(c.env, row, col, { type: 'message', username: auth.user.username, result }));
      const hostileLoop = await measureAsync(() => startHostileLoopIfNeeded(c.env, row, col));
      // Plan 013a: after the player's line lands, give a present NPC a chance to answer.
      // Plan 013d: a downed player's garbled plea still reaches the room — a present
      // cleric may piece it together and raise them (the engine gates the actual revive).
      await measureAsync(() => npcReactInRoom(c.env, row, col));
      logEvent({
        event: 'action.background',
        action: 'chat',
        roomRow: row,
        roomCol: col,
        broadcastMs: broadcast.durationMs,
        hostileLoopMs: hostileLoop.durationMs
      });
    });
    logEvent({
      event: 'action.complete',
      action: 'chat',
      roomRow: row,
      roomCol: col,
      durationMs: elapsedMs(actionStart),
      roomUseMs: roomUse.durationMs,
      parseFormMs: bodyResult.durationMs,
      gameActionMs: action.durationMs
    });
    return actionResponse(c, row, col, { action: 'chat', result });
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
    const actionStart = nowMs();
    const { row, col } = parseCoordinates(c);
    const roomUse = await measureAsync(() => ensureRoomUse(c, auth.user, row, col));
    const bodyResult = await measureAsync(() => parseForm(c));
    const body = bodyResult.value;
    const message = String(body.message || '');
    // Plan 024: the targeting toolbar aims at a body part out-of-band, so the limb
    // stays out of the chat prose. Empty => no called shot (weighted-random hit).
    const targetPart = body.targetPart ? String(body.targetPart) : null;
    const action = await measureAsync(() => handleAttackAction(c.env.DB, auth.user.username, row, col, message, targetPart));
    const result = action.value;
    runAfterResponse(c, { action: 'attack', roomRow: row, roomCol: col }, async () => {
      const broadcast = await measureAsync(() => broadcastRoom(c.env, row, col, { type: 'attack', username: auth.user.username, result }));
      const hostileLoop = await measureAsync(() => startHostileLoopIfNeeded(c.env, row, col));
      logEvent({
        event: 'action.background',
        action: 'attack',
        roomRow: row,
        roomCol: col,
        broadcastMs: broadcast.durationMs,
        hostileLoopMs: hostileLoop.durationMs
      });
    });
    logEvent({
      event: 'action.complete',
      action: 'attack',
      roomRow: row,
      roomCol: col,
      durationMs: elapsedMs(actionStart),
      roomUseMs: roomUse.durationMs,
      parseFormMs: bodyResult.durationMs,
      gameActionMs: action.durationMs
    });
    return actionResponse(c, row, col, { action: 'attack', result });
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
    const actionStart = nowMs();
    const { row, col } = parseCoordinates(c);
    const roomUseResult = await measureAsync(() => ensureRoomUse(c, auth.user, row, col));
    const roomUse = roomUseResult.value;
    const bodyResult = await measureAsync(() => parseForm(c));
    const body = bodyResult.value;
    const skillId = String(body.skillId || '');
    const targetUsername = String(body.targetUsername || body.message || '');
    const action = await measureAsync(() => handleSkillAction(
      c.env.DB,
      auth.user.username,
      row,
      col,
      skillId,
      targetUsername,
      roomUse.tickValue + 1
    ));
    const result = action.value;
    runAfterResponse(c, { action: 'skill', roomRow: row, roomCol: col }, async () => {
      const broadcast = await measureAsync(() => broadcastRoom(c.env, row, col, { type: 'skill', username: auth.user.username, result }));
      const hostileLoop = await measureAsync(() => startHostileLoopIfNeeded(c.env, row, col));
      logEvent({
        event: 'action.background',
        action: 'skill',
        roomRow: row,
        roomCol: col,
        broadcastMs: broadcast.durationMs,
        hostileLoopMs: hostileLoop.durationMs
      });
    });
    logEvent({
      event: 'action.complete',
      action: 'skill',
      roomRow: row,
      roomCol: col,
      durationMs: elapsedMs(actionStart),
      roomUseMs: roomUseResult.durationMs,
      parseFormMs: bodyResult.durationMs,
      gameActionMs: action.durationMs
    });
    return actionResponse(c, row, col, { action: 'skill', result });
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
    const actionStart = nowMs();
    const { row, col } = parseCoordinates(c);
    const roomUseResult = await measureAsync(() => ensureRoomUse(c, auth.user, row, col));
    const roomUse = roomUseResult.value;
    const bodyResult = await measureAsync(() => parseForm(c));
    const body = bodyResult.value;
    const action = await measureAsync(() => handleJobChangeAction(
      c.env.DB,
      auth.user.username,
      row,
      col,
      String(body.job || ''),
      roomUse
    ));
    const result = action.value;
    runAfterResponse(c, { action: 'job', roomRow: row, roomCol: col }, async () => {
      const broadcast = await measureAsync(() => broadcastRoom(c.env, row, col, { type: 'job', username: auth.user.username, result }));
      const hostileLoop = await measureAsync(() => startHostileLoopIfNeeded(c.env, row, col));
      logEvent({
        event: 'action.background',
        action: 'job',
        roomRow: row,
        roomCol: col,
        broadcastMs: broadcast.durationMs,
        hostileLoopMs: hostileLoop.durationMs
      });
    });
    logEvent({
      event: 'action.complete',
      action: 'job',
      roomRow: row,
      roomCol: col,
      durationMs: elapsedMs(actionStart),
      roomUseMs: roomUseResult.durationMs,
      parseFormMs: bodyResult.durationMs,
      gameActionMs: action.durationMs
    });
    return actionResponse(c, row, col, { action: 'job', result });
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
    const worldPulseMatch = url.pathname.match(/^\/world-pulse\/(\d+)\/(\d+)$/);
    if (worldPulseMatch && request.method === 'POST') {
      const row = Number.parseInt(worldPulseMatch[1], 10);
      const col = Number.parseInt(worldPulseMatch[2], 10);
      let payload = { type: 'world-pulse' };
      try {
        payload = await request.json();
      } catch {
        payload = { type: 'world-pulse' };
      }
      await this.broadcast({ room: { row, col }, ...payload });
      if (await roomHasActiveHostiles(this.env.DB, row, col)) {
        await this.ctx.storage.put('hostileRoom', { row, col });
        await this.ctx.storage.setAlarm(Date.now() + 5000);
      }
      return new Response('ok');
    }

    const hostileMatch = url.pathname.match(/^\/hostiles\/(\d+)\/(\d+)\/start$/);
    if (hostileMatch && request.method === 'POST') {
      const row = Number.parseInt(hostileMatch[1], 10);
      const col = Number.parseInt(hostileMatch[2], 10);
      await this.ctx.storage.put('hostileRoom', { row, col });
      // Plan 013f: only arm if no alarm is pending — frequent presence heartbeats must NOT
      // keep resetting (and thus starving) the loop. The alarm handler owns re-arming.
      if (await this.ctx.storage.getAlarm() === null) {
        await this.ctx.storage.setAlarm(Date.now() + 5000);
      }
      return new Response('ok');
    }

    // Plan 013a: let an NPC react to what a player just said. The model (this.env.AI)
    // is reached only here in the DO, never in a route's latency path; runNpcReply is
    // fallback-first, so a missing/slow binding degrades to a canned line.
    const npcReactMatch = url.pathname.match(/^\/npc-react\/(\d+)\/(\d+)$/);
    if (npcReactMatch && request.method === 'POST') {
      const row = Number.parseInt(npcReactMatch[1], 10);
      const col = Number.parseInt(npcReactMatch[2], 10);
      try {
        const result = await runNpcReply(this.env.DB, this.env.AI, row, col);
        if (result.spoke) {
          await this.broadcast({ type: 'message', room: { row, col }, username: result.npc });
        }
        // Plan 013c: hostile speech can flip the room's NPCs — wake the combat loop so
        // they actually come for the player.
        if (result.provoked > 0) {
          await this.ctx.storage.put('hostileRoom', { row, col });
          await this.ctx.storage.setAlarm(Date.now() + 5000);
        }
      } catch (err) {
        console.error('npc-react failed', err);
      }
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

    // Plan 013f: one loop drives both combat and ambient life. If the room is in combat,
    // run the hostile action (5s cadence). Otherwise a present-but-peaceful social room
    // gets a throttled NPC murmur (slower cadence; runNpcAmbient owns the real throttle).
    let peaceful = true;
    if (await roomHasActiveHostiles(this.env.DB, room.row, room.col)) {
      peaceful = false;
      const result = await runHostileRoomAction(this.env.DB, room.row, room.col);
      await this.broadcast({ type: 'hostile', room, result });
    } else {
      try {
        const ambient = await runNpcAmbient(this.env.DB, this.env.AI, room.row, room.col);
        if (ambient.spoke) {
          await this.broadcast({ type: 'message', room, username: ambient.npc });
        }
      } catch (err) {
        console.error('npc-ambient failed', err);
      }
    }

    if (await roomNeedsLoop(this.env.DB, room.row, room.col)) {
      await this.ctx.storage.setAlarm(Date.now() + (peaceful ? 12000 : 5000));
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
    const pulse = runScheduledWorldPulseAndWakeRooms(env);
    if (ctx && typeof ctx.waitUntil === 'function') {
      ctx.waitUntil(pulse);
      return;
    }
    await pulse;
  }
};
