// adv-013: the tick-loop COST decoupling. advanceGlobalTick was split into a cheap
// increment (advanceTickOnly) and the five whole-world sweeps (runWorldSweeps); the
// high-fan-out drivers (the per-5s hostile-room alarm, the cron) and the per-action path
// now gate the sweeps behind a single per-tick-window claim (claimWorldSweep) so K hostile
// rooms sweep the world ONCE per window instead of K×, and the action path runs them off
// the latency path. These tests pin BOTH halves of the contract:
//   1. the cost actually drops — advanceTickOnly runs no sweeps; a second claim in the
//      same tick-window is a no-op (the sweep fires once, not K×);
//   2. the cadence is provably PRESERVED — a downed player still bleeds exactly −1 per
//      swept tick, a poison status still ticks once per swept tick, and stamina still
//      recovers every third tick. CommonJS + node:test, the test/.helpers/d1 convention.

const assert = require('node:assert/strict');
const test = require('node:test');
const { createMigratedDb } = require('./.helpers/d1');
const { getWorldDay, generateRoomFeatures } = require('../utils/roomEcology');

// A room with no passive effect — so the ONLY thing that moves a present user's
// health/stamina across a sweep is the effect under test (bleed / poison / stamina), never
// a room hazard or rest passive. Mirrors the helper the bleed/status suites use.
function findCalmRoom(worldDay) {
  const hazardous = ['poison_marsh', 'moon_room', 'echo_chamber', 'pub', 'inn', 'sun_room', 'cold_room', 'guild'];
  for (let row = 1; row <= 16; row += 1) {
    for (let col = 1; col <= 16; col += 1) {
      if (!generateRoomFeatures(row, col, worldDay).map(f => f.effect?.type).some(t => hazardous.includes(t))) {
        return { row, col };
      }
    }
  }
  throw new Error('No calm room');
}

async function setTick(db, value) {
  await db.prepare('UPDATE tick SET value = ? WHERE id = 1').bind(value).run();
}

async function seedPlayer(db, username, { health = 30, maxHealth = 30, stamina = 50, speed = 1 } = {}) {
  await db.prepare(
    `INSERT INTO users (username, password, job, health, maxHealth, stamina, maxStamina, speed, strength, intelligence, level, gold)
     VALUES (?, 'pw', 'Novice', ?, ?, ?, 100, ?, 1, 1, 1, 0)`
  ).bind(username, health, maxHealth, stamina, speed).run();
}

async function placeUser(db, username, row, col, worldDay) {
  await db.prepare(
    `INSERT INTO roomPresence (username, roomRow, roomCol, lastSeenTick, worldDay, lastSeenAt)
     VALUES (?, ?, ?, 0, ?, CURRENT_TIMESTAMP)`
  ).bind(username, row, col, worldDay).run();
}

// A user already down with a known death clock — the observable the sweeps move by exactly
// one per tick (processIncapacitationBleed). deathClock 0 → −1 after one swept tick.
async function downPlayer(db, username, row, col, worldDay, deathClock = 0) {
  await seedPlayer(db, username, { health: 0 });
  await db.prepare(
    "UPDATE users SET incapacitated = 1, deathClock = ?, stance = 'prone', health = 0 WHERE username = ?"
  ).bind(deathClock, username).run();
  await placeUser(db, username, row, col, worldDay);
}

// --- 1. The cheap increment runs NO sweeps -------------------------------------------

