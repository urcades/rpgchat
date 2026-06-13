# Plan 005: Split worker/game.mjs into cohesive modules behind a stable facade

> **Executor instructions**: This is a large, incremental refactor. Do ONE cluster at
> a time, run `npm test` after each, and commit per cluster. Never move two clusters
> before verifying the first. Honor STOP conditions. Update this plan's row in
> `advisor-plans/README.md` when done (or when you stop early with partial progress).
>
> **Drift check (run first)**: `git diff --stat 02e8312..HEAD -- worker/game.mjs worker/index.mjs`
> If either changed materially since `02e8312`, re-derive the export inventory (Step 0)
> before trusting the cluster map below.

## Status

- **Priority**: P3
- **Effort**: L (multi-day; do it in cluster-sized commits)
- **Risk**: MED (no logic changes, but a large file is moving)
- **Depends on**: none (do this LAST; it touches the file other plans edit). If plans
  001/003/004 are planned, land them first so this rebases cleanly.
- **Category**: tech-debt
- **Planned at**: commit `02e8312`, 2026-06-13

## Why this matters

`worker/game.mjs` is ~3148 lines with **69 exports** — combat, items/inventory, body,
rooms/ecology, world events, progression, economy, and chat commands all in one file.
Every change touches it; cognitive load is high; and it's a latent circular-import
trap (it's large enough that someone will eventually be tempted to import a route
helper from `index.mjs` into it). Test coverage is already strong (132 tests), which
makes this the right time: the suite is the safety net for a pure, logic-preserving
move. The strategy is a **facade** — `game.mjs` becomes a barrel that re-exports from
new focused submodules — so `worker/index.mjs` (which imports 26 names from it) and
every test keep their imports unchanged and the move stays low-risk.

## Current state

- `worker/game.mjs` — 69 exports. Full inventory at `02e8312` (regenerate with the
  command in Step 0): combat (`calculateSpeedHitChance`, `validateAttackTargets`,
  `handleAttack`, `applyBodyDamage`, `applyBodyHeal`, `addStatusEffect`,
  `processStatusEffects`, `validateClassSkillUse`, `useClassSkill`,
  `roomHasActiveHostiles`, `runHostileRoomAction`, `handleAttackAction`,
  `handleSkillAction`); inventory (`getInventory`, `getEquippedModifiers`,
  `getConditionAndGearModifiers`, `equipItem`, `unequipItem`, `createItemForOwner`,
  `dropItemOnFloor`, `dropPlayerItemsOnDeath`, `getFloorItems`, `takeItem`,
  `handleEquipCommand`, `handleUnequipCommand`, `handleTakeCommand`); body
  (`getBodyParts`, `ensureBody`, `getBodyConditionModifiers`, `validateRegrowCommand`,
  `handleRegrowCommand`, `handleStanceCommand`); rooms/ecology (`getRoomFeaturesForTick`,
  `getActiveEffectsForRoom`, `roomHasEffect`, `getRoomAccessState`, `requireRoomUse`,
  `payInnAccess`, `getRoomEcology`, `getRoomState`, `createTrace`, `getActiveRound`,
  `updatePresence`, `processRoomEffects`, `resolveExpiredGamblingRounds`,
  `validateRollCommand`, `handleRollCommand`); world (`getCurrentTickValue`,
  `advanceGlobalTick`, `runScheduledWorldPulse`, `getActivePlayerRooms`,
  `getActiveWorldEvents`, `ensureDailyWorldEvents`, `createNpcForEvent`,
  `cleanupOldWorldDayData`); progression (`awardExperience` [internal], `updateLevel`
  [internal], `switchJob`, `moveUserToCemetery`); messages (`insertMessage`,
  `insertSystemMessage`, `getMessages`); core/state (`ActionError`, `getUser`,
  `getUserState`, `assertEnoughStamina`, `spendStamina`, `runPlayerAction`,
  `handleChatAction`, `handleJobChangeAction`).
- `worker/index.mjs:11-38` imports 26 named exports from `./game.mjs`. It imports only
  *from* game.mjs; game.mjs does NOT import from index.mjs (no cycle today — keep it that way).
- `utils/{body,items,jobs,leveling,roomEcology,worldEvents}.js` are clean, single-purpose,
  and have no cross-imports — game.mjs imports from them. Mirror that discipline.

## Commands

| Purpose | Command | Expected |
|---------|---------|----------|
| Suite | `npm test` | all pass (132+; must stay green after every cluster) |
| Bundle check | `npm run check` | exits 0 (index.mjs still resolves its imports) |
| Export inventory | see Step 0 | a stable sorted list of exported names |

## Scope

