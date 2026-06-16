// Plan 022 (tail): trophies. A defeated NPC has a LOW chance (bosses guaranteed) to
// drop a NAMED trinket-slot gear ALONGSIDE its monster_remains. The trophy carries
// the victim's name, equips via the normal gear path, and doubles as a Forge input
// (dual-use). RNG is seeded so the trophy roll deterministically fires. CommonJS +
// node:test, mirroring crafting/npcDeath integration tests.

const assert = require('node:assert/strict');
const test = require('node:test');
const { createSqliteD1, createMigratedDb } = require('./.helpers/d1');
const { getWorldDay } = require('../utils/roomEcology');
const { rollTrophyDrop } = require('../utils/items');

// Same mocked-RNG helper shape as workerMigration/combat tests: a fixed sequence,
// clamped to the last value once exhausted.
async function withMockedRandom(values, callback) {
  const originalRandom = Math.random;
  let index = 0;
  Math.random = () => {
    const value = values[Math.min(index, values.length - 1)];
    index += 1;
    return value;
  };
  try {
    return await callback();
  } finally {
    Math.random = originalRandom;
  }
}

async function seedUser(db, username) {
  await db.prepare(
    `INSERT INTO users (username, password, job, health, maxHealth, stamina, maxStamina, speed, strength, intelligence, level, gold)
     VALUES (?, 'pw', 'Novice', 30, 30, 100, 100, 1, 1, 1, 0, 0)`
  ).bind(username).run();
}

// ---------------------------------------------------------------------------

test('Plan 022 (tail): rollTrophyDrop honors its chance gate and consumes two randoms', async () => {
  // Gate fails (>= chance) -> null, one random consumed.
  assert.equal(rollTrophyDrop('ambient_hostile', () => 0.99), null, 'a high roll yields no trophy');
  // Gate passes, pick index 0.
  const trophy = rollTrophyDrop('ambient_hostile', mockSeq([0.0, 0.0]));
  assert.ok(trophy && trophy.slotType === 'trinket', 'a trophy is a trinket-slot gear');
  // Bosses are guaranteed regardless of the gate roll.
  const boss = rollTrophyDrop('raid_boss', () => 0.99);
  assert.ok(boss, 'a raid boss always yields a trophy');
  // Unknown kind -> null.
  assert.equal(rollTrophyDrop('not_a_kind', () => 0.0), null, 'unknown kinds yield no trophy');
});

function mockSeq(values) {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)];
}

test('Plan 022 (tail): a defeated monster drops a NAMED trophy alongside its remains', async () => {
  const db = await createMigratedDb();
  const { defeatNpc, getCurrentTickValue } = await import('../worker/game.mjs');
  try {
    const tick = await getCurrentTickValue(db);
    // RNG order inside defeatNpc:
    //   1) rollNpcDrop chance gate (0.5 >= 0.15 -> NO gear drop, so only the trophy
    //      + remains land, keeping the assertion clean).
    //   2) rollTrophyDrop chance gate (0.05 < 0.1 -> trophy FIRES).
    //   3) rollTrophyDrop pick (0.0 -> index 0 -> Goblin Skull).
    await withMockedRandom([0.5, 0.05, 0.0], () =>
      defeatNpc(db, { username: 'gob', displayName: 'Goblin Raider', npcKind: 'ambient_hostile', isNpc: 1, health: 0 },
        { killer: 'hero', row: 7, col: 7, currentTick: tick }));

    const trophy = await db.prepare(
      "SELECT name, templateId, slotType FROM items WHERE templateId = 'goblin_skull' AND roomRow = 7 AND roomCol = 7"
    ).first();
    assert.ok(trophy, 'a trophy dropped');
    assert.equal(trophy.name, "Goblin Raider's Goblin Skull", 'the trophy carries the victim name');
    assert.equal(trophy.slotType, 'trinket', 'the trophy is a trinket-slot gear');

    const remains = await db.prepare("SELECT COUNT(*) AS c FROM items WHERE templateId = 'monster_remains' AND roomRow = 7 AND roomCol = 7").first();
    assert.equal(remains.c, 1, 'the remains still drop alongside the trophy');
  } finally {
    await db.close();
  }
});

test('Plan 022 (tail): a dropped trophy can be taken and equipped via the normal gear path', async () => {
  const db = await createMigratedDb();
  const { defeatNpc, handleChatAction, getUserState, updatePresence, getCurrentTickValue } = await import('../worker/game.mjs');
  try {
    await seedUser(db, 'hero');
    await updatePresence(db, 'hero', 7, 7);
    await getUserState(db, 'hero'); // instantiate body (neck = trinket mount)
    const tick = await getCurrentTickValue(db);

    await withMockedRandom([0.5, 0.05, 0.0], () =>
      defeatNpc(db, { username: 'gob', displayName: 'Goblin Raider', npcKind: 'ambient_hostile', isNpc: 1, health: 0 },
        { killer: 'hero', row: 7, col: 7, currentTick: tick }));

    // Take the named trophy off the floor, then equip it (mounts on the neck).
    await handleChatAction(db, 'hero', 7, 7, "/take Goblin Raider's Goblin Skull");
    await handleChatAction(db, 'hero', 7, 7, "/equip Goblin Raider's Goblin Skull");
    const equipped = await db.prepare("SELECT equippedPartId FROM items WHERE templateId = 'goblin_skull' AND ownerUsername = 'hero'").first();
    assert.ok(equipped && equipped.equippedPartId !== null, 'the trophy is equipped');
    const sheet = await getUserState(db, 'hero');
    assert.ok(Object.values(sheet.equipment).includes("Goblin Raider's Goblin Skull"), 'the trophy shows in the equipment map');
  } finally {
    await db.close();
  }
});

test('Plan 022 (tail): a trophy is accepted as a Forge input (dual-use), consumed into gear', async () => {
  const db = await createMigratedDb();
  const { craftRecipe } = await import('../worker/game.mjs');
  try {
    await seedUser(db, 'smith');
    // A named trophy instance (per-instance name; templateId is the dual-use key).
    await db.prepare(
      `INSERT INTO items (templateId, name, slotType, rarity, modifiers, ownerUsername)
       VALUES ('goblin_skull', "Goblin Raider's Goblin Skull", 'trinket', 'common', '{"strength":1}', 'smith')`
    ).run();
    await db.prepare(
      `INSERT INTO items (templateId, name, slotType, rarity, modifiers, ownerUsername)
       VALUES ('scrap_metal', 'Scrap Metal', 'part', 'shop', '{}', 'smith')`
    ).run();

    // The Bone Blade recipe MELTS the trophy down — proving a trophy is a Forge input.
    const result = await craftRecipe(db, 'smith', 'forge', 'Bone Blade');
    assert.equal(result.crafted, 'Bone Blade');
    const trophyLeft = await db.prepare("SELECT COUNT(*) AS c FROM items WHERE ownerUsername = 'smith' AND templateId = 'goblin_skull'").first();
    assert.equal(trophyLeft.c, 0, 'the trophy was consumed as a Forge ingredient');
    const forged = await db.prepare("SELECT COUNT(*) AS c FROM items WHERE ownerUsername = 'smith' AND templateId = 'rusty_knife'").first();
    assert.equal(forged.c, 1, 'gear was forged from the trophy');
  } finally {
    await db.close();
  }
});
