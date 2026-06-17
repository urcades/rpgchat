// adv-008: END-TO-END coverage of the auth gate, driven through the REAL Hono `app`.
//
// The gate (currentUserOrResponse -> requireLiveUser) sits in front of every mutating /
// protected route. Until now it could only be smoke-tested live, because worker/index.mjs
// imports `cloudflare:workers` at the top, which bare `node --test` can't resolve. We reuse
// the errorBoundaries pattern: register an in-thread module hook that stubs
// `cloudflare:workers` with a no-op DurableObject base, then import the real index.mjs and
// drive `app.fetch(request, env, ctx)` exactly as the deployed `default.fetch` does.
//
// Representative protected route: GET /success (gate -> protectedAsset). We assert the three
// gate outcomes — no cookie -> 401, dead session -> 410 + /you-died, live -> pass-through to
// the asset — for both the JSON and HTML negotiations the gate branches on.

const assert = require('node:assert/strict');
const test = require('node:test');
const { registerHooks } = require('node:module');
const { createMigratedDb } = require('./.helpers/d1');

// --- Stub `cloudflare:workers` so worker/index.mjs is importable under node. ---
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

const SECRET = 'route-gate-secret';
// A sentinel the ASSETS stub returns so a "gate passed" can be told apart from any
// gate-produced response (401/410/redirect) without serving a real static file.
const ASSET_SENTINEL = 'ASSET-SERVED';

// env shaped like the Worker's: a real migrated D1 + an ASSETS binding that just echoes a
// sentinel. ROOMS/AI aren't touched by /success, so they're inert here.
function envFor(db) {
  return {
    DB: db,
    SESSION_SECRET: SECRET,
    ASSETS: {
      fetch() {
        return new Response(ASSET_SENTINEL, { status: 200, headers: { 'Content-Type': 'text/html' } });
      }
    }
  };
}

// The top-level middleware emits a structured `request.complete` log on every request.
// Silence console.log for the duration of a fetch so the test output stays clean (the
// log content itself is covered by errorBoundaries.test.js).
async function quietFetch(app, req, env) {
  const originalLog = console.log;
  console.log = () => {};
  try {
    return await app.fetch(req, env);
  } finally {
    console.log = originalLog;
  }
}

// Build a request to a route. host is 127.0.0.1 (NOT localhost) so the canonical-host
// middleware doesn't 307-redirect before the route runs. `accept` selects the gate's
// JSON vs HTML branch.
function request(path, { cookie, accept } = {}) {
  const headers = {};
  if (cookie) headers.Cookie = cookie;
  if (accept) headers.Accept = accept;
  return new Request(`http://127.0.0.1${path}`, { method: 'GET', headers });
}

// Mint a signed session cookie for a username/deadUsername the same way /login does.
async function sessionCookie(env, claims) {
  const { createSession } = await import('../worker/auth.mjs');
  const session = await createSession(env, claims);
  // createSession returns a full Set-Cookie; the request only needs the name=value token.
  return session.cookie.split(';', 1)[0];
}

async function seedLiveUser(db, username) {
  await db.prepare(
    `INSERT INTO users
      (username, password, job, health, maxHealth, stamina, maxStamina, speed, strength, intelligence)
     VALUES (?, 'pw', 'Novice', 30, 30, 100, 100, 1, 1, 1)`
  ).bind(username).run();
}

async function seedGrave(db, username) {
  await db.prepare(
    `INSERT INTO cemetery (username, password, job, level, gold, cause, roomRow, roomCol, diedAt)
     VALUES (?, 'pw', 'Novice', 3, 10, 'slain', 1, 1, CURRENT_TIMESTAMP)`
  ).bind(username).run();
}

// ---------------------------------------------------------------------------
// No cookie -> 401 (login required)
// ---------------------------------------------------------------------------

test('auth gate: no cookie on a protected route -> 401 JSON (login required)', async () => {
  const mod = await import('../worker/index.mjs');
  const db = await createMigratedDb();
  try {
    const res = await quietFetch(mod.app, request('/success', { accept: 'application/json' }), envFor(db));
    assert.equal(res.status, 401, 'no session => 401');
    const body = await res.json();
    assert.equal(body.error, 'Login required');
  } finally {
    await db.close();
  }
});

test('auth gate: no cookie + HTML request -> 302 redirect to /', async () => {
  const mod = await import('../worker/index.mjs');
  const db = await createMigratedDb();
  try {
    const res = await quietFetch(mod.app, request('/success', { accept: 'text/html' }), envFor(db));
    assert.equal(res.status, 302, 'HTML browser nav => redirect, not a JSON 401');
    assert.equal(res.headers.get('location'), '/', 'sent back to the login page');
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// Dead session -> 410 + /you-died
// ---------------------------------------------------------------------------

test('auth gate: dead session + JSON request -> 410 with a /you-died redirect', async () => {
  const mod = await import('../worker/index.mjs');
  const db = await createMigratedDb();
  try {
    const env = envFor(db);
    const cookie = await sessionCookie(env, { deadUsername: 'ghost' });
    const res = await quietFetch(mod.app, request('/success', { cookie, accept: 'application/json' }), env);
    assert.equal(res.status, 410, 'a dead character is Gone');
    const body = await res.json();
    assert.equal(body.error, 'You died');
    assert.equal(body.redirect, '/you-died', 'the client is told where to go');
  } finally {
    await db.close();
  }
});

test('auth gate: dead session + HTML request -> 302 redirect to /you-died', async () => {
  const mod = await import('../worker/index.mjs');
  const db = await createMigratedDb();
  try {
    const env = envFor(db);
    const cookie = await sessionCookie(env, { deadUsername: 'ghost' });
    const res = await quietFetch(mod.app, request('/success', { cookie, accept: 'text/html' }), env);
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/you-died', 'browser nav is redirected to the death screen');
  } finally {
    await db.close();
  }
});

test('auth gate: a live session whose user later DIED is flipped to dead (410)', async () => {
  // requireLiveUser's escalation: a session still marked `username` whose character now has
  // a grave is transitioned to a dead session and refused. Exercised end-to-end here.
  const mod = await import('../worker/index.mjs');
  const db = await createMigratedDb();
  try {
    const env = envFor(db);
    const cookie = await sessionCookie(env, { username: 'fallen' });
    await seedGrave(db, 'fallen'); // a grave but NO live users row
    const res = await quietFetch(mod.app, request('/success', { cookie, accept: 'application/json' }), env);
    assert.equal(res.status, 410, 'a live session for a now-dead user is escalated to Gone');
    const body = await res.json();
    assert.equal(body.redirect, '/you-died');
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// Live -> pass (reaches the protected asset)
// ---------------------------------------------------------------------------

test('auth gate: a live session passes the gate and reaches the protected asset', async () => {
  const mod = await import('../worker/index.mjs');
  const db = await createMigratedDb();
  try {
    const env = envFor(db);
    await seedLiveUser(db, 'alive');
    const cookie = await sessionCookie(env, { username: 'alive' });
    const res = await quietFetch(mod.app, request('/success', { cookie, accept: 'text/html' }), env);
    assert.equal(res.status, 200, 'the gate let the live user through');
    assert.equal(await res.text(), ASSET_SENTINEL, 'the protected asset was served');
    // protectedAsset always marks the protected page no-store.
    assert.equal(res.headers.get('Cache-Control'), 'no-store', 'protected page is not cached');
  } finally {
    await db.close();
  }
});
