// Plan 012: keyword rites — language AS mechanics. /cast <incantation> @target fires
// a linguistic ability whose stamina cost AND power both scale with the incantation's
// word count. CommonJS + node:test.

const assert = require('node:assert/strict');
const test = require('node:test');
const { createSqliteD1, createMigratedDb } = require('./.helpers/d1');
const { getWorldDay, generateRoomFeatures } = require('../utils/roomEcology');
const abilities = require('../utils/abilities');

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

async function withForcedHit(fn) {
  const realRandom = Math.random;
  Math.random = () => 0; // low roll → attacker wins the speed contest
  try { return await fn(); } finally { Math.random = realRandom; }
}

// ---------------------------------------------------------------------------

test('Plan 012: a rite\'s stamina cost scales with the incantation word count', () => {
  const bolt = abilities.getAbility('word_bolt');
  assert.equal(abilities.resolveAbilityStaminaCost(bolt, { text: '' }), 1, 'wordless = base 1');
  assert.equal(abilities.resolveAbilityStaminaCost(bolt, { text: 'burn the foul wretch' }), 5, '4 words = 1 + 4');
  assert.equal(abilities.resolveAbilityStaminaCost(bolt, { text: 'a '.repeat(40) }), 13, 'capped at 13');
});

test('Plan 012: /cast fires the rite — power scales with words, and it costs the scaled stamina', async () => {
  const db = await createMigratedDb();
  const { handleCastAction, getUserState, updatePresence } = await import('../worker/game.mjs');
  try {
    const calm = findCalmRoom(getWorldDay());
    await seedUser(db, 'mage', 'Mage', 10);
    await seedUser(db, 'dummy', 'Novice', 1);
    await updatePresence(db, 'mage', calm.row, calm.col);
    await updatePresence(db, 'dummy', calm.row, calm.col);
    await getUserState(db, 'dummy'); // instantiate body

    const before = (await getUserState(db, 'dummy')).effectiveStats.health;
    await withForcedHit(() => handleCastAction(db, 'mage', calm.row, calm.col, '/cast searing wrath unbound @dummy'));
    const after = (await getUserState(db, 'dummy')).effectiveStats.health;
    // "searing wrath unbound" = 3 words → damage 2 + 3 = 5.
    assert.equal(before - after, 5, 'a 3-word rite deals 2 + 3 damage');

    const mage = await getUserState(db, 'mage');
    assert.equal(mage.effectiveStats.stamina, 100 - (1 + 3), 'stamina cost = 1 + 3 words');
    const line = await db.prepare("SELECT kind, message FROM messages WHERE message LIKE 'mage incants%' ORDER BY id DESC LIMIT 1").bind().first();
    assert.ok(line && line.kind === 'rite', 'the rite line is kind=rite');
    assert.match(line.message, /3-word bolt/);
  } finally {
    await db.close();
  }
});

test('Plan 012: /cast requires a target and a rite to cast', async () => {
  const db = await createMigratedDb();
  const { handleCastAction, getUserState, updatePresence } = await import('../worker/game.mjs');
  try {
    const calm = findCalmRoom(getWorldDay());
    await seedUser(db, 'mage', 'Mage', 10);
    await seedUser(db, 'grunt', 'Fighter', 5);
    await updatePresence(db, 'mage', calm.row, calm.col);
    await updatePresence(db, 'grunt', calm.row, calm.col);
    await getUserState(db, 'mage');
    await getUserState(db, 'grunt');

    await assert.rejects(() => handleCastAction(db, 'mage', calm.row, calm.col, '/cast just words no target'), /Name a target/);
    // A Fighter knows no linguistic rite.
    await assert.rejects(() => handleCastAction(db, 'grunt', calm.row, calm.col, '/cast smash @mage'), /no rites/i);
  } finally {
    await db.close();
  }
});

// --- Plan 012 (tail): rite caps/cadence + mastery curve --------------------

test('Plan 012 (tail): riteRankFromCasts is a deterministic log2 climb capped at 5', () => {
  assert.equal(abilities.RITE_RANK_MAX, 5);
  const cases = [[0, 0], [1, 1], [3, 2], [7, 3], [15, 4], [31, 5], [1e6, 5]];
  for (const [casts, rank] of cases) {
    assert.equal(abilities.riteRankFromCasts(casts), rank, `casts ${casts} → rank ${rank}`);
  }
});

test('Plan 012 (tail): mastery rank lifts the linguistic word cap (rank 0 is byte-identical)', () => {
  const bolt = abilities.getAbility('word_bolt');
  const verbose = 'a '.repeat(40); // 40 words — well over any cap
  // rank 0: cap stays 12 → 1 + 12 = 13 (parity with the no-rank path).
  assert.equal(abilities.resolveAbilityStaminaCost(bolt, { text: verbose, rank: 0 }), 13, 'rank 0 cap = 12');
  // rank 3: cap lifts by rank*2 = 6 → 12 + 6 = 18 → 1 + 18 = 19.
  assert.equal(abilities.resolveAbilityStaminaCost(bolt, { text: verbose, rank: 3 }), 19, 'rank 3 cap = 18');
  // A short rite never hits the cap, so rank doesn't change it.
  assert.equal(abilities.resolveAbilityStaminaCost(bolt, { text: 'burn the foul wretch', rank: 3 }), 5, 'under cap → rank-invariant');
});

