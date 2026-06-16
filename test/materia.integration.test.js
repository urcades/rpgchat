// Plan 020d: materia + sockets + AP growth. Materia socketed into EQUIPPED gear
// inject their effect (stat / grant_ability / affinity); the effect scales with the
// materia's AP-grown level; sockets are limited by the host. CommonJS + node:test.

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

async function seedUser(db, username) {
  await db.prepare(
    `INSERT INTO users (username, password, job, health, maxHealth, stamina, maxStamina, speed, strength, intelligence, level, gold)
     VALUES (?, 'pw', 'Novice', 30, 30, 100, 100, 1, 1, 1, 0, 0)`
  ).bind(username).run();
}

async function giveCarried(db, username, templateId, name, slotType) {
  await db.prepare(
    `INSERT INTO items (templateId, name, slotType, rarity, modifiers, ownerUsername)
     VALUES (?, ?, ?, 'rare', '{}', ?)`
  ).bind(templateId, name, slotType, username).run();
}

async function giveEquipped(db, username, templateId, name, slotType) {
  const part = await db.prepare('SELECT id FROM bodyParts WHERE username = ? AND slotType = ? AND severed = 0 ORDER BY id ASC LIMIT 1').bind(username, slotType).first();
  await db.prepare(
    `INSERT INTO items (templateId, name, slotType, rarity, modifiers, ownerUsername, equippedPartId)
     VALUES (?, ?, ?, 'rare', '{}', ?, ?)`
  ).bind(templateId, name, slotType, username, part.id).run();
}

// ---------------------------------------------------------------------------

test('Plan 020d: a stat materia socketed in equipped gear folds into effective stats; unsocket reverts', async () => {
  const db = await createMigratedDb();
  const { socketMateria, unsocketMateria, getUserState, updatePresence } = await import('../worker/game.mjs');
  try {
    const calm = findCalmRoom(getWorldDay());
    await seedUser(db, 'q');
    await updatePresence(db, 'q', calm.row, calm.col);
    await getUserState(db, 'q');
    await giveEquipped(db, 'q', 'frostbitten_fang', 'Frostbitten Fang', 'hand'); // rare gear → 2 sockets
    await giveCarried(db, 'q', 'power_materia', 'Power Materia', 'materia');

    const before = (await getUserState(db, 'q')).effectiveStats.strength;
    await socketMateria(db, 'q', 'Power Materia', 'Frostbitten Fang');
    const after = (await getUserState(db, 'q')).effectiveStats.strength;
    assert.equal(after, before + 1, 'L1 power materia adds +1 strength');

    const state = await getUserState(db, 'q');
    assert.ok(!state.inventory.some(i => i.name === 'Power Materia'), 'socketed materia leaves the loose inventory');
    assert.ok(state.socketSummary.some(s => s.host === 'Frostbitten Fang' && s.materia.includes('Power Materia')), 'socket summary shows it');

    await unsocketMateria(db, 'q', 'Power Materia');
    assert.equal((await getUserState(db, 'q')).effectiveStats.strength, before, 'unsocket reverts the bonus');
  } finally {
    await db.close();
  }
});

test('Plan 020d: materia only count while the host is equipped', async () => {
  const db = await createMigratedDb();
  const { socketMateria, getUserState, updatePresence } = await import('../worker/game.mjs');
  try {
    const calm = findCalmRoom(getWorldDay());
    await seedUser(db, 'q');
    await updatePresence(db, 'q', calm.row, calm.col);
    await getUserState(db, 'q');
    await giveCarried(db, 'q', 'frostbitten_fang', 'Frostbitten Fang', 'hand'); // carried, NOT equipped
    await giveCarried(db, 'q', 'power_materia', 'Power Materia', 'materia');

    const before = (await getUserState(db, 'q')).effectiveStats.strength;
    await socketMateria(db, 'q', 'Power Materia', 'Frostbitten Fang');
    assert.equal((await getUserState(db, 'q')).effectiveStats.strength, before, 'a materia in carried (unequipped) gear is inert');
  } finally {
    await db.close();
  }
});

