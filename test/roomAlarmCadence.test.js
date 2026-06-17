// adv-008: the RoomObject DO alarm()'s CADENCE decision, driven against the real handler.
//
// errorBoundaries.test.js already proves the alarm's error boundaries (a hostile-path throw
// still re-arms; the re-arm tail is itself guarded). This file pins the OTHER half of the
// contract — which cadence the alarm picks on the clean (non-throwing) path:
//   - a hostile room (present player + live hostile NPC)  -> re-arm on the FAST 5s cadence
//   - a peaceful-but-active room (present player + social NPC, no hostiles) -> SLOW 12s
//   - a room that no longer needs the loop -> hostileRoom is cleared, no re-arm
// plus the cross-cutting guarantee that even a throwing hostile turn still reaches setAlarm.
//
// worker/index.mjs is imported under node with `cloudflare:workers` stubbed (the shared
// errorBoundaries pattern); RoomObject is constructed directly with a mocked ctx.storage and
// a real migrated D1.

const assert = require('node:assert/strict');
const test = require('node:test');
const { registerHooks } = require('node:module');
const { createMigratedDb } = require('./.helpers/d1');
const { getWorldDay } = require('../utils/roomEcology');

// --- Stub `cloudflare:workers` so worker/index.mjs is importable under node. ---
const CF_STUB_URL = 'cfstub:workers';
const CF_STUB_SOURCE =
  'export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }';

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'cloudflare:workers') {
      return { url: CF_STUB_URL, shortCircuit: true };
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url === CF_STUB_URL) {
      return { format: 'module', shortCircuit: true, source: CF_STUB_SOURCE };
    }
    return next(url, context);
  }
});

