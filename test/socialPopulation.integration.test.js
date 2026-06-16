// Plan 013b: the living social population. A player entering a tavern/guild lazily
// summons its cast (friendly/neutral, real jobs), idempotently, only when observed, and
// the cast is culled on the daily reset. Friendly NPCs must NOT register as hostiles.
// CommonJS + node:test, in-memory sqlite3 D1 shim.

const assert = require('node:assert/strict');
const test = require('node:test');
const { createSqliteD1, createMigratedDb } = require('./.helpers/d1');
const { getWorldDay } = require('../utils/roomEcology');

// getRoomPresence lives on the world seam and is not re-exported through the game.mjs
// facade; import it directly (world.mjs has no cloudflare:workers dependency, so it
// loads cleanly under node:test + the sqlite3 D1 shim).
async function importGetRoomPresence() {
  const world = await import('../worker/game/world.mjs');
  return world.getRoomPresence;
}

async function findTavernAndCalmRooms(game) {
  const worldDay = getWorldDay();
  let tavern = null;
  let calm = null;
  for (let row = 1; row <= 16 && (!tavern || !calm); row += 1) {
    for (let col = 1; col <= 16 && (!tavern || !calm); col += 1) {
      const isTavern = game.roomHasEffect(row, col, 0, 'pub', worldDay) || game.roomHasEffect(row, col, 0, 'inn', worldDay);
      const isSocial = isTavern || game.roomHasEffect(row, col, 0, 'guild', worldDay);
      if (isTavern && !tavern) tavern = { row, col };
      if (!isSocial && !calm) calm = { row, col };
    }
  }
  return { tavern, calm };
}

async function addHuman(db, game, username, row, col) {
  await db.prepare(
    `INSERT INTO users (username, password, job, health, maxHealth, stamina, maxStamina, speed, strength, intelligence, level)
     VALUES (?, 'pw', 'Fighter', 30, 30, 100, 100, 5, 5, 5, 1)`
  ).bind(username).run();
  await game.updatePresence(db, username, row, col);
}

test('Plan 013b: a player entering a tavern summons its cast — friendly, jobbed, idempotent', async () => {
  const db = await createMigratedDb();
  const game = await import('../worker/game.mjs');
  try {
    const { tavern } = await findTavernAndCalmRooms(game);
    assert.ok(tavern, 'expected at least one pub/inn room today');

    await addHuman(db, game, 'patronzero', tavern.row, tavern.col);
    const first = await game.ensureSocialPopulation(db, tavern.row, tavern.col);
    assert.equal(first.archetype, 'tavern');
    assert.ok(first.spawned >= 3, `spawned the roster (${first.spawned})`);

    const cast = await db.prepare(
      "SELECT username, job, disposition, role, npcKind, npcWorldDay FROM users WHERE isNpc = 1 AND npcKind = 'social'"
    ).all();
    assert.ok(cast.results.length >= 3);
    for (const npc of cast.results) {
      assert.ok(npc.job, 'social NPCs carry a real job');
      assert.ok(['friendly', 'neutral'].includes(npc.disposition), 'non-hostile disposition');
      assert.ok(npc.role, 'has a dialogue role');
      assert.equal(npc.npcWorldDay, getWorldDay(), 'anchored to today');
    }
    assert.ok(cast.results.some(n => n.role === 'bartender'), 'a bartender is present');

    // Idempotent: re-entering does not duplicate the cast.
    const second = await game.ensureSocialPopulation(db, tavern.row, tavern.col);
    assert.equal(second.spawned, 0, 're-entry spawns nobody new');
  } finally {
    await db.close();
  }
});