test('Plan 012 (tail): the rite cooldown blocks an immediate second cast (429) and spends NO stamina', async () => {
  const db = await createMigratedDb();
  const { handleCastAction, getUserState, updatePresence } = await import('../worker/game.mjs');
  try {
    const calm = findCalmRoom(getWorldDay());
    await seedUser(db, 'mage', 'Mage', 10);
    await seedUser(db, 'dummy', 'Novice', 1);
    await updatePresence(db, 'mage', calm.row, calm.col);
    await updatePresence(db, 'dummy', calm.row, calm.col);
    await getUserState(db, 'dummy');

    // First cast lands (forced hit) — costs 1 + 3 words = 4 stamina and stamps the cooldown.
    await withForcedHit(() => handleCastAction(db, 'mage', calm.row, calm.col, '/cast searing wrath unbound @dummy'));
    const afterFirst = (await getUserState(db, 'mage')).effectiveStats.stamina;
    assert.equal(afterFirst, 100 - 4, 'first cast spent the scaled stamina');

    // Immediate second cast is gated BEFORE stamina is spent → 429, no spend, no tick.
    const tickBefore = (await db.prepare('SELECT value FROM tick WHERE id = 1').bind().first()).value;
    await assert.rejects(
      () => handleCastAction(db, 'mage', calm.row, calm.col, '/cast searing wrath unbound @dummy'),
      (err) => err.statusCode === 429 && /gathering/i.test(err.message)
    );
    const afterBlocked = (await getUserState(db, 'mage')).effectiveStats.stamina;
    assert.equal(afterBlocked, afterFirst, 'a blocked rite spends NO stamina');
    const tickAfter = (await db.prepare('SELECT value FROM tick WHERE id = 1').bind().first()).value;
    assert.equal(tickAfter, tickBefore, 'a blocked rite does NOT advance the tick');
  } finally {
    await db.close();
  }
});

test('Plan 012 (tail): the rite cooldown clears after cooldownTicks', async () => {
  const db = await createMigratedDb();
  const { handleCastAction, getUserState, updatePresence } = await import('../worker/game.mjs');
  try {
    const calm = findCalmRoom(getWorldDay());
    await seedUser(db, 'mage', 'Mage', 10);
    await seedUser(db, 'dummy', 'Novice', 1);
    await updatePresence(db, 'mage', calm.row, calm.col);
    await updatePresence(db, 'dummy', calm.row, calm.col);
    await getUserState(db, 'dummy');

    // First cast at tick 0 stamps the cooldown (cooldownTicks = 5).
    await withForcedHit(() => handleCastAction(db, 'mage', calm.row, calm.col, '/cast searing wrath unbound @dummy'));
    // Jump the world clock to exactly cooldownTicks past the stamp.
    await db.prepare('UPDATE tick SET value = ? WHERE id = 1').bind(abilities.getAbility('word_bolt').cooldownTicks).run();

    const before = (await getUserState(db, 'dummy')).effectiveStats.health;
    await withForcedHit(() => handleCastAction(db, 'mage', calm.row, calm.col, '/cast searing wrath unbound @dummy'));
    const after = (await getUserState(db, 'dummy')).effectiveStats.health;
    assert.ok(before - after > 0, 'the rite fires again once the cooldown has elapsed');
  } finally {
    await db.close();
  }
});

test('Plan 012 (tail): mastery rank 3 (casts=7) makes a 3-word bolt deal 2+3+3=8 with (rank 3) in the line', async () => {
  const db = await createMigratedDb();
  const { handleCastAction, getUserState, updatePresence } = await import('../worker/game.mjs');
  try {
    const calm = findCalmRoom(getWorldDay());
    await seedUser(db, 'mage', 'Mage', 10);
    await seedUser(db, 'dummy', 'Novice', 1);
    await updatePresence(db, 'mage', calm.row, calm.col);
    await updatePresence(db, 'dummy', calm.row, calm.col);
    await getUserState(db, 'dummy');

    // Seed 7 prior casts → riteRankFromCasts(7) = 3.
    await db.prepare('INSERT INTO riteMastery (username, abilityId, casts) VALUES (?, ?, ?)').bind('mage', 'word_bolt', 7).run();

    const before = (await getUserState(db, 'dummy')).effectiveStats.health;
    await withForcedHit(() => handleCastAction(db, 'mage', calm.row, calm.col, '/cast searing wrath unbound @dummy'));
    const after = (await getUserState(db, 'dummy')).effectiveStats.health;
    // 3 words + rank 3 → 2 + 3 + 3 = 8.
    assert.equal(before - after, 8, 'damage = 2 + words(3) + rank(3)');

    const line = await db.prepare("SELECT message FROM messages WHERE message LIKE 'mage incants%' ORDER BY id DESC LIMIT 1").bind().first();
    assert.match(line.message, /8 damage/);
    assert.match(line.message, /\(rank 3\)/, 'rank is folded into the existing rite line');
  } finally {
    await db.close();
  }
});

test('Plan 012 (tail): a successful cast increments the mastery cast count 0 → 1', async () => {
  const db = await createMigratedDb();
  const { handleCastAction, getUserState, updatePresence, getRiteMastery } = await import('../worker/game.mjs');
  try {
    const calm = findCalmRoom(getWorldDay());
    await seedUser(db, 'mage', 'Mage', 10);
    await seedUser(db, 'dummy', 'Novice', 1);
    await updatePresence(db, 'mage', calm.row, calm.col);
    await updatePresence(db, 'dummy', calm.row, calm.col);
    await getUserState(db, 'dummy');

    assert.equal(await getRiteMastery(db, 'mage', 'word_bolt'), 0, 'no mastery before the first cast');
    await withForcedHit(() => handleCastAction(db, 'mage', calm.row, calm.col, '/cast searing wrath unbound @dummy'));
    assert.equal(await getRiteMastery(db, 'mage', 'word_bolt'), 1, 'a successful cast bumps casts to 1');
  } finally {
    await db.close();
  }
});
