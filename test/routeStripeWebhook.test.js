// adv-008: END-TO-END coverage of POST /stripe/webhook, driven through the REAL Hono `app`.
//
// stripe.test.js unit-tests verifyStripeWebhook (the signature math). This file drives the
// whole ROUTE: signature verify -> event-type guard -> payment-link guard -> payment-status
// guard -> fulfillResurrectionCheckout. It proves the route grants a resurrection exactly
// once for a valid completed-checkout event, and grants NOTHING for the wrong event type,
// an unpaid session, or a mismatched payment link.
//
// As with routeAuthGate, worker/index.mjs is made importable under node by stubbing
// `cloudflare:workers` (the errorBoundaries pattern). Signatures are recomputed in-test with
// the same `${timestamp}.${payload}` HMAC-SHA256 construction the verifier uses, so the test
// pins the wire format rather than an internal helper.

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

const WEBHOOK_SECRET = 'whsec_route_test_secret';

// Recompute a Stripe v1 signature independently of the module under test.
async function hmacSha256Hex(secret, signedPayload) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signedPayload));
  return Array.from(new Uint8Array(mac)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function signedHeader(payload, secret = WEBHOOK_SECRET) {
  const ts = Math.floor(Date.now() / 1000);
  return `t=${ts},v1=${await hmacSha256Hex(secret, `${ts}.${payload}`)}`;
}

// Silence the per-request structured log line AND the route's console.error on the
// intentional malformed-payload boundary, so the test output stays clean. The behavior
// (400 + caught throw) is asserted directly; the console noise is incidental.
async function quietFetch(app, req, env) {
  const originalLog = console.log;
  const originalError = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    return await app.fetch(req, env);
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

// POST a webhook body with a (by default valid) signature for that exact body.
async function postWebhook(app, env, eventObject, { secretForSig } = {}) {
  const payload = JSON.stringify(eventObject);
  const sig = await signedHeader(payload, secretForSig || WEBHOOK_SECRET);
  const req = new Request('http://127.0.0.1/stripe/webhook', {
    method: 'POST',
    headers: { 'stripe-signature': sig, 'Content-Type': 'application/json' },
    body: payload
  });
  return quietFetch(app, req, env);
}

function envFor(db, extra = {}) {
  return { DB: db, STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET, ...extra };
}

// Seed a dead player with a grave + an intact corpse, then mint a pending resurrection
// request exactly as /resurrection-link does. Returns the request token to drop into the
// webhook's client_reference_id.
async function seedPendingResurrection(db, username) {
  const { createResurrectionCheckout } = await import('../worker/resurrection.mjs');
  await db.prepare(
    `INSERT INTO cemetery (username, password, job, level, gold, cause, roomRow, roomCol, diedAt)
     VALUES (?, 'pw', 'Knight', 5, 42, 'slain', 2, 3, CURRENT_TIMESTAMP)`
  ).bind(username).run();
  // The corpse is the resurrection anchor; without it the checkout reports "severed".
  await db.prepare(
    `INSERT INTO items (templateId, name, slotType, ownerUsername, roomRow, roomCol, corpseOf)
     VALUES ('corpse', 'Corpse', 'trinket', NULL, 2, 3, ?)`
  ).bind(username).run();
  const checkout = await createResurrectionCheckout(db, username, 'https://buy.stripe.com/test');
  assert.ok(checkout && checkout.token, 'seed produced a pending resurrection request');
  return checkout.token;
}

async function liveUserExists(db, username) {
  const row = await db.prepare('SELECT username FROM users WHERE username = ?').bind(username).first();
  return Boolean(row);
}

async function requestStatus(db, token) {
  const row = await db.prepare('SELECT status FROM resurrectionRequests WHERE token = ?').bind(token).first();
  return row ? row.status : null;
}

// ---------------------------------------------------------------------------
// Signature gate
// ---------------------------------------------------------------------------

test('stripe route: a forged signature is rejected with 400 (no grant)', async () => {
  const mod = await import('../worker/index.mjs');
  const db = await createMigratedDb();
  try {
    const token = await seedPendingResurrection(db, 'ghost');
    // Sign with an attacker secret; verify against the real one => verifyStripeWebhook false.
    const res = await postWebhook(mod.app, envFor(db), {
      type: 'checkout.session.completed',
      data: { object: { client_reference_id: token, payment_status: 'paid' } }
    }, { secretForSig: 'whsec_attacker' });
    assert.equal(res.status, 400, 'a bad signature is refused before any fulfillment');
    assert.equal(await res.text(), 'Invalid Stripe signature');
    assert.equal(await liveUserExists(db, 'ghost'), false, 'no resurrection on a forged webhook');
    assert.equal(await requestStatus(db, token), 'pending', 'request left pending');
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// Event-type guard: wrong type -> acknowledged, no grant
// ---------------------------------------------------------------------------

test('stripe route: a non-checkout.session.completed event is acked but grants nothing', async () => {
  const mod = await import('../worker/index.mjs');
  const db = await createMigratedDb();
  try {
    const token = await seedPendingResurrection(db, 'ghost');
    const res = await postWebhook(mod.app, envFor(db), {
      type: 'payment_intent.succeeded',
      data: { object: { client_reference_id: token, payment_status: 'paid' } }
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { received: true }, 'acknowledged, not fulfilled');
    assert.equal(await liveUserExists(db, 'ghost'), false, 'wrong event type => no grant');
    assert.equal(await requestStatus(db, token), 'pending');
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// Payment-status guard: unpaid -> ignored, no grant
// ---------------------------------------------------------------------------

test('stripe route: an UNPAID completed checkout is ignored (no grant)', async () => {
  const mod = await import('../worker/index.mjs');
  const db = await createMigratedDb();
  try {
    const token = await seedPendingResurrection(db, 'ghost');
    const res = await postWebhook(mod.app, envFor(db), {
      type: 'checkout.session.completed',
      data: { object: { client_reference_id: token, payment_status: 'unpaid' } }
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { received: true, ignored: true });
    assert.equal(await liveUserExists(db, 'ghost'), false, 'unpaid => no resurrection');
    assert.equal(await requestStatus(db, token), 'pending', 'request untouched');
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// Payment-link guard: mismatched link -> ignored, no grant
// ---------------------------------------------------------------------------

test('stripe route: a MISMATCHED payment_link is ignored when the link id is configured', async () => {
  const mod = await import('../worker/index.mjs');
  const db = await createMigratedDb();
  try {
    const token = await seedPendingResurrection(db, 'ghost');
    // The env pins the expected payment link; the event carries a different one.
    const env = envFor(db, { STRIPE_RESURRECTION_PAYMENT_LINK_ID: 'plink_expected' });
    const res = await postWebhook(mod.app, env, {
      type: 'checkout.session.completed',
      data: { object: { client_reference_id: token, payment_status: 'paid', payment_link: 'plink_other' } }
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { received: true, ignored: true });
    assert.equal(await liveUserExists(db, 'ghost'), false, 'mismatched link => no grant');
    assert.equal(await requestStatus(db, token), 'pending');
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// Fail-closed (adv-015): an UNSET expected link id refuses (was fail-OPEN — granted any)
// ---------------------------------------------------------------------------

test('stripe route: a paid completed checkout is REFUSED when no link id is configured (fail-closed)', async () => {
  const mod = await import('../worker/index.mjs');
  const db = await createMigratedDb();
  try {
    const token = await seedPendingResurrection(db, 'ghost');
    // No STRIPE_RESURRECTION_PAYMENT_LINK_ID in env — a paid checkout the old fail-OPEN code
    // would have granted must now be refused (received, but ignored, no grant).
    const res = await postWebhook(mod.app, envFor(db), {
      type: 'checkout.session.completed',
      data: { object: { id: 'cs_x', client_reference_id: token, payment_status: 'paid', payment_link: 'plink_anything' } }
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { received: true, ignored: true });
    assert.equal(await liveUserExists(db, 'ghost'), false, 'fail-closed: no link id => no grant');
    assert.equal(await requestStatus(db, token), 'pending', 'request untouched');
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// Happy path: valid paid completed checkout -> grants exactly once
// ---------------------------------------------------------------------------

test('stripe route: a valid paid completed checkout grants the resurrection ONCE', async () => {
  const mod = await import('../worker/index.mjs');
  const db = await createMigratedDb();
  try {
    const token = await seedPendingResurrection(db, 'ghost');
    const env = envFor(db, { STRIPE_RESURRECTION_PAYMENT_LINK_ID: 'plink_expected' });
    const event = {
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_test_123',
          client_reference_id: token,
          payment_status: 'paid',
          payment_link: 'plink_expected'
        }
      }
    };

    const first = await postWebhook(mod.app, env, event);
    assert.equal(first.status, 200);
    const firstBody = await first.json();
    assert.equal(firstBody.received, true);
    assert.equal(firstBody.resurrection.revived, true, 'the player was resurrected');
    assert.equal(firstBody.resurrection.username, 'ghost');
    assert.equal(await liveUserExists(db, 'ghost'), true, 'a live users row now exists');
    assert.equal(await requestStatus(db, token), 'completed', 'request marked completed');

    // Stripe retries webhooks. A replay of the SAME event must be idempotent — the claim-
    // first UPDATE in fulfillResurrectionCheckout means the second pass grants nothing.
    const replay = await postWebhook(mod.app, env, event);
    assert.equal(replay.status, 200);
    const replayBody = await replay.json();
    assert.equal(replayBody.resurrection.revived, false, 'replay does not revive again');
    assert.equal(replayBody.resurrection.reason, 'already_completed');
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// Malformed payload -> 400 (boundary), no crash
// ---------------------------------------------------------------------------

test('stripe route: a non-JSON body with a valid signature is refused 400, not crashed', async () => {
  const mod = await import('../worker/index.mjs');
  const db = await createMigratedDb();
  try {
    const payload = 'this is not json';
    const sig = await signedHeader(payload);
    const req = new Request('http://127.0.0.1/stripe/webhook', {
      method: 'POST',
      headers: { 'stripe-signature': sig, 'Content-Type': 'application/json' },
      body: payload
    });
    const res = await quietFetch(mod.app, req, envFor(db));
    assert.equal(res.status, 400, 'a JSON.parse failure is caught and returned as 400');
    assert.equal(await res.text(), 'Invalid Stripe webhook payload');
  } finally {
    await db.close();
  }
});
