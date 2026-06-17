const test = require('node:test');
const assert = require('node:assert/strict');

// Pure unit tests for the validation predicates extracted from index.mjs route closures
// (adv-015 Stripe fail-closed, adv-016 username validation). NO database, NO network, NO
// cloudflare:workers — the routes themselves can't be unit-tested (the DurableObject import
// pulls in cloudflare:workers), so the *decisions* are tested here and pre-seamed for adv-008.

test('isValidUsername accepts 3-20 chars of [A-Za-z0-9_-]', async () => {
  const { isValidUsername } = await import('../worker/validation.mjs');
  assert.equal(isValidUsername('abc'), true, 'minimum length 3');
  assert.equal(isValidUsername('a'.repeat(20)), true, 'maximum length 20');
  assert.equal(isValidUsername('Player_1'), true);
  assert.equal(isValidUsername('cool-name'), true);
  assert.equal(isValidUsername('ABC123xyz'), true);
  assert.equal(isValidUsername('___'), true, 'all underscores still matches the shape (reserved check is separate)');
});

test('isValidUsername rejects out-of-range lengths', async () => {
  const { isValidUsername } = await import('../worker/validation.mjs');
  assert.equal(isValidUsername('ab'), false, 'too short (2)');
  assert.equal(isValidUsername(''), false, 'empty');
  assert.equal(isValidUsername('a'.repeat(21)), false, 'too long (21)');
});

test('isValidUsername rejects markup / whitespace / punctuation (XSS seam)', async () => {
  const { isValidUsername } = await import('../worker/validation.mjs');
  assert.equal(isValidUsername('<script>'), false);
  assert.equal(isValidUsername('a<b>c'), false);
  assert.equal(isValidUsername('a"b'), false);
  assert.equal(isValidUsername("a'b"), false);
  assert.equal(isValidUsername('has space'), false);
  assert.equal(isValidUsername('tab\there'), false);
  assert.equal(isValidUsername('new\nline'), false);
  assert.equal(isValidUsername('emoji😀x'), false);
  assert.equal(isValidUsername('semi;colon'), false);
  assert.equal(isValidUsername('dot.name'), false, 'dot is not allowed — and is part of the soc: namespace shape');
});

test('isValidUsername rejects non-strings', async () => {
  const { isValidUsername } = await import('../worker/validation.mjs');
  assert.equal(isValidUsername(null), false);
  assert.equal(isValidUsername(undefined), false);
  assert.equal(isValidUsername(12345), false);
  assert.equal(isValidUsername({}), false);
});

test('isReservedUsername blocks "System" case-insensitively', async () => {
  const { isReservedUsername } = await import('../worker/validation.mjs');
  assert.equal(isReservedUsername('System'), true, 'the literal system-message author');
  assert.equal(isReservedUsername('system'), true);
  assert.equal(isReservedUsername('SYSTEM'), true);
  assert.equal(isReservedUsername('SyStEm'), true);
});

test('isReservedUsername blocks the internal NPC prefixes', async () => {
  const { isReservedUsername } = await import('../worker/validation.mjs');
  assert.equal(isReservedUsername('soc:1:2:3:clerk:0'), true, 'social NPC namespace');
  assert.equal(isReservedUsername('soc:'), true);
  assert.equal(isReservedUsername('__npc_voice'), true, 'internal effect-tracking pseudo-user');
  assert.equal(isReservedUsername('__npc_ambient'), true);
  assert.equal(isReservedUsername('__anything'), true, 'anything starting with __');
});

test('isReservedUsername allows ordinary names (incl. an inner/late soc or single underscore)', async () => {
  const { isReservedUsername } = await import('../worker/validation.mjs');
  assert.equal(isReservedUsername('Aragorn'), false);
  assert.equal(isReservedUsername('social_butterfly'), false, 'soc not at the start');
  assert.equal(isReservedUsername('mysoc'), false, 'soc: not a prefix');
  assert.equal(isReservedUsername('_single'), false, 'a single leading underscore is fine — only __ is reserved');
  assert.equal(isReservedUsername('a__b'), false, '__ not at the start');
  assert.equal(isReservedUsername('systemic'), false, 'only an exact System match is reserved, not a prefix');
});

test('isReservedUsername tolerates non-strings', async () => {
  const { isReservedUsername } = await import('../worker/validation.mjs');
  assert.equal(isReservedUsername(null), false);
  assert.equal(isReservedUsername(undefined), false);
  assert.equal(isReservedUsername(42), false);
});

// --- adv-015: shouldFulfillResurrection (fail-closed) ---------------------------------

