// /give — one-way item hand-off between co-located players. Exercises the real
// handleGiveCommand (and one case through the handlers.mjs /give route) against an
// in-memory D1, covering the happy path (ownership moves; the public line is posted;
// the recipient can then equip it) and every validation refusal: self-give, an NPC
// target, a target who isn't present, an unknown target, a no-target command, an item
// the giver doesn't own, and an equipped item.
//
// CommonJS + node:test to match the rest of test/.

const assert = require('node:assert/strict');
const test = require('node:test');
const { createMigratedDb } = require('./.helpers/d1');
const { getWorldDay, generateRoomFeatures } = require('../utils/roomEcology');

// A room with no health-affecting / RNG-consuming passive, so the post-action tick
// can't perturb message counts or tails. Mirrors items.integration.test.js's helper.
function findCalmRoom(worldDay) {
  const hazardous = ['poison_marsh', 'moon_room', 'echo_chamber', 'pub', 'inn', 'sun_room', 'cold_room', 'guild'];
  for (let row = 1; row <= 16; row += 1) {
    for (let col = 1; col <= 16; col += 1) {
      if (!generateRoomFeatures(row, col, worldDay).map(f => f.effect?.type).some(t => hazardous.includes(t))) {
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

async function seedNpc(db, username, displayName, row, col, game) {
  await db.prepare(
    `INSERT INTO users
      (username, password, job, health, maxHealth, stamina, maxStamina, speed, strength, intelligence, level, isNpc, displayName, npcKind, disposition, role, npcWorldDay)
     VALUES (?, 'npc', 'Fighter', 20, 20, 100, 100, 4, 5, 1, 2, 1, ?, 'social', 'friendly', 'barmaid', ?)`
  ).bind(username, displayName, getWorldDay()).run();
  await game.updatePresence(db, username, row, col);
}

async function insertCarriedItem(db, owner, { templateId = 'tmpl', name, slotType, modifiers = {} }) {
  const result = await db.prepare(
    `INSERT INTO items (templateId, name, slotType, modifiers, ownerUsername)
     VALUES (?, ?, ?, ?, ?)`
  ).bind(templateId, name, slotType, JSON.stringify(modifiers), owner).run();
  return result.meta.last_row_id;
}

async function roomMessages(db, row, col) {
  const rows = await db.prepare(
    'SELECT username, message, kind FROM messages WHERE roomRow = ? AND roomCol = ? ORDER BY id ASC'
  ).bind(row, col).all();
  return rows.results;
}

// ---------------------------------------------------------------------------

test('/give: happy path — ownership moves to the recipient, a public line is posted, and the recipient can equip it', async () => {
  const db = await createMigratedDb();
  const { handleGiveCommand, getUserState, updatePresence } = await import('../worker/game.mjs');

  try {
    const calm = findCalmRoom(getWorldDay());
    await seedLiveUser(db, 'giver');
    await seedLiveUser(db, 'taker');
    await updatePresence(db, 'giver', calm.row, calm.col);
    await updatePresence(db, 'taker', calm.row, calm.col);
    await getUserState(db, 'giver'); // instantiate bodies
    await getUserState(db, 'taker');

    // Rusty Knife is a real catalog template (hand slot, strength +1).
    await insertCarriedItem(db, 'giver', { templateId: 'rusty_knife', name: 'Rusty Knife', slotType: 'hand', modifiers: { strength: 1 } });

    const result = await handleGiveCommand(db, 'giver', calm.row, calm.col, '/give Rusty Knife @taker');
    assert.deepEqual(result, { gave: 'Rusty Knife', to: 'taker' }, 'confirmation names the item and recipient');

    // Ownership flipped; the item is carried (off any floor), not equipped.
    const moved = await db.prepare(
      "SELECT ownerUsername, equippedPartId, roomRow, roomCol FROM items WHERE name = 'Rusty Knife'"
    ).first();
    assert.equal(moved.ownerUsername, 'taker', 'recipient now owns the item');
    assert.equal(moved.equippedPartId, null, 'handed-off item is carried, not equipped');
    assert.equal(moved.roomRow, null, 'item never touched a floor');
    assert.equal(moved.roomCol, null, 'item never touched a floor');

    // The giver no longer carries it; the recipient does.
    const giverState = await getUserState(db, 'giver');
    assert.equal(giverState.inventory.length, 0, 'giver no longer carries the item');
    const takerState = await getUserState(db, 'taker');
    assert.deepEqual(takerState.inventory.map(i => i.name), ['Rusty Knife'], 'recipient now carries the item');

    // The hand-off is announced PUBLICLY in the room feed (System line, by displayName).
    const msgs = await roomMessages(db, calm.row, calm.col);
    const handoff = msgs.find(m => m.message === 'giver hands the Rusty Knife to taker.');
    assert.ok(handoff, 'a public hand-off line is posted to the room');
    assert.equal(handoff.username, 'System', 'the announcement is a system line everyone present sees');

    // The recipient can then equip the received item — its strength +1 folds in.
    const { handleChatAction } = await import('../worker/game.mjs');
    await handleChatAction(db, 'taker', calm.row, calm.col, '/equip Rusty Knife');
    const wielded = await getUserState(db, 'taker');
    assert.equal(wielded.inventory.length, 0, 'equipped item left the recipient pack');
    assert.equal(wielded.effectiveStats.strength, 2, 'received-then-equipped knife folds strength +1');
  } finally {
    await db.close();
  }
});

test('/give: through the handlers.mjs /give route (spends stamina, advances the tick) the item still moves', async () => {
  const db = await createMigratedDb();
  const { handleChatAction, getUserState, updatePresence } = await import('../worker/game.mjs');

  try {
    const calm = findCalmRoom(getWorldDay());
    await seedLiveUser(db, 'router_giver', { stamina: 100, maxStamina: 100 });
    await seedLiveUser(db, 'router_taker');
    await updatePresence(db, 'router_giver', calm.row, calm.col);
    await updatePresence(db, 'router_taker', calm.row, calm.col);
    await getUserState(db, 'router_giver');
    await getUserState(db, 'router_taker');
    await insertCarriedItem(db, 'router_giver', { name: 'Old Boot', slotType: 'leg' });

    await handleChatAction(db, 'router_giver', calm.row, calm.col, '/give Old Boot @router_taker');

    const moved = await db.prepare("SELECT ownerUsername FROM items WHERE name = 'Old Boot'").first();
    assert.equal(moved.ownerUsername, 'router_taker', 'the /give route moved ownership');

    // The action spent stamina (the route wraps it in runPlayerAction with staminaCost 1).
    const after = await getUserState(db, 'router_giver');
    assert.ok(after.stamina < 100, 'the /give route spent stamina');
  } finally {
    await db.close();
  }
});

test('adv-006: resolveGiveTarget resolves a CO-LOCATED recipient but rejects an identically-named one standing elsewhere', async () => {
  const db = await createMigratedDb();
  const { handleGiveCommand, getUserState, updatePresence } = await import('../worker/game.mjs');

  try {
    const calm = findCalmRoom(getWorldDay());
    const other = { row: calm.row, col: (calm.col % 16) + 1 };
    await seedLiveUser(db, 'donor');
    await seedLiveUser(db, 'nearby');   // co-located with the donor
    await seedLiveUser(db, 'faraway');  // present, but in a DIFFERENT room
    await updatePresence(db, 'donor', calm.row, calm.col);
    await updatePresence(db, 'nearby', calm.row, calm.col);
    await updatePresence(db, 'faraway', other.row, other.col);
    await getUserState(db, 'donor');
    await getUserState(db, 'nearby');
    await getUserState(db, 'faraway');

    // Two carried items so we can attempt both a co-located and a remote hand-off.
    await insertCarriedItem(db, 'donor', { name: 'Old Boot', slotType: 'leg' });
    await insertCarriedItem(db, 'donor', { name: 'Worn Cap', slotType: 'head' });

    // Co-located target resolves and receives the item (presence-scoped resolution).
    const ok = await handleGiveCommand(db, 'donor', calm.row, calm.col, '/give Old Boot @nearby');
    assert.deepEqual(ok, { gave: 'Old Boot', to: 'nearby' }, 'a co-located recipient resolves and receives');
    const moved = await db.prepare("SELECT ownerUsername FROM items WHERE name = 'Old Boot'").first();
    assert.equal(moved.ownerUsername, 'nearby', 'ownership moved to the co-located recipient');

    // A real, present user who is NOT in this room is rejected with "is not here" —
    // and the item the donor tried to give stays put.
    await assert.rejects(
      handleGiveCommand(db, 'donor', calm.row, calm.col, '/give Worn Cap @faraway'),
      /faraway is not here/,
      'a recipient standing in another room is not a valid give target'
    );
    const still = await db.prepare("SELECT ownerUsername FROM items WHERE name = 'Worn Cap'").first();
    assert.equal(still.ownerUsername, 'donor', 'a give to an out-of-room target leaves ownership unchanged');
  } finally {
    await db.close();
  }
});

test('/give: rejects giving to yourself', async () => {
  const db = await createMigratedDb();
  const { handleGiveCommand, getUserState, updatePresence } = await import('../worker/game.mjs');

  try {
    const calm = findCalmRoom(getWorldDay());
    await seedLiveUser(db, 'solo');
    await updatePresence(db, 'solo', calm.row, calm.col);
    await getUserState(db, 'solo');
    await insertCarriedItem(db, 'solo', { name: 'Old Boot', slotType: 'leg' });

    await assert.rejects(
      handleGiveCommand(db, 'solo', calm.row, calm.col, '/give Old Boot @solo'),
      /cannot give an item to yourself/
    );
    // The item stayed put.
    const still = await db.prepare("SELECT ownerUsername FROM items WHERE name = 'Old Boot'").first();
    assert.equal(still.ownerUsername, 'solo', 'a rejected self-give leaves ownership unchanged');
  } finally {
    await db.close();
  }
});

test('/give: rejects an NPC target (players only)', async () => {
  const db = await createMigratedDb();
  const game = await import('../worker/game.mjs');
  const { handleGiveCommand, getUserState, updatePresence } = game;

  try {
    const calm = findCalmRoom(getWorldDay());
    await seedLiveUser(db, 'patron');
    await updatePresence(db, 'patron', calm.row, calm.col);
    await getUserState(db, 'patron');
    await seedNpc(db, 'soc_bar_1', 'Sil', calm.row, calm.col, game);
    await insertCarriedItem(db, 'patron', { name: 'Old Boot', slotType: 'leg' });

    await assert.rejects(
      handleGiveCommand(db, 'patron', calm.row, calm.col, '/give Old Boot @Sil'),
      /only give items to other players/
    );
    const still = await db.prepare("SELECT ownerUsername FROM items WHERE name = 'Old Boot'").first();
    assert.equal(still.ownerUsername, 'patron', 'a rejected NPC give leaves ownership unchanged');
  } finally {
    await db.close();
  }
});

test('/give: rejects a target who exists but is not in this room', async () => {
  const db = await createMigratedDb();
  const { handleGiveCommand, getUserState, updatePresence } = await import('../worker/game.mjs');

  try {
    const calm = findCalmRoom(getWorldDay());
    await seedLiveUser(db, 'here');
    await seedLiveUser(db, 'elsewhere');
    await updatePresence(db, 'here', calm.row, calm.col);
    // 'elsewhere' exists and is present — but in a DIFFERENT room.
    await updatePresence(db, 'elsewhere', calm.row, (calm.col % 16) + 1);
    await getUserState(db, 'here');
    await insertCarriedItem(db, 'here', { name: 'Old Boot', slotType: 'leg' });

    await assert.rejects(
      handleGiveCommand(db, 'here', calm.row, calm.col, '/give Old Boot @elsewhere'),
      /is not here/
    );
    const still = await db.prepare("SELECT ownerUsername FROM items WHERE name = 'Old Boot'").first();
    assert.equal(still.ownerUsername, 'here', 'a give to an absent target leaves ownership unchanged');
  } finally {
    await db.close();
  }
});

test('/give: rejects an unknown / missing target', async () => {
  const db = await createMigratedDb();
  const { handleGiveCommand, getUserState, updatePresence } = await import('../worker/game.mjs');

  try {
    const calm = findCalmRoom(getWorldDay());
    await seedLiveUser(db, 'lonely');
    await updatePresence(db, 'lonely', calm.row, calm.col);
    await getUserState(db, 'lonely');
    await insertCarriedItem(db, 'lonely', { name: 'Old Boot', slotType: 'leg' });

    // A named target that no user matches.
    await assert.rejects(
      handleGiveCommand(db, 'lonely', calm.row, calm.col, '/give Old Boot @ghost'),
      /No such person here/
    );
    // No @mention at all.
    await assert.rejects(
      handleGiveCommand(db, 'lonely', calm.row, calm.col, '/give Old Boot'),
      /Name who you are giving it to/
    );
  } finally {
    await db.close();
  }
});

test('/give: rejects an item the giver does not own', async () => {
  const db = await createMigratedDb();
  const { handleGiveCommand, getUserState, updatePresence } = await import('../worker/game.mjs');

  try {
    const calm = findCalmRoom(getWorldDay());
    await seedLiveUser(db, 'empty');
    await seedLiveUser(db, 'friend');
    await updatePresence(db, 'empty', calm.row, calm.col);
    await updatePresence(db, 'friend', calm.row, calm.col);
    await getUserState(db, 'empty');
    await getUserState(db, 'friend');

    await assert.rejects(
      handleGiveCommand(db, 'empty', calm.row, calm.col, '/give Phantom Blade @friend'),
      /aren't carrying that/
    );
  } finally {
    await db.close();
  }
});

test('/give: rejects an equipped item, telling the giver to unequip it first', async () => {
  const db = await createMigratedDb();
  const { handleChatAction, handleGiveCommand, getUserState, updatePresence } = await import('../worker/game.mjs');

  try {
    const calm = findCalmRoom(getWorldDay());
    await seedLiveUser(db, 'wielder');
    await seedLiveUser(db, 'comrade');
    await updatePresence(db, 'wielder', calm.row, calm.col);
    await updatePresence(db, 'comrade', calm.row, calm.col);
    await getUserState(db, 'wielder');
    await getUserState(db, 'comrade');

    await insertCarriedItem(db, 'wielder', { templateId: 'rusty_knife', name: 'Rusty Knife', slotType: 'hand', modifiers: { strength: 1 } });
    await handleChatAction(db, 'wielder', calm.row, calm.col, '/equip Rusty Knife'); // now equipped

    await assert.rejects(
      handleGiveCommand(db, 'wielder', calm.row, calm.col, '/give Rusty Knife @comrade'),
      /Unequip the Rusty Knife before giving it/
    );
    // It stayed equipped on the wielder.
    const still = await db.prepare(
      "SELECT ownerUsername, equippedPartId FROM items WHERE name = 'Rusty Knife'"
    ).first();
    assert.equal(still.ownerUsername, 'wielder', 'a rejected equipped-give leaves ownership unchanged');
    assert.notEqual(still.equippedPartId, null, 'the item is still equipped');
  } finally {
    await db.close();
  }
});
