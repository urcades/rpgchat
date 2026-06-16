// Plan 005 integration coverage — exercises the real /equip, /take, and death
// handlers against an in-memory D1, focusing on behaviors the big
// workerMigration.test.js suite does NOT already assert:
//   - getUserState's equipment map / inventory list / non-strength gear folding
//     into effectiveStats through the payload (existing tests only check raw DB
//     rows and effectiveStats.strength from a raw-inserted axe);
//   - a floor item picked up via /take then equipped, round-tripping ownership
//     into the getUserState payload (existing /take test never equips after);
//   - a sever knock-off item surfacing in getRoomEcology.groundItems and a
//     DIFFERENT player scavenging it via /take (existing tests assert the sever
//     drop and groundItems separately, never the chained flow).
//
// CommonJS + node:test to match the rest of test/.

const assert = require('node:assert/strict');
const test = require('node:test');
const { createSqliteD1, createMigratedDb } = require('./.helpers/d1');
const { getWorldDay, generateRoomFeatures } = require('../utils/roomEcology');

// --- D1 shim (same shape as workerMigration.test.js's createSqliteD1) --------
// A room with no health-affecting / RNG-consuming passive, so a post-action
// tick can't perturb counts or message tails. Mirrors workerMigration's helper.
function findCalmRoom(worldDay) {
  for (let row = 1; row <= 16; row += 1) {
    for (let col = 1; col <= 16; col += 1) {
      const features = generateRoomFeatures(row, col, worldDay);
      const hazardous = features.some(feature =>
        ['poison_marsh', 'moon_room', 'echo_chamber', 'pub', 'inn', 'sun_room', 'cold_room', 'guild']
          .includes(feature.effect?.type));
      if (!hazardous) {
        return { row, col };
      }
    }
  }
  throw new Error('No calm room found for ' + worldDay);
}

