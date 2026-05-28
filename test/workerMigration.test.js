const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const sqlite3 = require('sqlite3').verbose();

function createSqliteD1() {
  const raw = new sqlite3.Database(':memory:');
  return {
    raw,
    exec(sql) {
      return new Promise((resolve, reject) => {
        raw.exec(sql, err => (err ? reject(err) : resolve()));
      });
    },
    close() {
      return new Promise((resolve, reject) => {
        raw.close(err => (err ? reject(err) : resolve()));
      });
    },
    prepare(sql) {
      const statement = {
        params: [],
        bind(...params) {
          this.params = params;
          return this;
        },
        first() {
          return new Promise((resolve, reject) => {
            raw.get(sql, this.params, (err, row) => (err ? reject(err) : resolve(row || null)));
          });
        },
        all() {
          return new Promise((resolve, reject) => {
            raw.all(sql, this.params, (err, rows) => (err ? reject(err) : resolve({ results: rows })));
          });
        },
        run() {
          return new Promise((resolve, reject) => {
            raw.run(sql, this.params, function onRun(err) {
              if (err) {
                reject(err);
                return;
              }
              resolve({
                meta: {
                  changes: this.changes,
                  last_row_id: this.lastID
                }
              });
            });
          });
        }
      };
      return statement;
    }
  };
}

async function createMigratedDb() {
  const db = createSqliteD1();
  const migration = fs.readFileSync(path.join(__dirname, '../migrations/0001_initial.sql'), 'utf8');
  await db.exec(migration);
  return db;
}

test('Worker D1 migration creates a fresh normalized world schema', async () => {
  const db = await createMigratedDb();
  try {
    const tick = await db.prepare('SELECT value FROM tick WHERE id = 1').first();
    const system = await db.prepare("SELECT username, job FROM users WHERE username = 'System'").first();
    const messageTable = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'messages'").first();
    const oldRoomTable = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'messages_1_1'").first();

    assert.equal(tick.value, 0);
    assert.deepEqual(system, { username: 'System', job: 'Novice' });
    assert.equal(messageTable.name, 'messages');
    assert.equal(oldRoomTable, null);
  } finally {
    await db.close();
  }
});

test('Worker chat actions spend stamina, write normalized messages, and advance one tick', async () => {
  const db = await createMigratedDb();
  const { getCurrentTickValue, getMessages, handleChatAction } = await import('../worker/game.mjs');

  try {
    await db.prepare(
      `INSERT INTO users
        (username, password, job, health, maxHealth, stamina, maxStamina, speed, strength, intelligence)
       VALUES ('worker_a', 'pw', 'Novice', 12, 12, 100, 100, 1, 1, 1)`
    ).run();

    const result = await handleChatAction(db, 'worker_a', 1, 1, 'hello worker');
    const user = await db.prepare("SELECT stamina FROM users WHERE username = 'worker_a'").first();
    const messages = await getMessages(db, 1, 1);

    assert.equal(result.tick.tick, 1);
    assert.equal(await getCurrentTickValue(db), 1);
    assert.equal(user.stamina, 99);
    assert.equal(messages.at(-1).message, 'hello worker');
  } finally {
    await db.close();
  }
});

test('Worker low-stamina failures do not mutate messages or ticks', async () => {
  const db = await createMigratedDb();
  const { getCurrentTickValue, getMessages, handleChatAction } = await import('../worker/game.mjs');

  try {
    await db.prepare(
      `INSERT INTO users
        (username, password, job, health, maxHealth, stamina, maxStamina, speed, strength, intelligence)
       VALUES ('tired', 'pw', 'Novice', 12, 12, 0, 100, 1, 1, 1)`
    ).run();

    await assert.rejects(
      () => handleChatAction(db, 'tired', 1, 1, 'too tired'),
      /Not enough stamina/
    );

    assert.equal(await getCurrentTickValue(db), 0);
    assert.equal((await getMessages(db, 1, 1)).length, 0);
  } finally {
    await db.close();
  }
});

test('Worker class skills write system messages and advance through the shared action lifecycle', async () => {
  const db = await createMigratedDb();
  const { getCurrentTickValue, getMessages, handleSkillAction } = await import('../worker/game.mjs');

  try {
    await db.prepare(
      `INSERT INTO users
        (username, password, job, health, maxHealth, stamina, maxStamina, speed, strength, intelligence, gold)
       VALUES ('scout', 'pw', 'Novice', 12, 12, 100, 100, 1, 1, 4, 0)`
    ).run();

    const result = await handleSkillAction(db, 'scout', 1, 1, 'scrounge', '', 1);
    const user = await db.prepare("SELECT stamina, gold FROM users WHERE username = 'scout'").first();
    const messages = await getMessages(db, 1, 1);

    assert.equal(result.tick.tick, 1);
    assert.equal(await getCurrentTickValue(db), 1);
    assert.equal(user.stamina, 99);
    assert.equal(user.gold, 3);
    assert.match(messages.at(-1).message, /scrounges up 3 gold/);
  } finally {
    await db.close();
  }
});