test('adv-013: advanceTickOnly increments the tick and runs none of the world sweeps', async () => {
  const db = await createMigratedDb();
  const { advanceTickOnly, getCurrentTickValue } = await import('../worker/game.mjs');
  try {
    const worldDay = getWorldDay();
    const room = findCalmRoom(worldDay);
    // A downed player (deathClock observable) AND a live player carrying a poison status —
    // both are things the SWEEPS would move. If advanceTickOnly touched them, these pin it.
    await downPlayer(db, 'faller', room.row, room.col, worldDay, 0);
    await seedPlayer(db, 'poisoned', { health: 20 });
    await placeUser(db, 'poisoned', room.row, room.col, worldDay);
    await db.prepare(
      `INSERT INTO statusEffects (username, source, effectType, magnitude, createdTick, expiryTick, roomRow, roomCol, sourceUsername)
       VALUES ('poisoned', 'x', 'poison', 3, 0, 50, ?, ?, 'x')`
    ).bind(room.row, room.col).run();

    const result = await advanceTickOnly(db);

    assert.equal(result.tick, 1, 'the tick advanced by exactly one');
    assert.equal(await getCurrentTickValue(db), 1, 'the persisted tick matches');
    assert.equal(result.staminaUpdated, false, 'staminaUpdated mirrors tick % 3 (1 → false)');

    // The sweeps did NOT run: the bleed clock is untouched and the poison dealt no damage.
    const faller = await db.prepare("SELECT deathClock FROM users WHERE username = 'faller'").first();
    assert.equal(faller.deathClock, 0, 'advanceTickOnly did NOT run the incap bleed');
    const poisoned = await db.prepare("SELECT health FROM users WHERE username = 'poisoned'").first();
    assert.equal(poisoned.health, 20, 'advanceTickOnly did NOT tick the poison damage');
    const status = await db.prepare("SELECT id FROM statusEffects WHERE username = 'poisoned'").first();
    assert.ok(status, 'advanceTickOnly did NOT expire/clear status effects');
  } finally {
    await db.close();
  }
});

// --- 2. The dedup claim: the sweeps fire ONCE per tick-window, not K× -----------------

test('adv-013: claimWorldSweep grants the window to the first caller and no-ops the rest', async () => {
  const db = await createMigratedDb();
  const { claimWorldSweep } = await import('../worker/game.mjs');
  try {
    // Two callers race for the SAME tick-window (the K-hostile-rooms scenario, where every
    // alarm advanced to the same tick). Exactly one wins.
    assert.equal(await claimWorldSweep(db, 5), true, 'the first caller in tick-window 5 wins the claim');
    assert.equal(await claimWorldSweep(db, 5), false, 'a second caller in the SAME window is a no-op');
    assert.equal(await claimWorldSweep(db, 5), false, 'and so is a third — K callers, one sweep');
    // A LATER window always re-claims (the sweeps keep firing on every fresh tick).
    assert.equal(await claimWorldSweep(db, 6), true, 'the next tick-window re-grants the claim');
    assert.equal(await claimWorldSweep(db, 6), false, 'but only once within that window too');
    // A stale tick (already swept) never re-wins — guards against an out-of-order re-run.
    assert.equal(await claimWorldSweep(db, 5), false, 'a stale (lower) tick cannot reclaim a passed window');
  } finally {
    await db.close();
  }
});

test('adv-013: K sweeps in one tick-window apply the per-tick effect ONCE, not K times', async () => {
  const db = await createMigratedDb();
  const { runDeferredWorldSweeps } = await import('../worker/game.mjs');
  try {
    const worldDay = getWorldDay();
    const room = findCalmRoom(worldDay);
    await downPlayer(db, 'faller', room.row, room.col, worldDay, 0);
    await setTick(db, 7);

    // Simulate K=4 callers (e.g. four hostile-room alarms) all deferring a sweep on the
    // SAME tick. Only the first claims the window and runs runWorldSweeps; the rest skip.
    const ran = [];
    for (let i = 0; i < 4; i += 1) {
      ran.push(await runDeferredWorldSweeps(db, 7));
    }
    assert.deepEqual(ran, [true, false, false, false], 'the sweep ran once; the other three claims no-op');

    // The observable side effect (the bleed) moved by EXACTLY one tick, not four.
    const faller = await db.prepare("SELECT deathClock FROM users WHERE username = 'faller'").first();
    assert.equal(faller.deathClock, -1, 'the downed player bled exactly −1 (one swept tick), not −4');

    // A null/absent tick (a path that did not advance) is a safe no-op.
    assert.equal(await runDeferredWorldSweeps(db, null), false, 'a null tick defers nothing');
  } finally {
    await db.close();
  }
});