async function seedLiveUser(db, username, overrides = {}) {
  const stats = {
    job: 'Novice', health: 30, maxHealth: 30, stamina: 100, maxStamina: 100,
    speed: 1, strength: 1, intelligence: 1, level: 0, ...overrides
  };
  await db.prepare(
    `INSERT INTO users
      (username, password, job, health, maxHealth, stamina, maxStamina, speed, strength, intelligence, level)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    username, 'pw', stats.job, stats.health, stats.maxHealth, stats.stamina,
    stats.maxStamina, stats.speed, stats.strength, stats.intelligence, stats.level
  ).run();
}

async function insertCarriedItem(db, owner, { templateId = 'tmpl', name, slotType, modifiers = {} }) {
  const result = await db.prepare(
    `INSERT INTO items (templateId, name, slotType, modifiers, ownerUsername)
     VALUES (?, ?, ?, ?, ?)`
  ).bind(templateId, name, slotType, JSON.stringify(modifiers), owner).run();
  return result.meta.last_row_id;
}

// ---------------------------------------------------------------------------

test('Plan 005: equipping surfaces in the getUserState equipment map and folds a non-strength modifier into effectiveStats', async () => {
  const db = await createMigratedDb();
  const { handleChatAction, getUserState, updatePresence } = await import('../worker/game.mjs');

  try {
    await seedLiveUser(db, 'scholar', { health: 30, maxHealth: 30, intelligence: 1 });
    await updatePresence(db, 'scholar', 1, 1);
    await getUserState(db, 'scholar'); // instantiate body parts

    // A trinket mounts on the neck part. intelligence is a live effective-layer
    // modifier (unlike maxHealth, which is structural and intentionally hidden).
    await insertCarriedItem(db, 'scholar', { name: 'Sage Pendant', slotType: 'trinket', modifiers: { intelligence: 2 } });

    const before = await getUserState(db, 'scholar');
    assert.equal(before.effectiveStats.intelligence, 1, 'baseline intelligence with no gear');
    assert.equal(before.equipment.neck, null, 'neck starts empty in the equipment map');
    assert.deepEqual(
      before.inventory.map(i => i.name),
      ['Sage Pendant'],
      'unequipped item is listed as carried inventory'
    );
    assert.deepEqual(
      before.inventory[0].modifiers,
      { intelligence: 2 },
      'carried inventory exposes parsed modifiers'
    );

    await handleChatAction(db, 'scholar', 1, 1, '/equip Sage Pendant');

    const after = await getUserState(db, 'scholar');
    assert.equal(after.effectiveStats.intelligence, 3, 'trinket intelligence +2 folds into effectiveStats');
    assert.equal(after.gearBonuses.intelligence, 2, 'gearBonuses reports the trinket bonus');
    assert.equal(after.equipment.neck, 'Sage Pendant', 'equipment map keyed by part label shows the worn trinket');
    assert.equal(after.inventory.length, 0, 'equipped item is no longer carried inventory');
  } finally {
    await db.close();
  }
});

test('Plan 005: a floor item taken via /take becomes carried inventory and can then be equipped', async () => {
  const db = await createMigratedDb();
  const { handleChatAction, dropItemOnFloor, getUserState, updatePresence } = await import('../worker/game.mjs');

  try {
    await seedLiveUser(db, 'scav', { health: 30, maxHealth: 30, strength: 1 });
    await updatePresence(db, 'scav', 1, 1);
    await getUserState(db, 'scav'); // instantiate body

    // Rusty Knife is a real catalog template (hand slot, strength +1).
    await dropItemOnFloor(db, 'rusty_knife', 1, 1);

    // /take pulls it off the floor into the pack (carried, not equipped — no fold yet).
    await handleChatAction(db, 'scav', 1, 1, '/take Rusty Knife');
    const carried = await getUserState(db, 'scav');
    assert.deepEqual(carried.inventory.map(i => i.name), ['Rusty Knife'], 'taken item is carried');
    assert.equal(carried.effectiveStats.strength, 1, 'merely carrying it does not fold into stats');

    // Now equip the taken item; its strength bonus folds in and it leaves the pack.
    await handleChatAction(db, 'scav', 1, 1, '/equip Rusty Knife');
    const wielded = await getUserState(db, 'scav');
    assert.equal(wielded.inventory.length, 0, 'equipped item left the carried pack');
    assert.equal(wielded.equipment['left arm'], 'Rusty Knife', 'knife is on the first hand part');
    assert.equal(wielded.effectiveStats.strength, 2, 'equipped knife folds strength +1 into effectiveStats');
  } finally {
    await db.close();
  }
});

test('Plan 005: a severed limb drops its equipped item to the floor where another player scavenges it', async () => {
  const db = await createMigratedDb();
  const {
    applyBodyDamage, handleChatAction, getRoomEcology, getUserState, getUser, updatePresence
  } = await import('../worker/game.mjs');

  try {
    const calm = findCalmRoom(getWorldDay());
    await seedLiveUser(db, 'victim', { health: 30, maxHealth: 30 });
    await seedLiveUser(db, 'looter', { health: 30, maxHealth: 30 });
    await updatePresence(db, 'victim', calm.row, calm.col);
    await updatePresence(db, 'looter', calm.row, calm.col);
    await getUserState(db, 'victim'); // instantiate body
    await getUserState(db, 'looter');

    await insertCarriedItem(db, 'victim', { name: 'Heirloom Dagger', slotType: 'hand' });
    await handleChatAction(db, 'victim', calm.row, calm.col, '/equip Heirloom Dagger'); // left arm

    // Sever the left arm (range [0.467,0.600); random 0.5; 4 damage 4->0).
    const sever = await applyBodyDamage(db, await getUser(db, 'victim'), 4, {
      cause: 'a cleaver', row: calm.row, col: calm.col, random: () => 0.5
    });
    assert.deepEqual(sever.severedLabels, ['left arm']);

    // The knocked-off item now surfaces in the room payload's groundItems.
    const ecology = await getRoomEcology(db, 'looter', calm.row, calm.col);
    assert.deepEqual(
      ecology.groundItems.map(item => item.name),
      ['Heirloom Dagger'],
      'severed item appears on the floor in the room payload'
    );

    // A DIFFERENT player walks up and scavenges it.
    await handleChatAction(db, 'looter', calm.row, calm.col, '/take Heirloom Dagger');

    const owned = await db.prepare(
      "SELECT ownerUsername, equippedPartId, roomRow, roomCol FROM items WHERE name = 'Heirloom Dagger'"
    ).first();
    assert.equal(owned.ownerUsername, 'looter', 'looter now owns the scavenged item');
    assert.equal(owned.equippedPartId, null, 'taken item is carried, not equipped');
    assert.equal(owned.roomRow, null, 'taken item is off the floor');

    const looterState = await getUserState(db, 'looter');
    assert.deepEqual(looterState.inventory.map(i => i.name), ['Heirloom Dagger'], 'scavenged item is in the looter pack');

    // The floor is empty again.
    const after = await getRoomEcology(db, 'looter', calm.row, calm.col);
    assert.equal(after.groundItems.length, 0, 'floor is clear after the take');
  } finally {
    await db.close();
  }
});

test('/drop moves a carried item from the pack to the current room floor', async () => {
  const db = await createMigratedDb();
  const { handleChatAction, getUserState, getFloorItems, updatePresence } = await import('../worker/game.mjs');

  try {
    const calm = findCalmRoom(getWorldDay());
    await seedLiveUser(db, 'dropper', { health: 30, maxHealth: 30 });
    await updatePresence(db, 'dropper', calm.row, calm.col);
    await getUserState(db, 'dropper'); // instantiate body
    await insertCarriedItem(db, 'dropper', { name: 'Old Boot', slotType: 'leg' });

    const before = await getUserState(db, 'dropper');
    assert.deepEqual(before.inventory.map(i => i.name), ['Old Boot'], 'boot starts carried');

    const action = await handleChatAction(db, 'dropper', calm.row, calm.col, '/drop Old Boot');
    assert.equal(action.dropped, 'Old Boot');

    const after = await getUserState(db, 'dropper');
    assert.equal(after.inventory.length, 0, 'dropped item left the pack');

    const floor = await getFloorItems(db, calm.row, calm.col);
    assert.deepEqual(floor.map(i => i.name), ['Old Boot'], 'item now lies on the room floor');

    // Dropping something you are not carrying is rejected.
    await assert.rejects(
      handleChatAction(db, 'dropper', calm.row, calm.col, '/drop Old Boot'),
      /aren't carrying that/
    );
  } finally {
    await db.close();
  }
});

test('getUserState exposes currentRoom from presence and gearHealthBonus from worn armor', async () => {
  const db = await createMigratedDb();
  const { handleChatAction, getUserState, updatePresence } = await import('../worker/game.mjs');

  try {
    const calm = findCalmRoom(getWorldDay());
    await seedLiveUser(db, 'armored', { health: 30, maxHealth: 30 });
    await updatePresence(db, 'armored', calm.row, calm.col);
    await getUserState(db, 'armored'); // instantiate body

    const fresh = await getUserState(db, 'armored');
    assert.deepEqual(fresh.currentRoom, { row: calm.row, col: calm.col }, 'current room is read from presence');
    assert.equal(fresh.gearHealthBonus, 0, 'no armor worn yet');

    await insertCarriedItem(db, 'armored', { name: 'Plate Vest', slotType: 'torso', modifiers: { maxHealth: 5 } });
    await handleChatAction(db, 'armored', calm.row, calm.col, '/equip Plate Vest');

    const equipped = await getUserState(db, 'armored');
    assert.equal(equipped.equipment.torso, 'Plate Vest', 'vest sits on the torso slot');
    assert.equal(equipped.gearHealthBonus, 5, 'worn armor HP surfaces as gearHealthBonus');
    assert.equal(equipped.effectiveStats.maxHealth, 35, 'armor HP is folded into effective maxHealth');
  } finally {
    await db.close();
  }
});
