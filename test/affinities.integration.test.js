// Plan 020c: elemental affinities as statuses (model B). A weapon's element lands a
// status on the struck part, scaled by per-part affinity (armor + room mood); the
// status ticks (burn damages, shock saps stamina) or folds into stats (chill →
// speed). No element → no status (combat parity). CommonJS + node:test.

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

function findRoomWithEffect(worldDay, effectType) {
  for (let row = 1; row <= 16; row += 1) {
    for (let col = 1; col <= 16; col += 1) {
      if (generateRoomFeatures(row, col, worldDay).map(f => f.effect?.type).includes(effectType)) return { row, col };
    }
  }
  return null;
}

async function seedUser(db, username) {
  await db.prepare(
    `INSERT INTO users (username, password, job, health, maxHealth, stamina, maxStamina, speed, strength, intelligence, level, gold)
     VALUES (?, 'pw', 'Novice', 30, 30, 100, 100, 3, 1, 1, 0, 0)`
  ).bind(username).run();
}

async function equip(db, username, templateId, name, slotType) {
  const part = await db.prepare('SELECT id FROM bodyParts WHERE username = ? AND slotType = ? AND severed = 0 ORDER BY id ASC LIMIT 1').bind(username, slotType).first();
  await db.prepare(
    `INSERT INTO items (templateId, name, slotType, rarity, modifiers, ownerUsername, equippedPartId)
     VALUES (?, ?, ?, 'rare', '{}', ?, ?)`
  ).bind(templateId, name, slotType, username, part.id).run();
}

async function partLabelOf(db, username, slotType) {
  const part = await db.prepare('SELECT label FROM bodyParts WHERE username = ? AND slotType = ? AND severed = 0 ORDER BY id ASC LIMIT 1').bind(username, slotType).first();
  return part.label;
}

// ---------------------------------------------------------------------------

test('Plan 020c: a weapon\'s element is read from equipped gear', async () => {
  const db = await createMigratedDb();
  const { getAttackElement, getUserState } = await import('../worker/game.mjs');
  try {
    await seedUser(db, 'a');
    await getUserState(db, 'a');
    assert.equal(await getAttackElement(db, 'a'), null, 'no weapon → no element');
    await equip(db, 'a', 'flametongue', 'Flametongue', 'hand');
    assert.equal(await getAttackElement(db, 'a'), 'fire', 'Flametongue reads as fire');
  } finally {
    await db.close();
  }
});

test('Plan 020c: per-part affinity sums worn armor and the room mood', async () => {
  const db = await createMigratedDb();
  const { getElementAffinity, getUserState, getCurrentTickValue } = await import('../worker/game.mjs');
  try {
    const calm = findCalmRoom(getWorldDay());
    await seedUser(db, 'v');
    await getUserState(db, 'v');
    const tick = await getCurrentTickValue(db);

    assert.equal(await getElementAffinity(db, 'v', 'fire', null, calm.row, calm.col, tick), 0, 'neutral');

    await equip(db, 'v', 'wyrmscale_cloak', 'Wyrmscale Cloak', 'torso');
    const torso = await partLabelOf(db, 'v', 'torso');
    assert.equal(await getElementAffinity(db, 'v', 'fire', torso, calm.row, calm.col, tick), -0.5, 'resist armor on the struck part');

    await equip(db, 'v', 'straw_hat', 'Straw Hat', 'head');
    const head = await partLabelOf(db, 'v', 'head');
    assert.equal(await getElementAffinity(db, 'v', 'fire', head, calm.row, calm.col, tick), 0.5, 'weak armor on the struck part');

    const sun = findRoomWithEffect(getWorldDay(), 'sun_room');
    if (sun) {
      assert.equal(await getElementAffinity(db, 'v', 'fire', null, sun.row, sun.col, tick), 0.5, 'the sun room amplifies fire');
    }
  } finally {
    await db.close();
  }
});

test('Plan 020c: an elemental hit lands a status scaled by affinity (resist mitigates, weak worsens)', async () => {
  const db = await createMigratedDb();
  const { applyElementOnHit, getUserState, getCurrentTickValue } = await import('../worker/game.mjs');
  try {
    const calm = findCalmRoom(getWorldDay());
    await seedUser(db, 'v');
    await getUserState(db, 'v');
    const tick = await getCurrentTickValue(db);

    const neutral = await applyElementOnHit(db, { attacker: 'x', target: 'v', element: 'fire', partLabel: null, row: calm.row, col: calm.col, currentTick: tick });
    assert.equal(neutral.status, 'burn');
    assert.equal(neutral.magnitude, 2, 'neutral burn = base 2');

    await equip(db, 'v', 'wyrmscale_cloak', 'Wyrmscale Cloak', 'torso');
    const torso = await partLabelOf(db, 'v', 'torso');
    const resisted = await applyElementOnHit(db, { attacker: 'x', target: 'v', element: 'fire', partLabel: torso, row: calm.row, col: calm.col, currentTick: tick });
    assert.equal(resisted.magnitude, 1, 'resist halves the burn');

    await equip(db, 'v', 'straw_hat', 'Straw Hat', 'head');
    const head = await partLabelOf(db, 'v', 'head');
    const weak = await applyElementOnHit(db, { attacker: 'x', target: 'v', element: 'fire', partLabel: head, row: calm.row, col: calm.col, currentTick: tick });
    assert.equal(weak.magnitude, 3, 'weakness worsens the burn');

    const burns = await db.prepare("SELECT COUNT(*) AS c FROM statusEffects WHERE username = 'v' AND effectType = 'burn'").bind().first();
    assert.equal(burns.c, 3, 'each hit recorded a burn');
  } finally {
    await db.close();
  }
});

test('Plan 020c: burn ticks damage; chill saps effective speed', async () => {
  const db = await createMigratedDb();
  const { addStatusEffect, processStatusEffects, getUserState, getCurrentTickValue, updatePresence } = await import('../worker/game.mjs');
  try {
    const calm = findCalmRoom(getWorldDay());
    await seedUser(db, 'v');
    await updatePresence(db, 'v', calm.row, calm.col);
    await getUserState(db, 'v');
    const tick = await getCurrentTickValue(db);

    // chill folds into effective speed (seeded speed 3 → 3 − 2 = 1).
    await addStatusEffect(db, { username: 'v', source: 'v', effectType: 'chill', magnitude: 2, currentTick: tick, duration: 5, row: calm.row, col: calm.col });
    assert.equal((await getUserState(db, 'v')).effectiveStats.speed, 1, 'chill reduces effective speed');

    // burn ticks damage on the next world tick.
    await addStatusEffect(db, { username: 'v', source: 'x', effectType: 'burn', magnitude: 3, currentTick: tick, duration: 5, row: calm.row, col: calm.col });
    const before = (await getUserState(db, 'v')).effectiveStats.health;
    await processStatusEffects(db, tick + 1);
    const after = (await getUserState(db, 'v')).effectiveStats.health;
    assert.ok(after < before, `burn dealt tick damage (${before} → ${after})`);
  } finally {
    await db.close();
  }
});
