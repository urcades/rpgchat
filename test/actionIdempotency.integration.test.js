// adv DUR-01 — server-side action idempotency across transports.
//
// The client re-sends any un-acked WS action over HTTP when the socket dies,
// but the server commits BEFORE sending the ack: a blip in that window used to
// replay the action (duplicate chat line, double stamina spend, a second
// resolved attack). Each action now carries a client token; the first
// transport to claim it wins, the replay is acked as duplicate and applies
// nothing. Tokenless actions (smoke scripts, old clients) are untouched.
//
// Uses the adv-008 harness: `cloudflare:workers` stubbed, the REAL Hono app
// and RoomObject driven directly against a migrated in-memory D1.

const assert = require('node:assert/strict');
const test = require('node:test');
const { registerHooks } = require('node:module');
const { createMigratedDb } = require('./.helpers/d1');
const { getWorldDay, generateRoomFeatures } = require('../utils/roomEcology');

const CF_STUB_URL = 'cfstub:workers';
const CF_STUB_SOURCE =
  'export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }';

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'cloudflare:workers') {
      return { url: CF_STUB_URL, shortCircuit: true };
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url === CF_STUB_URL) {
      return { format: 'module', shortCircuit: true, source: CF_STUB_SOURCE };
    }
    return next(url, context);
  }
});

const SECRET = 'idempotency-secret';
const execCtx = { waitUntil() {}, passThroughOnException() {} };

function findCalmRoom(worldDay) {
  const hazardous = ['poison_marsh', 'moon_room', 'echo_chamber', 'pub', 'inn', 'sun_room', 'cold_room', 'guild'];
  for (let row = 1; row <= 16; row += 1) {
    for (let col = 1; col <= 16; col += 1) {
      const types = generateRoomFeatures(row, col, worldDay).map(f => f.effect?.type);
      if (!types.some(t => hazardous.includes(t))) {
        return { row, col };
      }
    }
  }
  throw new Error('No calm room for ' + worldDay);
}

async function seedLiveUser(db, username) {
  await db.prepare(
    `INSERT INTO users
      (username, password, job, health, maxHealth, stamina, maxStamina, speed, strength, intelligence, level, gold)
     VALUES (?, 'pw', 'Novice', 30, 30, 100, 100, 1, 1, 1, 0, 0)`
  ).bind(username).run();
}

// A ROOMS stub whose DO fetches are inert (the routes' post-action tail pings
// the DO; none of that matters to the idempotency assertions).
function envFor(db) {
  return {
    DB: db,
    SESSION_SECRET: SECRET,
    ROOMS: {
      idFromName() { return 'id'; },
      get() { return { fetch: async () => new Response('ok'), broadcast: async () => {} }; },
      getByName() { return { fetch: async () => new Response('ok'), broadcast: async () => {} }; }
    },
    ASSETS: { fetch: async () => new Response('asset', { status: 200 }) }
  };
}

async function sessionCookie(env, claims) {
  const { createSession } = await import('../worker/auth.mjs');
  const session = await createSession(env, claims);
  return session.cookie.split(';', 1)[0];
}

