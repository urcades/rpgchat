// adv-020: residual coverage for eatItem's CORPSE branch (plan 022c — the
// resurrection anchor). resurrectionAnchor.integration.test.js already proves a paid
// checkout is refused after a corpse is eaten; revival.integration.test.js proves a
// Cleric revive fails when the corpse is MANUALLY deleted. The gaps left:
//   (a) the 'death'-kind "<player> can never return" message line eatItem posts,
//   (b) the end-to-end chain eatItem(corpse) -> Cleric revive of that player FAILS
//       (it is the EAT, not a hand-rolled DELETE, that severs the tether).
// CommonJS + node:test, in-memory sqlite3 D1 shim.

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

test('adv-020: eating a corpse returns severed + posts the death-kind "can never return" line', async () => {
  const db = await createMigratedDb();
  const { moveUserToCemetery, eatItem, getUserState } = await import('../worker/game.mjs');
  try {
    const calm = findCalmRoom(getWorldDay());
    await seedUser(db, 'victim');
    await seedUser(db, 'ghoul');
    await getUserState(db, 'victim'); // instantiate body
    await getUserState(db, 'ghoul');
    await moveUserToCemetery(db, 'victim', 'a test fall', calm.row, calm.col);

    const corpse = await db.prepare("SELECT name FROM items WHERE corpseOf = 'victim'").first();
    assert.ok(corpse, 'a tagged corpse dropped where victim fell');

    const result = await eatItem(db, 'ghoul', corpse.name, calm.row, calm.col);

    // The severed result names the player whose tether was cut.
    assert.equal(result.severed, 'victim', 'eatItem reports the severed player');
    assert.equal(result.ate, corpse.name, 'and the item it consumed');

    // The corpse is gone from the floor.
    assert.ok(!(await db.prepare("SELECT 1 FROM items WHERE corpseOf = 'victim'").first()), 'the corpse was consumed');

    // The public line is kind 'death' and carries the permanence copy.
    const line = await db.prepare(
      "SELECT kind, message FROM messages WHERE roomRow = ? AND roomCol = ? ORDER BY id DESC LIMIT 1"
    ).bind(calm.row, calm.col).first();
    assert.ok(line, 'a line was posted to the room');
    assert.equal(line.kind, 'death', "the corpse-eat line is kind 'death'");
    assert.match(line.message, /victim can never return/, 'the line says the victim can never return');
    assert.match(line.message, /ghoul devours/, 'and names the devourer + act');
  } finally {
    await db.close();
  }
});

test('adv-020: after the corpse is EATEN, a Cleric revive of that player fails (permadeath)', async () => {
  const db = await createMigratedDb();
  const { moveUserToCemetery, eatItem, handleSkillAction, getUserState, getCurrentTickValue, updatePresence } = await import('../worker/game.mjs');
  try {
    const calm = findCalmRoom(getWorldDay());
    await seedUser(db, 'cleric', 'Cleric');
    await seedUser(db, 'ghoul');
    await seedUser(db, 'victim');
    await updatePresence(db, 'cleric', calm.row, calm.col);
    await updatePresence(db, 'ghoul', calm.row, calm.col);
    await getUserState(db, 'cleric');
    await getUserState(db, 'ghoul');
    await getUserState(db, 'victim');
    await moveUserToCemetery(db, 'victim', 'a test fall', calm.row, calm.col);

    // Sanity: with the corpse intact + grave present, revive WOULD be possible —
    // but we sever it by eating the corpse first.
    assert.ok(await db.prepare("SELECT 1 FROM cemetery WHERE username = 'victim'").first(), 'a grave exists');
    const corpse = await db.prepare("SELECT name FROM items WHERE corpseOf = 'victim'").first();
    const eaten = await eatItem(db, 'ghoul', corpse.name, calm.row, calm.col);
    assert.equal(eaten.severed, 'victim', 'the corpse was devoured');

    // The Cleric stands where the corpse fell, but it's gone → revive fails.
    const tick = await getCurrentTickValue(db);
    await assert.rejects(
      () => handleSkillAction(db, 'cleric', calm.row, calm.col, 'revive', 'victim', tick),
      /no corpse of victim here/i,
      'a Cleric cannot revive a devoured player — the anchor is gone'
    );

    // The victim is still dead: no live user row was recreated.
    assert.ok(!(await db.prepare("SELECT 1 FROM users WHERE username = 'victim'").first()), 'victim remains dead');
  } finally {
    await db.close();
  }
});