// --- 3. The cadence is PRESERVED across the split -------------------------------------

test('adv-013: a downed player bleeds exactly −1 per swept tick (cadence unchanged)', async () => {
  const db = await createMigratedDb();
  const { runWorldSweeps } = await import('../worker/game.mjs');
  try {
    const worldDay = getWorldDay();
    const room = findCalmRoom(worldDay);
    await downPlayer(db, 'bleeder', room.row, room.col, worldDay, 0);

    // One swept tick → −1. This is the exact assertion the incapacitation suite makes
    // against processIncapacitationBleed directly; here it is driven through runWorldSweeps
    // to prove the SPLIT preserves it.
    await runWorldSweeps(db, 1);
    let row = await db.prepare("SELECT deathClock FROM users WHERE username = 'bleeder'").first();
    assert.equal(row.deathClock, -1, 'one swept tick bleeds exactly one point');

    await runWorldSweeps(db, 2);
    row = await db.prepare("SELECT deathClock FROM users WHERE username = 'bleeder'").first();
    assert.equal(row.deathClock, -2, 'the second swept tick bleeds exactly one more — smooth, not batched');
  } finally {
    await db.close();
  }
});

test('adv-013: a poison status ticks its damage once per swept tick', async () => {
  const db = await createMigratedDb();
  const { runWorldSweeps } = await import('../worker/game.mjs');
  try {
    const worldDay = getWorldDay();
    const room = findCalmRoom(worldDay);
    // Seed at FULL health with a roomy body: with the SEGMENTED plan the smallest
    // pools are the hands/feet (4% shares), so maxHealth 120 keeps every part > the
    // poison magnitude — a tick can never zero a part, which would now SEVER it and
    // open a stump bleed that pollutes the next tick's delta. The cadence under test
    // is the health DELTA per swept tick: exactly −3 whatever part the RNG picks.
    await seedPlayer(db, 'victim', { health: 120, maxHealth: 120 });
    await placeUser(db, 'victim', room.row, room.col, worldDay);
    // processStatusEffects ticks an effect whose createdTick < currentTick — seed it at 0.
    await db.prepare(
      `INSERT INTO statusEffects (username, source, effectType, magnitude, createdTick, expiryTick, roomRow, roomCol, sourceUsername)
       VALUES ('victim', 'x', 'poison', 3, 0, 50, ?, ?, 'x')`
    ).bind(room.row, room.col).run();

    await runWorldSweeps(db, 1);
    let row = await db.prepare("SELECT health FROM users WHERE username = 'victim'").first();
    assert.equal(row.health, 117, 'one swept tick applies exactly one poison tick (−3)');

    await runWorldSweeps(db, 2);
    row = await db.prepare("SELECT health FROM users WHERE username = 'victim'").first();
    assert.equal(row.health, 114, 'the next swept tick applies exactly one more (−3) — once per tick');
  } finally {
    await db.close();
  }
});

