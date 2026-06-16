// Plan 022 (tail): corpse decay. processCorpseDecay ages remains and corpses by their
// decayTick each world pulse. MONSTER remains advance fresh -> rotten -> bones in place
// then are CULLED; a raw /eat of rotten remains poisons. PLAYER corpses are COSMETIC
// ONLY — renamed as they age but NEVER deleted, and corpseOf is ALWAYS kept, so the
// resurrection anchor persists indefinitely (decay must NOT permadeath). CommonJS +
// node:test, mirroring crafting/resurrectionAnchor integration tests.

const assert = require('node:assert/strict');
const test = require('node:test');
const { createSqliteD1, createMigratedDb } = require('./.helpers/d1');
const { getWorldDay, generateRoomFeatures } = require('../utils/roomEcology');

// Stage boundaries (kept in sync with shared.mjs): fresh 0..30, rotten 30..60,
// bones 60..90, cull at >= 90.
const FRESH_TICKS = 30;
const ROTTEN_TICKS = 30;
const CULL_TICKS = FRESH_TICKS + ROTTEN_TICKS + 30; // ~90

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

async function seedUser(db, username) {
  await db.prepare(
    `INSERT INTO users (username, password, job, health, maxHealth, stamina, maxStamina, speed, strength, intelligence, level, gold)
     VALUES (?, 'pw', 'Novice', 30, 30, 100, 100, 1, 1, 1, 2, 9)`
  ).bind(username).run();
}

async function dropRemains(db, row, col, decayTick) {
  await db.prepare(
    `INSERT INTO items (templateId, name, slotType, rarity, modifiers, roomRow, roomCol, decayTick)
     VALUES ('monster_remains', 'Monster Remains', 'part', 'common', '{}', ?, ?, ?)`
  ).bind(row, col, decayTick).run();
}

async function templateAt(db, row, col) {
  const r = await db.prepare('SELECT templateId, name FROM items WHERE roomRow = ? AND roomCol = ?').bind(row, col).first();
  return r;
}

// ---------------------------------------------------------------------------

test('Plan 022 (tail): monster remains decay fresh -> rotten -> bones, then are culled', async () => {
  const db = await createMigratedDb();
  const { processCorpseDecay } = await import('../worker/game.mjs');
  try {
    await dropRemains(db, 8, 8, 0); // decayTick 0

    // Fresh: still Monster Remains just before the rotten boundary.
    await processCorpseDecay(db, FRESH_TICKS - 1);
    assert.equal((await templateAt(db, 8, 8)).templateId, 'monster_remains', 'still fresh');

    // Rotten: at the fresh boundary it becomes rotten remains.
    await processCorpseDecay(db, FRESH_TICKS);
    let item = await templateAt(db, 8, 8);
    assert.equal(item.templateId, 'rotten_remains', 'aged to rotten');
    assert.equal(item.name, 'Rotten Remains', 'renamed to rotten');

    // Bones: past the rotten window it becomes bones.
    await processCorpseDecay(db, FRESH_TICKS + ROTTEN_TICKS);
    item = await templateAt(db, 8, 8);
    assert.equal(item.templateId, 'bones', 'aged to bones');
    assert.equal(item.name, 'Bones', 'renamed to bones');

    // Cull: at the bones-age cap the row is DELETEd.
    await processCorpseDecay(db, CULL_TICKS);
    assert.equal(await templateAt(db, 8, 8), null, 'bones culled at the age cap');
  } finally {
    await db.close();
  }
});

