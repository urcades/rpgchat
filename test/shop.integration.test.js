// Plan 007 integration coverage — /buy turns shop stock into owned items.
// Drives the real handleChatAction('/buy …') path against an in-memory D1.
// CommonJS + node:test to match the rest of test/.

const assert = require('node:assert/strict');
const test = require('node:test');
const { createSqliteD1, createMigratedDb } = require('./.helpers/d1');
const { getWorldDay, generateRoomFeatures, generateShopStock } = require('../utils/roomEcology');

const HAZARDOUS = ['poison_marsh', 'moon_room', 'echo_chamber', 'pub', 'inn', 'sun_room', 'cold_room', 'guild'];

// A shop room with no hazardous passive, so the post-buy tick can't perturb the
// stamina/tick assertions.
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

function findNonShopRoom(worldDay) {
  for (let row = 1; row <= 16; row += 1) {
    for (let col = 1; col <= 16; col += 1) {
      const types = generateRoomFeatures(row, col, worldDay).map(f => f.effect?.type);
      if (!types.includes('shop')) {
        return { row, col };
      }
    }
  }
  throw new Error('No non-shop room for ' + worldDay);
}

async function seedLiveUser(db, username, gold) {
  await db.prepare(
    `INSERT INTO users
      (username, password, job, health, maxHealth, stamina, maxStamina, speed, strength, intelligence, level, gold)
     VALUES (?, 'pw', 'Novice', 30, 30, 100, 100, 1, 1, 1, 0, ?)`
  ).bind(username, gold).run();
}

// ---------------------------------------------------------------------------

test('Plan 007: /buy spends gold, grants the item, spends stamina and advances a tick', async () => {
  const db = await createMigratedDb();
  const { handleChatAction, updatePresence } = await import('../worker/game.mjs');

  try {
    const worldDay = getWorldDay();
    const shop = findCalmShopRoom(worldDay);
    const stock = generateShopStock(shop.row, shop.col, worldDay);
    const item = stock[0];

    await seedLiveUser(db, 'buyer', 100);
    await updatePresence(db, 'buyer', shop.row, shop.col);
    const tickBefore = (await db.prepare('SELECT value FROM tick WHERE id = 1').first()).value;

    await handleChatAction(db, 'buyer', shop.row, shop.col, `/buy ${item.name}`);

    const user = await db.prepare("SELECT gold, stamina FROM users WHERE username = 'buyer'").first();
    assert.equal(user.gold, 100 - item.price, 'gold reduced by the stock price');
    assert.equal(user.stamina, 99, 'one stamina spent on the command');

    const owned = await db.prepare(
      "SELECT templateId, equippedPartId, roomRow FROM items WHERE ownerUsername = 'buyer'"
    ).first();
    assert.equal(owned.templateId, item.templateId, 'the bought template is now owned');
    assert.equal(owned.equippedPartId, null, 'bought item is carried, not equipped');
    assert.equal(owned.roomRow, null, 'bought item is not on a floor');

    const message = await db.prepare(
      "SELECT message FROM messages WHERE username = 'System' AND message LIKE 'buyer buys%' LIMIT 1"
    ).first();
    assert.equal(message.message, `buyer buys ${item.name} for ${item.price} gold.`);

    const tickAfter = (await db.prepare('SELECT value FROM tick WHERE id = 1').first()).value;
    assert.equal(tickAfter, tickBefore + 1, 'the world tick advanced once');
  } finally {
    await db.close();
  }
});

test('Plan 007: /buy with insufficient gold is rejected and consumes nothing', async () => {
  const db = await createMigratedDb();
  const { handleChatAction, updatePresence } = await import('../worker/game.mjs');

  try {
    const worldDay = getWorldDay();
    const shop = findCalmShopRoom(worldDay);
    const item = generateShopStock(shop.row, shop.col, worldDay)[0];

    await seedLiveUser(db, 'broke', item.price - 1);
    await updatePresence(db, 'broke', shop.row, shop.col);

    await assert.rejects(
      handleChatAction(db, 'broke', shop.row, shop.col, `/buy ${item.name}`),
      /Not enough gold/
    );

    const itemRow = await db.prepare("SELECT id FROM items WHERE ownerUsername = 'broke'").first();
    assert.equal(itemRow, null, 'no item granted');
    const cooldown = await db.prepare("SELECT effectType FROM roomEffectCooldowns WHERE username = 'broke'").first();
    assert.equal(cooldown, null, 'no daily slot consumed — the player can buy later when richer');
  } finally {
    await db.close();
  }
});

test('Plan 007: each stock line buys once per day; a different line still buys', async () => {
  const db = await createMigratedDb();
  const { handleChatAction, updatePresence } = await import('../worker/game.mjs');

  try {
    const worldDay = getWorldDay();
    const shop = findCalmShopRoom(worldDay);
    const stock = generateShopStock(shop.row, shop.col, worldDay);
    const [first, second] = stock;
    assert.ok(second, 'this shop stocks at least two lines');

    await seedLiveUser(db, 'regular', 1000);
    await updatePresence(db, 'regular', shop.row, shop.col);

    await handleChatAction(db, 'regular', shop.row, shop.col, `/buy ${first.name}`);
    await assert.rejects(
      handleChatAction(db, 'regular', shop.row, shop.col, `/buy ${first.name}`),
      /Sold out for you today/
    );
    // A different stock line is still available.
    await handleChatAction(db, 'regular', shop.row, shop.col, `/buy ${second.name}`);

    const owned = await db.prepare(
      "SELECT templateId FROM items WHERE ownerUsername = 'regular' ORDER BY id"
    ).all();
    assert.deepEqual(
      owned.results.map(r => r.templateId).sort(),
      [first.templateId, second.templateId].sort(),
      'exactly the two distinct lines were bought'
    );
  } finally {
    await db.close();
  }
});

test('Plan 007: /buy outside a shop, an unstocked name, and bare /buy are rejected', async () => {
  const db = await createMigratedDb();
  const { handleChatAction, updatePresence } = await import('../worker/game.mjs');

  try {
    const worldDay = getWorldDay();
    const shop = findCalmShopRoom(worldDay);
    const notShop = findNonShopRoom(worldDay);

    await seedLiveUser(db, 'shopper', 1000);
    await updatePresence(db, 'shopper', shop.row, shop.col);
    await updatePresence(db, 'shopper', notShop.row, notShop.col);

    await assert.rejects(
      handleChatAction(db, 'shopper', notShop.row, notShop.col, '/buy Dented Helm'),
      /only works in a shop/
    );
    await assert.rejects(
      handleChatAction(db, 'shopper', shop.row, shop.col, '/buy Excalibur'),
      /Not stocked here today/
    );
    await assert.rejects(
      handleChatAction(db, 'shopper', shop.row, shop.col, '/buy'),
      /Usage: \/buy/
    );
  } finally {
    await db.close();
  }
});