test('adv-013: stamina still recovers on every third tick through the deduped driver', async () => {
  const db = await createMigratedDb();
  const { advanceTickAndMaybeSweep } = await import('../worker/game.mjs');
  try {
    const worldDay = getWorldDay();
    const room = findCalmRoom(worldDay);
    // Below the cap so a recovery is observable; in a calm room so no rest passive adds
    // an extra point. recoverStaminaForAllUsers regenerates +1 on every tick % 3 === 0.
    await seedPlayer(db, 'tired', { health: 30, stamina: 50 });
    await placeUser(db, 'tired', room.row, room.col, worldDay);

    const t1 = await advanceTickAndMaybeSweep(db); // tick 1
    assert.equal(t1.tick, 1);
    assert.equal(t1.staminaUpdated, false, 'tick 1 is not a stamina tick');
    assert.equal((await db.prepare("SELECT stamina FROM users WHERE username = 'tired'").first()).stamina, 50);

    const t2 = await advanceTickAndMaybeSweep(db); // tick 2
    assert.equal(t2.staminaUpdated, false, 'tick 2 is not a stamina tick');
    assert.equal((await db.prepare("SELECT stamina FROM users WHERE username = 'tired'").first()).stamina, 50);

    const t3 = await advanceTickAndMaybeSweep(db); // tick 3 → recover
    assert.equal(t3.tick, 3);
    assert.equal(t3.staminaUpdated, true, 'tick 3 IS a stamina tick (tick % 3 === 0)');
    assert.equal(
      (await db.prepare("SELECT stamina FROM users WHERE username = 'tired'").first()).stamina,
      51,
      'stamina recovered exactly +1 on the third tick — cadence unchanged'
    );
  } finally {
    await db.close();
  }
});

// --- 4. The compatibility wrapper still runs everything synchronously -----------------

test('adv-013: advanceGlobalTick remains the run-everything wrapper (increment + full sweep)', async () => {
  const db = await createMigratedDb();
  const { advanceGlobalTick, getCurrentTickValue } = await import('../worker/game.mjs');
  try {
    const worldDay = getWorldDay();
    const room = findCalmRoom(worldDay);
    await downPlayer(db, 'faller', room.row, room.col, worldDay, 0);

    const result = await advanceGlobalTick(db);

    assert.equal(result.tick, 1, 'the wrapper still increments first');
    assert.equal(await getCurrentTickValue(db), 1);
    // The wrapper is the UN-deduped path: it always runs the sweeps, so the bleed fired.
    const faller = await db.prepare("SELECT deathClock FROM users WHERE username = 'faller'").first();
    assert.equal(faller.deathClock, -1, 'advanceGlobalTick ran the sweeps synchronously, as before');
  } finally {
    await db.close();
  }
});

// --- adv DUR-03: a skipped tick's modulo-gated stamina pulse is made up -------------

test('adv DUR-03: when a later tick claims first, the skipped %3 pulse still applies', async () => {
  const db = await createMigratedDb();
  const { runDeferredWorldSweeps, claimWorldSweepRange } = await import('../worker/game.mjs');
  try {
    const worldDay = getWorldDay();
    const room = findCalmRoom(worldDay);
    await seedPlayer(db, 'straggler', { health: 30, stamina: 50 });
    await placeUser(db, 'straggler', room.row, room.col, worldDay);

    // Two actions bump the tick to 2 then 3, but tick 4's sweep claims FIRST
    // (the exact under-load interleave): the winner owns (−1, 4] and must apply
    // the %3 pulse tick 3 carried.
    assert.equal(await runDeferredWorldSweeps(db, 4), true, 'the later tick wins the window');
    assert.equal(
      (await db.prepare("SELECT stamina FROM users WHERE username = 'straggler'").first()).stamina,
      51,
      'the skipped tick-3 stamina pulse was made up, not dropped'
    );
    assert.equal(await runDeferredWorldSweeps(db, 3), false, 'the earlier tick then no-ops');
    assert.equal(
      (await db.prepare("SELECT stamina FROM users WHERE username = 'straggler'").first()).stamina,
      51,
      'and applies nothing twice'
    );

    // The range claim never double-owns a window.
    assert.equal(await claimWorldSweepRange(db, 4), null, 'a re-claim of the same tick is refused');
    const next = await claimWorldSweepRange(db, 6);
    assert.deepEqual(next, { fromTick: 4 }, 'the next window picks up exactly where the last ended');
  } finally {
    await db.close();
  }
});