test('Plan 022 (tail): a raw /eat of rotten remains applies poison', async () => {
  const db = await createMigratedDb();
  const { processCorpseDecay, eatItem, getUserState, updatePresence } = await import('../worker/game.mjs');
  try {
    const calm = findCalmRoom(getWorldDay());
    await seedUser(db, 'ghoul');
    await updatePresence(db, 'ghoul', calm.row, calm.col);
    await getUserState(db, 'ghoul'); // instantiate body
    await dropRemains(db, calm.row, calm.col, 0);

    // Age it into the rotten stage.
    await processCorpseDecay(db, FRESH_TICKS);
    assert.equal((await templateAt(db, calm.row, calm.col)).templateId, 'rotten_remains', 'rotten now');

    const before = await db.prepare("SELECT COUNT(*) AS c FROM statusEffects WHERE username = 'ghoul' AND effectType = 'poison'").first();
    assert.equal(before.c, 0, 'not poisoned yet');

    const result = await eatItem(db, 'ghoul', 'Rotten Remains', calm.row, calm.col);
    assert.equal(result.poisoned, true, 'eating rotten remains reports poison');
    const after = await db.prepare("SELECT COUNT(*) AS c FROM statusEffects WHERE username = 'ghoul' AND effectType = 'poison'").first();
    assert.equal(after.c, 1, 'the rotten remains applied poison');
  } finally {
    await db.close();
  }
});

// THE CRITICAL TEST -----------------------------------------------------------
test('Plan 022 (tail): a player corpse decayed past ALL thresholds keeps corpseOf and still sells a resurrection (decay is cosmetic-only, no permadeath)', async () => {
  const db = await createMigratedDb();
  const { moveUserToCemetery, processCorpseDecay, getUserState } = await import('../worker/game.mjs');
  const { createResurrectionCheckout } = await import('../worker/resurrection.mjs');
  const PAY_URL = 'https://buy.example/resurrect';
  try {
    await seedUser(db, 'victim');
    await getUserState(db, 'victim'); // instantiate body
    await moveUserToCemetery(db, 'victim', 'a test', 5, 5);

    // The corpse exists with its anchor.
    const fresh = await db.prepare("SELECT name, templateId, corpseOf, decayTick FROM items WHERE corpseOf = 'victim'").first();
    assert.ok(fresh, 'a corpse dropped');
    assert.equal(fresh.templateId, 'player_corpse');
    assert.equal(fresh.name, "victim's Corpse");
    assert.ok(fresh.decayTick !== null && fresh.decayTick !== undefined, 'the corpse has a decay clock');

    // Decay it WAY past every threshold — far beyond the monster cull age.
    await processCorpseDecay(db, fresh.decayTick + CULL_TICKS * 5);

    // It is STILL present, STILL a player_corpse, STILL tagged corpseOf — only renamed.
    const aged = await db.prepare("SELECT name, templateId, corpseOf FROM items WHERE corpseOf = 'victim'").first();
    assert.ok(aged, 'the player corpse is NEVER culled by decay');
    assert.equal(aged.templateId, 'player_corpse', 'it stays a player_corpse (anchor template unchanged)');
    assert.equal(aged.corpseOf, 'victim', 'corpseOf is ALWAYS kept — the resurrection anchor persists');
    assert.equal(aged.name, "victim's Skeletal Remains", 'only the cosmetic name changed');

    // And a resurrection is STILL sellable — decay did NOT permadeath the player.
    const checkout = await createResurrectionCheckout(db, 'victim', PAY_URL);
    assert.ok(checkout && checkout.token && !checkout.severed, 'a token is still offered after total decay');
  } finally {
    await db.close();
  }
});

test('Plan 022 (tail): ordinary items (decayTick NULL) are untouched by decay', async () => {
  const db = await createMigratedDb();
  const { processCorpseDecay } = await import('../worker/game.mjs');
  try {
    // A plain floor item with no decay clock.
    await db.prepare(
      `INSERT INTO items (templateId, name, slotType, rarity, modifiers, roomRow, roomCol)
       VALUES ('rusty_knife', 'Rusty Knife', 'hand', 'common', '{"strength":1}', 9, 9)`
    ).run();
    await processCorpseDecay(db, 100000);
    const item = await db.prepare("SELECT templateId, name FROM items WHERE roomRow = 9 AND roomCol = 9").first();
    assert.ok(item, 'the ordinary item survives');
    assert.equal(item.templateId, 'rusty_knife', 'and is unchanged (decayTick NULL = never decays)');
  } finally {
    await db.close();
  }
});
