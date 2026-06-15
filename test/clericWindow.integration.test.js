// Plan 023d: the Cleric's revival WINDOW vs. Stripe's post-death path. While an ally
// is merely DOWNED (incapacitated), a Cleric can pull them back in real time — no
// corpse, no grave. Stripe's paid resurrection only applies once they are TRULY dead
// (a grave + corpse exist), so the two paths no longer overlap. CommonJS + node:test.

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

async function seedUser(db, username, opts = {}) {
  const { job = 'Novice', health = 30, speed = 1, strength = 1 } = opts;
  await db.prepare(
    `INSERT INTO users (username, password, job, health, maxHealth, stamina, maxStamina, speed, strength, intelligence, level, gold)
     VALUES (?, 'pw', ?, ?, 30, 100, 100, ?, ?, 3, 1, 0)`
  ).bind(username, job, health, speed, strength).run();
}

test('Plan 023d: a Cleric raises a DOWNED ally in real time — no corpse, no grave', async () => {
  const db = await createMigratedDb();
  const { descendTowardDeath, handleSkillAction, updatePresence, getUserState } = await import('../worker/game.mjs');
  try {
    const room = findCalmRoom(getWorldDay());
    await seedUser(db, 'cleric', { job: 'Cleric', strength: 5, speed: 5 });
    await seedUser(db, 'ally', { health: 20, speed: 1 });
    await updatePresence(db, 'cleric', room.row, room.col);
    await updatePresence(db, 'ally', room.row, room.col);
    await getUserState(db, 'ally'); // instantiate body

    // Down the ally (overkill under the gib threshold => incapacitated, not dead).
    await descendTowardDeath(db, 'ally', { cause: 'attack by ogre', row: room.row, col: room.col, blowDamage: 6, overkill: 2, currentTick: 1 });
    const downed = await db.prepare("SELECT incapacitated FROM users WHERE username = 'ally'").first();
    assert.equal(downed.incapacitated, 1, 'precondition: the ally is down');
    const noGraveYet = await db.prepare("SELECT username FROM cemetery WHERE username = 'ally'").first();
    assert.equal(noGraveYet, null, 'a downed ally has no grave — they are not dead');

    // The Cleric pulls them back from the brink.
    await handleSkillAction(db, 'cleric', room.row, room.col, 'revive', 'ally', 2);

    const up = await db.prepare("SELECT incapacitated, deathClock, stance, health FROM users WHERE username = 'ally'").first();
    assert.equal(up.incapacitated, 0, 'lifted from the brink');
    assert.equal(up.deathClock, 0);
    assert.equal(up.stance, 'standing');
    assert.ok(up.health > 0, 'restored above 0');
  } finally {
    await db.close();
  }
});

test('Plan 023d: Stripe will not sell a resurrection to the merely-downed — no grave to sell', async () => {
  const db = await createMigratedDb();
  const { descendTowardDeath, updatePresence, getUserState } = await import('../worker/game.mjs');
  const { createResurrectionCheckout } = await import('../worker/resurrection.mjs');
  try {
    const room = findCalmRoom(getWorldDay());
    await seedUser(db, 'faller', { health: 8, speed: 1 });
    await updatePresence(db, 'faller', room.row, room.col);
    await getUserState(db, 'faller');

    await descendTowardDeath(db, 'faller', { cause: 'attack by wolf', row: room.row, col: room.col, blowDamage: 9, overkill: 3, currentTick: 1 });

    // Incapacitated, not dead: no grave exists, so the paid path has nothing to sell.
    const grave = await db.prepare("SELECT username FROM cemetery WHERE username = 'faller'").first();
    assert.equal(grave, null);
    const checkout = await createResurrectionCheckout(db, 'faller', 'https://example.test/pay');
    assert.equal(checkout, null, 'Stripe resurrection is post-death only — distinct from the cleric window');
  } finally {
    await db.close();
  }
});
