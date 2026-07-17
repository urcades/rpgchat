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
  getLeaderboard,
  getMessages,
  getActiveWorldEvents,
  getRoomAccessState,
  getRoomEcology,
  getProgressionGrid,
  getRoomState,
  getUserState,
  normalizeJob,
  respecProgression,
  unlockProgressionNode,
  payInnAccess,
  requireRoomUse,
  ensureSocialPopulation,
  updatePresence,
  validateMovement,
  validateRoomCoordinates,
  validateStartingAllocation
} from './game.mjs';
import { performRoomAction, runActionTail } from './actions.mjs';
import {
  broadcastRoom,
  npcReactInRoom,
  roomName,
  runScheduledWorldPulseAndWakeRooms,
  startHostileLoopIfNeeded
} from './roomBus.mjs';
// Re-export so the wrangler DO class binding (resolved by name from the entry
// module) and existing tests (`mod.RoomObject`) keep working unchanged.
export { RoomObject } from './roomObject.mjs';
import {
  createResurrectionCheckout,
  fulfillResurrectionCheckout
} from './resurrection.mjs';
import { verifyStripeWebhook } from './stripe.mjs';
import { canonicalLocalRequestUrl } from './localHost.mjs';
import { wantsHtmlResponse, wantsJsonResponse } from './http.mjs';
import { elapsedMs, errorFields, guard, logEvent, measureAsync, nowMs } from './observability.mjs';
import { isReservedUsername, isValidUsername, shouldFulfillResurrection } from './validation.mjs';

// `app` is exported so the Hono routes + middleware can be driven end-to-end under
// `node --test` (with `cloudflare:workers` stubbed via module.registerHooks — see
// test/errorBoundaries.test.js / test/routeAuthGate.test.js). Exporting the same
// singleton the default `fetch` delegates to keeps the deploy entrypoint byte-identical:
// nothing about route registration, middleware order, or wiring changes.
export const app = new Hono();
const DEFAULT_RESURRECTION_PAYMENT_LINK_URL = 'https://buy.stripe.com/8x23codZs9Tj8dgertbV600';
const NO_STORE = 'no-store';

// adv-012 observability slice: tag each incoming request with a short id so the structured
// log lines emitted on its path can be correlated. Prefer Cloudflare's per-request ray id
// (stable across the edge + visible in the dashboard); fall back to a process-local counter
// when it's absent (local dev / tests). Stored on c.set('requestId', ...) so any handler —
// and the error path in formError — can read it back with requestIdFromContext(c).
let requestCounter = 0;

function mintRequestId(c) {
  const ray = c.req.raw.headers.get('cf-ray');
  if (ray) {
    return ray;
  }
  requestCounter += 1;
  return `req-${requestCounter.toString(36)}`;
}

function requestIdFromContext(c) {
  // c.get throws if the var was never set (e.g. a request that errored before the
  // top-level middleware ran); fall back to null so a log line is never blocked.
  try {
    return c.get('requestId') ?? null;
  } catch {
    return null;
  }
}

