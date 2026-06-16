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
