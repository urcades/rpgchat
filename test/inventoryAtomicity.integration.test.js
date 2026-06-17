// adv-017/018: inventory atomicity under concurrency. Each test drives a racing
// interleaving against the in-memory D1 (two competing operations, or one op
// interleaved with a competing write) and asserts SINGLE-EFFECT — the claim-then-act
// fixes in worker/game/inventory.mjs must arbitrate so exactly one effect lands:
//
//   1. equip: two /equip into the same slot -> one wins, maxHealth folded ONCE
//      (the loser folds NO HP, so a failed equip never corrupts users.maxHealth).
//   2. buy:   two /buy of one stock line -> one purchase, the per-day cap holds.
//   3. craft: two crafts on one input set -> one output, inputs consumed once;
//             a multi-input craft that comes up short consumes nothing.
//   4. socket: two sockets into the last free slot -> over-socket rejected.
//   5. give:  a give whose recipient is deleted mid-flight -> item on the floor,
//             not orphaned onto a non-existent user.
//
// The shim serializes each SQL statement atomically (a single connection), so
// firing the two calls with Promise.all interleaves their awaits: both reads can
// land before either write, reproducing the read-decide-write window the fixes
// close. CommonJS + node:test to match the rest of test/.

const assert = require('node:assert/strict');
const test = require('node:test');
const { createMigratedDb } = require('./.helpers/d1');
const { getWorldDay, generateRoomFeatures, generateShopStock } = require('../utils/roomEcology');

const HAZARDOUS = ['poison_marsh', 'moon_room', 'echo_chamber', 'pub', 'inn', 'sun_room', 'cold_room', 'guild'];

function findCalmRoom(worldDay) {
  for (let row = 1; row <= 16; row += 1) {
    for (let col = 1; col <= 16; col += 1) {
      const types = generateRoomFeatures(row, col, worldDay).map(f => f.effect?.type);
      if (!types.some(t => HAZARDOUS.includes(t))) {
        return { row, col };
      }
    }
  }
  throw new Error('No calm room for ' + worldDay);
}

function findCalmShopRoom(worldDay) {
  for (let row = 1; row <= 16; row += 1) {
    for (let col = 1; col <= 16; col += 1) {
      const types = generateRoomFeatures(row, col, worldDay).map(f => f.effect?.type);
      if (types.includes('shop') && !types.some(t => HAZARDOUS.includes(t))) {
        return { row, col };
      }
    }
  }
  throw new Error('No calm shop room for ' + worldDay);
}