test('Plan 013b: no spawn without a human present, and none in non-social rooms', async () => {
  const db = await createMigratedDb();
  const game = await import('../worker/game.mjs');
  try {
    const { tavern, calm } = await findTavernAndCalmRooms(game);
    assert.ok(tavern && calm, 'need a tavern and a calm room');

    // Tavern, but empty of humans -> nobody spawns.
    const empty = await game.ensureSocialPopulation(db, tavern.row, tavern.col);
    assert.equal(empty.spawned, 0, 'alive only when observed');

    // Human present, but a non-social room -> no archetype, no spawn.
    await addHuman(db, game, 'lonewalker', calm.row, calm.col);
    const wild = await game.ensureSocialPopulation(db, calm.row, calm.col);
    assert.equal(wild.archetype, null);
    assert.equal(wild.spawned, 0);
  } finally {
    await db.close();
  }
});

test('Plan 013b: friendly social NPCs do NOT register as hostiles (the barmaid won\'t attack)', async () => {
  const db = await createMigratedDb();
  const game = await import('../worker/game.mjs');
  try {
    const { tavern } = await findTavernAndCalmRooms(game);
    await addHuman(db, game, 'drinker', tavern.row, tavern.col);
    await game.ensureSocialPopulation(db, tavern.row, tavern.col);

    const hostilesActive = await game.roomHasActiveHostiles(db, tavern.row, tavern.col);
    assert.equal(hostilesActive, false, 'a room of friendly NPCs is not a combat room');
  } finally {
    await db.close();
  }
});

test('Plan 013b: the daily reset culls yesterday\'s social cast', async () => {
  const db = await createMigratedDb();
  const game = await import('../worker/game.mjs');
  try {
    const { tavern } = await findTavernAndCalmRooms(game);
    await addHuman(db, game, 'drinker', tavern.row, tavern.col);
    await game.ensureSocialPopulation(db, tavern.row, tavern.col);

    // Backdate the cast to a prior day, then run cleanup for today.
    await db.prepare("UPDATE users SET npcWorldDay = '1999-01-01' WHERE npcKind = 'social'").run();
    await game.cleanupOldWorldDayData(db, getWorldDay());

    const left = await db.prepare("SELECT COUNT(*) AS n FROM users WHERE npcKind = 'social'").first();
    assert.equal(left.n, 0, 'yesterday\'s cast is gone');
  } finally {
    await db.close();
  }
});

test('social-bodies: every spawned social NPC is bodied (brute) and aimable for called shots', async () => {
  const db = await createMigratedDb();
  const game = await import('../worker/game.mjs');
  const getRoomPresence = await importGetRoomPresence();
  try {
    const { tavern } = await findTavernAndCalmRooms(game);
    assert.ok(tavern, 'expected at least one pub/inn room today');

    await addHuman(db, game, 'aimer', tavern.row, tavern.col);
    const spawn = await game.ensureSocialPopulation(db, tavern.row, tavern.col);
    assert.ok(spawn.spawned >= 3, `spawned the roster (${spawn.spawned})`);

    // Every spawned social NPC row carries a body plan (the humanoid 'brute'), never NULL —
    // so a social NPC provoked into hostility can be targeted with a called shot.
    const cast = await db.prepare(
      "SELECT username, creatureBodyPlan FROM users WHERE isNpc = 1 AND npcKind = 'social'"
    ).all();
    assert.ok(cast.results.length >= 3);
    for (const npc of cast.results) {
      assert.equal(npc.creatureBodyPlan, 'brute', `${npc.username} is bodied (brute), not NULL`);
    }

    // getRoomPresence exposes the aimable humanoid part labels for a social NPC.
    const presence = await getRoomPresence(db, tavern.row, tavern.col, getWorldDay());
    const socialOccupant = presence.find(p => p.isNpc && p.npcKind === 'social');
    assert.ok(socialOccupant, 'a social NPC is present in the room');
    assert.ok(Array.isArray(socialOccupant.aimParts) && socialOccupant.aimParts.length > 0,
      'a bodied social NPC has aimable parts');
    assert.ok(socialOccupant.aimParts.includes('head') && socialOccupant.aimParts.includes('torso'),
      'humanoid labels (head/torso) are present');
  } finally {
    await db.close();
  }
});
