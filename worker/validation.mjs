// Pure validation predicates extracted from index.mjs route closures (adv-015, adv-016).
// The routes themselves can't be unit-tested in isolation (they pull in cloudflare:workers
// via the DurableObject import in index.mjs), so the *decisions* those routes make live here
// as small, side-effect-free, exported functions that ARE unit-testable — and that pre-seam
// the logic for adv-008. Nothing in this module touches the DB, the network, or env.

// adv-016: a username must be 3-20 chars of [A-Za-z0-9_-]. This is the shape gate; it also
// happens to block the stored-XSS seam (no `<`, `>`, `"`, `'`, whitespace, or other markup
// can ever enter a username and later render unescaped in a room transcript or leaderboard).
export const USERNAME_PATTERN = /^[A-Za-z0-9_-]{3,20}$/;

export function isValidUsername(name) {
  return typeof name === 'string' && USERNAME_PATTERN.test(name);
}

// adv-016: names the engine reserves for itself and must never hand to a player.
//   - "System" is the literal author of every system message (see game/messages.mjs:
//     insertMessage(db, row, col, 'System', ...)). Registering it lets a human impersonate
//     the narrator. Matched case-insensitively so "system"/"SYSTEM" can't sneak past.
//   - the "soc:" prefix is the namespace for spawned social NPC usernames
//     (game/world.mjs: `soc:${worldDay}:${row}:${col}:...`).
//   - the "__" prefix is the namespace for internal effect-tracking pseudo-users
//     (game/npc.mjs: "__npc_voice", "__npc_ambient").
// A name colliding with any of these could shadow or impersonate an engine actor.
export const RESERVED_USERNAME_PREFIXES = ['soc:', '__'];

export function isReservedUsername(name) {
  if (typeof name !== 'string') {
    return false;
  }
  if (name.toLowerCase() === 'system') {
    return true;
  }
  return RESERVED_USERNAME_PREFIXES.some(prefix => name.startsWith(prefix));
}

// adv-015: the single fail-CLOSED decision for whether a verified Stripe
// `checkout.session.completed` event should fulfill a resurrection. Returns
// `{ fulfill: boolean, reason: string }` — `reason` is for the structured log line so a
// refusal is diagnosable. The signature is already verified by the caller; this gates the
// *contents* of the event.
//
// Fail-closed rules, in order:
//   1. expectedLinkId MUST be configured. If it's missing/empty we CANNOT prove the payment
//      was for a resurrection, so we refuse (the previous behavior skipped the check and
//      fulfilled ANY completed checkout — that's the hole this closes).
//   2. the event's payment_link MUST equal the expected one.
//   3. payment_status MUST be exactly 'paid' (a present-but-unpaid status, e.g. 'unpaid' or
//      'no_payment_required', is refused; an ABSENT status is tolerated for forward-compat
//      with event shapes that omit it, matching the prior behavior).
//   4. when an expected amount/currency is known, amount_total and currency must match
//      (best-effort sanity check; skipped when not configured so a missing price env var
//      doesn't block legitimate fulfillment).
export function shouldFulfillResurrection({
  linkId,
  expectedLinkId,
  paymentStatus,
  amountTotal,
  expectedAmount,
  currency,
  expectedCurrency
} = {}) {
  if (!expectedLinkId) {
    return { fulfill: false, reason: 'expected_link_id_not_configured' };
  }
  if (linkId !== expectedLinkId) {
    return { fulfill: false, reason: 'payment_link_mismatch' };
  }
  // Absent status: tolerated (older/edge event shapes). Present status: must be 'paid'.
  if (paymentStatus && paymentStatus !== 'paid') {
    return { fulfill: false, reason: 'payment_not_paid' };
  }
  if (expectedAmount != null && amountTotal != null && amountTotal !== expectedAmount) {
    return { fulfill: false, reason: 'amount_mismatch' };
  }
  if (expectedCurrency && currency && currency.toLowerCase() !== expectedCurrency.toLowerCase()) {
    return { fulfill: false, reason: 'currency_mismatch' };
  }
  return { fulfill: true, reason: 'ok' };
}
