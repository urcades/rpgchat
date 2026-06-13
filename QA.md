# QA & Release Process

A repeatable checklist for shipping large feature batches (the plan-NNN pushes)
without regressions. Born from an incident where the status panel went blank in
production — see [Why this exists](#why-this-exists).

## TL;DR — after a big feature push

```bash
npm test                 # 1. unit + in-memory integration tests
npm run check:migrations # 2. is the REMOTE D1 schema behind the code? (the gap that bit us)
npm run deploy           # 3. applies remote migrations → deploys → runs the live smoke test
npm run combat-smoke     # 4. two-account live PvP: attack → called shot → sever → drop
/qa https://rpgchat-worker.organelle.workers.dev   # 5. browser-driven gameplay QA (gstack)
/improve                 # 6. read-only advisory audit + improvement plan
```

Steps 1–3 also run automatically in CI ([.github/workflows/ci.yml](.github/workflows/ci.yml)):
every push/PR runs the test suite + a credential-free bundle check, and a push to
`main` auto-deploys (migrate → deploy → smoke) once you set the `CLOUDFLARE_API_TOKEN`
repo secret. Until that secret exists, the deploy job skips cleanly.

If `npm run deploy` is too coupled for your taste, the equivalent manual sequence is:

```bash
npm run db:migrate:remote   # apply migrations to prod D1
npm run deploy              # (predeploy re-checks migrations are applied; harmless no-op)
npm run smoke               # live smoke test against prod
```

## The layers, and what each one can and cannot catch

| Layer | Command | Catches | Blind to |
|-------|---------|---------|----------|
| Unit / integration | `npm test` | Logic bugs, schema-vs-code mismatches **in code** | Whether the *deployed* DB matches the code — the test DB is always freshly migrated |
| Migration drift guard | `npm run check:migrations` | Remote D1 missing migrations the code needs | Runtime behavior |
| Live smoke test | `npm run smoke` | Auth-gated endpoints 500ing, blank panels, dead bindings on the **real** running system | Deep gameplay (combat math, PvP, drops) |
| Browser QA | `/qa <url>` | Visual regressions, broken flows, console errors, interaction bugs | Things you don't think to click |
| Advisory audit | `/improve` | Tech debt, missing coverage, next-step opportunities | Nothing ships from this; it's read-only |

The key insight from the incident: **green unit tests do not mean prod works.**
`npm test` runs against a fresh in-memory SQLite with every migration applied, so
it stays green even when the remote database is several migrations behind the code
that's calling it. Layers 2 and 3 exist specifically to close that gap.

## What `npm run deploy` now does

`deploy` is wired with npm lifecycle hooks so migrations can't drift behind code again:

1. **`predeploy`** → `npm run db:migrate:remote` — applies pending migrations to prod D1.
2. **`deploy`** → `wrangler deploy` — ships the worker.
3. **`postdeploy`** → `npm run smoke` — verifies the live system; non-zero exit fails the deploy loudly.

**Migration ordering caveat:** this applies migrations *before* deploying code, which
is correct for **additive** changes (new tables, new columns with defaults — old code
simply ignores them). For a **destructive/renaming** migration (dropping or renaming a
column the currently-live code still reads), use the expand/contract pattern instead:
ship code that tolerates both shapes first, then migrate, then remove the old path.
Don't blindly `npm run deploy` a destructive migration.

## The smoke test

`scripts/smoke.mjs` signs into a deployed instance as a fixed QA account
(`qa_smoke_bot`) and asserts the endpoints that broke in the incident return
populated data: `/room-state`, `/user-attributes`, `/character`, `/tick`.

```bash
npm run smoke                                  # production (default)
node scripts/smoke.mjs http://localhost:8787   # against `npm run dev`
BASE_URL=https://preview… node scripts/smoke.mjs
```

It's idempotent (creates the QA account once, logs in thereafter). If the QA account
ever dies in-game, login redirects to `/death` and the smoke test reports
`QA account is alive — FAIL`; reset it by deleting the row, e.g.:

```bash
npx wrangler d1 execute DB --remote --command \
  "DELETE FROM users WHERE username='qa_smoke_bot'"
```

(the next smoke run re-creates it).

## The combat smoke test

`scripts/combat-smoke.mjs` is the heavier counterpart: it stands up **two** throwaway
accounts (unique-suffixed per run, so re-runs never reuse a corpse) and drives a real
fight — attacker aims a called shot at the victim's left arm until it severs, which
drops the Fighter's Iron Cleaver to the floor. It asserts the core combat invariants
that solo smoke can't reach: a hit landed, victim total health dropped, the *aimed*
part took the damage, attacker stamina was spent, and the severed limb's gear dropped
into the room's `groundItems`.

```bash
npm run combat-smoke                              # production
node scripts/combat-smoke.mjs http://localhost:8787
MAX_ATTACKS=120 npm run combat-smoke             # force a sever if RNG is unlucky
```

Because it's destructive and leaves throwaway accounts behind, sweep them up
occasionally:

```bash
npx wrangler d1 execute DB --remote --command \
  "DELETE FROM users WHERE username LIKE 'qa_atk_%' OR username LIKE 'qa_vic_%'"
```

## Why this exists

Plans 005 and 006 added migrations `0005`–`0007` (body parts, items, `users.stance`,
`bodyParts.baseMaxHp`). The worker code was deployed, but the migrations were never
applied to the remote D1 database. Every authenticated state query (`getUserState`'s
`SELECT … stance …`, body-part and item reads) hit *"no such column / no such table"*
and returned 500. The chat page's only surviving call was `/tick` — the one endpoint
with no auth and no broken query — so "Global Tick / Phase" rendered while the entire
status, ecology, and message area stayed blank. Unit tests were green the whole time.

`npm run check:migrations` would have caught it in one command; migrate-on-deploy
prevents it structurally; `npm run smoke` would have failed the deploy.
