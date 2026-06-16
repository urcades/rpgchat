# Campaign A — Totalizing Hardening Pass

> **Orchestrator:** Claude (Opus 4.8, main loop). **Authored:** 2026-06-15, against
> `HEAD = 05efdf4`. **Mandate (owner, this session):** embark on the *totality* of
> group A (the `advisor-plans/` hardening backlog) as a "totalizing /improve pass on
> the entire codebase," and **do not stop until every item is fully done.**
>
> **Owner decisions baked in (do not re-litigate):**
> - **Scope:** a fresh `/improve deep` audit of the whole codebase FIRST, then execute
>   all of A **plus any new CRITICAL findings** the audit surfaces. Lower-priority new
>   findings get filed in `advisor-plans/README.md`, not necessarily executed this run.
> - **Goals format:** explicit goal lists (this doc) **+** the Task system as the live ledger.
> - **Push policy:** **full autonomy** — commit + push + auto-deploy each item as it lands,
>   no per-item approval gate. (Per `deploy-model` memory: push-to-main auto-deploys; any
>   migration applies to remote FIRST, expand-then-deploy.)

---

## Orchestrator meta-goals (mine)

- **MG-1 · Totality.** Drive `adv-002`, `adv-003`, `adv-004`, `adv-005`, `adv-001B`, and
  every audit-surfaced **CRITICAL**, to full completion. "Done" = merged to `main`, suite
  green **and grown**, pushed, auto-deployed, live-verified. Do not hand back or declare
  victory until *every* item clears that bar.
- **MG-2 · Correctness ratchet.** The test suite (263 today) only ever grows. Never merge a
  wave that reds a test or breaks `wrangler deploy --dry-run`. Run the FULL suite after every
  merge; run `smoke` + `combat-smoke` after any worker-runtime change reaches prod.
- **MG-3 · Safe parallelism.** Fan out executor subagents on **disjoint file sets** in isolated
  git worktrees; **serialize** anything sharing a file (`worker/index.mjs`, `worker/game.mjs`).
  Integrate branches sequentially on `main` with a green suite between merges. Two agents must
  never edit the same file concurrently.
- **MG-4 · Live ledger.** The Task system is the single source of truth for what's left.
  `in_progress` on start; `completed` only when the bar is met. Keep this doc + `advisor-plans/README.md`
  statuses current as items land.
- **MG-5 · Deploy autonomy (granted).** Commit + push + auto-deploy each item as it lands.
  Migrations (if a new item needs one) apply to remote FIRST, then push. Live-verify each deploy.
- **MG-6 · Surface, don't absorb.** Report at phase/wave boundaries (audit results; each wave's
  merge + verify). Surface any blocker, scope surprise, or audit critical immediately. Otherwise
  keep moving.

## Completion bar

The campaign is **done** only when ALL of the following are merged to `main`, pushed, deployed,
and the full suite + `smoke` + `combat-smoke` are green on the deployed build:

| Item | What | Effort |
|---|---|---|
| **adv-002** | Extract the shared test D1 shim (`createSqliteD1`, duplicated in 28/38 test files) | S |
| **adv-003** | Tests for untested HTTP action paths (job-change, leveling-on-action, inn-pay) | S |
| **adv-004** | Error boundaries + structured logging on async paths (`runAfterResponse`, cron `scheduled()`, DO `alarm()`) | M |
| **adv-005** | Split `worker/game.mjs` (4,937 lines) behind a stable facade | L |
| **adv-001B** | Extract + test the Stripe signature verifier (`verifyStripeWebhook`/`computeStripeSignature`) | S |
| **(criticals)** | Any CRITICAL surfaced by the Phase 0 audit, slotted by file-overlap into the waves below | TBD |

## Phases & wave DAG