// Suppress logEvent/console output for the duration of fn (alarm() logs ambient/error lines).
async function quiet(fn) {
  const originalLog = console.log;
  const originalError = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

// A mock DO storage that records setAlarm/delete and seeds a hostileRoom.
function mockStorage(hostileRoom = { row: 3, col: 4 }) {
  return {
    _hostileRoom: hostileRoom,
    _alarm: null,
    _deleted: false,
    async get(key) { return key === 'hostileRoom' ? this._hostileRoom : undefined; },
    async setAlarm(time) { this._alarm = time; },
    async getAlarm() { return this._alarm; },
    async delete(key) { if (key === 'hostileRoom') this._deleted = true; }
  };
}

async function seedHuman(db, username, row, col, worldDay) {
  await db.prepare(
    `INSERT INTO users
      (username, password, job, health, maxHealth, stamina, maxStamina, speed, strength, intelligence)
     VALUES (?, 'pw', 'Novice', 12, 12, 100, 100, 1, 1, 1)`
  ).bind(username).run();
  await db.prepare(
    `INSERT INTO roomPresence (username, roomRow, roomCol, lastSeenTick, worldDay, lastSeenAt)
     VALUES (?, ?, ?, 0, ?, CURRENT_TIMESTAMP)`
  ).bind(username, row, col, worldDay).run();
}

async function seedHostileNpc(db, username, row, col, worldDay) {
  await db.prepare(
    `INSERT INTO users
      (username, password, job, health, maxHealth, stamina, maxStamina, speed, strength, intelligence, isNpc, displayName, npcKind, disposition)
     VALUES (?, 'pw', 'Novice', 20, 20, 100, 100, 5, 8, 1, 1, 'Ash Brute', 'hostile', 'hostile')`
  ).bind(username).run();
  await db.prepare(
    `INSERT INTO roomPresence (username, roomRow, roomCol, lastSeenTick, worldDay, lastSeenAt)
     VALUES (?, ?, ?, 0, ?, CURRENT_TIMESTAMP)`
  ).bind(username, row, col, worldDay).run();
}

async function seedSocialNpc(db, username, row, col, worldDay) {
  await db.prepare(
    `INSERT INTO users
      (username, password, job, health, maxHealth, stamina, maxStamina, speed, strength, intelligence, isNpc, displayName, npcKind, disposition)
     VALUES (?, 'pw', 'Novice', 20, 20, 100, 100, 1, 1, 1, 1, 'Barkeep', 'social', 'friendly')`
  ).bind(username).run();
  await db.prepare(
    `INSERT INTO roomPresence (username, roomRow, roomCol, lastSeenTick, worldDay, lastSeenAt)
     VALUES (?, ?, ?, 0, ?, CURRENT_TIMESTAMP)`
  ).bind(username, row, col, worldDay).run();
}

// ---------------------------------------------------------------------------
// Hostile room -> fast 5s cadence (clean path)
// ---------------------------------------------------------------------------

test('alarm cadence: a hostile room re-arms on the fast 5s combat cadence', async () => {
  const mod = await import('../worker/index.mjs');
  const db = await createMigratedDb();
  try {
    const worldDay = getWorldDay();
    await seedHuman(db, 'hero', 3, 4, worldDay);
    await seedHostileNpc(db, 'brute', 3, 4, worldDay);

    const storage = mockStorage({ row: 3, col: 4 });
    const room = new mod.RoomObject({ storage }, { DB: db, AI: {} });
    // Let the hostile turn + broadcast run for real (no forced throw): we want the clean
    // re-arm decision, not the error path.
    room.broadcast = async () => {};

    const before = Date.now();
    await quiet(() => room.alarm());
    const after = Date.now();

    assert.notEqual(storage._alarm, null, 'the combat loop re-armed');
    assert.equal(storage._deleted, false, 'the room is still hostile, so hostileRoom is kept');
    // setAlarm(innerNow + 5000) is computed at some instant inside alarm() with
    // before <= innerNow <= after, so the offset from `before` is in [5000, 5000 + elapsed].
    const delay = storage._alarm - before;
    const elapsed = after - before;
    assert.ok(delay >= 5000 && delay <= 5000 + elapsed + 50, `fast 5s cadence (got ${delay}ms)`);
    assert.ok(delay < 8000, 'clearly the 5s combat cadence, not the 12s peaceful one');
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// Peaceful-but-active room -> slow 12s cadence
// ---------------------------------------------------------------------------

test('alarm cadence: a peaceful room with a present player + social NPC re-arms on the slow 12s cadence', async () => {
  const mod = await import('../worker/index.mjs');
  const db = await createMigratedDb();
  try {
    const worldDay = getWorldDay();
    await seedHuman(db, 'hero', 5, 6, worldDay);
    await seedSocialNpc(db, 'barkeep', 5, 6, worldDay); // social, NOT hostile

    const storage = mockStorage({ row: 5, col: 6 });
    const room = new mod.RoomObject({ storage }, { DB: db, AI: {} });
    room.broadcast = async () => {};

    const before = Date.now();
    await quiet(() => room.alarm());
    const after = Date.now();

    assert.notEqual(storage._alarm, null, 'the ambient loop re-armed');
    assert.equal(storage._deleted, false, 'a present human + social NPC still needs the loop');
    // Offset from `before` is in [12000, 12000 + elapsed]. The >8000 lower bound proves it
    // is the slow peaceful cadence, NOT the 5s combat one.
    const delay = storage._alarm - before;
    const elapsed = after - before;
    assert.ok(delay >= 12000 && delay <= 12000 + elapsed + 50, `slow 12s cadence (got ${delay}ms)`);
    assert.ok(delay > 8000, 'clearly the 12s peaceful cadence, not the 5s combat one');
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// Room no longer needs the loop -> clear hostileRoom, do not re-arm
// ---------------------------------------------------------------------------

test('alarm cadence: when the room no longer needs the loop, hostileRoom is cleared and no alarm is set', async () => {
  const mod = await import('../worker/index.mjs');
  const db = await createMigratedDb();
  try {
    // hostileRoom points at an EMPTY room: no players, no NPCs => roomHasActiveHostiles and
    // roomNeedsLoop are both false. The alarm takes the ambient branch (no-op) and the
    // re-arm tail deletes hostileRoom instead of scheduling another tick.
    const storage = mockStorage({ row: 9, col: 9 });
    const room = new mod.RoomObject({ storage }, { DB: db, AI: {} });
    room.broadcast = async () => { throw new Error('should not broadcast in an empty room'); };

    await quiet(() => room.alarm());

    assert.equal(storage._alarm, null, 'a dead room schedules no further alarm');
    assert.equal(storage._deleted, true, 'hostileRoom was cleared so the loop stops');
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// Cross-cutting: even a throwing hostile turn still reaches setAlarm on the 5s cadence
// ---------------------------------------------------------------------------

test('alarm cadence: a throwing hostile turn STILL reaches setAlarm (boundary + fast cadence)', async () => {
  const mod = await import('../worker/index.mjs');
  const db = await createMigratedDb();
  try {
    const worldDay = getWorldDay();
    await seedHuman(db, 'hero', 3, 4, worldDay);
    await seedHostileNpc(db, 'brute', 3, 4, worldDay);

    const storage = mockStorage({ row: 3, col: 4 });
    const room = new mod.RoomObject({ storage }, { DB: db, AI: {} });
    // Force the hostile branch to throw AFTER the action ran (broadcast is the tail).
    let broadcastCalls = 0;
    room.broadcast = async () => { broadcastCalls += 1; throw new Error('socket exploded'); };

    const before = Date.now();
    const { logs } = await captureQuiet(() => room.alarm());

    const after = Date.now();
    assert.equal(broadcastCalls, 1, 'the hostile branch reached broadcast (then threw)');
    assert.ok(logs.some(r => r && r.event === 'alarm.hostile.error'), 'the throw was caught + logged');
    assert.notEqual(storage._alarm, null, 'the re-arm tail still ran despite the throw');
    // peaceful is fixed to false BEFORE the throwing action, so the re-arm uses the fast 5s
    // cadence even though the hostile turn failed.
    const delay = storage._alarm - before;
    const elapsed = after - before;
    assert.ok(delay >= 5000 && delay <= 5000 + elapsed + 50, `re-armed on the fast 5s cadence (got ${delay}ms)`);
    assert.ok(delay < 8000, 'fast cadence, not the peaceful one');
  } finally {
    await db.close();
  }
});

// Like quiet(), but captures the structured log records emitted during fn so a test can
// assert on the boundary's error event.
async function captureQuiet(fn) {
  const logs = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args) => { logs.push(args[0]); };
  console.error = () => {};
  try {
    const value = await fn();
    return { value, logs };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}
