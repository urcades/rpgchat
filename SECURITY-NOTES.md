# Security notes

## Accepted `npm audit` findings (dev-toolchain only)

`npm audit` currently reports **11 vulnerabilities (8 high, 3 low)**. **Every one of
them lives in the dev/build toolchain — `wrangler` and `sqlite3` and their transitive
deps — and none ship in the deployed Cloudflare Worker.**

The Worker's only runtime dependency is `hono`, which has **zero** advisories. The
Worker is bundled by `wrangler deploy` (esbuild) and runs on the Workers runtime; the
flagged packages (`ws`, `miniflare`, `esbuild`, `tar`, `node-gyp`, `cacache`,
`make-fetch-happen`, `@tootallnate/once`, `http-proxy-agent`) are only used locally for
`wrangler dev`, the test sandbox, and native-addon builds. They are not in the upload.

### ⛔️ Do NOT run `npm audit fix --force`

It **downgrades `wrangler` to 4.63.0** (an older major-ish line) to satisfy the
advisory resolver, which is a real regression for a non-runtime risk. Remediate by
bumping **forward** (`npm install wrangler@latest hono@latest`) when upstream ships
fixes, never by force-fixing.

### The findings, and why each is accepted

All paths are dev-only; "Reachable at runtime" is **No** for every row.

| Package | Severity | Pulled in by | Why it's not a runtime risk |
| --- | --- | --- | --- |
| `wrangler` | high | (devDependency) | Build/deploy CLI; not bundled into the Worker. Flagged transitively via `esbuild` + `miniflare`. |
| `miniflare` | high | `wrangler` | Local Workers simulator (`wrangler dev` / tests). Flagged via `ws`. Never deployed. |
| `ws` | high | `wrangler` → `miniflare` | WebSocket lib for the local dev server only (memory-exhaustion DoS against a local listener). |
| `esbuild` | low | `wrangler` | Bundler. Advisory is a dev-server arbitrary-file-read **on Windows**; we don't run the esbuild dev server. |
| `sqlite3` | high | (devDependency) | Native SQLite used only by the local test/dev harness. Worker uses D1, not `sqlite3`. |
| `node-gyp` | high | `sqlite3` | Native-addon build tool. Build-time only. Flagged via `make-fetch-happen` + `tar`. |
| `make-fetch-happen` | high | `sqlite3` → `node-gyp` | npm-internal fetch used during native builds. Flagged via `cacache` + `http-proxy-agent`. |
| `cacache` | high | `sqlite3` → `node-gyp` | Build-cache for native installs. Flagged via `tar`. |
| `tar` | high | `sqlite3`, `node-gyp` | Archive extraction during `npm install` of native deps (path-traversal class). Build-time only. |
| `@tootallnate/once` | low | `sqlite3` → `node-gyp` → `http-proxy-agent` | Tiny promise helper on the build-time proxy-agent path. |
| `http-proxy-agent` | low | `sqlite3` → `node-gyp` → `make-fetch-happen` | Proxy agent for build-time fetches. Not in the Worker. |

> The exact set shifts as advisories are published/merged upstream; regenerate with
> `npm audit` after a `wrangler`/`sqlite3` bump. The invariant that matters:
> **`hono` (the sole runtime dep) stays clean, and the highs remain confined to the
> dev toolchain.** If a high ever appears under a *runtime* path, it must be fixed, not
> accepted.

### How to re-verify

```sh
npm ci
npm audit                         # counts should be dev-toolchain only
npm ls hono                       # the only runtime dep; must be advisory-free
npx wrangler deploy --dry-run     # confirms what actually bundles
```
