// Plan 023b: the gib. A blow with enough overkill (or any heavy blow on an already-
// downed body) skips the incapacitation band entirely — the victim is torn apart:
// instant true death, limbs flung to the floor as grotesque items. CommonJS + node:test.

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

async function seedBodiedUser(db, username, room) {
  const { updatePresence, getUserState } = await import('../worker/game.mjs');
  await db.prepare(
    `INSERT INTO users (username, password, job, health, maxHealth, stamina, maxStamina, speed, strength, intelligence, level, gold)
     VALUES (?, 'pw', 'Novice', 30, 30, 100, 100, 1, 1, 1, 1, 0)`
  ).bind(username).run();
  await updatePresence(db, username, room.row, room.col);
  await getUserState(db, username); // instantiate body parts
}

test('Plan 023b: a blow with massive overkill gibs from standing — instant true death, limbs fly', async () => {
  const db = await createMigratedDb();
  try {
    const room = findCalmRoom(getWorldDay());
    await seedBodiedUser(db, 'meat', room);
    await seedBodiedUser(db, 'butcher', room); // recordKill needs a real, living killer
    const { descendTowardDeath } = await import('../worker/game.mjs');

    const outcome = await descendTowardDeath(db, 'meat', {
      cause: 'attack by butcher',
      row: room.row,
      col: room.col,
      blowDamage: 25,
      overkill: 25,
      currentTick: 1
    });

    assert.equal(outcome.state, 'gibbed');
    const gone = await db.prepare("SELECT username FROM users WHERE username = 'meat'").first();
    assert.equal(gone, null, 'gibbed === truly dead, no incapacitation band');
    const corpse = await db.prepare("SELECT id FROM items WHERE corpseOf = 'meat'").first();
    assert.ok(corpse, 'a corpse anchor still drops');
    const limbs = await db.prepare("SELECT name FROM items WHERE templateId = 'severed_part' AND name LIKE \"meat's severed %\"").all();
    assert.ok(limbs.results.length >= 1, 'at least one severed limb is flung to the floor');
    const torn = await db.prepare("SELECT message FROM messages WHERE message = 'meat is torn apart.'").first();
    assert.ok(torn, 'the room sees the dismemberment');
    const kill = await db.prepare("SELECT killerUsername FROM killHistory WHERE defeatedUsername = 'meat'").first();
    assert.equal(kill.killerUsername, 'butcher');
  } finally {
    await db.close();
  }
});

test('Plan 023b: a heavy blow on an already-downed body gibs it', async () => {
  const db = await createMigratedDb();
  try {
    const room = findCalmRoom(getWorldDay());
    await seedBodiedUser(db, 'victim', room);
    await seedBodiedUser(db, 'reaper', room); // recordKill needs a real, living killer
    const { descendTowardDeath } = await import('../worker/game.mjs');

    // First, a small lethal blow downs them (overkill under the gib threshold).
    const down = await descendTowardDeath(db, 'victim', { cause: 'attack by reaper', row: room.row, col: room.col, blowDamage: 4, overkill: 2, currentTick: 1 });
    assert.equal(down.state, 'incapacitated');
    const stillHere = await db.prepare("SELECT incapacitated FROM users WHERE username = 'victim'").first();
    assert.equal(stillHere.incapacitated, 1);

    // Then a heavy blow finishes them with dismemberment.
    const finish = await descendTowardDeath(db, 'victim', { cause: 'attack by reaper', row: room.row, col: room.col, blowDamage: 20, overkill: 20, currentTick: 2 });
    assert.equal(finish.state, 'gibbed');
    const gone = await db.prepare("SELECT username FROM users WHERE username = 'victim'").first();
    assert.equal(gone, null);
    const limbs = await db.prepare("SELECT name FROM items WHERE templateId = 'severed_part'").all();
    assert.ok(limbs.results.length >= 1, 'the downed body is torn apart');
  } finally {
    await db.close();
  }
});

test('Plan 023b: a modest lethal blow downs (does NOT gib)', async () => {
  const db = await createMigratedDb();
  try {
    const room = findCalmRoom(getWorldDay());
    await seedBodiedUser(db, 'spared', room);
    const { descendTowardDeath } = await import('../worker/game.mjs');

    const outcome = await descendTowardDeath(db, 'spared', { cause: 'attack by mugger', row: room.row, col: room.col, blowDamage: 8, overkill: 3, currentTick: 1 });
    assert.equal(outcome.state, 'incapacitated', 'overkill under the threshold downs rather than dismembers');
    const limbs = await db.prepare("SELECT id FROM items WHERE templateId = 'severed_part'").all();
    assert.equal(limbs.results.length, 0, 'no dismemberment on a clean down');
  } finally {
    await db.close();
  }
});