app.use('*', async (c, next) => {
  const requestStart = nowMs();
  const requestId = mintRequestId(c);
  c.set('requestId', requestId);
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
        requestId,
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
      // Boundary: a background task throw is caught + logged (with a timestamp via
      // logEvent and a stack via errorFields) and never propagates — runAfterResponse
      // is fire-and-forget, so an unlogged throw here would vanish silently.
      logEvent({
        ...payload,
        event: 'background.error',
        durationMs: elapsedMs(start),
        ...errorFields(err)
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
  // adv-012: correlate every error reply with its request id and emit it as a structured
  // line (5xx also keeps the raw console.error for the full stack in the dashboard). A
  // client never sees the id — it only ties the user-facing failure back to the logs.
  const requestId = requestIdFromContext(c);
  logEvent({
    event: 'request.error',
    requestId,
    method: c.req.method,
    path: new URL(c.req.url).pathname,
    status: statusCode,
    ...errorFields(err)
  });
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

// Read-heavy GETs fetch through a D1 session with unconstrained reads so a
// nearby read replica can serve them once replication is enabled on the
// database; with no replicas (or an adapter without withSession, e.g. the test
// shim) this resolves to the primary exactly as before. Writes and anything
// order-sensitive (auth, room-use gating, actions) stay on env.DB.
function readDb(env) {
  return typeof env.DB.withSession === 'function' ? env.DB.withSession('first-unconstrained') : env.DB;
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
    // adv-016: enforce the username shape BEFORE the reserved check (a clearer error for the
    // common typo) and before any DB lookup. The pattern also closes a stored-XSS seam —
    // markup characters can never enter a username and later render in a transcript.
    if (!isValidUsername(username)) {
      throw new ActionError('Username must be 3-20 characters: letters, numbers, hyphens, or underscores only.');
    }
    if (isReservedUsername(username)) {
      throw new ActionError('That username is reserved. Please choose another.');
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
     ORDER BY cm.diedAt DESC, cm.id DESC
     LIMIT 200`
  );
  return c.json(players);
});

app.get('/leaderboard-data', async c => {
  const players = await getLeaderboard(readDb(c.env));
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
    // adv-015 (Campaign D, shipped 2026-06-17 once STRIPE_RESURRECTION_PAYMENT_LINK_ID was set
    // in prod): FAIL CLOSED. The previous allowlist check was SKIPPED when the link id was
    // unset, so any completed checkout fulfilled a resurrection. shouldFulfillResurrection
    // refuses unless the expected link id is configured AND matches, the payment is 'paid', and
    // (when a price is configured) the amount/currency line up. A refusal is acknowledged
    // (received:true, no grant) so Stripe doesn't retry, and logged with the request id + reason.
    const decision = shouldFulfillResurrection({
      linkId: session.payment_link,
      expectedLinkId: c.env.STRIPE_RESURRECTION_PAYMENT_LINK_ID,
      paymentStatus: session.payment_status,
      amountTotal: session.amount_total,
      expectedAmount: c.env.STRIPE_RESURRECTION_PRICE_AMOUNT != null
        ? Number(c.env.STRIPE_RESURRECTION_PRICE_AMOUNT)
        : undefined,
      currency: session.currency,
      expectedCurrency: c.env.STRIPE_RESURRECTION_CURRENCY
    });
    if (!decision.fulfill) {
      logEvent({
        event: 'stripe.webhook.refused',
        requestId: requestIdFromContext(c),
        reason: decision.reason,
        sessionId: session.id ?? null
      });
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
    return c.json(await getUserState(readDb(c.env), auth.user.username));
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
    return c.json(await getUserState(readDb(c.env), auth.user.username));
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

app.get('/tick', async c => c.json({ tick: await getCurrentTickValue(readDb(c.env)) }));

app.get('/messages/:row/:col', async c => {
  const auth = await currentUserOrResponse(c);
  if (auth instanceof Response) {
    return auth;
  }

  try {
    const { row, col } = parseCoordinates(c);
    const roomUse = await ensureRoomUse(c, auth.user, row, col);
    // ?since=<id>: delta fetch — only messages newer than the client's last
    // rendered id (the socket-driven refresh path). Absent => full window.
    const since = c.req.query('since') || null;
    return c.json(await getMessages(readDb(c.env), row, col, roomUse.tickValue, since));
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
    return c.json(await getRoomEcology(readDb(c.env), auth.user.username, row, col));
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
    return c.json(await getRoomState(readDb(c.env), auth.user.username, row, col, roomUse.tickValue));
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

// adv ARCH-01: all four action routes are ONE factory over the shared
// pipeline in worker/actions.mjs — validate/claim/handle/enrich happen in
// performRoomAction, and the post-turn tail (sweeps -> loop wake -> NPC reply)
// runs in runActionTail with HTTP-flavored hooks (DO pings). The WS path in
// RoomObject.webSocketMessage is the other thin adapter over the same calls.
function makeActionRoute(type) {
  return async c => {
    const auth = await currentUserOrResponse(c);
    if (auth instanceof Response) {
      return auth;
    }
    try {
      const actionStart = nowMs();
      const { row, col } = parseCoordinates(c);
      const roomUseResult = await measureAsync(() => ensureRoomUse(c, auth.user, row, col));
      const bodyResult = await measureAsync(() => parseForm(c));
      const action = await measureAsync(() => performRoomAction(c.env.DB, {
        type,
        user: auth.user,
        row,
        col,
        payload: bodyResult.value,
        roomUse: roomUseResult.value
      }));
      const performed = action.value;
      if (performed.duplicate) {
        // The WS transport already applied this exact action (lost-ack replay).
        return actionResponse(c, row, col, { action: type, duplicate: true });
      }
      runAfterResponse(c, { action: type, roomRow: row, roomCol: col }, async () => {
        const broadcast = await measureAsync(() => broadcastRoom(c.env, row, col, performed.broadcastPayload));
        const tail = await measureAsync(() => runActionTail(c.env.DB, performed, {
          wakeLoop: () => startHostileLoopIfNeeded(c.env, row, col),
          // The DO owns env.AI — the model is never touched in a route's path.
          npcReply: () => npcReactInRoom(c.env, row, col)
        }));
        logEvent({
          event: 'action.background',
          action: type,
          roomRow: row,
          roomCol: col,
          broadcastMs: broadcast.durationMs,
          tailMs: tail.durationMs
        });
      });
      logEvent({
        event: 'action.complete',
        action: type,
        roomRow: row,
        roomCol: col,
        durationMs: elapsedMs(actionStart),
        roomUseMs: roomUseResult.durationMs,
        parseFormMs: bodyResult.durationMs,
        gameActionMs: action.durationMs
      });
      return actionResponse(c, row, col, { action: type, result: performed.result });
    } catch (err) {
      return formError(c, err);
    }
  };
}

for (const type of ['chat', 'attack', 'skill', 'job']) {
  app.post(`/${type}/:row/:col`, makeActionRoute(type));
}


app.get('/ws/:row/:col', async c => {
  const coordinates = validateRoomCoordinates(c.req.param('row'), c.req.param('col'));
  if (!coordinates) {
    return c.text('Invalid room coordinates', 400);
  }
  const stub = c.env.ROOMS.getByName(roomName(coordinates.row, coordinates.col));
  return stub.fetch(c.req.raw);
});

app.notFound(c => c.env.ASSETS.fetch(c.req.raw));

export default {
  fetch(request, env, ctx) {
    return app.fetch(request, env, ctx);
  },
  async scheduled(_event, env, ctx) {
    // Boundary: the cron tick is unobserved, so a throw inside the world pulse would be
    // lost silently (and, under waitUntil, surface only as an unhandled rejection). guard()
    // catches + logs the failure structurally; the (now non-rejecting) tick still settles.
    const start = nowMs();
    const pulse = guard('scheduled.error', async () => {
      await runScheduledWorldPulseAndWakeRooms(env);
      logEvent({ event: 'scheduled.complete', durationMs: elapsedMs(start) });
    });
    if (ctx && typeof ctx.waitUntil === 'function') {
      ctx.waitUntil(pulse);
      return;
    }
    await pulse;
  }
};
