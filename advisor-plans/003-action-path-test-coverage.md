# Plan 003: Backfill tests for the untested action handlers (job change, leveling, inn)

> **Executor instructions**: Follow step by step; run every verification command and
> confirm before proceeding. Honor STOP conditions. Update this plan's row in
> `advisor-plans/README.md` when done.
>
> **Drift check (run first)**: `git diff --stat 02e8312..HEAD -- worker/game.mjs`
> If `worker/game.mjs` changed, re-confirm the function signatures in "Current state"
> before writing tests; on a mismatch, STOP.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: plan 002 (use the shared D1 helper if it exists; otherwise inline the shim like the other tests)
- **Category**: tests
- **Planned at**: commit `02e8312`, 2026-06-13

## Why this matters

Three game-state-mutating handlers have their underlying utils unit-tested but their
*handler-level* behavior — including authorization gates — uncovered: job change
(guild-room gate), experience/leveling on player actions, and inn-access payment.
A regression in the guild gate (job-swap anywhere) or the per-action XP award would
ship silently. These handlers are exported from `worker/game.mjs` and testable
directly at the game layer (the HTTP routes in `index.mjs` can't be imported under
`node --test` because `index.mjs` imports `cloudflare:workers`).

## Current state

- `worker/game.mjs:3133` — `handleJobChangeAction(db, username, row, col, nextJob, roomUse)`:
  `validate` throws `ActionError('Job changes require a Guild room.', 403)` unless
  `roomHasEffect(row, col, roomUse.tickValue, 'guild', roomUse.worldDay)`, and throws
  `'Invalid job.'` unless `nextJob` is a key of `JOBS`; `perform` calls
  `switchJob(db, { username, nextJob, row, col })`.
- `worker/game.mjs:2815` — `switchJob(...)` performs the actual job mutation (exported).
- `worker/game.mjs:2275` — `updateLevel(db, username, row, col)` → `awardExperience(db, username, PLAYER_ACTION_EXPERIENCE)` where `PLAYER_ACTION_EXPERIENCE = 1` (`:66`). `updateLevel` is called from `handleChatAction` (`:3056`) — i.e. a plain chat action awards +1 XP and may level the player up (granting attribute points via the leveling curve in `utils/leveling.js`).
- `worker/game.mjs:229` — `payInnAccess(db, username, row, col)` (already has a unit test in `test/workerMigration.test.js` ~line 1273; the gap is only the action/HTTP framing — keep new inn coverage light).
- **Conventions**: see `test/items.integration.test.js` and `test/combat.integration.test.js` for the harness (in-memory D1, migrations applied, `seedLiveUser`, `updatePresence`, dynamic `import('../worker/game.mjs')`). `roomHasEffect`/`getActiveEffectsForRoom` are deterministic per `(row,col,tick,worldDay)`.

## Commands

| Purpose | Command | Expected |
|---------|---------|----------|
| New file | `node --test test/actions.integration.test.js` | all pass |
| Full suite | `npm test` | all pass |

## Scope

**In scope:** `test/actions.integration.test.js` (create).
**Out of scope:** any change to `worker/` source. This plan is tests only. If a test
reveals a real bug, do NOT fix it — note it and STOP.

## Git workflow
- Branch: `advisor/003-action-tests`
- Commit: `test: cover job-change gate, action XP/leveling, inn access`

## Steps

### Step 1 — Job change handler

Test cases against `handleJobChangeAction`:
- **gate**: in a NON-guild room (find one the way `findCalmRoom` finds calm rooms, or assert with a room/tick where `roomHasEffect(...,'guild',...)` is false), expect it to throw an `ActionError` with status `403`.
- **invalid job**: in any room, `nextJob='Wizard'` (not a `JOBS` key) → throws `'Invalid job.'`.
- **success**: rather than hunt for a guild room, test `switchJob` directly — seed a user, call `switchJob(db,{username,nextJob:'Mage',row,col})`, assert `users.job` is now `'Mage'`. (Document in a comment that the guild gate is covered by the rejection case above and `switchJob` is the mutation.)

Build the `roomUse` arg as `{ tickValue: <current tick>, worldDay: getWorldDay() }` — read both from the exported helpers.

**Verify**: `node --test test/actions.integration.test.js` → these pass.

### Step 2 — Experience & leveling on a player action

- Seed a fresh user at level 0, experience 0. Drive `handleChatAction(db, username, row, col, 'hello world')` once; assert the user's `experience` increased by `PLAYER_ACTION_EXPERIENCE` (1).
- Drive enough chat actions to cross the first level threshold (read the threshold from `utils/leveling.js` — do not hardcode a guess; compute it). Assert `level` incremented and `attributePoints` increased accordingly.

**Verify**: `node --test test/actions.integration.test.js` → these pass.

### Step 3 — Inn access (light)

- Seed a user with enough gold; on an inn room (find one via the room-feature helpers, or assert the not-an-inn rejection if a guild/inn room is hard to locate deterministically), call `payInnAccess` and assert gold decreased by the fee and access is recorded; on insufficient gold assert it throws. Keep this minimal — the core is already unit-tested.

**Verify**: `node --test test/actions.integration.test.js` → all pass; then `npm test` → all pass.

## Test plan

- New: `test/actions.integration.test.js` — job-change gate (403), invalid job, `switchJob` success, chat awards +1 XP, leveling grants attribute points, inn pay deducts gold. Model structure on `test/combat.integration.test.js`.
- Verification: `npm test` → all pass, ≥6 new cases over baseline.

## Done criteria

- [ ] `npm test` exits 0; `test/actions.integration.test.js` exists with ≥6 passing cases.
- [ ] No file outside `test/` modified (`git status`).
- [ ] `advisor-plans/README.md` row updated.

## STOP conditions

- A test exposes a real bug (e.g. job swap succeeds outside a guild, or no XP awarded): STOP, document the bug and the failing assertion, do not fix source here.
- A deterministic guild/inn room can't be located from the feature helpers within reason: cover the rejection paths + `switchJob`/`payInnAccess` directly and note the gap.

## Maintenance notes

- If `PLAYER_ACTION_EXPERIENCE` or the leveling curve changes, Step 2's threshold math must be recomputed from `utils/leveling.js`, not hardcoded.
- These are game-layer tests; the HTTP routes remain untestable until a workerd-based test runner exists (tracked separately).
