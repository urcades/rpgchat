# Plan 004: Add error boundaries + structured logging to async/background work

> **Executor instructions**: Follow step by step; run each verification command.
> Honor STOP conditions. Update this plan's row in `advisor-plans/README.md` when done.
>
> **Drift check (run first)**: `git diff --stat 02e8312..HEAD -- worker/index.mjs`
> If `worker/index.mjs` changed, re-confirm the excerpts below before editing; on a
> mismatch, STOP.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug / ops
- **Planned at**: commit `02e8312`, 2026-06-13

## Why this matters

Three async paths can fail silently in production. None corrupts data (the world
pulse's cleanup is idempotent and `reconcileBodyHealthInvariant` self-heals), but a
failure today is invisible and one path can wedge gameplay:

1. **`runAfterResponse`** background work (broadcasts, hostile-loop spawn) catches
   errors but only `console`-logs them — no structured event, so failures can't be
   alerted on or counted.
2. **`scheduled()`** (the per-minute world cron) has no try/catch around the pulse;
   a throw is lost with no app-level signal that a tick was skipped.
3. **`RoomObject.alarm()`** runs `runHostileRoomAction` then conditionally reschedules
   the alarm; if the action throws, the reschedule is skipped and the platform retries
   the *whole* handler — re-running the NPC action. There's no isolation or logging.

This plan adds try/catch + structured `logEvent` at each boundary so failures are
observable and the hostile loop degrades predictably.

## Current state

- `worker/index.mjs:142-166` — `runAfterResponse(c, payload, callback)`: schedules
  `callback` via `ctx.waitUntil` (or runs it inline) and on error logs with `logEvent`
  /`console`. Confirm exactly how it currently handles the rejection before changing.
- `worker/index.mjs:980-987` — `scheduled(_event, env, ctx)`:
  ```js
  async scheduled(_event, env, ctx) {
    const pulse = runScheduledWorldPulseAndWakeRooms(env);
    if (ctx && typeof ctx.waitUntil === 'function') { ctx.waitUntil(pulse); return; }
    await pulse;
  }
  ```
  No try/catch; `runScheduledWorldPulseAndWakeRooms` is defined near `index.mjs:291`.
- `worker/index.mjs:959-973` — `RoomObject.alarm()`:
  ```js
  async alarm() {
    const room = await this.ctx.storage.get('hostileRoom');
    if (!room) return;
    const result = await runHostileRoomAction(this.env.DB, room.row, room.col); // may throw
    await this.broadcast({ type: 'hostile', room, result });
    if (await roomHasActiveHostiles(this.env.DB, room.row, room.col)) {
      await this.ctx.storage.setAlarm(Date.now() + 5000);
    } else {
      await this.ctx.storage.delete('hostileRoom');
    }
  }
  ```
- `worker/observability.mjs` — exports `logEvent` (already used throughout `index.mjs`,
  e.g. the `action.background`/`action.complete` events). Match its shape:
  `logEvent({ event: '<name>', ... })`.

**`worker/index.mjs` imports `cloudflare:workers` and therefore cannot be imported
under `node --test`.** Verification for this plan is the bundle check + targeted greps,
not new unit tests. Do not attempt to unit-test `index.mjs`.

## Commands

| Purpose | Command | Expected |
|---------|---------|----------|
| Bundle check | `npm run check` | exits 0, prints bindings, "--dry-run: exiting now." |
| Suite (unchanged) | `npm test` | all pass (no new tests; must not regress) |

## Scope

**In scope:** `worker/index.mjs` (the three boundaries above).
**Out of scope:** the contents of `runScheduledWorldPulseAndWakeRooms`,
`runHostileRoomAction`, or broadcast logic — wrap them, don't rewrite them. No new
status enums, no retry queue (explicitly deferred).

## Git workflow
- Branch: `advisor/004-async-error-boundaries`
- Commit: `fix: add error boundaries + structured logging to background/cron/alarm paths`

## Steps

### Step 1 — Structured error event in `runAfterResponse`

Ensure the background callback's rejection is caught and emitted as a structured
event including the `payload` context (action, roomRow, roomCol) and the error
message — e.g. `logEvent({ event: 'action.background.error', ...payload, error: String(err?.message || err) })`. Keep it non-throwing (background work must never surface to the already-sent response).

**Verify**: `grep -n "action.background.error" worker/index.mjs` → matches; `npm run check` → exits 0.

### Step 2 — Wrap the scheduled pulse

In `scheduled()`, wrap the pulse so a throw is logged, not lost. Preserve the
`waitUntil` behavior: `ctx.waitUntil(pulse.catch(err => logEvent({ event: 'world_pulse.error', error: String(err?.message || err) })))`, and in the inline branch wrap the `await` in try/catch with the same `logEvent`. Do not swallow then re-throw (a thrown scheduled handler gains nothing here).

**Verify**: `grep -n "world_pulse.error" worker/index.mjs` → matches; `npm run check` → exits 0.

### Step 3 — Isolate `alarm()` so the loop degrades predictably

Wrap `runHostileRoomAction` + broadcast in try/catch. On error: `logEvent({ event: 'hostile.alarm.error', row: room.row, col: room.col, error: ... })`, then STILL evaluate the reschedule/cleanup so a transient failure doesn't either wedge the loop or trigger an uncaught-throw retry storm. Target shape:

```js
async alarm() {
  const room = await this.ctx.storage.get('hostileRoom');
  if (!room) return;
  try {
    const result = await runHostileRoomAction(this.env.DB, room.row, room.col);
    await this.broadcast({ type: 'hostile', room, result });
  } catch (err) {
    logEvent({ event: 'hostile.alarm.error', row: room.row, col: room.col, error: String(err?.message || err) });
  }
  if (await roomHasActiveHostiles(this.env.DB, room.row, room.col)) {
    await this.ctx.storage.setAlarm(Date.now() + 5000);
  } else {
    await this.ctx.storage.delete('hostileRoom');
  }
}
```

Import `logEvent` into `index.mjs` if not already imported (it is used elsewhere in
the file, so it should be).

**Verify**: `grep -n "hostile.alarm.error" worker/index.mjs` → matches; `npm run check` → exits 0.

## Test plan

No new unit tests (the target file isn't importable under `node --test`). Regression
gate: `npm test` must still pass unchanged. The done-criteria greps prove each
boundary now emits a structured error event.

## Done criteria

- [ ] `npm run check` exits 0.
- [ ] `npm test` exits 0, count unchanged.
- [ ] `grep -nE "action.background.error|world_pulse.error|hostile.alarm.error" worker/index.mjs` → three matches.
- [ ] `alarm()` evaluates reschedule/cleanup even when the hostile action throws.
- [ ] Only `worker/index.mjs` modified (`git status`).
- [ ] `advisor-plans/README.md` row updated.

## STOP conditions

- `roomHasActiveHostiles` is itself the thing that throws (then the reschedule line can also fail): if so, wrap the entire `alarm()` body and always attempt cleanup; note the change.
- `logEvent` is not actually exported/imported where expected: STOP and report rather than inventing a logger.

## Maintenance notes

- These are observability + degradation improvements, not a retry mechanism. If a
  dashboard/alert is later wired to these events, document the event names there.
- A future workerd-based test harness could assert the alarm reschedules after a
  thrown action; not possible with `node --test` today.
- Reviewer: confirm no error path now swallows something that *should* surface to a
  user-facing request (only background/cron/alarm paths are in scope).
