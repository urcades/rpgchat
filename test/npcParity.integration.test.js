// Plan 021a: NPC parity — monsters carry a level and an intrinsic creature affinity,
// so the elements from 020c matter in PvE (a fire-weak Frost Wyrm burns harder; cold
// fizzles), and elemental DoTs can wear a monster down. CommonJS + node:test.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const sqlite3 = require('sqlite3').verbose();
const { getWorldDay, generateRoomFeatures } = require('../utils/roomEcology');

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

function findCalmRoom(worldDay) {
  const hazardous = ['poison_marsh', 'moon_room', 'echo_chamber', 'pub', 'inn', 'sun_room', 'cold_room', 'guild'];
  for (let row = 1; row <= 16; row += 1) {
    for (let col = 1; col <= 16; col += 1) {
      if (!generateRoomFeatures(row, col, worldDay).map(f => f.effect?.type).some(t => hazardous.includes(t))) return { row, col };
    }
  }
  throw new Error('No calm room');
}

// ---------------------------------------------------------------------------

test('Plan 021a: NPCs are created with a level, and elemental hits scale by creature affinity', async () => {
  const db = await createMigratedDb();
  const { createNpcForEvent, applyElementOnHit, getCurrentTickValue } = await import('../worker/game.mjs');
  try {
    const calm = findCalmRoom(getWorldDay());
    await createNpcForEvent(db, {
      username: 'wyrm', displayName: 'Frost Wyrm', npcKind: 'raid_boss', level: 6,
      health: 20, stamina: 100, speed: 7, strength: 12, intelligence: 3,
      worldEventId: 'evt1', row: calm.row, col: calm.col, worldDay: getWorldDay()
    });
    const created = await db.prepare("SELECT level, health, isNpc FROM users WHERE username = 'wyrm'").bind().first();
    assert.equal(created.level, 6, 'the NPC stores its level');
    assert.equal(created.isNpc, 1);

    const tick = await getCurrentTickValue(db);
    // Fire vs a fire-WEAK wyrm (+0.5) → magnitude 2 × 1.5 = 3.
    const fire = await applyElementOnHit(db, { attacker: 'p', target: 'wyrm', element: 'fire', row: calm.row, col: calm.col, currentTick: tick, targetIsNpc: true, targetDisplayName: 'Frost Wyrm' });
    assert.equal(fire.magnitude, 3, 'fire burns the fire-weak wyrm harder');
    // Cold vs a cold-RESIST wyrm (−0.5) → magnitude 2 × 0.5 = 1.
    const cold = await applyElementOnHit(db, { attacker: 'p', target: 'wyrm', element: 'cold', row: calm.row, col: calm.col, currentTick: tick, targetIsNpc: true, targetDisplayName: 'Frost Wyrm' });
    assert.equal(cold.magnitude, 1, 'cold barely chills the cold-resistant wyrm');
    // A neutral beast → base magnitude.
    const neutral = await applyElementOnHit(db, { attacker: 'p', target: 'wyrm', element: 'fire', row: calm.row, col: calm.col, currentTick: tick, targetIsNpc: true, targetDisplayName: 'Restless Brute' });
    assert.equal(neutral.magnitude, 2, 'a neutral creature takes base magnitude');
  } finally {
    await db.close();
  }
});

test('Plan 021a: an elemental DoT ticks down a monster', async () => {
  const db = await createMigratedDb();
  const { createNpcForEvent, addStatusEffect, processStatusEffects, getCurrentTickValue } = await import('../worker/game.mjs');
  try {
    const calm = findCalmRoom(getWorldDay());
    await createNpcForEvent(db, {
      username: 'wyrm', displayName: 'Frost Wyrm', npcKind: 'raid_boss', level: 6,
      health: 20, stamina: 100, speed: 7, strength: 12, intelligence: 3,
      worldEventId: 'evt1', row: calm.row, col: calm.col, worldDay: getWorldDay()
    });
    const tick = await getCurrentTickValue(db);
    await addStatusEffect(db, { username: 'wyrm', source: 'p', effectType: 'burn', magnitude: 4, currentTick: tick, duration: 5, row: calm.row, col: calm.col });

    const before = (await db.prepare("SELECT health FROM users WHERE username = 'wyrm'").bind().first()).health;
    await processStatusEffects(db, tick + 1);
    const after = (await db.prepare("SELECT health FROM users WHERE username = 'wyrm'").bind().first()).health;
    assert.equal(after, before - 4, 'burn ticks 4 damage onto the monster');
  } finally {
    await db.close();
  }
});

test('Plan 021b: a kitted monster casts an ability on cast-ticks, basic-attacks otherwise', async () => {
  const db = await createMigratedDb();
  const { createNpcForEvent, runHostileRoomAction, updatePresence } = await import('../worker/game.mjs');
  try {
    const calm = findCalmRoom(getWorldDay());
    // A high-HP victim so the test survives several monster turns.
    await db.prepare(
      `INSERT INTO users (username, password, job, health, maxHealth, stamina, maxStamina, speed, strength, intelligence, level, gold)
       VALUES ('hero', 'pw', 'Novice', 500, 500, 100, 100, 1, 1, 1, 1, 0)`
    ).bind().run();
    await updatePresence(db, 'hero', calm.row, calm.col);
    await createNpcForEvent(db, {
      username: 'wyrm', displayName: 'Frost Wyrm', npcKind: 'raid_boss', level: 6,
      health: 200, stamina: 100, speed: 7, strength: 12, intelligence: 3,
      worldEventId: 'evt1', row: calm.row, col: calm.col, worldDay: getWorldDay()
    });

    // advanceGlobalTick increments first; seed an ODD tick → becomes even → cast.
    await db.prepare('UPDATE tick SET value = 5 WHERE id = 1').bind().run();
    const cast = await runHostileRoomAction(db, calm.row, calm.col);
    assert.ok(cast.acted, 'the monster acted');
    assert.ok(cast.cast, `it cast an ability (${cast.cast})`);

    // Seed an EVEN tick → becomes odd → basic attack (no cast).
    await db.prepare('UPDATE tick SET value = 8 WHERE id = 1').bind().run();
    const basic = await runHostileRoomAction(db, calm.row, calm.col);
    assert.ok(basic.acted, 'the monster acted');
    assert.ok(!basic.cast, 'it made a basic attack, not a cast');
  } finally {
    await db.close();
  }
});
