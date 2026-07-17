// DO-stub helpers the routes (and the cron) use to talk to rooms. Split out of
// worker/index.mjs mechanically — no logic change.
import { roomNeedsLoop, runScheduledWorldPulse } from './game.mjs';
import { guard, logEvent } from './observability.mjs';

export function roomName(row, col) {
  return `${row}:${col}`;
}

export async function broadcastRoom(env, row, col, payload) {
  const stub = env.ROOMS.getByName(roomName(row, col));
  await stub.broadcast({
    room: { row, col },
    ...payload
  });
}

export async function startHostileLoopIfNeeded(env, row, col) {
  // Plan 013f: the room loop now also drives proactive NPC chatter, so wake it whenever a
  // room "needs" a loop (combat OR a present human + social NPCs), not just for hostiles.
  if (!await roomNeedsLoop(env.DB, row, col)) {
    return;
  }
  const stub = env.ROOMS.getByName(roomName(row, col));
  await stub.fetch(new Request(`https://room.local/hostiles/${row}/${col}/start`, { method: 'POST' }));
}

// Plan 013a: ask the room's Durable Object to let an NPC react to what a player just
// said. The DO owns env.AI (the model is never touched in a route's latency path) and
// owns broadcast + per-room serialization. Fire-and-forget from runAfterResponse.
export async function npcReactInRoom(env, row, col) {
  const stub = env.ROOMS.getByName(roomName(row, col));
  await stub.fetch(new Request(`https://room.local/npc-react/${row}/${col}`, { method: 'POST' }));
}

export async function wakeActiveRooms(env, pulse) {
  const rooms = pulse.activeRooms || [];
  // Boundary: each room wake is independently guarded so one failure never aborts the
  // others. guard() resolves the action's value (true) on success and the fallback
  // (false) on a caught+logged throw, so the booleans below tally cleanly.
  const outcomes = await Promise.all(rooms.map((room, index) => guard('world-pulse.wake-room.error', async () => {
    // Stagger the wakes so every active room doesn't slam its DO (and, from
    // there, D1) in the same second each minute. Deterministic per position,
    // ~0.5s apart, capped well under the cron window.
    await new Promise(resolve => setTimeout(resolve, Math.min(index * 500, 15000)));
    const stub = env.ROOMS.getByName(roomName(room.row, room.col));
    await stub.fetch(new Request(`https://room.local/world-pulse/${room.row}/${room.col}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'world-pulse',
        tick: pulse.tick,
        environmental: pulse.environmental
      })
    }));
    return true;
  }, { fields: { roomRow: room.row, roomCol: room.col }, fallback: false })));

  // Aggregate summary so a systemic failure (e.g. every room failing) is visible at a
  // glance instead of drowning in per-room error lines.
  const succeeded = outcomes.filter(Boolean).length;
  logEvent({
    event: 'world-pulse.wake-rooms.summary',
    attempted: rooms.length,
    succeeded,
    failed: rooms.length - succeeded
  });
}

export async function runScheduledWorldPulseAndWakeRooms(env) {
  const pulse = await runScheduledWorldPulse(env.DB);
  await wakeActiveRooms(env, pulse);
  return pulse;
}