test('shouldFulfillResurrection FAILS CLOSED when the expected link id is not configured', async () => {
  const { shouldFulfillResurrection } = await import('../worker/validation.mjs');
  // This is the hole adv-015 closes: previously an unset env var SKIPPED the check and ANY
  // completed checkout fulfilled. Now an unset expectedLinkId is an outright refusal.
  const d = shouldFulfillResurrection({
    linkId: 'plink_attacker',
    expectedLinkId: undefined,
    paymentStatus: 'paid'
  });
  assert.equal(d.fulfill, false);
  assert.equal(d.reason, 'expected_link_id_not_configured');
});

test('shouldFulfillResurrection refuses an empty-string expected link id (also unset)', async () => {
  const { shouldFulfillResurrection } = await import('../worker/validation.mjs');
  const d = shouldFulfillResurrection({ linkId: 'plink_x', expectedLinkId: '', paymentStatus: 'paid' });
  assert.equal(d.fulfill, false);
  assert.equal(d.reason, 'expected_link_id_not_configured');
});

test('shouldFulfillResurrection refuses a payment_link mismatch', async () => {
  const { shouldFulfillResurrection } = await import('../worker/validation.mjs');
  const d = shouldFulfillResurrection({
    linkId: 'plink_some_other_product',
    expectedLinkId: 'plink_resurrection',
    paymentStatus: 'paid'
  });
  assert.equal(d.fulfill, false);
  assert.equal(d.reason, 'payment_link_mismatch');
});

test('shouldFulfillResurrection refuses a present-but-unpaid status', async () => {
  const { shouldFulfillResurrection } = await import('../worker/validation.mjs');
  for (const status of ['unpaid', 'no_payment_required', 'pending']) {
    const d = shouldFulfillResurrection({
      linkId: 'plink_resurrection',
      expectedLinkId: 'plink_resurrection',
      paymentStatus: status
    });
    assert.equal(d.fulfill, false, `status ${status} must not fulfill`);
    assert.equal(d.reason, 'payment_not_paid');
  }
});

test('shouldFulfillResurrection fulfills the happy path (link matches + paid)', async () => {
  const { shouldFulfillResurrection } = await import('../worker/validation.mjs');
  const d = shouldFulfillResurrection({
    linkId: 'plink_resurrection',
    expectedLinkId: 'plink_resurrection',
    paymentStatus: 'paid'
  });
  assert.equal(d.fulfill, true);
  assert.equal(d.reason, 'ok');
});

test('shouldFulfillResurrection tolerates an ABSENT payment_status (forward-compat)', async () => {
  const { shouldFulfillResurrection } = await import('../worker/validation.mjs');
  // Some event shapes omit payment_status; the link match is the primary gate, matching the
  // prior behavior (`session.payment_status && ...`).
  const d = shouldFulfillResurrection({
    linkId: 'plink_resurrection',
    expectedLinkId: 'plink_resurrection',
    paymentStatus: undefined
  });
  assert.equal(d.fulfill, true);
  assert.equal(d.reason, 'ok');
});

test('shouldFulfillResurrection sanity-checks amount when an expected amount is configured', async () => {
  const { shouldFulfillResurrection } = await import('../worker/validation.mjs');
  const base = { linkId: 'plink_r', expectedLinkId: 'plink_r', paymentStatus: 'paid', expectedAmount: 500 };
  assert.equal(shouldFulfillResurrection({ ...base, amountTotal: 500 }).fulfill, true, 'matching amount passes');
  const mismatch = shouldFulfillResurrection({ ...base, amountTotal: 1 });
  assert.equal(mismatch.fulfill, false, 'a $0.01 underpayment is refused');
  assert.equal(mismatch.reason, 'amount_mismatch');
});

test('shouldFulfillResurrection SKIPS the amount check when no expected amount is set', async () => {
  const { shouldFulfillResurrection } = await import('../worker/validation.mjs');
  // A missing price env var must NOT block legitimate fulfillment — only the link+paid gate applies.
  const d = shouldFulfillResurrection({
    linkId: 'plink_r',
    expectedLinkId: 'plink_r',
    paymentStatus: 'paid',
    amountTotal: 12345
  });
  assert.equal(d.fulfill, true);
});

test('shouldFulfillResurrection checks currency case-insensitively when configured', async () => {
  const { shouldFulfillResurrection } = await import('../worker/validation.mjs');
  const base = { linkId: 'plink_r', expectedLinkId: 'plink_r', paymentStatus: 'paid', expectedCurrency: 'usd' };
  assert.equal(shouldFulfillResurrection({ ...base, currency: 'USD' }).fulfill, true, 'USD matches usd');
  const mismatch = shouldFulfillResurrection({ ...base, currency: 'eur' });
  assert.equal(mismatch.fulfill, false);
  assert.equal(mismatch.reason, 'currency_mismatch');
});

test('shouldFulfillResurrection with no args fails closed (no expected link id)', async () => {
  const { shouldFulfillResurrection } = await import('../worker/validation.mjs');
  const d = shouldFulfillResurrection();
  assert.equal(d.fulfill, false);
  assert.equal(d.reason, 'expected_link_id_not_configured');
});
