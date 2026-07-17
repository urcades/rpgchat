// adv-003: coverage for authenticated action paths that were previously untested.
// Drives the real EXPORTED game.mjs handlers against a migrated in-memory D1 — the
// same style as the rest of test/*.integration.test.js. Areas covered here:
//   * handleJobChangeAction  (the /job action)
//   * leveling-on-action     (XP accrual + level-up via the plain-chat path)
//   * payInnAccess           (the /room-access/pay action)
//   * signup validation seam (the building blocks the /signup route composes)
//   * validateRoomCoordinates (the parseCoordinates gate every action route shares)
//
// NOTE (escape hatch): the /login, /signup and /room-access route CLOSURES live in
// worker/index.mjs, which imports `cloudflare:workers` and therefore cannot be
// `import`ed under `node --test`. So the HTTP layer itself isn't driven here; these
// tests pin the exported logic those routes delegate to. See the README delta in the
// handoff for the seam needed to test the route closures end-to-end.

const assert = require('node:assert/strict');
const test = require('node:test');
const { createMigratedDb } = require('./.helpers/d1');
const { getWorldDay, generateRoomFeatures } = require('../utils/roomEcology');

const HAZARDOUS = ['poison_marsh', 'moon_room', 'echo_chamber', 'pub', 'inn', 'sun_room', 'cold_room', 'guild'];

// A room with no hazardous/mechanic passive, so a post-action world tick can't
// perturb the stamina/level assertions (matches the pattern in shop/progression tests).
function findCalmRoom(worldDay) {
  for (let row = 1; row <= 16; row += 1) {
    for (let col = 1; col <= 16; col += 1) {
      const types = generateRoomFeatures(row, col, worldDay).map(f => f.effect?.type);
      if (!types.some(t => HAZARDOUS.includes(t))) return { row, col };
    }
  }
  throw new Error('No calm room for ' + worldDay);
}

// A guild room with no OTHER stamina/health-perturbing passive, so the guild's
// +1-stamina rest passive is the ONLY offset to the action's −1 cost — net 0, at
// cap. findRoomWithEffect alone can land on a guild that ALSO rolled e.g. cold_room
// on some world-days, making the net −1 and flaking the exact stamina assertion.
function findCleanGuildRoom(worldDay) {
  const others = HAZARDOUS.filter(t => t !== 'guild');
  for (let row = 1; row <= 16; row += 1) {
    for (let col = 1; col <= 16; col += 1) {
      const types = generateRoomFeatures(row, col, worldDay).map(f => f.effect?.type);
      if (types.includes('guild') && !types.some(t => others.includes(t))) return { row, col };
    }
  }
  throw new Error('No clean guild room for ' + worldDay);
}

function findRoomWithEffect(worldDay, effectType) {
  for (let row = 1; row <= 16; row += 1) {
    for (let col = 1; col <= 16; col += 1) {
      const types = generateRoomFeatures(row, col, worldDay).map(f => f.effect?.type);
      if (types.includes(effectType)) return { row, col };
    }
  }
  return null;
}

// Guild/inn features carry no activePhase, so they are active at every tick — the
// roomUse object handed to handleJobChangeAction can use a fixed tickValue.
function roomUseFor(worldDay, tickValue = 0) {
  return { worldDay, tickValue };
}

