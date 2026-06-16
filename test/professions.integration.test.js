// Plan 022 (tail): Brew + Forge professions. Both mirror /cook exactly — the
// verb-agnostic craftRecipe consumes carried inputs and yields the output. Brew
// makes consumables (a brewed tonic /use-fires its onUse); Forge reforges scrap (and
// dual-use trophies) into gear (which /equip-s). Professions are UNGATED — a Novice
// can brew and forge. CommonJS + node:test, mirroring crafting/consumables tests.

const assert = require('node:assert/strict');
const test = require('node:test');
const { createSqliteD1, createMigratedDb } = require('./.helpers/d1');
const { getWorldDay, generateRoomFeatures } = require('../utils/roomEcology');

function findCalmRoom(worldDay) {
  const hazardous = ['poison_marsh', 'moon_room', 'echo_chamber', 'pub', 'inn', 'sun_room', 'cold_room', 'guild'];
  for (let row = 1; row <= 16; row += 1) {
    for (let col = 1; col <= 16; col += 1) {
      const types = generateRoomFeatures(row, col, worldDay).map(f => f.effect?.type);
      if (!types.some(t => hazardous.includes(t))) return { row, col };
    }
  }
  throw new Error('No calm room for ' + worldDay);
}

async function seedUser(db, username, job = 'Novice') {
  await db.prepare(
    `INSERT INTO users (username, password, job, health, maxHealth, stamina, maxStamina, speed, strength, intelligence, level, gold)
     VALUES (?, 'pw', ?, 30, 30, 100, 100, 1, 1, 1, 0, 0)`
  ).bind(username, job).run();
}

async function giveCarried(db, username, templateId, name, slotType = 'part', quantity = 1) {
  await db.prepare(
    `INSERT INTO items (templateId, name, slotType, rarity, modifiers, ownerUsername, quantity)
     VALUES (?, ?, ?, 'common', '{}', ?, ?)`
  ).bind(templateId, name, slotType, username, quantity).run();
}

async function countOwned(db, username, templateId) {
  const row = await db.prepare('SELECT COUNT(*) AS c FROM items WHERE ownerUsername = ? AND templateId = ?').bind(username, templateId).first();
  return row.c;
}

// ---------------------------------------------------------------------------

test('Plan 022 (tail): brewing consumes remains and yields a tonic', async () => {
  const db = await createMigratedDb();
  const { craftRecipe } = await import('../worker/game.mjs');
  try {
    await seedUser(db, 'q');
    await giveCarried(db, 'q', 'monster_remains', 'Monster Remains');
    await giveCarried(db, 'q', 'monster_remains', 'Monster Remains');

    const result = await craftRecipe(db, 'q', 'brew', 'Crimson Tonic');
    assert.equal(result.crafted, 'Crimson Tonic');
    assert.equal(await countOwned(db, 'q', 'monster_remains'), 0, 'both remains were consumed');
    assert.equal(await countOwned(db, 'q', 'crimson_tonic'), 1, 'a tonic was produced');
  } finally {
    await db.close();
  }
});

test('Plan 022 (tail): forging consumes scrap and yields gear', async () => {
  const db = await createMigratedDb();
  const { craftRecipe } = await import('../worker/game.mjs');
  try {
    await seedUser(db, 'q');
    await giveCarried(db, 'q', 'scrap_metal', 'Scrap Metal');
    await giveCarried(db, 'q', 'scrap_metal', 'Scrap Metal');

    const result = await craftRecipe(db, 'q', 'forge', 'Rusty Knife');
    assert.equal(result.crafted, 'Rusty Knife');
    assert.equal(await countOwned(db, 'q', 'scrap_metal'), 0, 'the scrap was consumed');
    assert.equal(await countOwned(db, 'q', 'rusty_knife'), 1, 'gear was produced');
  } finally {
    await db.close();
  }
});

