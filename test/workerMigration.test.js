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
  const migrationsDir = path.join(__dirname, '../migrations');
  const migrations = fs.readdirSync(migrationsDir)
    .filter(file => file.endsWith('.sql'))
    .sort();
  for (const migrationFile of migrations) {
    const migration = fs.readFileSync(path.join(migrationsDir, migrationFile), 'utf8');
    await db.exec(migration);
  }
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

test('Worker malformed roll commands fail before spending stamina or advancing ticks', async () => {
  const db = await createMigratedDb();
  const { getCurrentTickValue, getMessages, handleChatAction } = await import('../worker/game.mjs');

  try {
    await db.prepare(
      `INSERT INTO users
        (username, password, job, health, maxHealth, stamina, maxStamina, speed, strength, intelligence, gold)
       VALUES ('roller', 'pw', 'Novice', 12, 12, 100, 100, 1, 1, 1, 10)`
    ).run();

    await assert.rejects(
      () => handleChatAction(db, 'roller', 1, 1, '/roll nope'),
      /Use \/roll <gold>/
    );

    const user = await db.prepare("SELECT stamina, gold FROM users WHERE username = 'roller'").first();
    assert.deepEqual(user, { stamina: 100, gold: 10 });
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

test('Worker resurrection link creates a pending request for the current grave', async () => {
  const db = await createMigratedDb();
  const { createResurrectionCheckout } = await import('../worker/resurrection.mjs');

  try {
    await db.prepare(
      `INSERT INTO cemetery
        (username, password, level, gold, job, cause, roomRow, roomCol)
       VALUES ('fallen', 'pw', 4, 7, 'Mage', 'test', 2, 3)`
    ).run();

    const checkout = await createResurrectionCheckout(db, 'fallen', 'https://buy.stripe.com/test_link');
    const request = await db.prepare(
      'SELECT token, username, graveId, status FROM resurrectionRequests WHERE username = ?'
    ).bind('fallen').first();

    assert.equal(request.token, checkout.token);
    assert.equal(request.username, 'fallen');
    assert.equal(request.status, 'pending');
    assert.match(checkout.url, /^https:\/\/buy\.stripe\.com\/test_link\?client_reference_id=/);
  } finally {
    await db.close();
  }
});

test('Worker resurrection fulfillment revives a paid grave only once', async () => {
  const db = await createMigratedDb();
  const { createResurrectionCheckout, fulfillResurrectionCheckout } = await import('../worker/resurrection.mjs');

  try {
    await db.prepare(
      `INSERT INTO cemetery
        (username, password, level, gold, job, cause, roomRow, roomCol)
       VALUES ('fallen', 'pw', 4, 7, 'Mage', 'test', 2, 3)`
    ).run();

    const checkout = await createResurrectionCheckout(db, 'fallen', 'https://buy.stripe.com/test_link');
    const first = await fulfillResurrectionCheckout(db, checkout.token, 'cs_test_123');
    const second = await fulfillResurrectionCheckout(db, checkout.token, 'cs_test_123');
    const revived = await db.prepare(
      'SELECT username, password, level, gold, job, health, maxHealth, stamina, maxStamina FROM users WHERE username = ?'
    ).bind('fallen').first();
    const grave = await db.prepare('SELECT username FROM cemetery WHERE username = ?').bind('fallen').first();
    const request = await db.prepare(
      'SELECT status, stripeSessionId, completedAt FROM resurrectionRequests WHERE token = ?'
    ).bind(checkout.token).first();

    assert.equal(first.revived, true);
    assert.equal(second.revived, false);
    assert.deepEqual(revived, {
      username: 'fallen',
      password: 'pw',
      level: 4,
      gold: 7,
      job: 'Mage',
      health: 10,
      maxHealth: 10,
      stamina: 100,
      maxStamina: 100
    });
    assert.equal(grave, null);
    assert.equal(request.status, 'completed');
    assert.equal(request.stripeSessionId, 'cs_test_123');
    assert.ok(request.completedAt);
  } finally {
    await db.close();
  }
});
