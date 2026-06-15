// Plan 022a: crafting. A verb (cook) consumes carried recipe inputs and produces the
// output; defeated monsters leave remains (the input substrate). CommonJS + node:test.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const sqlite3 = require('sqlite3').verbose();

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

async function seedUser(db, username) {
  await db.prepare(
    `INSERT INTO users (username, password, job, health, maxHealth, stamina, maxStamina, speed, strength, intelligence, level, gold)
     VALUES (?, 'pw', 'Novice', 30, 30, 100, 100, 1, 1, 1, 0, 0)`
  ).bind(username).run();
}

async function giveCarried(db, username, templateId, name) {
  await db.prepare(
    `INSERT INTO items (templateId, name, slotType, rarity, modifiers, ownerUsername)
     VALUES (?, ?, 'part', 'common', '{}', ?)`
  ).bind(templateId, name, username).run();
}

async function countOwned(db, username, templateId) {
  const row = await db.prepare("SELECT COUNT(*) AS c FROM items WHERE ownerUsername = ? AND templateId = ?").bind(username, templateId).first();
  return row.c;
}

// ---------------------------------------------------------------------------

test('Plan 022a: cooking consumes remains and yields food', async () => {
  const db = await createMigratedDb();
  const { craftRecipe } = await import('../worker/game.mjs');
  try {
    await seedUser(db, 'q');
    await giveCarried(db, 'q', 'monster_remains', 'Monster Remains');

    const result = await craftRecipe(db, 'q', 'cook', 'Cooked Remains');
    assert.equal(result.crafted, 'Cooked Remains');
    assert.equal(await countOwned(db, 'q', 'monster_remains'), 0, 'the remains were consumed');
    assert.equal(await countOwned(db, 'q', 'cooked_remains'), 1, 'food was produced');
  } finally {
    await db.close();
  }
});

test('Plan 022a: cooking rejects when inputs are missing or the recipe is unknown', async () => {
  const db = await createMigratedDb();
  const { craftRecipe } = await import('../worker/game.mjs');
  try {
    await seedUser(db, 'q');
    await assert.rejects(() => craftRecipe(db, 'q', 'cook', 'Cooked Remains'), /need/i);
    await assert.rejects(() => craftRecipe(db, 'q', 'cook', 'Dragon Steak'), /No cook recipe/);
  } finally {
    await db.close();
  }
});

test('Plan 022a: a defeated monster leaves remains on the floor', async () => {
  const db = await createMigratedDb();
  const { createNpcForEvent, defeatNpc, getCurrentTickValue } = await import('../worker/game.mjs');
  try {
    await createNpcForEvent(db, {
      username: 'lurker', displayName: 'Room Lurker', npcKind: 'ambient_hostile', level: 1,
      health: 8, stamina: 60, speed: 3, strength: 4, intelligence: 1,
      worldEventId: 'evt1', row: 5, col: 5, worldDay: require('../utils/roomEcology').getWorldDay()
    });
    const tick = await getCurrentTickValue(db);
    await defeatNpc(db, { username: 'lurker', displayName: 'Room Lurker', npcKind: 'ambient_hostile', isNpc: 1, health: 0 }, { killer: 'hero', row: 5, col: 5, currentTick: tick });
    const remains = await db.prepare("SELECT COUNT(*) AS c FROM items WHERE templateId = 'monster_remains' AND roomRow = 5 AND roomCol = 5").bind().first();
    assert.ok(remains.c >= 1, 'remains dropped on the floor');
  } finally {
    await db.close();
  }
});