```
Phase 0 — Fresh /improve deep audit  (≤8 read-only Explore agents, one per category)
          → I vet every finding against the code myself → fold CRITICALs into the waves below.

Wave 1 (parallel · disjoint files):
   adv-002  [test/* + new test/helpers/d1.mjs]        ─┐
   adv-001B [worker/index.mjs Stripe path → new module]├─→ merge 002, then 001B; suite green; push
                                                        ─┘
Wave 2 (parallel · disjoint files, after Wave 1):
   adv-003  [test/* new files, imports the shared shim] ─┐
   adv-004  [worker/index.mjs async boundaries + util]   ├─→ merge both; suite green; push + smoke
                                                          ─┘
Wave 3 (solo · touches everything that imports game.mjs):
   adv-005  [worker/game.mjs → modules behind a facade]  ──→ merge; full suite + smoke + combat-smoke; push
```

**Why this order:** `adv-002` establishes `test/helpers/d1.mjs`, which `003`/`001B` import — so
it lands first. `001B` and `004` both edit `worker/index.mjs`, so they cannot run together —
`001B` (Wave 1) lands before `004` (Wave 2). `005` restructures `game.mjs` and rewrites imports
repo-wide, so it goes **last and alone** to avoid rebasing every other branch on top of it.

### Integration protocol (per executor branch)

1. Executor subagent works in an **isolated worktree** on a branch `adv/<id>-<slug>`; implements,
   adds/updates tests, runs `npm test` in-worktree, commits to its branch. **Does not** merge/push/deploy.
2. Orchestrator (me) merges the branch into `main`, runs the **full** `npm test`, then
   `wrangler deploy --dry-run`. On any red: fix-forward or bounce back to a fresh executor with the diff.
3. Green → push `main` (auto-deploys). For worker-runtime waves, run `smoke` (+ `combat-smoke` for
   combat-touching changes) against prod; on red, hotfix immediately.
4. Update the Task ledger + this doc + `advisor-plans/README.md` statuses.

---

## Per-subagent goal briefs

Each executor is a fresh-context subagent. Its prompt embeds the goal list below **and** points it
at the full, self-contained plan file in `advisor-plans/` (refreshed by the Phase 0 audit). Briefs
are objectives + boundaries; the plan file carries the line-level spec.

### Executor brief · adv-002 (test D1 shim)
- **Goal:** Replace the `createSqliteD1` + `createMigratedDb` boilerplate duplicated across 28 test
  files with one shared module `test/helpers/d1.mjs`; every test imports it; behavior identical.
- **In scope:** `test/**`, new `test/helpers/d1.mjs`. **Out of scope:** all of `worker/**`, `migrations/**`.
- **Done:** `npm test` green with the SAME test count as before (no tests lost); `grep -rl 'function createSqliteD1' test/` returns only the helper.
- **Escape hatch:** if any test relied on a subtly different shim variant, preserve its behavior via an option on the shared helper — do not silently change semantics; note it.

### Executor brief · adv-001B (Stripe signature verifier)
- **Goal:** Extract `verifyStripeWebhook` / `computeStripeSignature` out of the webhook handler into a
  testable module (`worker/stripe.mjs` or sibling), and add unit tests (valid sig, bad sig, missing
  header, replayed timestamp). Behavior on the live path is unchanged.
- **In scope:** `worker/index.mjs` (the Stripe webhook path only), new `worker/stripe.mjs`, new `test/stripe.*.test.js` (import `test/helpers/d1.mjs` once adv-002 lands). **Out of scope:** `worker/game.mjs`, resurrection fulfillment logic (that was adv-001 Part A — already shipped).
- **Done:** `npm test` green (+ new sig tests); the webhook route behaves identically (signature still enforced).
- **Escape hatch:** never print or log a real signing secret (reference env var by name only).

### Executor brief · adv-003 (action-path tests)
- **Goal:** Cover the untested authenticated HTTP action paths: job change, XP/leveling-on-action,
  inn-access pay. Assert both the authz gate and the state mutation.
- **In scope:** new `test/*.test.js` files importing `test/helpers/d1.mjs`. **Out of scope:** any `worker/**` change — this is **tests only**; if a route is too coupled to test without a refactor, STOP and report (do not refactor source here).
- **Done:** `npm test` green with new coverage for `/job`, leveling on chat/attack/skill, `/room-access/pay`.

