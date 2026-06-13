# Plan 001: Make resurrection fulfillment idempotent and test the Stripe path

> **Executor instructions**: Follow this plan step by step. Run every verification
> command and confirm the expected result before moving on. If anything in "STOP
> conditions" occurs, stop and report — do not improvise. When done, update this
> plan's row in `advisor-plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 02e8312..HEAD -- worker/resurrection.mjs worker/index.mjs`
> If either file changed since this plan was written, compare the "Current state"
> excerpts below against the live code before proceeding; on a mismatch, STOP.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: bug + tests
- **Planned at**: commit `02e8312`, 2026-06-13

## Why this matters

Resurrection is the only paid path in the game (Stripe checkout → webhook → revive).
`fulfillResurrectionCheckout` is **not idempotent under concurrent or retried
webhook delivery**: it reads the `pending` gate, then performs the side effects
(`INSERT user`, `DELETE cemetery`) *before* the conditional status write that's
meant to gate them. Two deliveries of the same `checkout.session.completed` event
(Stripe retries on any non-2xx, and can deliver concurrently) can both pass the
read gate, then collide on the `users` primary-key INSERT — throwing a constraint
error and leaving inconsistent state (cemetery row already deleted, status not yet
flipped). The path also has zero automated tests. This plan makes fulfillment
claim-then-act (race-safe) and adds coverage, including a concurrency test.

## Current state

- `worker/resurrection.mjs` — the fulfillment logic. `fulfillResurrectionCheckout`
  (lines 41–116) currently does, in order: read request (`:46`), early-return if
  `status !== 'pending'` (`:56`), read grave (`:60`), `INSERT users` if no live user
  (`:82-90`), `DELETE cemetery` (`:92`), conditional `UPDATE … status='completed' …
  WHERE token=? AND status='pending'` (`:93-102`), `UPDATE sessions` (`:103-110`).
  The conditional status write — the only race-safe mutation — happens **last**,
  after the side effects. Excerpt of the unsafe ordering:

  ```js
  if (request.status !== 'pending') {            // :56  read gate (not a claim)
    return { revived: false, reason: 'already_completed' };
  }
  const grave = await dbFirst(db, /* … */);       // :60
  // … grave-missing branch sets status='missing_grave' …
  const liveUser = await dbFirst(db, 'SELECT username FROM users WHERE username = ?', [grave.username]);
  if (!liveUser) {
    await dbRun(db, `INSERT INTO users …`, [...]); // :85  SIDE EFFECT before claim
  }
  await dbRun(db, 'DELETE FROM cemetery WHERE id = ?', [grave.id]);          // :92 SIDE EFFECT
  await dbRun(db, `UPDATE resurrectionRequests SET status='completed' …      // :93 claim, too late
                   WHERE token = ? AND status = 'pending'`, [...]);
  ```

- `worker/db.mjs` — exports `dbFirst`, `dbRun`, and **`changes(result)`** (returns
  `result?.meta?.changes ?? result?.changes ?? 0`). `resurrection.mjs` currently
  imports only `{ dbFirst, dbRun }` — you will add `changes`.

- `worker/index.mjs` — the `/stripe/webhook` route (`:509-547`) and the verifier
  helpers `computeStripeSignature` (`:223`), `verifyStripeWebhook` (`:236`), plus
  `parseStripeSignature` and `constantTimeEqual`/`bytesToHex` used by them.
  **`index.mjs` imports `cloudflare:workers` (line 1) and constructs a Durable
  Object, so it cannot be imported under `node --test`.** That is why every test
  imports `worker/game.mjs` / `utils/*` / `worker/resurrection.mjs` directly, never
  `index.mjs`. To test the signature verifier you must move it to its own module
  with no `cloudflare:workers` import (Part B).

- **Test conventions**: CommonJS `.js` files in `test/`, `node:test` + `node:assert/strict`.
  Each test builds an in-memory D1 via a `createSqliteD1()` shim and applies every
  file in `/migrations` in sorted order. Copy that harness from
  `test/items.integration.test.js` (its top ~80 lines: `createSqliteD1`,
  `createMigratedDb`). `fulfillResurrectionCheckout` and `createResurrectionCheckout`
  are already exported from `worker/resurrection.mjs` and import only `db.mjs`, so
  they are directly testable. Tests `import(...)` ESM modules from CommonJS via
  dynamic `await import('../worker/resurrection.mjs')` — match the pattern in
  `test/combat.integration.test.js:132`.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Tests | `npm test` | all pass (132 today + your new tests) |
