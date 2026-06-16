// Plan 020a: consumables + the effects-walker. A `/use <item>` verb runs a
// consumable's onUse effects through the shared primitives (heal / clear_status)
// and consumes a charge; non-consumables are rejected. CommonJS + node:test.

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

async function giveItem(db, username, templateId, name, slotType, quantity = 1) {
  await db.prepare(
    `INSERT INTO items (templateId, name, slotType, rarity, modifiers, ownerUsername, quantity)
     VALUES (?, ?, ?, 'common', '{}', ?, ?)`
  ).bind(templateId, name, slotType, username, quantity).run();
}

async function itemCount(db, username, name) {
  const row = await db.prepare("SELECT COUNT(*) AS c FROM items WHERE ownerUsername = ? AND LOWER(name) = LOWER(?)").bind(username, name).first();
  return row.c;
}

// ---------------------------------------------------------------------------

test('Plan 020a: /use a consumable runs its effect, posts a line, and consumes it', async () => {
  const db = await createMigratedDb();
  const { useItem, getUserState, updatePresence } = await import('../worker/game.mjs');
  try {
    const calm = findCalmRoom(getWorldDay());
    await seedUser(db, 'q');
    await updatePresence(db, 'q', calm.row, calm.col);
    await getUserState(db, 'q'); // instantiate body
    await giveItem(db, 'q', 'salted_bread', 'Salted Bread', 'consumable');

    const result = await useItem(db, 'q', 'Salted Bread', calm.row, calm.col);
    assert.equal(result.used, 'Salted Bread');
    assert.equal(await itemCount(db, 'q', 'Salted Bread'), 0, 'the last charge is consumed (row deleted)');
    const line = await db.prepare("SELECT kind FROM messages WHERE message LIKE 'q uses Salted Bread%' ORDER BY id DESC LIMIT 1").bind().first();
    assert.ok(line && line.kind === 'support', 'a support line is posted');
  } finally {
    await db.close();
  }
});

test('Plan 020a: a heal consumable restores health when below max', async () => {
  const db = await createMigratedDb();
  const { useItem, getUserState, updatePresence } = await import('../worker/game.mjs');
  try {
    const calm = findCalmRoom(getWorldDay());
    await seedUser(db, 'q');
    await updatePresence(db, 'q', calm.row, calm.col);
    await getUserState(db, 'q');
    // Wound one part by 8 and drop overall health to match.
    const part = await db.prepare("SELECT id FROM bodyParts WHERE username = 'q' AND severed = 0 ORDER BY maxHp DESC LIMIT 1").bind().first();
    await db.prepare('UPDATE bodyParts SET hp = hp - 8 WHERE id = ?').bind(part.id).run();
    await db.prepare("UPDATE users SET health = health - 8 WHERE username = 'q'").bind().run();

    const before = (await getUserState(db, 'q')).effectiveStats.health;
    await giveItem(db, 'q', 'salted_bread', 'Salted Bread', 'consumable');
    await useItem(db, 'q', 'Salted Bread', calm.row, calm.col);
    const after = (await getUserState(db, 'q')).effectiveStats.health;
    assert.ok(after > before, `health rose after a heal (${before} → ${after})`);
  } finally {
    await db.close();
  }
});

test('Plan 020a: an antidote clears a harmful status', async () => {
  const db = await createMigratedDb();
  const { useItem, getUserState, addStatusEffect, getCurrentTickValue, updatePresence } = await import('../worker/game.mjs');
  try {
    const calm = findCalmRoom(getWorldDay());
    await seedUser(db, 'q');
    await updatePresence(db, 'q', calm.row, calm.col);
    await getUserState(db, 'q');
    const tick = await getCurrentTickValue(db);
    await addStatusEffect(db, { username: 'q', source: 'q', effectType: 'poison', magnitude: 1, currentTick: tick, duration: 5, row: calm.row, col: calm.col });

    const before = await db.prepare("SELECT COUNT(*) AS c FROM statusEffects WHERE username = 'q' AND effectType = 'poison'").bind().first();
    assert.equal(before.c, 1, 'poisoned');

    await giveItem(db, 'q', 'antidote', 'Antidote', 'consumable');
    await useItem(db, 'q', 'Antidote', calm.row, calm.col);
    const after = await db.prepare("SELECT COUNT(*) AS c FROM statusEffects WHERE username = 'q' AND effectType = 'poison'").bind().first();
    assert.equal(after.c, 0, 'the antidote cleared the poison');
  } finally {
    await db.close();
  }
});

test('Plan 020a: a stacked consumable decrements rather than vanishing', async () => {
  const db = await createMigratedDb();
  const { useItem, getUserState, updatePresence } = await import('../worker/game.mjs');
  try {
    const calm = findCalmRoom(getWorldDay());
    await seedUser(db, 'q');
    await updatePresence(db, 'q', calm.row, calm.col);
    await getUserState(db, 'q');
    await giveItem(db, 'q', 'heal_potion', 'Healing Draught', 'consumable', 2);

    await useItem(db, 'q', 'Healing Draught', calm.row, calm.col);
    const row = await db.prepare("SELECT quantity FROM items WHERE ownerUsername = 'q' AND name = 'Healing Draught'").bind().first();
    assert.ok(row, 'the stack still exists');
    assert.equal(row.quantity, 1, 'one charge consumed, one remains');
  } finally {
    await db.close();
  }
});

test('Plan 020a: gear and missing items cannot be used', async () => {
  const db = await createMigratedDb();
  const { useItem, getUserState, updatePresence } = await import('../worker/game.mjs');
  try {
    const calm = findCalmRoom(getWorldDay());
    await seedUser(db, 'q');
    await updatePresence(db, 'q', calm.row, calm.col);
    await getUserState(db, 'q');
    await giveItem(db, 'q', 'rusty_knife', 'Rusty Knife', 'hand');

    await assert.rejects(() => useItem(db, 'q', 'Rusty Knife', calm.row, calm.col), /cannot be used/);
    await assert.rejects(() => useItem(db, 'q', 'Phantom Tonic', calm.row, calm.col), /not carrying/);
  } finally {
    await db.close();
  }
});
