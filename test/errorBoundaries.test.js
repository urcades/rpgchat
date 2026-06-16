// adv-004: error boundaries + structured logging for the unguarded async entrypoints.
//
// Two layers of coverage:
//   A. observability.mjs primitives (logEvent timestamp, errorFields stack, guard
//      catch/log/continue) — imported directly; no loader needed.
//   B. The REAL worker/index.mjs entrypoints (`scheduled` cron + DO `alarm`). index.mjs
//      imports `cloudflare:workers`, which the bare `node --test` loader cannot resolve,
//      so we register an in-thread module hook that stubs `cloudflare:workers` with a
//      no-op DurableObject base class, then drive the real handlers with a real migrated
//      D1 and a mocked ctx.storage. node runs each test file in its own process, so the
//      hook never leaks into the rest of the suite.

const assert = require('node:assert/strict');
const test = require('node:test');
const { registerHooks } = require('node:module');
const { createMigratedDb, createSqliteD1 } = require('./.helpers/d1');

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

// Capture everything logEvent/console writes during `fn`, restoring the originals after.
async function captureLogs(fn) {
  const logs = [];
  const errors = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args) => { logs.push(args[0]); };
  console.error = (...args) => { errors.push(args); };
  try {
    const value = await fn();
    return { value, logs, errors };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

// ---------------------------------------------------------------------------
// A. observability.mjs primitives
// ---------------------------------------------------------------------------

test('logEvent stamps every payload with app + ISO timestamp', async () => {
  const { logEvent } = await import('../worker/observability.mjs');
  const { logs } = await captureLogs(() => logEvent({ event: 'unit.test', extra: 1 }));

  assert.equal(logs.length, 1);
  const record = logs[0];
  assert.equal(record.app, 'rpgchat');
  assert.equal(record.event, 'unit.test');
  assert.equal(record.extra, 1);
  assert.equal(typeof record.timestamp, 'string');
  // Round-trips as a valid ISO instant.
  assert.equal(new Date(record.timestamp).toISOString(), record.timestamp);
});

test('logEvent lets a caller override the default timestamp', async () => {
  const { logEvent } = await import('../worker/observability.mjs');
  const { logs } = await captureLogs(() => logEvent({ event: 'x', timestamp: 'fixed' }));
  assert.equal(logs[0].timestamp, 'fixed');
});

test('errorFields extracts message + stack from an Error', async () => {
  const { errorFields } = await import('../worker/observability.mjs');
  const err = new Error('boom');
  const fields = errorFields(err);

  assert.equal(fields.error, 'boom');
  assert.equal(typeof fields.stack, 'string');
  assert.ok(fields.stack.includes('boom'));
});

test('errorFields stringifies a non-Error throw and omits a stack', async () => {
  const { errorFields } = await import('../worker/observability.mjs');
  const fields = errorFields('plain string failure');

  assert.equal(fields.error, 'plain string failure');
  assert.equal('stack' in fields, false);
});

test('guard returns the action value and logs nothing on success', async () => {
  const { guard } = await import('../worker/observability.mjs');
  const { value, logs } = await captureLogs(() => guard('should.not.log', async () => 42));

  assert.equal(value, 42);
  assert.equal(logs.length, 0, 'happy path must be byte-identical: no extra log');
});

test('guard catches a throw, logs a structured error, and returns the fallback', async () => {
  const { guard } = await import('../worker/observability.mjs');
  const { value, logs } = await captureLogs(() => guard(
    'thing.error',
    async () => { throw new Error('kaboom'); },
    { fields: { roomRow: 4, roomCol: 7 }, fallback: 'fell-back' }
  ));

  assert.equal(value, 'fell-back');
  assert.equal(logs.length, 1);
  const record = logs[0];
  assert.equal(record.event, 'thing.error');
  assert.equal(record.roomRow, 4);
  assert.equal(record.roomCol, 7);
  assert.equal(record.error, 'kaboom');
  assert.ok(record.stack.includes('kaboom'), 'error log carries a stack trace');
  assert.ok(record.timestamp, 'error log carries a timestamp');
});

test('guard never propagates the throw to its caller', async () => {
  const { guard } = await import('../worker/observability.mjs');
  // If guard rethrew, this would reject and fail the test.
  await captureLogs(async () => {
    const result = await guard('swallow.error', async () => { throw new Error('nope'); });
    assert.equal(result, undefined, 'default fallback is undefined');
  });
});

test('guard fallback defaults to undefined when omitted', async () => {
  const { guard } = await import('../worker/observability.mjs');
  const { value } = await captureLogs(() => guard('e', async () => { throw new Error('x'); }));
  assert.equal(value, undefined);
});

// ---------------------------------------------------------------------------
// B. Real worker/index.mjs entrypoints
// ---------------------------------------------------------------------------

test('cron scheduled() catches a world-pulse throw, logs it, and never rejects', async () => {
  const mod = await import('../worker/index.mjs');

  // A DB whose prepare() throws makes the REAL runScheduledWorldPulse throw on its first
  // query (cleanupOldWorldDayData), exercising the scheduled() boundary end to end.
  const throwingDb = {
    prepare() { throw new Error('d1 unavailable'); },
    exec() { throw new Error('d1 unavailable'); }
  };
  const env = { DB: throwingDb };

  let waited;
  const ctx = { waitUntil(promise) { waited = promise; } };

  const { logs } = await captureLogs(async () => {
    // Must not throw even though the underlying work does.
    await assert.doesNotReject(() => mod.default.scheduled({}, env, ctx));
    // waitUntil received the boundary-wrapped promise; awaiting it must also not reject.
    assert.ok(waited, 'scheduled() handed a promise to waitUntil');
    await assert.doesNotReject(() => waited);
  });

  const errorLog = logs.find(record => record && record.event === 'scheduled.error');
  assert.ok(errorLog, 'a scheduled.error event was logged');
  assert.equal(errorLog.error, 'd1 unavailable');
  assert.ok(errorLog.stack, 'scheduled.error carries a stack');
  assert.ok(errorLog.timestamp, 'scheduled.error carries a timestamp');
  // The boundary swallowed the failure: no success event for this tick.
  assert.equal(logs.some(record => record && record.event === 'scheduled.complete'), false);
});

test('cron scheduled() logs scheduled.complete on the happy path (no error event)', async () => {
  const mod = await import('../worker/index.mjs');
  const db = await createMigratedDb();
  try {
    // ROOMS is only touched when there are active rooms; a migrated DB has none, so
    // wakeActiveRooms makes zero stub calls and the tick completes cleanly.
    const env = { DB: db, ROOMS: { getByName() { throw new Error('should not be called'); } } };
    // scheduled() hands the work to waitUntil and returns immediately; capture and await
    // that promise so the pulse finishes (and logs land) before we assert / close the DB.
    let waited;
    const { logs } = await captureLogs(async () => {
      await mod.default.scheduled({}, env, { waitUntil(p) { waited = p; } });
      await waited;
    });

    assert.ok(logs.some(r => r && r.event === 'scheduled.complete'), 'happy path logs completion');
    assert.equal(logs.some(r => r && r.event === 'scheduled.error'), false, 'no error on happy path');
    // wakeActiveRooms still emits its aggregate summary, attempting zero rooms.
    const summary = logs.find(r => r && r.event === 'world-pulse.wake-rooms.summary');
    assert.ok(summary);
    assert.deepEqual(
      { attempted: summary.attempted, succeeded: summary.succeeded, failed: summary.failed },
      { attempted: 0, succeeded: 0, failed: 0 }
    );
  } finally {
    await db.close();
  }
});

test('DO alarm() re-arms after the hostile action path throws', async () => {
  const mod = await import('../worker/index.mjs');
  const { getWorldDay } = require('../utils/roomEcology');
  const db = await createMigratedDb();
  try {
    const worldDay = getWorldDay();
    // A present (fresh) player + a live hostile NPC in the same room => roomHasActiveHostiles
    // and roomNeedsLoop both return true, so the alarm takes the hostile branch and, after
    // the boundary, must re-arm.
    await db.prepare(
      `INSERT INTO users
        (username, password, job, health, maxHealth, stamina, maxStamina, speed, strength, intelligence)
       VALUES ('hero', 'pw', 'Novice', 12, 12, 100, 100, 1, 1, 1)`
    ).run();
    await db.prepare(
      `INSERT INTO users
        (username, password, job, health, maxHealth, stamina, maxStamina, speed, strength, intelligence, isNpc, displayName, npcKind, disposition)
       VALUES ('brute', 'pw', 'Novice', 20, 20, 100, 100, 5, 8, 1, 1, 'Ash Brute', 'hostile', 'hostile')`
    ).run();
    await db.prepare(
      `INSERT INTO roomPresence (username, roomRow, roomCol, lastSeenTick, worldDay, lastSeenAt)
       VALUES ('hero', 3, 4, 0, ?, CURRENT_TIMESTAMP), ('brute', 3, 4, 0, ?, CURRENT_TIMESTAMP)`
    ).bind(worldDay, worldDay).run();

    // Mock DO storage. hostileRoom is set; setAlarm/delete are recorded.
    const storage = {
      _hostileRoom: { row: 3, col: 4 },
      _alarm: null,
      _deleted: false,
      async get(key) { return key === 'hostileRoom' ? this._hostileRoom : undefined; },
      async setAlarm(time) { this._alarm = time; },
      async getAlarm() { return this._alarm; },
      async delete(key) { if (key === 'hostileRoom') this._deleted = true; }
    };

    const room = new mod.RoomObject({ storage }, { DB: db, AI: {} });
    // Force the boundary: the hostile branch ends with `await this.broadcast(...)`. Make
    // broadcast throw so the guarded block fails AFTER runHostileRoomAction ran for real.
    let broadcastCalls = 0;
    room.broadcast = async () => { broadcastCalls += 1; throw new Error('socket exploded'); };

    const { logs } = await captureLogs(async () => {
      // The whole alarm tick must settle without throwing despite the broadcast failure.
      await assert.doesNotReject(() => room.alarm());
    });

    assert.equal(broadcastCalls, 1, 'hostile branch reached broadcast (then threw)');
    // The boundary logged the hostile failure with structured fields.
    const hostileErr = logs.find(r => r && r.event === 'alarm.hostile.error');
    assert.ok(hostileErr, 'alarm.hostile.error logged');
    assert.equal(hostileErr.error, 'socket exploded');
    assert.equal(hostileErr.roomRow, 3);
    assert.equal(hostileErr.roomCol, 4);
    assert.ok(hostileErr.stack, 'hostile error carries a stack');

    // THE KEY ASSERTION: the re-arm tail still ran after the caught throw, so the combat
    // loop survives. roomNeedsLoop is still true (hostile + present player) => setAlarm on
    // the fast 5s cadence, and hostileRoom was NOT deleted.
    assert.notEqual(storage._alarm, null, 'alarm was re-armed after the hostile throw');
    assert.equal(storage._deleted, false, 'hostileRoom was kept (room still needs the loop)');
    const delay = storage._alarm - Date.now();
    assert.ok(delay > 0 && delay <= 5000, `re-armed on the combat cadence (got ${delay}ms)`);
  } finally {
    await db.close();
  }
});

test('DO alarm() with no hostileRoom does nothing and never re-arms', async () => {
  const mod = await import('../worker/index.mjs');
  const storage = {
    _alarm: null,
    async get() { return undefined; },
    async setAlarm(t) { this._alarm = t; },
    async delete() {}
  };
  const room = new mod.RoomObject({ storage }, { DB: createSqliteD1(), AI: {} });
  room.broadcast = async () => { throw new Error('should never broadcast'); };

  await captureLogs(() => assert.doesNotReject(() => room.alarm()));
  assert.equal(storage._alarm, null, 'no room => early return, no alarm scheduled');
});

test('DO alarm() re-arm tail still runs (and is itself guarded) when roomNeedsLoop throws', async () => {
  const mod = await import('../worker/index.mjs');
  const { getWorldDay } = require('../utils/roomEcology');
  const db = await createMigratedDb();
  try {
    const worldDay = getWorldDay();
    await db.prepare(
      `INSERT INTO users
        (username, password, job, health, maxHealth, stamina, maxStamina, speed, strength, intelligence)
       VALUES ('hero', 'pw', 'Novice', 12, 12, 100, 100, 1, 1, 1)`
    ).run();
    await db.prepare(
      `INSERT INTO users
        (username, password, job, health, maxHealth, stamina, maxStamina, speed, strength, intelligence, isNpc, displayName, npcKind, disposition)
       VALUES ('brute', 'pw', 'Novice', 20, 20, 100, 100, 5, 8, 1, 1, 'Ash Brute', 'hostile', 'hostile')`
    ).run();
    await db.prepare(
      `INSERT INTO roomPresence (username, roomRow, roomCol, lastSeenTick, worldDay, lastSeenAt)
       VALUES ('hero', 3, 4, 0, ?, CURRENT_TIMESTAMP), ('brute', 3, 4, 0, ?, CURRENT_TIMESTAMP)`
    ).bind(worldDay, worldDay).run();

    // A DB proxy that runs normally until the hostile action finishes, then poisons the
    // NEXT prepared statement — which is roomNeedsLoop's query in the re-arm tail. This
    // proves the re-arm tail's own guard catches a DB hiccup and retries setAlarm rather
    // than wedging the loop.
    let poison = false;
    const dbProxy = {
      prepare(sql) {
        if (poison) { throw new Error('d1 blip during re-arm'); }
        return db.prepare(sql);
      },
      exec(sql) { return db.exec(sql); }
    };

    const storage = {
      _hostileRoom: { row: 3, col: 4 },
      _alarm: null,
      _deleted: false,
      async get(key) { return key === 'hostileRoom' ? this._hostileRoom : undefined; },
      async setAlarm(t) { this._alarm = t; },
      async getAlarm() { return this._alarm; },
      async delete(key) { if (key === 'hostileRoom') this._deleted = true; }
    };

    const room = new mod.RoomObject({ storage }, { DB: dbProxy, AI: {} });
    room.broadcast = async () => { poison = true; }; // succeed, then arm the poison

    const { logs } = await captureLogs(() => assert.doesNotReject(() => room.alarm()));

    const rearmErr = logs.find(r => r && r.event === 'alarm.rearm.error');
    assert.ok(rearmErr, 'the re-arm tail guard caught the DB blip');
    assert.equal(rearmErr.error, 'd1 blip during re-arm');
    // Despite the failed roomNeedsLoop decision, the retry re-armed the alarm.
    assert.notEqual(storage._alarm, null, 'retry re-armed the alarm so the loop is not dead');
    assert.equal(storage._deleted, false);
  } finally {
    await db.close();
  }
});
