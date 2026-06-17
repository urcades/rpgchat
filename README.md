# RPGChat

RPGChat is a dangerous group chat where messages are game actions. The app now runs as a Cloudflare Worker with D1 for game state and Durable Objects for room-local realtime updates.

The previous local Express/SQLite app has been removed. New development should happen against the Worker code path.

## Runtime

- `worker/index.mjs` contains the Hono routes, the `RoomObject` Durable Object
  (room-local realtime + WebSocket fan-out, driven by a DO `alarm()` game loop),
  the cron-triggered `scheduled()` handler (a `* * * * *` tick that advances the
  world and seeds daily events), and the Stripe webhook boundary.
- `worker/game.mjs` is a stable ~175-line **facade** (plan adv-005): it re-exports
  the public surface from cohesive seams under `worker/game/` — `combat.mjs`,
  `world.mjs` (rooms/ecology/ticks/presence/leaderboard), `body.mjs`,
  `inventory.mjs`, `progression.mjs`, `death.mjs`, `npc.mjs`, `handlers.mjs`,
  `messages.mjs`, `shared.mjs`. Imports `from './game.mjs'` keep working unchanged.
- `worker/npcVoice.mjs` generates NPC dialogue via the optional `[ai]`
  (Workers AI, `env.AI`) binding, falling back to canned per-role lines.
- `worker/resurrection.mjs` handles paid resurrection requests; `worker/stripe.mjs`
  verifies the webhook signature; `worker/auth.mjs` handles session cookies.
- `worker/static/` contains the HTML/CSS served by the Worker — including the
  chat view, the world map, the progression grid, the leaderboard, and the
  cemetery.
- `migrations/` contains D1 schema migrations.
- `utils/` holds the shared, pure game-domain modules used by the Worker (11):
  `abilities.js`, `body.js`, `combatFlavor.js`, `items.js`, `jobs.js`,
  `leveling.js`, `npcGrowth.js`, `progressionGrid.js`, `recipes.js`,
  `roomEcology.js`, `worldEvents.js`.

## Local Development

1. Install dependencies:

   ```sh
   npm install
   ```

2. Apply local D1 migrations:

   ```sh
   npm run db:migrate:local
   ```

3. Start the Worker locally:

   ```sh
   npm run dev
   ```

4. Open:

   ```text
   http://localhost:8787
   ```

## Deployment

Deploy to Cloudflare with:

```sh
npm run deploy
```

Before deploying a fresh Cloudflare environment, configure:

- the D1 database binding in `wrangler.toml`
- the `SESSION_SECRET` Worker secret
- `STRIPE_WEBHOOK_SECRET` if paid resurrection is enabled
- optionally `RESURRECTION_PAYMENT_LINK_URL`
- optionally `STRIPE_RESURRECTION_PAYMENT_LINK_ID`

Apply remote D1 migrations with:

```sh
npm run db:migrate:remote
```

## Checks

Run the test suite:

```sh
npm test
```

Run a Wrangler deploy dry-run:

```sh
npm run check
```

Both should pass before merging or deploying.

## Current Production URL

```text
https://rpgchat-worker.organelle.workers.dev
```

## Safety Note

This game still uses intentionally simple username/password behavior. Do not reuse real passwords here. Messages and player records should be treated as public playtest data until a later security pass hardens authentication and data handling.
