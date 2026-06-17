// adv-020: residual coverage for the rite-mastery + cooldown rails around the
// Word Bolt rite (plan 012 tail). Two invariants the atomicity/cadence tests left
// uncovered:
//   1. mastery-on-MISS — a DODGED player cast must NOT bump riteMastery, but the
//      per-ability cooldown IS still stamped ("the gathering is spent either way").
//   2. NPC-cast safety — a hostile NPC casting Word Bolt (runAbility isPlayerCast=
//      false, the runHostileRoomAction path) must NEVER write a riteMastery row OR a
//      'rite:*' cooldown row under its opaque username.
//
// Random is INJECTED and always restored (plan 004 convention): a forced MISS uses a
// draw above the 0.95 hit-chance clamp; a forced HIT uses 0. No global Math.random
// dependence, so the suite is deterministic across reruns. CommonJS + node:test.

const assert = require('node:assert/strict');
const test = require('node:test');
const { createSqliteD1, createMigratedDb } = require('./.helpers/d1');
const { getWorldDay, generateRoomFeatures } = require('../utils/roomEcology');

function findCalmRoom(worldDay) {
  const hazardous = ['poison_marsh', 'moon_room', 'echo_chamber', 'pub', 'inn', 'sun_room', 'cold_room', 'guild'];
  for (let row = 1; row <= 16; row += 1) {
    for (let col = 1; col <= 16; col += 1) {
      if (!generateRoomFeatures(row, col, worldDay).map(f => f.effect?.type).some(t => hazardous.includes(t))) return { row, col };
    }
  }
  throw new Error('No calm room');
}

async function seedUser(db, username, job, speed) {
  await db.prepare(
    `INSERT INTO users (username, password, job, health, maxHealth, stamina, maxStamina, speed, strength, intelligence, level, gold)
     VALUES (?, 'pw', ?, 40, 40, 100, 100, ?, 1, 5, 3, 0)`
  ).bind(username, job, speed).run();
}

// A forced HIT: the speed contest is `Math.random() < hitChance`, so a 0 draw always
// wins (matches keywordRites' withForcedHit). The cooldown rail reads ONE Math.random-
// free path, so a single value suffices for the whole cast.
async function withForcedHit(fn) {
  const real = Math.random;
  Math.random = () => 0;
  try { return await fn(); } finally { Math.random = real; }
}

// A forced MISS: hitChance clamps at SPEED_HIT_MAX_CHANCE (0.95), so any draw ≥ 0.95
// loses the contest regardless of the speed gap. 0.99 is comfortably above the clamp.
async function withForcedMiss(fn) {
  const real = Math.random;
  Math.random = () => 0.99;
  try { return await fn(); } finally { Math.random = real; }
}

async function riteCooldownRows(db, username) {
  return db.prepare("SELECT COUNT(*) AS c FROM roomEffectCooldowns WHERE username = ? AND effectType LIKE 'rite:%'").bind(username).first();
}

async function masteryRows(db, username) {
  return db.prepare('SELECT COUNT(*) AS c FROM riteMastery WHERE username = ?').bind(username).first();
}

// ---------------------------------------------------------------------------
// Gap 1: mastery-on-MISS — a dodged player cast stamps the cooldown but NOT mastery.

test('adv-020: a MISSED Word Bolt does NOT bump riteMastery, but DOES stamp the cooldown', async () => {
  const db = await createMigratedDb();
  const { handleCastAction, getRiteMastery, getUserState, updatePresence } = await import('../worker/game.mjs');
  try {
    const calm = findCalmRoom(getWorldDay());
    // dummy is FAST so the miss is plausible, but the forced 0.99 draw guarantees it.
    await seedUser(db, 'mage', 'Mage', 5);
    await seedUser(db, 'dummy', 'Novice', 20);
    await updatePresence(db, 'mage', calm.row, calm.col);
    await updatePresence(db, 'dummy', calm.row, calm.col);
    await getUserState(db, 'dummy'); // instantiate body

    assert.equal(await getRiteMastery(db, 'mage', 'word_bolt'), 0, 'no mastery before the cast');
    const before = (await getUserState(db, 'dummy')).effectiveStats.health;

    const result = await withForcedMiss(() => handleCastAction(db, 'mage', calm.row, calm.col, '/cast searing wrath unbound @dummy'));
    assert.equal(result.missed, true, 'the rite missed (forced dodge)');

    const after = (await getUserState(db, 'dummy')).effectiveStats.health;
    assert.equal(after, before, 'a missed bolt deals no damage');

    // (a) mastery is NOT bumped on a miss — bumpRiteMastery is gated behind the hit.
    assert.equal(await getRiteMastery(db, 'mage', 'word_bolt'), 0, 'a miss does NOT accrue mastery');
    assert.equal((await masteryRows(db, 'mage')).c, 0, 'no riteMastery row exists at all after a miss');

    // (b) the per-ability cooldown IS stamped — the gathering is spent either way.
    const cd = await db.prepare(
      "SELECT lastAppliedTick FROM roomEffectCooldowns WHERE username = 'mage' AND roomRow = 0 AND roomCol = 0 AND effectType = 'rite:word_bolt' AND worldDay = ?"
    ).bind(getWorldDay()).first();
    assert.ok(cd, 'a miss still stamps the rite cooldown');
  } finally {
    await db.close();
  }
});

