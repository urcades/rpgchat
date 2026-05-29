export function nowMs() {
  return typeof performance !== 'undefined' && performance.now
    ? performance.now()
    : Date.now();
}

export function elapsedMs(start) {
  return Math.round((nowMs() - start) * 100) / 100;
}

export function logEvent(payload) {
  console.log({
    app: 'rpgchat',
    ...payload
  });
}

export async function measureAsync(callback) {
  const start = nowMs();
  const value = await callback();
  return {
    value,
    durationMs: elapsedMs(start)
  };
}
