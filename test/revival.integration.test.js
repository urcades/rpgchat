// Plan 011: the Cleric revival rite. A Cleric revives a fallen ally whose corpse
// (the 022c anchor) lies in the room — restored from the grave, corpse consumed.
// CommonJS + node:test.

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

async function seedUser(db, username, job = 'Novice') {
  await db.prepare(
    `INSERT INTO users (username, password, job, health, maxHealth, stamina, maxStamina, speed, strength, intelligence, level, gold)
     VALUES (?, 'pw', ?, 30, 30, 100, 100, 1, 1, 1, 3, 0)`
  ).bind(username, job).run();
}

// ---------------------------------------------------------------------------

test('Plan 011: a Cleric revives a fallen ally whose corpse is in the room', async () => {
  const db = await createMigratedDb();
  const { handleSkillAction, getUserState, moveUserToCemetery, getCurrentTickValue, updatePresence } = await import('../worker/game.mjs');
  try {
    const calm = findCalmRoom(getWorldDay());
    await seedUser(db, 'cleric', 'Cleric');
    await seedUser(db, 'ally', 'Fighter');
    await updatePresence(db, 'cleric', calm.row, calm.col);
    await getUserState(db, 'cleric');
    await getUserState(db, 'ally'); // instantiate body
    await moveUserToCemetery(db, 'ally', 'a test fall', calm.row, calm.col);

    // Preconditions: ally is dead (no user row), corpse + grave exist.
    assert.ok(!(await db.prepare("SELECT 1 FROM users WHERE username = 'ally'").bind().first()), 'ally is dead');
    assert.ok(await db.prepare("SELECT 1 FROM items WHERE corpseOf = 'ally'").bind().first(), 'corpse present');

    const tick = await getCurrentTickValue(db);
    await handleSkillAction(db, 'cleric', calm.row, calm.col, 'revive', 'ally', tick);

    assert.ok(await db.prepare("SELECT 1 FROM users WHERE username = 'ally'").bind().first(), 'ally is alive again');
    assert.ok(!(await db.prepare("SELECT 1 FROM items WHERE corpseOf = 'ally'").bind().first()), 'corpse consumed');
    assert.ok(!(await db.prepare("SELECT 1 FROM cemetery WHERE username = 'ally'").bind().first()), 'grave cleared');
    const line = await db.prepare("SELECT message FROM messages WHERE message LIKE 'cleric revives ally%' ORDER BY id DESC LIMIT 1").bind().first();
    assert.ok(line, 'a revival line was posted');
  } finally {
    await db.close();
  }
});

test('Plan 011: revival fails with no corpse in the room (and severs are permanent)', async () => {
  const db = await createMigratedDb();
  const { handleSkillAction, getUserState, moveUserToCemetery, getCurrentTickValue, updatePresence } = await import('../worker/game.mjs');
  try {
    const calm = findCalmRoom(getWorldDay());
    const elsewhere = { row: calm.row === 1 ? 2 : 1, col: calm.col };
    await seedUser(db, 'cleric', 'Cleric');
    await seedUser(db, 'ally', 'Fighter');
    await updatePresence(db, 'cleric', calm.row, calm.col);
    await getUserState(db, 'cleric');
    await getUserState(db, 'ally');
    // Ally dies in a DIFFERENT room → no corpse where the Cleric stands.
    await moveUserToCemetery(db, 'ally', 'a test fall', elsewhere.row, elsewhere.col);

    const tick = await getCurrentTickValue(db);
    await assert.rejects(
      () => handleSkillAction(db, 'cleric', calm.row, calm.col, 'revive', 'ally', tick),
      /no corpse of ally here/
    );

    // And once the corpse is destroyed, revival is impossible even in its room.
    await db.prepare("DELETE FROM items WHERE corpseOf = 'ally'").bind().run();
    await updatePresence(db, 'cleric', elsewhere.row, elsewhere.col);
    await assert.rejects(
      () => handleSkillAction(db, 'cleric', elsewhere.row, elsewhere.col, 'revive', 'ally', tick),
      /no corpse of ally here/
    );
  } finally {
    await db.close();
  }
});
