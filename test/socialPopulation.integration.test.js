// Plan 013b: the living social population. A player entering a tavern/guild lazily
// summons its cast (friendly/neutral, real jobs), idempotently, only when observed, and
// the cast is culled on the daily reset. Friendly NPCs must NOT register as hostiles.
// CommonJS + node:test, in-memory sqlite3 D1 shim.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const sqlite3 = require('sqlite3').verbose();
const { getWorldDay } = require('../utils/roomEcology');

function createSqliteD1() {
  const raw = new sqlite3.Database(':memory:');
  return {
    raw,
    exec(sql) { return new Promise((resolve, reject) => raw.exec(sql, err => (err ? reject(err) : resolve()))); },
    close() { return new Promise((resolve, reject) => raw.close(err => (err ? reject(err) : resolve()))); },
    prepare(sql) {
      return {
        params: [],
        bind(...params) { this.params = params; return this; },
        first() { return new Promise((resolve, reject) => raw.get(sql, this.params, (err, row) => (err ? reject(err) : resolve(row || null)))); },
        all() { return new Promise((resolve, reject) => raw.all(sql, this.params, (err, rows) => (err ? reject(err) : resolve({ results: rows })))); },
        run() {
          return new Promise((resolve, reject) => {
            raw.run(sql, this.params, function onRun(err) {
              if (err) { reject(err); return; }
              resolve({ meta: { changes: this.changes, last_row_id: this.lastID } });
            });
          });
        }
      };
    }
  };
}

async function createMigratedDb() {
  const db = createSqliteD1();
  const dir = path.join(__dirname, '../migrations');
  for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) {
    await db.exec(fs.readFileSync(path.join(dir, file), 'utf8'));
  }
  return db;
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
