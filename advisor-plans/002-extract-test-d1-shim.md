# Plan 002: Extract the duplicated test D1 shim into one shared helper

> **Executor instructions**: Follow step by step; run every verification command and
> confirm its expected result before proceeding. Honor STOP conditions. When done,
> update this plan's row in `advisor-plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 02e8312..HEAD -- test/`
> If the listed test files changed since this plan was written, re-confirm the
> shim copies are still identical before extracting; on a mismatch, STOP.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none (do AFTER plan 001 if 001 is in flight, to avoid editing a brand-new test file twice — not a hard dependency)
- **Category**: tech-debt (tests)
- **Planned at**: commit `02e8312`, 2026-06-13

## Why this matters

The same `createSqliteD1()` D1 shim (an in-memory `sqlite3` wrapper shaped like the
Cloudflare D1 API) is copy-pasted across at least three test files, plus
`createMigratedDb()`/`withMockedRandom()` helpers in several. A change to the shim
(e.g. to support a new D1 method the code starts calling) must be made in every copy
and can silently drift between them. Extracting one shared module removes the
duplication and makes the harness a single source of truth.

## Current state

- `test/workerMigration.test.js` — defines `createSqliteD1()` (~lines 9–71).
- `test/items.integration.test.js` — defines an identical `createSqliteD1()` (~25–72) plus `createMigratedDb()`, `withMockedRandom()`, `findCalmRoom()`, `seedLiveUser()`.
- `test/combat.integration.test.js` — defines an identical `createSqliteD1()` (25–72) plus the same helper set (verify by reading; lines 25–126).
- (If plan 001 landed, `test/resurrection.integration.test.js` also has a copy.)

The shim shape (confirm it matches in each file before extracting):

```js
function createSqliteD1() {
  const raw = new sqlite3.Database(':memory:');
  return { raw, exec(sql){…}, close(){…}, prepare(sql){ /* bind/first/all/run */ } };
}
```

- **Conventions**: `test/` files are CommonJS (`require`), run by `node --test`. A
  shared helper file must therefore also be CommonJS and use `module.exports`. Name
  it `test/helpers/d1.js` (create the `helpers/` dir). `node --test` only treats
  files matching its test glob as test files; a plain `helpers/d1.js` with no
  `test(...)` calls is just a required module, not a test — good.

## Commands you will need

| Purpose | Command | Expected |
|---------|---------|----------|
| All tests | `npm test` | all pass, same count as before (132 + any from plan 001) |
| One file | `node --test test/combat.integration.test.js` | pass |

## Scope

**In scope:**
- `test/helpers/d1.js` (create — exports `createSqliteD1`, and optionally `createMigratedDb`, `withMockedRandom`, `findCalmRoom`, `seedLiveUser` if they are byte-identical across files)
- `test/workerMigration.test.js`, `test/items.integration.test.js`, `test/combat.integration.test.js` (and `test/resurrection.integration.test.js` if present) — replace local copies with `require('./helpers/d1')`

**Out of scope:**
- Any change to test *assertions* or behavior. This is a pure move; the suite must
  pass identically.
- Helpers that differ between files — if `seedLiveUser` or `findCalmRoom` are NOT
  identical across files, leave those local; only extract the byte-identical ones.

## Git workflow

- Branch: `advisor/002-test-d1-shim`
- Commit: `test: extract shared in-memory D1 shim helper`

## Steps

### Step 1 — Create the shared helper

Create `test/helpers/d1.js`. Move the verbatim `createSqliteD1()` implementation
there (require `sqlite3` at top). Add `createMigratedDb()` (the version that reads
`../../migrations` — note the extra `..` because the file is one dir deeper). Export
everything you move: `module.exports = { createSqliteD1, createMigratedDb, … };`

Before moving `withMockedRandom`/`findCalmRoom`/`seedLiveUser`: diff them across the
test files. Move only the ones that are identical. If one differs, keep it local in
each file and don't export it.

**Verify**: `node -e "require('./test/helpers/d1.js')"` → exits 0, no throw.

### Step 2 — Switch each test file to the shared helper

In each in-scope test file, delete the local copies of the moved helpers and add
`const { createSqliteD1, createMigratedDb /*, … */ } = require('./helpers/d1');`
near the other requires. Mind the relative path: from `test/foo.test.js` it's
`./helpers/d1`. Leave any non-identical local helpers in place.

**Verify after each file**: `node --test test/<that-file>` → pass.

### Step 3 — Full suite

**Verify**: `npm test` → all pass, count unchanged from baseline; then
`grep -rn "new sqlite3.Database(':memory:')" test/` returns matches ONLY in
`test/helpers/d1.js` (no duplicate shim bodies remain).

## Test plan

No new tests. The existing suite is the regression check — it must pass with the
same count before and after. The done-criteria grep proves the duplication is gone.

## Done criteria

- [ ] `npm test` exits 0 with the same test count as before this plan.
- [ ] `grep -rn "new sqlite3.Database(':memory:')" test/` → matches only in `test/helpers/d1.js`.
- [ ] No assertion or test logic changed (`git diff` shows only deletions of helper defs + added requires in test files, plus the new helper file).
- [ ] `advisor-plans/README.md` status row updated.

## STOP conditions

- The shim copies are NOT identical across files (drift): report which differ; extract only the common subset and note the divergence.
- The suite count changes after extraction — a test silently stopped running; STOP and report.

## Maintenance notes

- New test files should `require('./helpers/d1')` rather than re-inlining the shim.
- If the real code starts calling a D1 method the shim doesn't implement (e.g.
  `batch()`), add it once in `test/helpers/d1.js`.
