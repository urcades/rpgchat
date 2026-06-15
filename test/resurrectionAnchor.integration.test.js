// Plan 022c: the resurrection anchor. Death drops a corpse tagged corpseOf;
// resurrection (paid OR free) requires that corpse to still exist; eating/destroying
// it severs the tether — true, permanent death. CommonJS + node:test.

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
     VALUES (?, 'pw', 'Novice', 30, 30, 100, 100, 1, 1, 1, 2, 9)`
  ).bind(username).run();
}

const PAY_URL = 'https://buy.example/resurrect';

// ---------------------------------------------------------------------------

test('Plan 022c: death drops a tagged corpse on the floor', async () => {
  const db = await createMigratedDb();
  const { moveUserToCemetery, getUserState } = await import('../worker/game.mjs');
  try {
    await seedUser(db, 'victim');
    await getUserState(db, 'victim'); // instantiate body
    await moveUserToCemetery(db, 'victim', 'a test', 5, 5);
    const corpse = await db.prepare("SELECT name, corpseOf, roomRow, roomCol FROM items WHERE corpseOf = 'victim'").bind().first();
    assert.ok(corpse, 'a corpse dropped');
    assert.equal(corpse.name, "victim's Corpse");
    assert.equal(corpse.roomRow, 5);
  } finally {
    await db.close();
  }
});

test('Plan 022c: with the corpse intact, resurrection works and consumes it', async () => {
  const db = await createMigratedDb();
  const { moveUserToCemetery, getUserState } = await import('../worker/game.mjs');
  const { createResurrectionCheckout, fulfillResurrectionCheckout } = await import('../worker/resurrection.mjs');
  try {
    await seedUser(db, 'victim');
    await getUserState(db, 'victim');
    await moveUserToCemetery(db, 'victim', 'a test', 5, 5);

    const checkout = await createResurrectionCheckout(db, 'victim', PAY_URL);
    assert.ok(checkout && checkout.token && !checkout.severed, 'checkout offered while the corpse exists');

    const result = await fulfillResurrectionCheckout(db, checkout.token, 'sess-1');
    assert.equal(result.revived, true, 'revived');
    const back = await db.prepare("SELECT username FROM users WHERE username = 'victim'").bind().first();
    assert.ok(back, 'the player is alive again');
    const corpse = await db.prepare("SELECT 1 AS c FROM items WHERE corpseOf = 'victim'").bind().first();
    assert.ok(!corpse, 'the corpse was consumed by the revival');
  } finally {
    await db.close();
  }
});

test('Plan 022c: eating the corpse severs resurrection — even paid', async () => {
  const db = await createMigratedDb();
  const { moveUserToCemetery, eatItem, getUserState } = await import('../worker/game.mjs');
  const { createResurrectionCheckout } = await import('../worker/resurrection.mjs');
  try {
    await seedUser(db, 'victim');
    await seedUser(db, 'ghoul');
    await getUserState(db, 'victim');
    await getUserState(db, 'ghoul');
    await moveUserToCemetery(db, 'victim', 'a test', 5, 5);

    // Another player devours the corpse on the floor.
    const eaten = await eatItem(db, 'ghoul', "victim's Corpse", 5, 5);
    assert.equal(eaten.severed, 'victim', 'eating a corpse reports the severed player');
    assert.ok(!(await db.prepare("SELECT 1 AS c FROM items WHERE corpseOf = 'victim'").bind().first()), 'corpse gone');

    // Now even a paid checkout is refused.
    const checkout = await createResurrectionCheckout(db, 'victim', PAY_URL);
    assert.deepEqual(checkout, { severed: true }, 'no resurrection can be sold');
  } finally {
    await db.close();
  }
});

test('Plan 022c: a corpse destroyed mid-checkout fails fulfillment (no revive)', async () => {
  const db = await createMigratedDb();
  const { moveUserToCemetery, getUserState } = await import('../worker/game.mjs');
  const { createResurrectionCheckout, fulfillResurrectionCheckout } = await import('../worker/resurrection.mjs');
  try {
    await seedUser(db, 'victim');
    await getUserState(db, 'victim');
    await moveUserToCemetery(db, 'victim', 'a test', 5, 5);

    const checkout = await createResurrectionCheckout(db, 'victim', PAY_URL); // corpse still there
    assert.ok(checkout.token);
    // Corpse destroyed before payment clears.
    await db.prepare("DELETE FROM items WHERE corpseOf = 'victim'").bind().run();

    const result = await fulfillResurrectionCheckout(db, checkout.token, 'sess-2');
    assert.equal(result.revived, false);
    assert.equal(result.reason, 'corpse_destroyed');
    assert.ok(!(await db.prepare("SELECT 1 AS c FROM users WHERE username = 'victim'").bind().first()), 'still dead');
  } finally {
    await db.close();
  }
});
