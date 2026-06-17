// adv-008: direct unit tests for worker/auth.mjs's crypto + cookie-parsing primitives.
//
// authCrypto.test.js already covers these THROUGH the public session seam (createSession /
// getSession with a real D1). This file pins the primitives in isolation now that they are
// exported: the HMAC sign/verify round-trip, the constant-time compare's contract, and the
// two cookie parsers (general name=value `parseCookie` + the multi-value `getCookieValues`
// the live getSession path uses). No DB, no network — just the pure functions.

const assert = require('node:assert/strict');
const test = require('node:test');

// --- sign / verifyCookieValue: the HMAC round-trip ------------------------------

test('sign is deterministic for the same value+secret and base64url-safe', async () => {
  const { sign } = await import('../worker/auth.mjs');
  const a = await sign('session-id-123', 'secret');
  const b = await sign('session-id-123', 'secret');
  assert.equal(a, b, 'same input => same signature');
  // base64url alphabet only: no +, /, or = padding leaks into the cookie.
  assert.match(a, /^[A-Za-z0-9_-]+$/, 'signature is base64url (cookie-safe)');
});

test('sign diverges on a different value or a different secret', async () => {
  const { sign } = await import('../worker/auth.mjs');
  const base = await sign('id-A', 'secret-1');
  assert.notEqual(await sign('id-B', 'secret-1'), base, 'different value => different MAC');
  assert.notEqual(await sign('id-A', 'secret-2'), base, 'different secret => different MAC');
});

test('verifyCookieValue round-trips a value signed by sign()', async () => {
  const { sign, verifyCookieValue } = await import('../worker/auth.mjs');
  const sessionId = 'abc-123';
  const value = `${sessionId}.${await sign(sessionId, 'unit-secret')}`;
  assert.equal(
    await verifyCookieValue(value, 'unit-secret'),
    sessionId,
    'a genuinely-signed value verifies and yields its session id'
  );
});

test('verifyCookieValue rejects a tampered signature (equal length, wrong bytes)', async () => {
  const { sign, verifyCookieValue } = await import('../worker/auth.mjs');
  const sessionId = 'abc-123';
  const sig = await sign(sessionId, 'unit-secret');
  const last = sig.slice(-1);
  const forgedSig = sig.slice(0, -1) + (last === 'A' ? 'B' : 'A');
  assert.equal(forgedSig.length, sig.length, 'forged signature kept the same length');
  assert.equal(
    await verifyCookieValue(`${sessionId}.${forgedSig}`, 'unit-secret'),
    null,
    'an equal-length but wrong signature does not verify'
  );
});

test('verifyCookieValue rejects a signature made with the wrong secret', async () => {
  const { sign, verifyCookieValue } = await import('../worker/auth.mjs');
  const value = `id-1.${await sign('id-1', 'secret-A')}`;
  assert.equal(await verifyCookieValue(value, 'secret-B'), null, 'wrong key => no match');
});

test('verifyCookieValue rejects malformed values without throwing', async () => {
  const { verifyCookieValue } = await import('../worker/auth.mjs');
  for (const bad of ['', 'no-dot-here', '.onlysig', 'onlyid.', null, undefined]) {
    assert.equal(await verifyCookieValue(bad, 'secret'), null, `rejected: ${String(bad)}`);
  }
});

// --- constantTimeEqual: the timing-safe compare contract ------------------------

test('constantTimeEqual is true only for byte-identical equal-length strings', async () => {
  const { constantTimeEqual } = await import('../worker/auth.mjs');
  assert.equal(constantTimeEqual('abcdef', 'abcdef'), true, 'identical strings match');
  assert.equal(constantTimeEqual('abcdef', 'abcdeg'), false, 'one differing byte fails');
  assert.equal(constantTimeEqual('', ''), true, 'empty strings match');
});

test('constantTimeEqual fails fast (false) on a length mismatch', async () => {
  const { constantTimeEqual } = await import('../worker/auth.mjs');
  assert.equal(constantTimeEqual('short', 'longer-value'), false, 'different lengths never match');
  assert.equal(constantTimeEqual('abc', 'ab'), false);
});

// --- parseCookie: general name=value parsing ------------------------------------

test('parseCookie parses a multi-cookie header into a name->value map', async () => {
  const { parseCookie } = await import('../worker/auth.mjs');
  const parsed = parseCookie('theme=dark; rpgchat_session=abc.def; analytics=xyz%20123');
  assert.equal(parsed.theme, 'dark');
  assert.equal(parsed.rpgchat_session, 'abc.def');
  assert.equal(parsed.analytics, 'xyz 123', 'values are URL-decoded');
});

test('parseCookie tolerates empty / malformed segments', async () => {
  const { parseCookie } = await import('../worker/auth.mjs');
  assert.deepEqual(parseCookie(''), {}, 'empty header => empty map');
  const parsed = parseCookie('valueless; a=1; ; =leadingequals');
  assert.equal(parsed.a, '1', 'a well-formed pair is still captured');
  assert.equal('valueless' in parsed, false, 'a segment with no = is skipped');
});

// --- getCookieValues: the multi-value collector getSession relies on ------------

test('getCookieValues collects every value for a repeated cookie name', async () => {
  const { getCookieValues } = await import('../worker/auth.mjs');
  // Some proxies / path-scoping send the same cookie name more than once.
  const header = 'rpgchat_session=first.sig; other=x; rpgchat_session=second.sig';
  assert.deepEqual(
    getCookieValues(header, 'rpgchat_session'),
    ['first.sig', 'second.sig'],
    'both values for the target name are returned, neighbors ignored'
  );
});

test('getCookieValues returns an empty list when the cookie is absent', async () => {
  const { getCookieValues } = await import('../worker/auth.mjs');
  assert.deepEqual(getCookieValues('theme=dark; other=x', 'rpgchat_session'), []);
  assert.deepEqual(getCookieValues('', 'rpgchat_session'), []);
});