async function seedUser(db, username, overrides = {}) {
  const s = {
    job: 'Novice', health: 30, maxHealth: 30, stamina: 100, maxStamina: 100,
    speed: 1, strength: 1, intelligence: 1, level: 0, gold: 0, ...overrides
  };
  await db.prepare(
    `INSERT INTO users (username, password, job, health, maxHealth, stamina, maxStamina, speed, strength, intelligence, level, gold)
     VALUES (?, 'pw', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(username, s.job, s.health, s.maxHealth, s.stamina, s.maxStamina, s.speed, s.strength, s.intelligence, s.level, s.gold).run();
}

async function insertCarried(db, owner, templateId, name, slotType, modifiers = {}) {
  const r = await db.prepare(
    `INSERT INTO items (templateId, name, slotType, rarity, modifiers, ownerUsername)
     VALUES (?, ?, ?, 'common', ?, ?)`
  ).bind(templateId, name, slotType, JSON.stringify(modifiers), owner).run();
  return r.meta.last_row_id;
}

// Run a promise expected to reject, swallowing the rejection; returns 'ok' if it
// resolved, or the rejection. Lets us settle two racers and inspect both.
async function settle(p) {
  try { return { ok: true, value: await p }; }
  catch (err) { return { ok: false, err }; }
}

// ---------------------------------------------------------------------------
// Fix 1 (HIGH) — attachItemToBody: claim the slot, fold HP only on a won claim.

test('adv-018 equip race: two /equip into the same single slot — one wins, maxHealth folded exactly once', async () => {
  const db = await createMigratedDb();
  const { getUserState, equipItem, getUser, updatePresence } = await import('../worker/game.mjs');
  try {
    const calm = findCalmRoom(getWorldDay());
    await seedUser(db, 'h', { health: 30, maxHealth: 30 });
    await updatePresence(db, 'h', calm.row, calm.col);
    await getUserState(db, 'h'); // instantiate body parts

    // Two DISTINCT torso items, each +3 maxHealth. A humanoid has ONE torso part,
    // so only one can be worn — the other must lose the slot claim.
    await insertCarried(db, 'h', 'padded_vest', 'Padded Vest', 'torso', { maxHealth: 3 });
    await insertCarried(db, 'h', 'padded_vest', 'Quilted Vest', 'torso', { maxHealth: 3 });

    const user = await getUser(db, 'h');
    // Fire both concurrently: both read the empty torso, both try to claim it.
    const [a, b] = await Promise.all([
      settle(equipItem(db, user, 'Padded Vest', calm.row, calm.col)),
      settle(equipItem(db, user, 'Quilted Vest', calm.row, calm.col))
    ]);

    // Exactly one equip succeeded.
    const wins = [a, b].filter(r => r.ok).length;
    assert.equal(wins, 1, 'exactly one of the two racing equips wins the slot');

    // The torso holds exactly one item.
    const wornCount = await db.prepare(
      `SELECT COUNT(*) AS c FROM items i JOIN bodyParts bp ON bp.id = i.equippedPartId
       WHERE i.ownerUsername = 'h' AND bp.slotType = 'torso'`
    ).first();
    assert.equal(wornCount.c, 1, 'the torso part holds exactly one item, not two');

    // maxHealth folded ONCE (+3 over the base 30), never twice and never corrupted
    // by the loser folding HP for an equip that failed.
    const u = await db.prepare("SELECT maxHealth FROM users WHERE username = 'h'").first();
    assert.equal(u.maxHealth, 33, 'maxHealth reflects exactly one +3 fold (the lost claim folded no HP)');

    // The structural fold is consistent end-to-end: effective maxHealth == 33.
    const state = await getUserState(db, 'h');
    assert.equal(state.effectiveStats.maxHealth, 33, 'effective maxHealth folds the winning vest once');
  } finally {
    await db.close();
  }
});

test('adv-018 equip race: a lost claim leaves maxHealth untouched even when the loser would have folded HP', async () => {
  const db = await createMigratedDb();
  const { getUserState, equipItem, getUser, updatePresence } = await import('../worker/game.mjs');
  try {
    const calm = findCalmRoom(getWorldDay());
    await seedUser(db, 'g', { health: 30, maxHealth: 30 });
    await updatePresence(db, 'g', calm.row, calm.col);
    await getUserState(db, 'g');

    // Two distinct torso vests, +4 and +6 HP. Whichever wins the single torso
    // slot, maxHealth must fold ONLY that winner (34 or 36) — never base + BOTH
    // (= 40), which is what the old "fold-before-claim" path produced when the
    // loser folded HP for an equip that then failed on the unique index. The
    // distinct bonuses make "stacked" (40) unambiguous vs either single fold.
    await insertCarried(db, 'g', 'padded_vest', 'Plain Vest', 'torso', { maxHealth: 4 }); // +4 HP
    await insertCarried(db, 'g', 'padded_vest', 'Iron Vest', 'torso', { maxHealth: 6 }); // +6 HP

    const user = await getUser(db, 'g');
    const [a, b] = await Promise.all([
      settle(equipItem(db, user, 'Plain Vest', calm.row, calm.col)),
      settle(equipItem(db, user, 'Iron Vest', calm.row, calm.col))
    ]);
    assert.equal([a, b].filter(r => r.ok).length, 1, 'exactly one equip wins');

    const u = await db.prepare("SELECT maxHealth FROM users WHERE username = 'g'").first();
    // maxHealth is base 30 + the WINNER's bonus only (34 or 36) — never 30 + 4 + 6.
    const wornBonus = await db.prepare(
      `SELECT i.modifiers FROM items i JOIN bodyParts bp ON bp.id = i.equippedPartId
       WHERE i.ownerUsername = 'g' AND bp.slotType = 'torso'`
    ).first();
    const winnerBonus = JSON.parse(wornBonus.modifiers).maxHealth || 0;
    assert.equal(u.maxHealth, 30 + winnerBonus, 'maxHealth folds ONLY the winner — the lost claim folded no HP');
    assert.notEqual(u.maxHealth, 40, 'both bonuses never stack from a failed equip');
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// Fix 2 (MED) — buyShopItem: claim the per-day slot first, then spend.

test('adv-018 buy race: two concurrent /buy of one stock line — one purchase, the per-day cap holds', async () => {
  const db = await createMigratedDb();
  const { buyShopItem, updatePresence } = await import('../worker/game.mjs');
  try {
    const worldDay = getWorldDay();
    const shop = findCalmShopRoom(worldDay);
    const item = generateShopStock(shop.row, shop.col, worldDay)[0];

    // Fund BOTH buys (2x the price). The per-day cap, not the wallet, must stop
    // the second — proving the cooldown claim (not just the gold spend) gates it.
    await seedUser(db, 'rich', { gold: item.price * 2 });
    await updatePresence(db, 'rich', shop.row, shop.col);

    const [a, b] = await Promise.all([
      settle(buyShopItem(db, 'rich', shop.row, shop.col, item.name)),
      settle(buyShopItem(db, 'rich', shop.row, shop.col, item.name))
    ]);
    assert.equal([a, b].filter(r => r.ok).length, 1, 'exactly one /buy succeeds');
    const loser = [a, b].find(r => !r.ok);
    assert.match(loser.err.message, /Sold out for you today/, 'the loser hits the per-day cap');

    // Exactly one item minted; gold spent exactly once.
    const owned = await db.prepare("SELECT COUNT(*) AS c FROM items WHERE ownerUsername = 'rich'").first();
    assert.equal(owned.c, 1, 'exactly one item minted, not two');
    const u = await db.prepare("SELECT gold FROM users WHERE username = 'rich'").first();
    assert.equal(u.gold, item.price, 'gold debited exactly once (started at 2x price)');
    const cd = await db.prepare("SELECT COUNT(*) AS c FROM roomEffectCooldowns WHERE username = 'rich'").first();
    assert.equal(cd.c, 1, 'a single per-day slot consumed');
  } finally {
    await db.close();
  }
});

test('adv-018 buy: a failed payment releases the claimed slot — the player can buy later when richer', async () => {
  const db = await createMigratedDb();
  const { buyShopItem, updatePresence } = await import('../worker/game.mjs');
  try {
    const worldDay = getWorldDay();
    const shop = findCalmShopRoom(worldDay);
    const item = generateShopStock(shop.row, shop.col, worldDay)[0];

    await seedUser(db, 'poor', { gold: item.price - 1 });
    await updatePresence(db, 'poor', shop.row, shop.col);

    await assert.rejects(() => buyShopItem(db, 'poor', shop.row, shop.col, item.name), /Not enough gold/);
    // The claim-first design must NOT burn the daily slot on a failed payment.
    const cd = await db.prepare("SELECT COUNT(*) AS c FROM roomEffectCooldowns WHERE username = 'poor'").first();
    assert.equal(cd.c, 0, 'no daily slot consumed when payment fails');

    // Top them up; the same line is still buyable (slot was released).
    await db.prepare("UPDATE users SET gold = ? WHERE username = 'poor'").bind(item.price).run();
    const r = await buyShopItem(db, 'poor', shop.row, shop.col, item.name);
    assert.equal(r.bought, item.name, 'the released slot lets the now-richer player buy');
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// Fix 3 (MED) — craftRecipe: atomic claimed consume; no partial consume.

test('adv-018 craft race: two crafts on ONE input set — one output, inputs consumed once', async () => {
  const db = await createMigratedDb();
  const { craftRecipe } = await import('../worker/game.mjs');
  try {
    await seedUser(db, 'c');
    // Crimson Tonic needs 2x monster_remains; give exactly 2 — enough for ONE craft.
    await insertCarried(db, 'c', 'monster_remains', 'Monster Remains', 'part');
    await insertCarried(db, 'c', 'monster_remains', 'Monster Remains', 'part');

    const [a, b] = await Promise.all([
      settle(craftRecipe(db, 'c', 'brew', 'Crimson Tonic')),
      settle(craftRecipe(db, 'c', 'brew', 'Crimson Tonic'))
    ]);
    assert.equal([a, b].filter(r => r.ok).length, 1, 'exactly one craft succeeds on a single input set');

    const remains = await db.prepare("SELECT COUNT(*) AS c FROM items WHERE ownerUsername = 'c' AND templateId = 'monster_remains'").first();
    assert.equal(remains.c, 0, 'the two remains were consumed exactly once');
    const tonics = await db.prepare("SELECT COUNT(*) AS c FROM items WHERE ownerUsername = 'c' AND templateId = 'crimson_tonic'").first();
    assert.equal(tonics.c, 1, 'exactly one output minted, not two from shared materials');
  } finally {
    await db.close();
  }
});

test('adv-018 craft: a multi-input craft short on its SECOND input consumes nothing (no partial consume)', async () => {
  const db = await createMigratedDb();
  const { craftRecipe } = await import('../worker/game.mjs');
  try {
    await seedUser(db, 'd');
    // Bone Blade (forge) needs goblin_skull x1 + scrap_metal x1. Give the skull but
    // NO scrap: the first input claim deletes the skull, the second comes up short.
    // The fix must re-mint the skull (no partial consume) and produce no output.
    await insertCarried(db, 'd', 'goblin_skull', 'Goblin Skull', 'gear');

    await assert.rejects(() => craftRecipe(db, 'd', 'forge', 'Bone Blade'), /need/i);

    const skull = await db.prepare("SELECT COUNT(*) AS c FROM items WHERE ownerUsername = 'd' AND templateId = 'goblin_skull'").first();
    assert.equal(skull.c, 1, 'the first input is restored — nothing partially consumed');
    const blade = await db.prepare("SELECT COUNT(*) AS c FROM items WHERE ownerUsername = 'd' AND templateId = 'rusty_knife'").first();
    assert.equal(blade.c, 0, 'no output produced on a short craft');
  } finally {
    await db.close();
  }
});

test('adv-018 craft race: a craft racing a /drop of its only input — single-effect (one craft OR the input drops, never double-spent)', async () => {
  const db = await createMigratedDb();
  const { craftRecipe, dropOwnedItem } = await import('../worker/game.mjs');
  try {
    const calm = findCalmRoom(getWorldDay());
    await seedUser(db, 'e');
    // Cooked Remains needs 1x monster_remains; give exactly one and race a /drop.
    await insertCarried(db, 'e', 'monster_remains', 'Monster Remains', 'part');

    const [craft, drop] = await Promise.all([
      settle(craftRecipe(db, 'e', 'cook', 'Cooked Remains')),
      settle(dropOwnedItem(db, 'e', 'Monster Remains', calm.row, calm.col))
    ]);

    // Exactly one of the two operations claims the single remains.
    const both = (craft.ok ? 1 : 0) + (drop.ok ? 1 : 0);
    assert.equal(both, 1, 'the lone input is claimed by exactly one of craft / drop');

    if (craft.ok) {
      // Crafted: input consumed, output minted, nothing on the floor.
      const food = await db.prepare("SELECT COUNT(*) AS c FROM items WHERE ownerUsername = 'e' AND templateId = 'cooked_remains'").first();
      assert.equal(food.c, 1, 'craft won: one output');
      const floor = await db.prepare("SELECT COUNT(*) AS c FROM items WHERE templateId = 'monster_remains' AND ownerUsername IS NULL").first();
      assert.equal(floor.c, 0, 'craft won: the input did not also drop to the floor');
    } else {
      // Dropped: the remains are on the floor, no food was crafted from it.
      const floor = await db.prepare("SELECT COUNT(*) AS c FROM items WHERE templateId = 'monster_remains' AND ownerUsername IS NULL").first();
      assert.equal(floor.c, 1, 'drop won: the input is on the floor');
      const food = await db.prepare("SELECT COUNT(*) AS c FROM items WHERE templateId = 'cooked_remains'").first();
      assert.equal(food.c, 0, 'drop won: no output crafted from a dropped input');
    }
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// Fix 4 (MED) — socketMateria: claim-then-recheck capacity.

test('adv-018 socket race: two materia into the host\'s last free slot — exactly one socketed, over-capacity rejected', async () => {
  const db = await createMigratedDb();
  const { socketMateria, getUserState, updatePresence } = await import('../worker/game.mjs');
  try {
    const calm = findCalmRoom(getWorldDay());
    await seedUser(db, 's');
    await updatePresence(db, 's', calm.row, calm.col);
    await getUserState(db, 's');

    // Rusty Knife (common gear) has exactly ONE socket; two materia race for it.
    await insertCarried(db, 's', 'rusty_knife', 'Rusty Knife', 'hand');
    await insertCarried(db, 's', 'power_materia', 'Power Materia', 'materia');
    await insertCarried(db, 's', 'swift_materia', 'Swift Materia', 'materia');

    const [a, b] = await Promise.all([
      settle(socketMateria(db, 's', 'Power Materia', 'Rusty Knife')),
      settle(socketMateria(db, 's', 'Swift Materia', 'Rusty Knife'))
    ]);
    assert.equal([a, b].filter(r => r.ok).length, 1, 'exactly one socket succeeds into a single-socket host');
    const loser = [a, b].find(r => !r.ok);
    assert.match(loser.err.message, /sockets are full/, 'the loser is told the sockets are full');

    // The host holds exactly ONE socketed materia (capacity respected).
    const knife = await db.prepare("SELECT id FROM items WHERE ownerUsername = 's' AND templateId = 'rusty_knife'").first();
    const used = await db.prepare('SELECT COUNT(*) AS c FROM items WHERE socketedInId = ?').bind(knife.id).first();
    assert.equal(used.c, 1, 'capacity of 1 is not exceeded under the race');

    // The loser's materia is fully rolled back — loose, not socketed.
    const loose = await db.prepare(
      "SELECT COUNT(*) AS c FROM items WHERE ownerUsername = 's' AND socketedInId IS NULL AND templateId IN ('power_materia','swift_materia')"
    ).first();
    assert.equal(loose.c, 1, 'the losing materia is left loose (rolled back), not stuck socketed');
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// Fix 5 (HIGH) — giveItem: orphan guard drops to the floor if the recipient
// is deleted between resolve and the ownership flip.

test('adv-018 give orphan: a recipient deleted mid-give leaves the item on the floor, not orphaned', async () => {
  const db = await createMigratedDb();
  const { giveItem, updatePresence } = await import('../worker/game.mjs');
  try {
    const calm = findCalmRoom(getWorldDay());
    await seedUser(db, 'giver');
    await seedUser(db, 'doomed');
    await updatePresence(db, 'giver', calm.row, calm.col);
    const itemId = await insertCarried(db, 'giver', 'rusty_knife', 'Rusty Knife', 'hand');

    // Simulate the recipient dying AFTER resolution but the death's DELETE landing
    // before our give would have settled: delete the recipient's user row, then
    // call giveItem. The orphan guard must re-check existence and floor the item.
    await db.prepare("DELETE FROM users WHERE username = 'doomed'").bind().run();

    const result = await giveItem(db, 'giver', 'Rusty Knife', 'doomed', calm.row, calm.col);
    assert.equal(result.name, 'Rusty Knife', 'the call still resolves the item name');

    const row = await db.prepare("SELECT ownerUsername, roomRow, roomCol, equippedPartId FROM items WHERE id = ?").bind(itemId).first();
    assert.equal(row.ownerUsername, null, 'item is NOT owned by the deleted recipient (no orphan)');
    assert.equal(row.roomRow, calm.row, 'item dropped to the giver-room floor');
    assert.equal(row.roomCol, calm.col, 'item dropped to the giver-room floor');
    assert.equal(row.equippedPartId, null, 'floored item is not equipped');

    // The orphan row would be invisible; the floored item is takeable again.
    const { getFloorItems } = await import('../worker/game.mjs');
    const floor = await getFloorItems(db, calm.row, calm.col);
    assert.deepEqual(floor.map(i => i.name), ['Rusty Knife'], 'the item is back in play on the floor');
  } finally {
    await db.close();
  }
});

test('adv-018 give: a live recipient still receives the item normally (orphan guard is a no-op on the happy path)', async () => {
  const db = await createMigratedDb();
  const { giveItem, updatePresence } = await import('../worker/game.mjs');
  try {
    const calm = findCalmRoom(getWorldDay());
    await seedUser(db, 'from');
    await seedUser(db, 'to');
    await updatePresence(db, 'from', calm.row, calm.col);
    const itemId = await insertCarried(db, 'from', 'rusty_knife', 'Rusty Knife', 'hand');

    await giveItem(db, 'from', 'Rusty Knife', 'to', calm.row, calm.col);

    const row = await db.prepare("SELECT ownerUsername, roomRow, roomCol FROM items WHERE id = ?").bind(itemId).first();
    assert.equal(row.ownerUsername, 'to', 'a present recipient receives the item');
    assert.equal(row.roomRow, null, 'the received item is carried, never touched a floor');
    assert.equal(row.roomCol, null, 'the received item is carried, never touched a floor');
  } finally {
    await db.close();
  }
});