| Single file | `node --test test/resurrection.integration.test.js` | all pass |
| Bundle check | `npm run check` | exits 0, prints bindings, "--dry-run: exiting now." |

## Scope

**In scope:**
- `worker/resurrection.mjs` (modify fulfillment ordering; add `changes` import)
- `test/resurrection.integration.test.js` (create)
- Part B only: `worker/stripe.mjs` (create), `worker/index.mjs` (swap the verifier
  definitions for imports from `worker/stripe.mjs`), `test/stripe-signature.test.js` (create)

**Out of scope (do NOT touch):**
- The `/stripe/webhook` route body logic in `index.mjs` (event-type/payment-status
  filtering) beyond replacing where the verifier *comes from* in Part B.
- `createResurrectionCheckout` — it's fine as is.
- Any change to the `resurrectionRequests` schema / migrations.

## Git workflow

- Branch: `advisor/001-resurrection-idempotency`
- Conventional commits (repo style — see `git log`): e.g.
  `fix: claim resurrection request before side effects (idempotent fulfillment)`
- Do NOT push or open a PR unless the operator asks.

## Steps

### Step 1 — Reorder fulfillment to claim-then-act

In `worker/resurrection.mjs`, change the import on line 1 to include `changes`:
`import { dbFirst, dbRun, changes } from './db.mjs';`

Rewrite the body of `fulfillResurrectionCheckout` after the `request_not_found`
check so the **conditional status update is the claim and runs first**. Target shape:

```js
// Atomically claim the request: only one caller can flip pending->completed.
// Every side effect below runs ONLY for the winner, so a retried/concurrent
// webhook for the same token is a no-op instead of a double-fulfillment.
const claim = await dbRun(
  db,
  `UPDATE resurrectionRequests
   SET status = 'completed', stripeSessionId = ?, completedAt = CURRENT_TIMESTAMP
   WHERE token = ? AND status = 'pending'`,
  [stripeSessionId || null, token]
);
if (changes(claim) !== 1) {
  return { revived: false, reason: 'already_completed' };
}

const grave = await dbFirst(db, /* same SELECT as today, by request.graveId + username */);
if (!grave) {
  await dbRun(db, `UPDATE resurrectionRequests SET status = 'missing_grave' WHERE token = ?`, [token]);
  return { revived: false, reason: 'grave_not_found' };
}

const liveUser = await dbFirst(db, 'SELECT username FROM users WHERE username = ?', [grave.username]);
if (!liveUser) {
  await dbRun(db, `INSERT INTO users (…same columns/values as today…)`, [...]);
}
await dbRun(db, 'DELETE FROM cemetery WHERE id = ?', [grave.id]);
await dbRun(db, `UPDATE sessions SET username = ?, deadUsername = NULL WHERE deadUsername = ?`, [grave.username, grave.username]);

return { revived: true, username: grave.username };
```

Keep the initial `if (!token)` and `request_not_found` early returns. The `grave`
SELECT, `INSERT users` columns, and `sessions` UPDATE are unchanged from today —
only the *order* changes and the status write becomes the gate.

**Verify**: `npm run check` → exits 0 (file still parses/bundles).

### Step 2 — Write the fulfillment tests

Create `test/resurrection.integration.test.js`. Copy the `createSqliteD1` +
`createMigratedDb` helpers from `test/items.integration.test.js`. Import the
functions under test: `const { createResurrectionCheckout, fulfillResurrectionCheckout } = await import('../worker/resurrection.mjs');`

Write these cases (seed a cemetery row directly with `db.prepare(INSERT INTO cemetery …).run()`):