async function quiet(fn) {
  const originalLog = console.log;
  const originalError = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

function postForm(path, cookie, body) {
  return new Request(`http://127.0.0.1${path}`, {
    method: 'POST',
    headers: {
      Cookie: cookie,
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body
  });
}

// ---------------------------------------------------------------------------
// HTTP replay: the same actionToken applies once; the replay is a visible no-op.
// ---------------------------------------------------------------------------

test('DUR-01: an HTTP /chat replay with the same actionToken applies exactly once', async () => {
  const db = await createMigratedDb();
  const mod = await import('../worker/index.mjs');
  const { updatePresence } = await import('../worker/game.mjs');
  try {
    const env = envFor(db);
    const calm = findCalmRoom(getWorldDay());
    await seedLiveUser(db, 'replayer');
    await updatePresence(db, 'replayer', calm.row, calm.col);
    const cookie = await sessionCookie(env, { username: 'replayer' });

    const body = 'message=hello%20once&actionToken=nonce%3A1';
    const first = await quiet(() => mod.app.fetch(postForm(`/chat/${calm.row}/${calm.col}`, cookie, body), env, execCtx));
    assert.equal(first.status, 200);
    assert.equal((await first.json()).ok, true);

    const replay = await quiet(() => mod.app.fetch(postForm(`/chat/${calm.row}/${calm.col}`, cookie, body), env, execCtx));
    assert.equal(replay.status, 200);
    const replayJson = await replay.json();
    assert.equal(replayJson.duplicate, true, 'the replay is flagged duplicate');

    const count = await db.prepare(
      "SELECT COUNT(*) AS c FROM messages WHERE username = 'replayer' AND message = 'hello once'"
    ).first();
    assert.equal(count.c, 1, 'the line landed exactly once');
    const stamina = (await db.prepare("SELECT stamina FROM users WHERE username = 'replayer'").first()).stamina;
    assert.equal(stamina, 99, 'stamina spent once, not twice');
  } finally {
    await db.close();
  }
});

test('DUR-01: tokenless actions behave exactly as before (no claim, both apply)', async () => {
  const db = await createMigratedDb();
  const mod = await import('../worker/index.mjs');
  const { updatePresence } = await import('../worker/game.mjs');
  try {
    const env = envFor(db);
    const calm = findCalmRoom(getWorldDay());
    await seedLiveUser(db, 'legacy');
    await updatePresence(db, 'legacy', calm.row, calm.col);
    const cookie = await sessionCookie(env, { username: 'legacy' });

    for (let i = 0; i < 2; i += 1) {
      const res = await quiet(() => mod.app.fetch(
        postForm(`/chat/${calm.row}/${calm.col}`, cookie, 'message=same%20line'), env, execCtx));
      assert.equal((await res.json()).ok, true);
    }
    const count = await db.prepare(
      "SELECT COUNT(*) AS c FROM messages WHERE username = 'legacy' AND message = 'same line'"
    ).first();
    assert.equal(count.c, 2, 'two tokenless sends are two real actions');
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// Cross-transport: WS applies, then the HTTP fallback replays the same token.
// This is the exact lost-ack window the fix exists for.
// ---------------------------------------------------------------------------

test('DUR-01: WS applies the action, the HTTP fallback replay of the same token is a no-op', async () => {
  const db = await createMigratedDb();
  const mod = await import('../worker/index.mjs');
  const { updatePresence } = await import('../worker/game.mjs');
  try {
    const env = envFor(db);
    const calm = findCalmRoom(getWorldDay());
    await seedLiveUser(db, 'wsfaller');
    await updatePresence(db, 'wsfaller', calm.row, calm.col);
    const cookie = await sessionCookie(env, { username: 'wsfaller' });

    // Drive the REAL webSocketMessage with a mocked socket + storage.
    const storage = {
      async get() { return undefined; },
      async put() {},
      async setAlarm() {},
      async getAlarm() { return null; },
      async delete() {}
    };
    const room = new mod.RoomObject({ storage }, { DB: db, AI: {} });
    room.broadcast = async () => {};
    const sent = [];
    const ws = {
      send(payload) { sent.push(JSON.parse(payload)); },
      deserializeAttachment() {
        return { username: 'wsfaller', row: calm.row, col: calm.col };
      }
    };

    await quiet(() => room.webSocketMessage(ws, JSON.stringify({
      type: 'chat', message: 'over the wire', token: 'tok:42', seq: 7
    })));
    const ack = sent.find(f => f.type === 'ack');
    assert.ok(ack, 'the WS action was acked');
    assert.notEqual(ack.duplicate, true, 'first application is not a duplicate');

    // The socket "dies" before the client saw the ack; the fallback re-posts.
    const replay = await quiet(() => mod.app.fetch(postForm(
      `/chat/${calm.row}/${calm.col}`, cookie,
      'message=over%20the%20wire&actionToken=tok%3A42'
    ), env, execCtx));
    assert.equal((await replay.json()).duplicate, true, 'the HTTP replay is refused');

    const count = await db.prepare(
      "SELECT COUNT(*) AS c FROM messages WHERE username = 'wsfaller' AND message = 'over the wire'"
    ).first();
    assert.equal(count.c, 1, 'one line total across both transports');
    const stamina = (await db.prepare("SELECT stamina FROM users WHERE username = 'wsfaller'").first()).stamina;
    assert.equal(stamina, 99, 'stamina spent exactly once');

    // And a WS retry of the same token is likewise acked-as-duplicate.
    sent.length = 0;
    await quiet(() => room.webSocketMessage(ws, JSON.stringify({
      type: 'chat', message: 'over the wire', token: 'tok:42', seq: 8
    })));
    const dupAck = sent.find(f => f.type === 'ack');
    assert.equal(dupAck.duplicate, true, 'WS retry acked as duplicate');
    const countAfter = await db.prepare(
      "SELECT COUNT(*) AS c FROM messages WHERE username = 'wsfaller' AND message = 'over the wire'"
    ).first();
    assert.equal(countAfter.c, 1, 'still one line');
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// Race: two concurrent submissions of one token — exactly one claim wins.
// ---------------------------------------------------------------------------

test('DUR-01: concurrent same-token submissions apply exactly once (claim race)', async () => {
  const db = await createMigratedDb();
  const { claimActionToken } = await import('../worker/game.mjs');
  try {
    const results = await Promise.all([
      claimActionToken(db, 'racer', 'tok:9'),
      claimActionToken(db, 'racer', 'tok:9')
    ]);
    assert.deepEqual(results.filter(Boolean).length, 1, 'exactly one claim wins');
    // Different user, same token string: independent claim.
    assert.equal(await claimActionToken(db, 'other', 'tok:9'), true, 'claims are per-user');
    // Blank/absent tokens never claim (legacy path).
    assert.equal(await claimActionToken(db, 'racer', ''), true);
    assert.equal(await claimActionToken(db, 'racer', null), true);
  } finally {
    await db.close();
  }
});
