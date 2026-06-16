const test = require('node:test');
const assert = require('node:assert/strict');

// Pure unit tests for the Stripe webhook signature verifier — NO database, NO network.
// Expected signatures are recomputed in-test with the same HMAC-SHA256 construction the
// verifier uses (`${timestamp}.${payload}`), so the tests pin the wire format, not an
// internal helper. The signing secret here is a dummy literal; the real secret only ever
// lives in the STRIPE_WEBHOOK_SECRET env var and is never hardcoded.
const DUMMY_SECRET = 'whsec_dummy_test_secret_value';

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
  return Array.from(new Uint8Array(mac))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

// Build a `Stripe-Signature` header for a payload at a given timestamp, signing with the
// SAME `${timestamp}.${payload}` construction the verifier expects.
async function signHeader(payload, timestamp, secret = DUMMY_SECRET) {
  const sig = await hmacSha256Hex(secret, `${timestamp}.${payload}`);
  return `t=${timestamp},v1=${sig}`;
}

test('parseStripeSignature pulls the timestamp and all v1 signatures', async () => {
  const { parseStripeSignature } = await import('../worker/stripe.mjs');
  const parsed = parseStripeSignature('t=1700000000,v1=aaa,v1=bbb,v0=ccc');
  assert.equal(parsed.timestamp, '1700000000');
  assert.deepEqual(parsed.signatures, ['aaa', 'bbb']);
});

test('valid signature within tolerance passes', async () => {
  const { verifyStripeWebhook } = await import('../worker/stripe.mjs');
  const payload = JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed' });
  const header = await signHeader(payload, nowSeconds());
  assert.equal(await verifyStripeWebhook(payload, header, DUMMY_SECRET), true);
});

test('tampered body fails (signature no longer matches)', async () => {
  const { verifyStripeWebhook } = await import('../worker/stripe.mjs');
  const original = JSON.stringify({ id: 'evt_1', amount: 100 });
  const header = await signHeader(original, nowSeconds());
  const tampered = JSON.stringify({ id: 'evt_1', amount: 999999 });
  assert.equal(await verifyStripeWebhook(tampered, header, DUMMY_SECRET), false);
});

test('wrong secret fails (forged signature)', async () => {
  const { verifyStripeWebhook } = await import('../worker/stripe.mjs');
  const payload = JSON.stringify({ id: 'evt_1' });
  // Sign with an attacker-controlled secret, verify against the real one.
  const header = await signHeader(payload, nowSeconds(), 'whsec_attacker_secret');
  assert.equal(await verifyStripeWebhook(payload, header, DUMMY_SECRET), false);
});

test('missing v1 scheme fails (only v0 present)', async () => {
  const { verifyStripeWebhook } = await import('../worker/stripe.mjs');
  const payload = JSON.stringify({ id: 'evt_1' });
  const ts = nowSeconds();
  const v0 = await hmacSha256Hex(DUMMY_SECRET, `${ts}.${payload}`);
  // Same digest, but advertised under the legacy v0 scheme the verifier ignores.
  const header = `t=${ts},v0=${v0}`;
  assert.equal(await verifyStripeWebhook(payload, header, DUMMY_SECRET), false);
});

test('absent signature header fails', async () => {
  const { verifyStripeWebhook } = await import('../worker/stripe.mjs');
  const payload = JSON.stringify({ id: 'evt_1' });
  assert.equal(await verifyStripeWebhook(payload, '', DUMMY_SECRET), false);
});

test('header missing the timestamp fails', async () => {
  const { verifyStripeWebhook } = await import('../worker/stripe.mjs');
  const payload = JSON.stringify({ id: 'evt_1' });
  const sig = await hmacSha256Hex(DUMMY_SECRET, `${nowSeconds()}.${payload}`);
  assert.equal(await verifyStripeWebhook(payload, `v1=${sig}`, DUMMY_SECRET), false);
});

test('timestamp just inside the 300s tolerance passes', async () => {
  const { verifyStripeWebhook } = await import('../worker/stripe.mjs');
  const payload = JSON.stringify({ id: 'evt_1' });
  const ts = nowSeconds() - 299; // within the 300s window
  const header = await signHeader(payload, ts);
  assert.equal(await verifyStripeWebhook(payload, header, DUMMY_SECRET), true);
});

test('timestamp beyond the 300s tolerance fails (replay defense)', async () => {
  const { verifyStripeWebhook } = await import('../worker/stripe.mjs');
  const payload = JSON.stringify({ id: 'evt_1' });
  const ts = nowSeconds() - 301; // just outside the 300s window
  // Signature is otherwise valid for this old timestamp; only the age rejects it.
  const header = await signHeader(payload, ts);
  assert.equal(await verifyStripeWebhook(payload, header, DUMMY_SECRET), false);
});

test('non-numeric timestamp fails', async () => {
  const { verifyStripeWebhook } = await import('../worker/stripe.mjs');
  const payload = JSON.stringify({ id: 'evt_1' });
  const sig = await hmacSha256Hex(DUMMY_SECRET, `not-a-number.${payload}`);
  assert.equal(await verifyStripeWebhook(payload, `t=not-a-number,v1=${sig}`, DUMMY_SECRET), false);
});

test('multiple v1 signatures with one match passes (secret rotation)', async () => {
  const { verifyStripeWebhook } = await import('../worker/stripe.mjs');
  const payload = JSON.stringify({ id: 'evt_1' });
  const ts = nowSeconds();
  const good = await hmacSha256Hex(DUMMY_SECRET, `${ts}.${payload}`);
  const bogus = 'deadbeef'.repeat(8);
  // Order shouldn't matter: a bogus signature first, the valid one second.
  const header = `t=${ts},v1=${bogus},v1=${good}`;
  assert.equal(await verifyStripeWebhook(payload, header, DUMMY_SECRET), true);
});

test('multiple v1 signatures with none matching fails', async () => {
  const { verifyStripeWebhook } = await import('../worker/stripe.mjs');
  const payload = JSON.stringify({ id: 'evt_1' });
  const ts = nowSeconds();
  const header = `t=${ts},v1=${'aa'.repeat(32)},v1=${'bb'.repeat(32)}`;
  assert.equal(await verifyStripeWebhook(payload, header, DUMMY_SECRET), false);
});

test('missing secret throws ActionError with status 500', async () => {
  const { verifyStripeWebhook } = await import('../worker/stripe.mjs');
  const { ActionError } = await import('../worker/game.mjs');
  const payload = JSON.stringify({ id: 'evt_1' });
  const header = await signHeader(payload, nowSeconds());
  await assert.rejects(
    () => verifyStripeWebhook(payload, header, undefined),
    err => {
      assert.ok(err instanceof ActionError, 'should throw ActionError so the route returns 500');
      assert.equal(err.statusCode, 500);
      return true;
    }
  );
});