test('Plan 020d: socket validation — sockets fill up, only materia, only gear hosts', async () => {
  const db = await createMigratedDb();
  const { socketMateria, getUserState, updatePresence } = await import('../worker/game.mjs');
  try {
    const calm = findCalmRoom(getWorldDay());
    await seedUser(db, 'q');
    await updatePresence(db, 'q', calm.row, calm.col);
    await getUserState(db, 'q');
    await giveEquipped(db, 'q', 'rusty_knife', 'Rusty Knife', 'hand'); // common → 1 socket
    await giveCarried(db, 'q', 'power_materia', 'Power Materia', 'materia');
    await giveCarried(db, 'q', 'swift_materia', 'Swift Materia', 'materia');

    await socketMateria(db, 'q', 'Power Materia', 'Rusty Knife');
    await assert.rejects(() => socketMateria(db, 'q', 'Swift Materia', 'Rusty Knife'), /sockets are full/);
    await assert.rejects(() => socketMateria(db, 'q', 'Rusty Knife', 'Rusty Knife'), /not materia/);
    await assert.rejects(() => socketMateria(db, 'q', 'Swift Materia', 'Power Materia'), /cannot hold materia/);
  } finally {
    await db.close();
  }
});

test('Plan 020d: a grant_ability materia makes its ability usable; affinity materia adds resistance', async () => {
  const db = await createMigratedDb();
  const { socketMateria, validateClassSkillUse, getElementAffinity, getUserState, getCurrentTickValue, updatePresence } = await import('../worker/game.mjs');
  try {
    const calm = findCalmRoom(getWorldDay());
    await seedUser(db, 'q');
    await updatePresence(db, 'q', calm.row, calm.col);
    await getUserState(db, 'q');
    await giveEquipped(db, 'q', 'frostbitten_fang', 'Frostbitten Fang', 'hand');
    await giveEquipped(db, 'q', 'padded_vest', 'Padded Vest', 'torso');
    await giveCarried(db, 'q', 'spell_materia', 'Spell Materia', 'materia');
    await giveCarried(db, 'q', 'guard_materia', 'Guard Materia', 'materia');

    // grant_ability materia → arcane_pin usable + on the hotbar.
    await assert.rejects(() => validateClassSkillUse(db, { username: 'q', skillId: 'arcane_pin', targetUsername: 'q' }), /cannot use that skill/);
    await socketMateria(db, 'q', 'Spell Materia', 'Frostbitten Fang');
    const ok = await validateClassSkillUse(db, { username: 'q', skillId: 'arcane_pin', targetUsername: 'q' });
    assert.equal(ok.ability.id, 'arcane_pin');
    assert.ok((await getUserState(db, 'q')).skills.map(s => s.id).includes('arcane_pin'), 'on the hotbar');

    // affinity materia in the torso armor → fire resist on that part.
    const torso = await db.prepare("SELECT label FROM bodyParts WHERE username='q' AND slotType='torso' AND severed=0 ORDER BY id ASC LIMIT 1").bind().first();
    const tick = await getCurrentTickValue(db);
    const before = await getElementAffinity(db, 'q', 'fire', torso.label, calm.row, calm.col, tick);
    await socketMateria(db, 'q', 'Guard Materia', 'Padded Vest');
    const after = await getElementAffinity(db, 'q', 'fire', torso.label, calm.row, calm.col, tick);
    assert.equal(after, before - 0.25, 'guard materia adds fire resistance to its part');
  } finally {
    await db.close();
  }
});

test('Plan 020d: materia grows with AP — effect scales with level', async () => {
  const db = await createMigratedDb();
  const { socketMateria, getUserState, updatePresence } = await import('../worker/game.mjs');
  try {
    const calm = findCalmRoom(getWorldDay());
    await seedUser(db, 'q');
    await updatePresence(db, 'q', calm.row, calm.col);
    await getUserState(db, 'q');
    await giveEquipped(db, 'q', 'frostbitten_fang', 'Frostbitten Fang', 'hand');
    await giveCarried(db, 'q', 'power_materia', 'Power Materia', 'materia');

    const base = (await getUserState(db, 'q')).effectiveStats.strength;
    await socketMateria(db, 'q', 'Power Materia', 'Frostbitten Fang');
    assert.equal((await getUserState(db, 'q')).effectiveStats.strength, base + 1, 'L1 = +1');

    // Grow the materia to level 2 (AP ≥ 10).
    await db.prepare("UPDATE items SET ap = 10 WHERE ownerUsername='q' AND name='Power Materia'").bind().run();
    assert.equal((await getUserState(db, 'q')).effectiveStats.strength, base + 2, 'L2 = +2');
  } finally {
    await db.close();
  }
});