### Executor brief · adv-004 (async error boundaries)
- **Goal:** Wrap the three unguarded async paths — `runAfterResponse`, cron `scheduled()`, DO `alarm()` —
  so a thrown error is caught, logged with structure (route/room/tick context), and (for `alarm()`) the
  reschedule still happens. Add a tiny logging helper.
- **In scope:** `worker/index.mjs`, new `worker/log.mjs` (or similar). **Out of scope:** `worker/game.mjs` internals (wrap calls into it; don't edit it — adv-005 owns that file), `worker/resurrection.mjs`.
- **Done:** `npm test` green (+ tests proving a thrown handler is caught and the alarm still re-arms); `smoke` green post-deploy.
- **Escape hatch:** preserve existing behavior on the happy path exactly; the boundary only adds catch+log+continue.

### Executor brief · adv-005 (split game.mjs)
- **Goal:** Split the 4,937-line `worker/game.mjs` into cohesive modules behind a **stable facade**
  (`worker/game.mjs` keeps re-exporting the same public API so `index.mjs` and tests don't change).
  Seams: combat / body / inventory / room-ecology / npc / progression / commands.
- **In scope:** `worker/game.mjs` → new `worker/game/*.mjs`; the facade. **Out of scope:** behavior changes of ANY kind — pure mechanical move + re-export. No logic edits, no signature changes.
- **Done:** `npm test` green with the **exact same** count and assertions (zero test edits ideally); `wrangler deploy --dry-run` clean; `smoke` + `combat-smoke` green post-deploy.
- **Escape hatch:** if a true circular dependency blocks a clean split, STOP and report the cycle with file:line rather than introducing a behavior change to break it.

### Phase 0 audit results — vetted 2026-06-15

7 read-only Explore agents swept correctness, security, performance, test-coverage, tech-debt/architecture,
deps/migrations, DX/docs (HEAD `05efdf4`). I opened every cited line to vet. Verdict:

**No NEW standalone critical.** The lone candidate — CORRECTNESS-001 ("null-deref when a player kills a
non-hostile NPC via handleAttack", `game.mjs:3774`/`:3840`) — is a **FALSE POSITIVE**: the re-read at `:3774`
runs BEFORE `descendTowardDeath`/`defeatNpc` (`:3824`), so `attackedUser` is a pre-death snapshot and is
non-null at `:3840`. Rejected.

**Security: zero findings** — SQL fully parameterized, frontend renders via `textContent`/`escapeHtml`,
sessions HMAC-signed + constant-time compare, Stripe path timing-safe, NPC model output advisory-only. Clean.

**Real findings fold into the existing A-plans (no scope explosion):**
- **adv-004** absorbs the confirmed reliability bug: `runHostileRoomAction` in the DO `alarm()` (`index.mjs:1165`)
  is unguarded while `runNpcAmbient` is wrapped — a throw kills the room's combat loop (never re-arms). Cron
  `scheduled()` (`:1190`) and `wakeActiveRooms` (swallows per-room errors) are also unguarded; logging lacks
  stack traces + timestamps. adv-004 now explicitly covers all three entrypoints, building on `worker/observability.mjs`.
- **adv-001B** also folds ARCH-002: the duplicated resurrection-user INSERT (`resurrection.mjs ~:42 & ~:143`) → a private helper.
- **adv-003** broadens to add the security-adjacent untested auth crypto (`auth.mjs` sign/verify/constantTimeEqual/parseCookie
  — TEST-002, MED risk) + login/signup negative cases + coordinate validation, alongside job/leveling/inn-pay.
- **adv-005** uses the audit's SEAM MAP (ARCH-001: combat / body / inventory / npc / room-ecology / progression /
  commands / death, with cross-seam deps) as its split blueprint, + the no-reverse-import guard comments (ARCH-008).

**Deferred to backlog** (real but NOT critical — recorded in `advisor-plans/README.md`, not executed this run):
combat/loop query-perf cluster, hot-path index additions, minor dep bumps, dev-only npm-audit advisories,
architecture follow-ons (getUser query-helper, index.mjs layering, command-handler dedup), DX/docs polish.

---

## Ledger

Live in the Task system (this session). Tasks mirror the items above with the wave dependencies encoded.
This doc is the durable narrative; the Task list is the operational truth.
