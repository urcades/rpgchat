export function nowMs() {
  return typeof performance !== 'undefined' && performance.now
    ? performance.now()
    : Date.now();
}

export function elapsedMs(start) {
  return Math.round((nowMs() - start) * 100) / 100;
}

// Normalize an arbitrary thrown value into structured error fields. Error
// instances surface both their message and stack so a caught throw is fully
// diagnosable from the logs; non-Error throws degrade to a stringified message
// with no stack. Spread the result into a logEvent payload for error events.
export function errorFields(err) {
  if (err instanceof Error) {
    return { error: err.message, stack: err.stack };
  }
  return { error: String(err) };
}

export function logEvent(payload) {
  console.log({
    app: 'rpgchat',
    timestamp: new Date().toISOString(),
    ...payload
  });
}

// Error boundary primitive for unguarded async entrypoints (DO alarms, the cron tick,
// fire-and-forget background work). Runs `action`; on success returns its resolved value
// and logs NOTHING (so the happy path is byte-identical). On throw it logs a single
// structured error event — `event: label`, plus any correlation `fields`, plus the
// normalized message + stack + timestamp — and resolves to `fallback` (default
// undefined) so the caller's loop/tick can proceed instead of dying silently.
export async function guard(label, action, { fields = {}, fallback } = {}) {
  try {
    return await action();
  } catch (err) {
    logEvent({ event: label, ...fields, ...errorFields(err) });
    return fallback;
  }
}

export async function measureAsync(callback) {
  const start = nowMs();
  const value = await callback();
  return {
    value,
    durationMs: elapsedMs(start)
  };
}
