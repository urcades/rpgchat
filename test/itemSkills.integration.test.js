// Plan 020b: skill-granting gear. Equipping an item with grantsAbility lets a class
// borrow another's ability (018c's union); unequipping removes it. CommonJS + node:test.

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
      const types = generateRoomFeatures(row, col, worldDay).map(f => f.effect?.type);
      if (!types.some(t => hazardous.includes(t))) return { row, col };
    }
  }
  throw new Error('No calm room for ' + worldDay);
}

const ids = list => list.map(x => x.id);

test('Plan 020b: equipping skill-gear grants the ability cross-class; unequipping removes it', async () => {
  const db = await createMigratedDb();
  const { getUserState, validateClassSkillUse, updatePresence } = await import('../worker/game.mjs');
  try {
    const calm = findCalmRoom(getWorldDay());
    await db.prepare(
      `INSERT INTO users (username, password, job, health, maxHealth, stamina, maxStamina, speed, strength, intelligence, level, gold)
       VALUES ('q', 'pw', 'Novice', 30, 30, 100, 100, 1, 1, 1, 1, 0)`
    ).bind().run();
    await updatePresence(db, 'q', calm.row, calm.col);
    await getUserState(db, 'q'); // instantiate body

    // A Novice can't innately Mark.
    await assert.rejects(() => validateClassSkillUse(db, { username: 'q', skillId: 'mark', targetUsername: '' }), /cannot use that skill/);

    // Equip Venom Fang (grantsAbility: 'mark') onto a hand.
    const hand = await db.prepare("SELECT id FROM bodyParts WHERE username = 'q' AND slotType = 'hand' AND severed = 0 ORDER BY id ASC LIMIT 1").bind().first();
    await db.prepare(
      `INSERT INTO items (templateId, name, slotType, rarity, modifiers, ownerUsername, equippedPartId)
       VALUES ('venom_fang', 'Venom Fang', 'hand', 'rare', '{"speed":1}', 'q', ?)`
    ).bind(hand.id).run();

    const equipped = await getUserState(db, 'q');
    assert.ok(ids(equipped.skills).includes('mark'), 'the granted ability is on the hotbar');
    const ok = await validateClassSkillUse(db, { username: 'q', skillId: 'mark', targetUsername: 'q' });
    assert.equal(ok.ability.id, 'mark', 'and it is usable');

    // Unequip (carry it) → the ability is gone.
    await db.prepare("UPDATE items SET equippedPartId = NULL WHERE ownerUsername = 'q' AND name = 'Venom Fang'").bind().run();
    const carried = await getUserState(db, 'q');
    assert.ok(!ids(carried.skills).includes('mark'), 'unequipping removes the granted ability');
    await assert.rejects(() => validateClassSkillUse(db, { username: 'q', skillId: 'mark', targetUsername: '' }), /cannot use that skill/);
  } finally {
    await db.close();
  }
});