async function seedPlayer(db, username, opts = {}) {
  const {
    job = 'Novice', health = 30, maxHealth = 30, stamina = 100, maxStamina = 100,
    speed = 1, strength = 1, intelligence = 1, level = 0, gold = 0, experience = 0
  } = opts;
  await db.prepare(
    `INSERT INTO users
      (username, password, job, health, maxHealth, stamina, maxStamina, speed, strength, intelligence, level, gold, experience)
     VALUES (?, 'pw', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(username, job, health, maxHealth, stamina, maxStamina, speed, strength, intelligence, level, gold, experience).run();
}

// ===========================================================================
// 1. Job change — handleJobChangeAction / the /job action
// ===========================================================================

test('Plan adv-003: /job in a guild changes vocation, folds the job bonus, and spends stamina', async () => {
  const db = await createMigratedDb();
  const { handleJobChangeAction, updatePresence, getUserState, runDeferredWorldSweeps } = await import('../worker/game.mjs');
  try {
    const worldDay = getWorldDay();
    const guild = findCleanGuildRoom(worldDay);
    assert.ok(guild, 'today has a guild room somewhere on the grid');

    // Start as a Novice (no bonuses); a Mage adds +3 intelligence on top of base.
    await seedPlayer(db, 'switcher', { job: 'Novice', stamina: 100 });
    await updatePresence(db, 'switcher', guild.row, guild.col);

    const before = await getUserState(db, 'switcher');
    const result = await handleJobChangeAction(db, 'switcher', guild.row, guild.col, 'Mage', roomUseFor(worldDay));
    assert.equal(result.job, 'Mage', 'the action reports the new job');
    // adv-013: the action now only ADVANCES the tick synchronously; the global sweeps
    // (incl. the guild's stamina-restoring room passive) run off the latency path. The
    // route drives them from runAfterResponse — mirror that here so the post-tick state
    // (the +1 stamina offset below) is observed exactly as a player would experience it.
    await runDeferredWorldSweeps(db, result.tick.tick);

    const row = await db.prepare("SELECT job, stamina FROM users WHERE username = 'switcher'").first();
    assert.equal(row.job, 'Mage', 'the job is persisted');
    // The action spends 1 stamina, but a Guild is itself a rest spot — its passive
    // restores +1 stamina on the same tick (see applyPassiveEffectToUser 'guild'),
    // so the net at the cap is unchanged. The cost is proven independently by the
    // "no stamina" rejection test below; here the FOLD + system message are the signal.
    assert.equal(row.stamina, 100, "the guild's rest passive offsets the action's stamina cost");

    const after = await getUserState(db, 'switcher');
    assert.equal(
      after.effectiveStats.intelligence,
      before.effectiveStats.intelligence + 3,
      "the Mage's +3 intelligence bonus folds into effective stats"
    );

    const msg = await db.prepare(
      "SELECT message FROM messages WHERE username = 'System' AND message LIKE '%changes job to Mage%' LIMIT 1"
    ).first();
    assert.ok(msg, 'a room system message announces the change');
  } finally {
    await db.close();
  }
});

test('Plan adv-003: /job outside a guild room is refused (403) and changes nothing', async () => {
  const db = await createMigratedDb();
  const { handleJobChangeAction, updatePresence } = await import('../worker/game.mjs');
  try {
    const worldDay = getWorldDay();
    const calm = findCalmRoom(worldDay);
    await seedPlayer(db, 'wanderer', { job: 'Novice', stamina: 100 });
    await updatePresence(db, 'wanderer', calm.row, calm.col);

    await assert.rejects(
      () => handleJobChangeAction(db, 'wanderer', calm.row, calm.col, 'Mage', roomUseFor(worldDay)),
      /Guild room/
    );

    const row = await db.prepare("SELECT job, stamina FROM users WHERE username = 'wanderer'").first();
    assert.equal(row.job, 'Novice', 'job unchanged');
    assert.equal(row.stamina, 100, 'rejected before any stamina is spent');
  } finally {
    await db.close();
  }
});

test('Plan adv-003: /job to an unknown vocation is refused and spends no stamina', async () => {
  const db = await createMigratedDb();
  const { handleJobChangeAction, updatePresence } = await import('../worker/game.mjs');
  try {
    const worldDay = getWorldDay();
    const guild = findRoomWithEffect(worldDay, 'guild');
    assert.ok(guild, 'today has a guild room');
    await seedPlayer(db, 'picky', { job: 'Novice', stamina: 100 });
    await updatePresence(db, 'picky', guild.row, guild.col);

    await assert.rejects(
      () => handleJobChangeAction(db, 'picky', guild.row, guild.col, 'Wizard', roomUseFor(worldDay)),
      /Invalid job/
    );

    const row = await db.prepare("SELECT job, stamina FROM users WHERE username = 'picky'").first();
    assert.equal(row.job, 'Novice', 'job unchanged on an unknown vocation');
    assert.equal(row.stamina, 100, 'no stamina spent — validate runs before spend');
  } finally {
    await db.close();
  }
});

test('Plan adv-003: an incapacitated player cannot change jobs', async () => {
  const db = await createMigratedDb();
  const { handleJobChangeAction, updatePresence } = await import('../worker/game.mjs');
  try {
    const worldDay = getWorldDay();
    const guild = findRoomWithEffect(worldDay, 'guild');
    assert.ok(guild, 'today has a guild room');
    await seedPlayer(db, 'downed', { job: 'Novice', stamina: 100, health: 0 });
    await db.prepare("UPDATE users SET incapacitated = 1 WHERE username = 'downed'").run();
    await updatePresence(db, 'downed', guild.row, guild.col);

    await assert.rejects(
      () => handleJobChangeAction(db, 'downed', guild.row, guild.col, 'Mage', roomUseFor(worldDay)),
      /incapacitated/
    );

    const row = await db.prepare("SELECT job FROM users WHERE username = 'downed'").first();
    assert.equal(row.job, 'Novice', 'the downed stay in their current job');
  } finally {
    await db.close();
  }
});

test('Plan adv-003: /job with no stamina is refused before the change', async () => {
  const db = await createMigratedDb();
  const { handleJobChangeAction, updatePresence } = await import('../worker/game.mjs');
  try {
    const worldDay = getWorldDay();
    const guild = findRoomWithEffect(worldDay, 'guild');
    assert.ok(guild, 'today has a guild room');
    await seedPlayer(db, 'spent', { job: 'Novice', stamina: 0 });
    await updatePresence(db, 'spent', guild.row, guild.col);

    await assert.rejects(
      () => handleJobChangeAction(db, 'spent', guild.row, guild.col, 'Mage', roomUseFor(worldDay)),
      /Not enough stamina/
    );

    const row = await db.prepare("SELECT job FROM users WHERE username = 'spent'").first();
    assert.equal(row.job, 'Novice', 'no change without the stamina to act');
  } finally {
    await db.close();
  }
});

// ===========================================================================
// 2. Leveling-on-action — XP accrual + level-up when a player acts
// ===========================================================================

test('Plan adv-003: acting at an XP boundary levels the player up and posts the notice', async () => {
  const db = await createMigratedDb();
  const { handleChatAction, updatePresence, getUserState } = await import('../worker/game.mjs');
  try {
    const worldDay = getWorldDay();
    const calm = findCalmRoom(worldDay);
    // Linear leveling: level = floor(xp / 100). Seed one XP short of level 1.
    await seedPlayer(db, 'climber', { level: 0, experience: 99, gold: 0 });
    await updatePresence(db, 'climber', calm.row, calm.col);

    const before = await getUserState(db, 'climber');
    assert.equal(before.level, 0);

    // A plain (non-slash) line is the action that accrues +1 XP.
    await handleChatAction(db, 'climber', calm.row, calm.col, 'I press onward.');

    const row = await db.prepare(
      "SELECT level, experience, attributePoints, skillPoints FROM users WHERE username = 'climber'"
    ).first();
    assert.equal(row.experience, 100, 'one action granted one experience');
    assert.equal(row.level, 1, 'crossing the boundary raised the level');
    assert.equal(row.attributePoints, 10, 'a level grants 10 attribute points');
    assert.equal(row.skillPoints, 1, 'a level grants 1 skill point');

    const after = await getUserState(db, 'climber');
    assert.equal(after.level, 1, 'recomputed state reflects the new level');
    assert.equal(after.attributePoints, 10, 'the fresh attribute budget is spendable');

    const notice = await db.prepare(
      "SELECT message FROM messages WHERE username = 'System' AND message LIKE '%reached level 1%' LIMIT 1"
    ).first();
    assert.ok(notice, 'a level-up message is posted to the room');
    assert.match(notice.message, /gained 10 attribute points/);
  } finally {
    await db.close();
  }
});

test('Plan adv-003: acting below the boundary accrues XP without leveling', async () => {
  const db = await createMigratedDb();
  const { handleChatAction, updatePresence } = await import('../worker/game.mjs');
  try {
    const worldDay = getWorldDay();
    const calm = findCalmRoom(worldDay);
    await seedPlayer(db, 'plodder', { level: 0, experience: 10 });
    await updatePresence(db, 'plodder', calm.row, calm.col);

    await handleChatAction(db, 'plodder', calm.row, calm.col, 'Just chatting.');

    const row = await db.prepare(
      "SELECT level, experience, attributePoints FROM users WHERE username = 'plodder'"
    ).first();
    assert.equal(row.experience, 11, 'experience still accrues');
    assert.equal(row.level, 0, 'no level-up below the threshold');
    assert.equal(row.attributePoints, 0, 'no attribute points awarded without a level');

    const notice = await db.prepare(
      "SELECT id FROM messages WHERE username = 'System' AND message LIKE '%reached level%'"
    ).first();
    assert.equal(notice, null, 'no level-up notice posted');
  } finally {
    await db.close();
  }
});

// ===========================================================================
// 3. Inn access — payInnAccess / the /room-access/pay action
// ===========================================================================

test('Plan adv-003: paying inn access deducts the fee and grants access', async () => {
  const db = await createMigratedDb();
  const { payInnAccess, getRoomAccessState, updatePresence } = await import('../worker/game.mjs');
  try {
    const worldDay = getWorldDay();
    const inn = findRoomWithEffect(worldDay, 'inn');
    assert.ok(inn, 'today has an inn room');
    await seedPlayer(db, 'guest', { gold: 100 });
    await updatePresence(db, 'guest', inn.row, inn.col);

    const stateBefore = await getRoomAccessState(db, 'guest', inn.row, inn.col);
    assert.equal(stateBefore.required, true, 'the inn gates entry');
    assert.equal(stateBefore.paid, false, 'not paid yet');
    const fee = stateBefore.fee;
    assert.ok(fee > 0, 'the inn charges a positive fee');

    const result = await payInnAccess(db, 'guest', inn.row, inn.col);
    assert.equal(result.paid, true, 'payment grants access');
    assert.equal(result.costPaid, fee, 'the recorded cost equals the fee');

    const gold = (await db.prepare("SELECT gold FROM users WHERE username = 'guest'").first()).gold;
    assert.equal(gold, 100 - fee, 'gold reduced by exactly the fee');

    const stateAfter = await getRoomAccessState(db, 'guest', inn.row, inn.col);
    assert.equal(stateAfter.paid, true, 'access state now reads paid');

    const access = await db.prepare(
      "SELECT costPaid FROM roomAccess WHERE username = 'guest' AND roomRow = ? AND roomCol = ?"
    ).bind(inn.row, inn.col).first();
    assert.ok(access, 'a roomAccess row was written');
    assert.equal(access.costPaid, fee);
  } finally {
    await db.close();
  }
});

test('Plan adv-003: a broke player cannot pay inn access (402) and loses no gold', async () => {
  const db = await createMigratedDb();
  const { payInnAccess, getRoomAccessState, updatePresence } = await import('../worker/game.mjs');
  try {
    const worldDay = getWorldDay();
    const inn = findRoomWithEffect(worldDay, 'inn');
    assert.ok(inn, 'today has an inn room');
    const fee = (await getRoomAccessState(db, null, inn.row, inn.col)).fee;

    await seedPlayer(db, 'pauper', { gold: fee - 1 });
    await updatePresence(db, 'pauper', inn.row, inn.col);

    await assert.rejects(
      () => payInnAccess(db, 'pauper', inn.row, inn.col),
      /Not enough gold/
    );

    const gold = (await db.prepare("SELECT gold FROM users WHERE username = 'pauper'").first()).gold;
    assert.equal(gold, fee - 1, 'the broke player keeps every coin');
    const access = await db.prepare("SELECT username FROM roomAccess WHERE username = 'pauper'").first();
    assert.equal(access, null, 'no access granted on a failed payment');
  } finally {
    await db.close();
  }
});

test('Plan adv-003: paying twice is idempotent — the second pay is free', async () => {
  const db = await createMigratedDb();
  const { payInnAccess, updatePresence } = await import('../worker/game.mjs');
  try {
    const worldDay = getWorldDay();
    const inn = findRoomWithEffect(worldDay, 'inn');
    assert.ok(inn, 'today has an inn room');
    await seedPlayer(db, 'repeat', { gold: 100 });
    await updatePresence(db, 'repeat', inn.row, inn.col);

    const first = await payInnAccess(db, 'repeat', inn.row, inn.col);
    const goldAfterFirst = (await db.prepare("SELECT gold FROM users WHERE username = 'repeat'").first()).gold;
    assert.equal(goldAfterFirst, 100 - first.costPaid, 'first pay charges the fee');

    // Re-paying an already-paid room returns the current access and charges nothing.
    const second = await payInnAccess(db, 'repeat', inn.row, inn.col);
    assert.equal(second.paid, true, 're-pay still reports access');
    const goldAfterSecond = (await db.prepare("SELECT gold FROM users WHERE username = 'repeat'").first()).gold;
    assert.equal(goldAfterSecond, goldAfterFirst, 'no double charge on re-pay');

    const rows = await db.prepare(
      "SELECT COUNT(*) AS c FROM roomAccess WHERE username = 'repeat' AND roomRow = ? AND roomCol = ?"
    ).bind(inn.row, inn.col).first();
    assert.equal(rows.c, 1, 'still a single access row (no duplicate)');
  } finally {
    await db.close();
  }
});

test('Plan adv-003: paying for access in a non-inn room is refused', async () => {
  const db = await createMigratedDb();
  const { payInnAccess, updatePresence } = await import('../worker/game.mjs');
  try {
    const worldDay = getWorldDay();
    const calm = findCalmRoom(worldDay); // calm excludes inns
    await seedPlayer(db, 'confused', { gold: 100 });
    await updatePresence(db, 'confused', calm.row, calm.col);

    await assert.rejects(
      () => payInnAccess(db, 'confused', calm.row, calm.col),
      /not an inn/
    );
    const gold = (await db.prepare("SELECT gold FROM users WHERE username = 'confused'").first()).gold;
    assert.equal(gold, 100, 'no gold moves when the room is not an inn');
  } finally {
    await db.close();
  }
});

// ===========================================================================
// 5. Signup negative cases — the validation seam the /signup route composes
//    (the route closure itself is in index.mjs and can't be imported under
//    node --test; see the file header note).
// ===========================================================================

test('Plan adv-003: signup validation rejects a bad attribute allocation', async () => {
  const { validateStartingAllocation } = await import('../worker/game.mjs');
  // Spends 5 points, not the required 12 — the route surfaces errors[0].
  const result = validateStartingAllocation({ health: 1, stamina: 1, speed: 1, strength: 1, intelligence: 1 });
  assert.equal(result.valid, false, 'a non-12 allocation is invalid');
  assert.ok(result.errors.length > 0, 'an actionable error message is produced');
  assert.match(result.errors[0], /exactly 12 points/);
});

test('Plan adv-003: signup validation rejects non-integer attribute values', async () => {
  const { validateStartingAllocation } = await import('../worker/game.mjs');
  const result = validateStartingAllocation({ health: 2, stamina: '3.5', speed: 2, strength: 2, intelligence: 2 });
  assert.equal(result.valid, false);
  assert.match(result.errors[0], /whole numbers/);
});

test('Plan adv-003: signup rejects an unknown job (the route guards JOBS membership)', async () => {
  const { JOBS } = await import('../worker/game.mjs');
  // The /signup route checks `Object.prototype.hasOwnProperty.call(JOBS, body.job)`
  // against the RAW submitted job, so a junk value is rejected as Invalid job.
  assert.equal(Object.prototype.hasOwnProperty.call(JOBS, 'Wizard'), false, 'an unknown job is not a real job');
  assert.equal(Object.prototype.hasOwnProperty.call(JOBS, ''), false, 'a missing job is not a real job');
  assert.equal(Object.prototype.hasOwnProperty.call(JOBS, 'Mage'), true, 'a real job passes the guard');
});

test('Plan adv-003: signup detects a duplicate username before insert', async () => {
  const db = await createMigratedDb();
  const { buildStartingStats, validateStartingAllocation, JOBS } = await import('../worker/game.mjs');
  const { dbFirst, dbRun } = await import('../worker/db.mjs');
  try {
    const alloc = validateStartingAllocation({ health: 2, stamina: 3, speed: 2, strength: 3, intelligence: 2 });
    assert.equal(alloc.valid, true, 'a sound 12-point allocation is valid');
    assert.ok(Object.prototype.hasOwnProperty.call(JOBS, 'Fighter'));

    const stats = buildStartingStats(alloc.allocation);
    await dbRun(
      db,
      `INSERT INTO users
        (username, password, job, health, maxHealth, stamina, maxStamina, speed, strength, intelligence, level, gold, experience, isNpc)
       VALUES (?, ?, 'Fighter', ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0)`,
      ['dup', 'pw', stats.health, stats.maxHealth, stats.stamina, stats.maxStamina, stats.speed, stats.strength, stats.intelligence]
    );

    // The route's duplicate guard: SELECT username FROM users WHERE username = ?
    const existing = await dbFirst(db, 'SELECT username FROM users WHERE username = ?', ['dup']);
    assert.ok(existing, 'a second signup for the same name would be caught as taken');
    assert.equal(existing.username, 'dup');
  } finally {
    await db.close();
  }
});

test('Plan adv-003: a valid allocation builds the saved base stats the route inserts', async () => {
  const { buildStartingStats, validateStartingAllocation } = await import('../worker/game.mjs');
  const alloc = validateStartingAllocation({ health: 2, stamina: 3, speed: 2, strength: 3, intelligence: 2 });
  assert.equal(alloc.valid, true);
  const stats = buildStartingStats(alloc.allocation);
  // base 30 + 2*3, base 100 + 3*10, base 1 + each point — these are what /signup stores.
  assert.deepEqual(stats, {
    health: 36, maxHealth: 36, stamina: 130, maxStamina: 130, speed: 3, strength: 4, intelligence: 3
  });
});

// ===========================================================================
// 6. Coordinate validation — validateRoomCoordinates, the gate behind
//    parseCoordinates() that every action route runs first.
// ===========================================================================

test('Plan adv-003: valid in-range integer coordinates are accepted', async () => {
  const { validateRoomCoordinates, GRID_SIZE } = await import('../worker/game.mjs');
  assert.deepEqual(validateRoomCoordinates('1', '1'), { row: 1, col: 1 }, 'lower bound accepted');
  assert.deepEqual(validateRoomCoordinates(String(GRID_SIZE), String(GRID_SIZE)), { row: GRID_SIZE, col: GRID_SIZE }, 'upper bound accepted');
  assert.deepEqual(validateRoomCoordinates(8, 8), { row: 8, col: 8 }, 'numeric inputs accepted');
});

test('Plan adv-003: out-of-range coordinates are rejected (the parseCoordinates gate)', async () => {
  const { validateRoomCoordinates, GRID_SIZE } = await import('../worker/game.mjs');
  assert.equal(validateRoomCoordinates('0', '1'), null, 'row below 1 rejected');
  assert.equal(validateRoomCoordinates('1', '0'), null, 'col below 1 rejected');
  assert.equal(validateRoomCoordinates(String(GRID_SIZE + 1), '1'), null, 'row above the grid rejected');
  assert.equal(validateRoomCoordinates('1', String(GRID_SIZE + 1)), null, 'col above the grid rejected');
  assert.equal(validateRoomCoordinates('999', '999'), null, 'far out-of-range rejected');
});

test('Plan adv-003: negative coordinates are rejected', async () => {
  const { validateRoomCoordinates } = await import('../worker/game.mjs');
  assert.equal(validateRoomCoordinates('-1', '5'), null, 'negative row rejected');
  assert.equal(validateRoomCoordinates('5', '-1'), null, 'negative col rejected');
  assert.equal(validateRoomCoordinates('-3', '-3'), null, 'both negative rejected');
});

test('Plan adv-003: non-integer and junk coordinates are rejected', async () => {
  const { validateRoomCoordinates } = await import('../worker/game.mjs');
  // parseInt('1.5') === 1, but the source re-checks Number.isInteger AFTER parseInt;
  // since parseInt already truncates, the guard's real teeth are on NaN/junk inputs.
  assert.equal(validateRoomCoordinates('abc', '5'), null, 'non-numeric row rejected');
  assert.equal(validateRoomCoordinates('5', 'xyz'), null, 'non-numeric col rejected');
  assert.equal(validateRoomCoordinates('', ''), null, 'empty strings rejected');
  assert.equal(validateRoomCoordinates(null, null), null, 'null coordinates rejected');
  assert.equal(validateRoomCoordinates(undefined, undefined), null, 'undefined coordinates rejected');
});
