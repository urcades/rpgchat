# RPGChat

RPGChat is a dangerous group chat where messages are game actions. The app now runs as a Cloudflare Worker with D1 for game state and Durable Objects for room-local realtime updates.

The previous local Express/SQLite app has been removed. New development should happen against the Worker code path.

## Runtime

- `worker/index.mjs` contains the Worker routes and room Durable Object.
- `worker/game.mjs` contains the Cloudflare-facing game/action loop.
- `worker/resurrection.mjs` handles paid resurrection requests.
- `worker/static/` contains the HTML/CSS served by the Worker.
- `migrations/` contains D1 schema migrations.
- `utils/jobs.js`, `utils/roomEcology.js`, and `utils/leveling.js` are shared game-domain modules used by the Worker.

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