**In scope:** create `worker/combat.mjs`, `worker/inventory.mjs`, `worker/body-state.mjs`,
`worker/rooms.mjs`, `worker/world.mjs`, `worker/progression.mjs` (names are guidance —
adjust if a cleaner seam emerges); modify `worker/game.mjs` to re-export from them.
Optionally update `worker/index.mjs` imports to point at the new modules directly
*after* the facade is proven (only if you choose to retire the facade — otherwise leave
index.mjs untouched).

**Out of scope:** ANY behavior change. No renamed exports, no signature changes, no
"while I'm here" fixes. `utils/*` unchanged. Migrations unchanged.

## Git workflow
- Branch: `advisor/005-split-game-module`
- One commit per cluster moved: `refactor: extract <cluster> from game.mjs into worker/<file>.mjs`
- Keep every commit green (`npm test` passes).

## Steps

### Step 0 — Pin the contract

Capture the exported-name set as the invariant the refactor must preserve:

```
grep -nE "^export (async function|function|class|const) " worker/game.mjs \
  | sed -E 's/.*(function|class|const) ([A-Za-z0-9_]+).*/\2/' | sort > /tmp/exports-before.txt
```

**Verify**: `wc -l /tmp/exports-before.txt` → 69 (or the current count after drift check).

### Step 1..N — Extract one cluster at a time (facade pattern)

For each cluster (start with the most self-contained — **messages**, then
**progression**, then **inventory**, **body-state**, **combat**, **rooms**, **world**):

1. Create `worker/<cluster>.mjs`. Move the cluster's exported functions **and their
   private helpers** into it. Add imports at the top of the new module for anything it
   still needs from `db.mjs`, `utils/*`, `observability.mjs`, or *other new modules*
   (cross-cluster calls become explicit imports — this is the point).
2. In `worker/game.mjs`, delete the moved definitions and add a re-export:
   `export { handleAttack, applyBodyDamage, /* … */ } from './combat.mjs';`
   game.mjs stays the single import surface for index.mjs and tests.
3. If two clusters call each other, import across modules directly. If you hit a true
   cycle (A imports B and B imports A), extract the shared piece into a small
   `worker/core.mjs` (e.g. `ActionError`, `getUser`, stamina/`runPlayerAction`) that
   both import — do NOT solve a cycle by importing from `game.mjs` (that recreates the
   god dependency).

**Verify after EACH cluster**: `npm test` → all pass; `npm run check` → exits 0.
Commit before starting the next cluster.

### Final step — Confirm the contract held

```
grep -rhnE "^export " worker/game.mjs | sed -E 's/.*(function|class|const|\{) .*/x/' >/dev/null
# Re-derive the *effective* export set of game.mjs (including re-exports) and diff:
node -e "import('./worker/game.mjs').then(m => console.log(Object.keys(m).sort().join('\n')))" | sort > /tmp/exports-after.txt
diff /tmp/exports-before.txt /tmp/exports-after.txt
```

**Verify**: `diff` prints nothing (the public surface is identical). `npm test` → all
pass. `npm run check` → exits 0.

## Test plan

No new tests — the existing 132 are the regression harness and must pass after every
cluster move. The export-set `diff` is the structural invariant. (If you want, add a
trivial `test/game-facade.test.js` that imports `../worker/game.mjs` and asserts a
handful of key exports are functions — optional.)

## Done criteria

- [ ] `npm test` exits 0 with count unchanged (or higher if you added the optional facade test).
- [ ] `npm run check` exits 0.
- [ ] `diff /tmp/exports-before.txt /tmp/exports-after.txt` is empty.
- [ ] `worker/game.mjs` is materially smaller and contains mostly re-exports (or a small core); no submodule imports from `index.mjs`.
- [ ] `grep -rn "from './index" worker/*.mjs` returns nothing (no cycle into the router).
- [ ] `advisor-plans/README.md` row updated.

## STOP conditions

- A cluster can't be moved without creating an import cycle that a small `core.mjs`
  doesn't resolve: land the clusters that DO separate cleanly, leave the rest in
  game.mjs, and report which cluster resisted and why.
- `npm test` count drops or a test fails and isn't fixed by correcting an import path:
  STOP — you've changed behavior, which is out of scope.
- The export `diff` is non-empty at the end: a name was dropped or renamed — fix the
  re-export before declaring done.

## Maintenance notes

- New game logic should land in the relevant submodule, not back in `game.mjs`.
- Consider an import-lint rule forbidding `worker/{combat,inventory,…}.mjs` from
  importing `./index.mjs`, to lock in the layering.
- Once stable, a follow-up could retire the facade by repointing `index.mjs` imports
  at the submodules directly — deliberately deferred here to keep this plan low-risk.