test('Plan 022 (tail): a Novice can /brew (ungated) and the brewed consumable /use-fires its onUse', async () => {
  const db = await createMigratedDb();
  const { handleChatAction, useItem, getUserState, updatePresence } = await import('../worker/game.mjs');
  try {
    const calm = findCalmRoom(getWorldDay());
    await seedUser(db, 'q', 'Novice'); // explicitly the unskilled starter job
    await updatePresence(db, 'q', calm.row, calm.col);
    await getUserState(db, 'q'); // instantiate body
    await giveCarried(db, 'q', 'monster_remains', 'Monster Remains');
    await giveCarried(db, 'q', 'monster_remains', 'Monster Remains');

    // Full dispatch path: /brew costs stamina + advances a tick, like /cook.
    const tickBefore = (await db.prepare('SELECT value FROM tick WHERE id = 1').first()).value;
    await handleChatAction(db, 'q', calm.row, calm.col, '/brew Crimson Tonic');
    const after = await db.prepare("SELECT stamina FROM users WHERE username = 'q'").first();
    assert.equal(after.stamina, 99, 'one stamina spent (ungated, like /cook)');
    const tickAfter = (await db.prepare('SELECT value FROM tick WHERE id = 1').first()).value;
    assert.equal(tickAfter, tickBefore + 1, 'the world tick advanced once');
    assert.equal(await countOwned(db, 'q', 'crimson_tonic'), 1, 'the Novice brewed a tonic');

    // Wound the player so the tonic's heal has headroom, then /use it.
    const part = await db.prepare("SELECT id FROM bodyParts WHERE username = 'q' AND severed = 0 ORDER BY maxHp DESC LIMIT 1").first();
    await db.prepare('UPDATE bodyParts SET hp = hp - 10 WHERE id = ?').bind(part.id).run();
    await db.prepare("UPDATE users SET health = health - 10 WHERE username = 'q'").run();
    const before = (await getUserState(db, 'q')).effectiveStats.health;
    await useItem(db, 'q', 'Crimson Tonic', calm.row, calm.col);
    const healed = (await getUserState(db, 'q')).effectiveStats.health;
    assert.ok(healed > before, `the brewed tonic healed on use (${before} -> ${healed})`);
    assert.equal(await countOwned(db, 'q', 'crimson_tonic'), 0, 'the tonic charge was consumed');
  } finally {
    await db.close();
  }
});

test('Plan 022 (tail): a Novice can /forge (ungated) and the forged gear /equip-s', async () => {
  const db = await createMigratedDb();
  const { handleChatAction, getUserState, updatePresence } = await import('../worker/game.mjs');
  try {
    const calm = findCalmRoom(getWorldDay());
    await seedUser(db, 'q', 'Novice');
    await updatePresence(db, 'q', calm.row, calm.col);
    await getUserState(db, 'q');
    await giveCarried(db, 'q', 'scrap_metal', 'Scrap Metal');
    await giveCarried(db, 'q', 'scrap_metal', 'Scrap Metal');

    await handleChatAction(db, 'q', calm.row, calm.col, '/forge Rusty Knife');
    assert.equal(await countOwned(db, 'q', 'rusty_knife'), 1, 'the Novice forged a knife');

    // The forged gear equips through the existing /equip path (mounts on a hand).
    await handleChatAction(db, 'q', calm.row, calm.col, '/equip Rusty Knife');
    const equipped = await db.prepare("SELECT equippedPartId FROM items WHERE ownerUsername = 'q' AND templateId = 'rusty_knife'").first();
    assert.ok(equipped && equipped.equippedPartId !== null, 'the forged knife is equipped on a body part');
    const sheet = await getUserState(db, 'q');
    assert.ok(Object.values(sheet.equipment).includes('Rusty Knife'), 'the forged knife shows in the equipment map');
  } finally {
    await db.close();
  }
});

test('Plan 022 (tail): brew/forge reject missing inputs and unknown recipes', async () => {
  const db = await createMigratedDb();
  const { craftRecipe } = await import('../worker/game.mjs');
  try {
    await seedUser(db, 'q');
    // No inputs carried.
    await assert.rejects(() => craftRecipe(db, 'q', 'brew', 'Crimson Tonic'), /need/i);
    await assert.rejects(() => craftRecipe(db, 'q', 'forge', 'Rusty Knife'), /need/i);
    // Unknown recipes per verb.
    await assert.rejects(() => craftRecipe(db, 'q', 'brew', 'Elixir of Life'), /No brew recipe/);
    await assert.rejects(() => craftRecipe(db, 'q', 'forge', 'Excalibur'), /No forge recipe/);
  } finally {
    await db.close();
  }
});