1. **happy path**: insert a grave; `createResurrectionCheckout` → `{token}`; `fulfill(token,'sess_1')` → `{revived:true}`; assert a `users` row now exists for that username, the `cemetery` row is gone, and `resurrectionRequests.status === 'completed'`.
2. **idempotent retry**: call `fulfill(token,'sess_1')` twice; second returns `{revived:false, reason:'already_completed'}`; assert exactly **one** `users` row (no duplicate/throw).
3. **concurrent delivery**: `await Promise.all([fulfill(token,'a'), fulfill(token,'b')])`; assert exactly one result has `revived:true` and one is `already_completed`; assert exactly one `users` row; assert no promise rejected.
4. **grave missing**: create a request whose `graveId` points at a deleted grave; `fulfill` → `{revived:false, reason:'grave_not_found'}` and `status === 'missing_grave'`.
5. **unknown token**: `fulfill('nope','s')` → `{revived:false, reason:'request_not_found'}`.

**Verify**: `node --test test/resurrection.integration.test.js` → all pass.

### Step 3 (Part B) — Make the Stripe signature verifier testable

Create `worker/stripe.mjs` and **move** `computeStripeSignature`, `verifyStripeWebhook`,
`parseStripeSignature`, and the small helpers they call that are Stripe-specific
(`bytesToHex` if only used here; import `constantTimeEqual` from where it lives —
likely `worker/auth.mjs` — if it's shared). Export `verifyStripeWebhook` and
`computeStripeSignature`. The module must NOT import `cloudflare:workers`. Keep
`STRIPE_WEBHOOK_TOLERANCE_SECONDS` with the verifier.

In `worker/index.mjs`, delete the moved definitions and add
`import { verifyStripeWebhook } from './stripe.mjs';` (and `computeStripeSignature`
if referenced elsewhere). The `/stripe/webhook` route is otherwise unchanged.

**Verify**: `npm run check` → exits 0; `npm test` → still all pass.

### Step 4 (Part B) — Test signature verification

Create `test/stripe-signature.test.js`. Import `{ verifyStripeWebhook, computeStripeSignature } from '../worker/stripe.mjs'`. Build a signed header with a known secret using `computeStripeSignature`, then assert:
- valid signature + fresh timestamp → `true`;
- tampered payload (sign one body, verify another) → `false`;
- stale timestamp (now − tolerance − 10) → `false`;
- missing/garbage `stripe-signature` header → `false`;
- missing secret → throws (matches current `verifyStripeWebhook` behavior).

Stripe header format is `t=<unixSeconds>,v1=<hexHmac>`. Compute "now" with
`Math.floor(Date.now()/1000)` in the test (tests may use Date, unlike workflow scripts).

**Verify**: `node --test test/stripe-signature.test.js` → all pass.

## Test plan

- New: `test/resurrection.integration.test.js` (5 cases above), modeled on `test/items.integration.test.js`.
- New: `test/stripe-signature.test.js` (5 cases above).
- Verification: `npm test` → all pass; new test count ≥ 10 over the 132 baseline.

## Done criteria

- [ ] `npm test` exits 0; `resurrection.integration.test.js` and `stripe-signature.test.js` exist and pass.
- [ ] In `worker/resurrection.mjs`, the `UPDATE resurrectionRequests … status='completed' … WHERE token=? AND status='pending'` is the FIRST mutation in `fulfillResurrectionCheckout` and is guarded by `changes(claim) !== 1`.
- [ ] `npm run check` exits 0.
- [ ] `git status` shows only in-scope files modified.
- [ ] `advisor-plans/README.md` status row updated.

## STOP conditions

Stop and report (do not improvise) if:
- The "Current state" excerpts don't match the live code (drift since `02e8312`).
- Part B reveals that `constantTimeEqual`/`bytesToHex`/`parseStripeSignature` are
  entangled with `cloudflare:workers`-importing code such that extraction can't be
  done cleanly — land Part A (Steps 1–2) alone and report Part B as blocked.
- Any verification fails twice after a reasonable fix attempt.

## Maintenance notes

- The claim-first pattern relies on `UPDATE … WHERE status='pending'` being atomic
  in D1 (it is — single-statement). If a future change adds a second concurrent
  writer to `resurrectionRequests`, re-check the gate.
- Reviewer should confirm no side effect (INSERT user, DELETE cemetery, sessions
  update) can run before the claim succeeds.
- Deferred: full `app.fetch`-level test of the `/stripe/webhook` route is still not
  possible without a workerd test runner; Part B covers the verifier in isolation,
  which is the security-critical piece.