test('adv-020: a missed rite leaves the cooldown gating an immediate recast (429), proving the stamp took', async () => {
  const db = await createMigratedDb();
  const { handleCastAction, updatePresence, getUserState } = await import('../worker/game.mjs');
  try {
    const calm = findCalmRoom(getWorldDay());
    await seedUser(db, 'mage', 'Mage', 5);
    await seedUser(db, 'dummy', 'Novice', 20);
    await updatePresence(db, 'mage', calm.row, calm.col);
    await updatePresence(db, 'dummy', calm.row, calm.col);
    await getUserState(db, 'dummy');

    await withForcedMiss(() => handleCastAction(db, 'mage', calm.row, calm.col, '/cast burn @dummy'));
    // The cooldown stamped by the MISS must block an immediate second cast.
    await assert.rejects(
      () => withForcedMiss(() => handleCastAction(db, 'mage', calm.row, calm.col, '/cast burn @dummy')),
      (err) => err.statusCode === 429 && /gathering/i.test(err.message),
      'the cooldown stamped on the miss gates the recast'
    );
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// Gap 2: NPC-cast safety — a hostile mage's Word Bolt never touches the mastery/
// cooldown tables under its (opaque) username.

// Direct-path proof: runAbility with isPlayerCast=false (the default the hostile-room
// driver passes) must write neither table, on a HIT.
test('adv-020: an NPC Word Bolt (runAbility, isPlayerCast=false) writes ZERO mastery and ZERO cooldown rows', async () => {
  const db = await createMigratedDb();
  const { runAbility, getEffectiveUser, getUserState, getRiteMastery, updatePresence } = await import('../worker/game.mjs');
  try {
    const calm = findCalmRoom(getWorldDay());
    // The NPC's username is opaque; seed it as an isNpc Mage so getEffectiveUser works.
    await db.prepare(
      `INSERT INTO users (username, password, job, health, maxHealth, stamina, maxStamina, speed, strength, intelligence, level, isNpc, displayName, npcKind, disposition, npcWorldDay)
       VALUES ('npc_mage_x9', 'npc', 'Mage', 30, 30, 100, 100, 8, 1, 5, 2, 1, 'Hedge Mage', 'social', 'hostile', ?)`
    ).bind(getWorldDay()).run();
    await seedUser(db, 'victim', 'Novice', 1);
    await updatePresence(db, 'npc_mage_x9', calm.row, calm.col);
    await updatePresence(db, 'victim', calm.row, calm.col);
    await getUserState(db, 'victim');

    const npc = await db.prepare("SELECT * FROM users WHERE username = 'npc_mage_x9'").first();
    const effectiveActor = { ...getEffectiveUser(npc), username: npc.displayName };

    const before = (await getUserState(db, 'victim')).effectiveStats.health;
    await withForcedHit(() => runAbility(db, 'word_bolt', {
      username: npc.displayName, // display-named, exactly as runHostileRoomAction does
      effectiveActor,
      target: 'victim',
      row: calm.row,
      col: calm.col,
      currentTick: 0,
      phase: 'day',
      incantation: 'die mortal',
      rank: 0
      // isPlayerCast omitted → defaults false (the NPC path)
    }));
    const after = (await getUserState(db, 'victim')).effectiveStats.health;
    assert.ok(after < before, 'the NPC bolt still LANDS (the guard is only on the side-tables)');

    // ZERO rite-mastery rows for the NPC (neither displayName nor opaque username).
    assert.equal(await getRiteMastery(db, 'npc_mage_x9', 'word_bolt'), 0, 'opaque username has no mastery');
    assert.equal(await getRiteMastery(db, 'Hedge Mage', 'word_bolt'), 0, 'display name has no mastery');
    assert.equal((await masteryRows(db, 'npc_mage_x9')).c, 0, 'no riteMastery row (opaque username)');
    assert.equal((await masteryRows(db, 'Hedge Mage')).c, 0, 'no riteMastery row (display name)');

    // ZERO rite:* cooldown rows for the NPC.
    assert.equal((await riteCooldownRows(db, 'npc_mage_x9')).c, 0, "no rite:* cooldown row (opaque username)");
    assert.equal((await riteCooldownRows(db, 'Hedge Mage')).c, 0, "no rite:* cooldown row (display name)");
  } finally {
    await db.close();
  }
});

// Integration proof: drive the REAL hostile-room turn until a hostile Mage casts
// Word Bolt, then assert the same zero-rows invariant. getHostileKit(Mage) is
// [arcane_pin, word_bolt]; casts fire on even ticks, kit index = floor(tick/2) %
// len, so word_bolt lands on ticks where floor(tick/2) is odd (e.g. tick 2). We let
// the driver advance the tick itself and loop a few turns (forced HIT) until we
// observe the word_bolt cast, asserting NO rite rows accrued the whole time.
test('adv-020: runHostileRoomAction — a hostile Mage actually casts Word Bolt yet accrues NO rite rows', async () => {
  const db = await createMigratedDb();
  const { runHostileRoomAction, getUserState, updatePresence } = await import('../worker/game.mjs');
  try {
    const calm = findCalmRoom(getWorldDay());
    await db.prepare(
      `INSERT INTO users (username, password, job, health, maxHealth, stamina, maxStamina, speed, strength, intelligence, level, isNpc, displayName, npcKind, disposition, npcWorldDay)
       VALUES ('npc_mage_kx', 'npc', 'Mage', 40, 40, 100, 100, 12, 1, 5, 3, 1, 'Wild Mage', 'social', 'hostile', ?)`
    ).bind(getWorldDay()).run();
    // A slow, beefy victim so it survives several turns without dying.
    await db.prepare(
      `INSERT INTO users (username, password, job, health, maxHealth, stamina, maxStamina, speed, strength, intelligence, level)
       VALUES ('prey', 'pw', 'Fighter', 200, 200, 100, 100, 1, 5, 1, 5)`
    ).run();
    await updatePresence(db, 'npc_mage_kx', calm.row, calm.col);
    await updatePresence(db, 'prey', calm.row, calm.col);
    await getUserState(db, 'prey'); // instantiate body (so the bolt has a target body)

    let sawWordBolt = false;
    // A handful of driven turns (forced HIT) — enough to roll the kit through both
    // abilities at least once. We do NOT depend on the global clock's starting phase.
    for (let i = 0; i < 8 && !sawWordBolt; i += 1) {
      const result = await withForcedHit(() => runHostileRoomAction(db, calm.row, calm.col));
      if (result && result.cast === 'word_bolt') {
        sawWordBolt = true;
      }
    }
    assert.ok(sawWordBolt, 'the hostile Mage cast Word Bolt at least once over the driven turns');

    // Despite a real, landed Word Bolt cast, the NPC accrued NOTHING on the rite rails.
    assert.equal((await masteryRows(db, 'npc_mage_kx')).c, 0, 'NPC opaque username has no riteMastery row');
    assert.equal((await masteryRows(db, 'Wild Mage')).c, 0, 'NPC display name has no riteMastery row');
    assert.equal((await riteCooldownRows(db, 'npc_mage_kx')).c, 0, 'NPC opaque username has no rite:* cooldown row');
    assert.equal((await riteCooldownRows(db, 'Wild Mage')).c, 0, 'NPC display name has no rite:* cooldown row');
    // And the global rail carries no rite rows for ANYONE here (no player ever cast).
    const total = await db.prepare("SELECT COUNT(*) AS c FROM riteMastery").first();
    assert.equal(total.c, 0, 'no riteMastery rows exist anywhere — only NPCs cast');
  } finally {
    await db.close();
  }
});
