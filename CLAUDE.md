# CLAUDE.md

Guidance for working in this repo. RPGChat is a dangerous group chat where every
message is a game action, served as a single Cloudflare Worker.

## Commands

```sh
npm test                  # node --test (in-memory SQLite + all migrations); the gate
npm run check             # wrangler deploy --dry-run; verify bindings + bundle
npm run check:migrations  # static migration sanity check
npm run dev               # wrangler dev --local on :8787
npm run db:migrate:local  # apply D1 migrations to the LOCAL dev DB
npm run db:migrate:remote # apply D1 migrations to PRODUCTION D1
npm run deploy            # wrangler deploy (predeploy runs db:migrate:remote)
npm run smoke             # live smoke vs deployed instance (read/state path)
npm run combat-smoke      # live two-account PvP smoke (core combat loop)
```

`npm test` and `npm run check` must both pass before merging or deploying.

## Architecture

A single Cloudflare Worker, no separate backend. The old local Express/SQLite app
was removed; all development targets the Worker.

- **Worker + Hono** — `worker/index.mjs` is the entrypoint: Hono routes, the
  `RoomObject` Durable Object (imports `DurableObject` from `cloudflare:workers`),
  the cron `scheduled()` handler, and the Stripe webhook / boundary. It is the
  trust boundary; treat request data as untrusted here.
- **D1** — SQLite-backed game state. Schema lives in `migrations/` (sequential
  SQL files). Production D1 is authoritative; the test suite builds a fresh
  in-memory SQLite from the same migrations.
- **Durable Objects** — `RoomObject` (binding `ROOMS`) holds room-local realtime
  state, fans out WebSocket broadcasts, and uses a DO `alarm()` to drive the
  per-room game loop (corpse decay, hostile turns, effect ticks).
- **Cron** — a `* * * * *` trigger (`wrangler.toml [triggers]`) advances the
  global tick and seeds/cleans daily world events.
- **`[ai]` binding (`env.AI`)** — Workers AI, used only for NPC dialogue
  generation. It is **fallback-first**: the generator (`worker/npcVoice.mjs`,
  driven from `worker/game/npc.mjs`) is passed `env.AI` and falls back to canned
  per-role lines (`pickFallback`) if the binding is absent or errors, so the
  Worker runs even on an account without Workers AI enabled. Nothing to "turn on"
  product-side — it's just the free-tier binding.
- **Static frontend** — `worker/static/*.html` (+ `styles.css`), served by the
  `ASSETS` binding with `run_worker_first = true`. Plain HTML with inline
  `<script>` per page (no build step, no framework). `chat.html` is the main
  game view: a reconnecting WebSocket plus a 15s heartbeat poll.

### The game-logic seams + facade (plan adv-005)

`worker/game.mjs` is **not** the game loop anymore — it is a ~175-line **facade**
(barrel) that re-exports the public surface from cohesive seams under
`worker/game/`:

- `combat.mjs` — attacks, abilities, class skills, hostile-room actions,
  elements, hit chance (e.g. `handleAttack`)
- `world.mjs` — rooms, ecology, world events, ticks, presence, leaderboard
  (e.g. `getRoomEcology`, `getUserState`, `getLeaderboard`)
- `body.mjs` — body parts, damage/heal, status effects, condition modifiers
- `inventory.mjs` — items, equip, craft/cook/brew/forge, shop, drop/take, `/give`
- `progression.mjs` — leveling, attribute allocation, the progression grid, jobs
- `death.mjs` — incapacitation, bleed-out, defeat, the cemetery
- `npc.mjs` — NPC ambient/reply behavior, hostile/help classification
- `handlers.mjs` — the per-action HTTP handler wrappers
- `messages.mjs` / `shared.mjs` — message rows + traces; shared primitives
  (`ActionError`, JOBS, body-plan helpers)

Anything importing `from './game.mjs'` (including tests' `import('../worker/game.mjs')`)
keeps working unchanged. Private cross-seam helpers are exported from their home
module but deliberately **not** re-exported by the facade.

### Shared domain modules (`utils/`)

Pure game-domain data/logic shared by the Worker (11 files): `abilities.js`,
`body.js`, `combatFlavor.js`, `items.js`, `jobs.js`, `leveling.js`,
`npcGrowth.js`, `progressionGrid.js`, `recipes.js`, `roomEcology.js`,
`worldEvents.js`.

### Other worker modules

`auth.mjs` (session cookies + crypto), `resurrection.mjs` (paid revival),
`stripe.mjs` (webhook signature verify), `observability.mjs`, `db.mjs`,
`http.mjs`, `localHost.mjs`.

## Testing

- Tests run under bare `node --test` (CommonJS `require`). They build a fresh
  in-memory SQLite and apply every migration, then exercise the worker logic.
- **Shared D1 shim**: `test/.helpers/d1.js` (the dot-dir keeps it out of test
  discovery). Use it instead of re-rolling a SQLite→D1 adapter per file.
- **Known gap — `cloudflare:workers`**: `worker/index.mjs`'s top-level
  `import { DurableObject } from 'cloudflare:workers'` is not resolvable under
  `node --test`, so the Hono app / route closures / DO are **not** importable
  directly. Tests cover the *logic* the routes call (via `game.mjs`) and stub the
  import (`module.registerHooks`) where they must touch route/DO code; there are
  no true end-to-end route tests. This is why the live `smoke` scripts exist.
- Because the suite runs against a *freshly migrated* DB, it stays green even when
  the **remote** D1 schema is stale — it structurally cannot catch a
  missing-column drift. `scripts/smoke.mjs` signs in against the real deployed
  system and asserts the state endpoints return populated data; that is the only
  thing that catches "deployed code references a column the remote DB lacks".

## Deploy model — MIGRATE REMOTE FIRST

Push-to-`main` auto-deploys. **Apply remote migrations BEFORE the deploy**, never
after: a deploy whose code references a column not yet in remote D1 will 500 every
auth-gated request in production. The `predeploy` script runs `db:migrate:remote`
for the `npm run deploy` path; if you deploy by pushing to `main`, run
`npm run db:migrate:remote` manually first.

Per-plan commits land on `main`; ask before pushing; live-verify (smoke) after.

Before configuring a fresh Cloudflare environment: set the `DB` binding
(`wrangler.toml`), the `SESSION_SECRET` secret, and — if paid resurrection is on —
`STRIPE_WEBHOOK_SECRET` (plus optional `RESURRECTION_PAYMENT_LINK_URL` /
`STRIPE_RESURRECTION_PAYMENT_LINK_ID`).

## Conventions / gotchas

- Game verbs stay chat-command-backed (`/stance`, `/give`, …); UI buttons issue
  the same command rather than hitting a bespoke endpoint.
- Stakes are intentionally public/brutal; gang-up damage caps and private
  whispers were considered and deliberately dropped.
- Passwords are plaintext on purpose (pre-production); the login page warns. The
  security gate (hashing, login rate-limiting, cookie `Secure` flag) is
  owner-gated and not done mid-flight.
- The advisor backlog and plans live in `advisor-plans/` (tracked) and `plans/`
  (gitignored product design docs).
