// adv-020: a self-test for the shared D1 shim (test/.helpers/d1.js). Every other
// suite trusts this shim to mimic the slice of the Cloudflare D1 prepared-statement
// API the worker uses — prepare -> bind -> first/all/run, the run() meta shape
// (changes / last_row_id), and SQL NULL <-> JS null round-tripping. Pinning that
// contract here means a future shim regression fails ONE obvious test, not a
// scattered handful of mystery failures across the integration suites.
// CommonJS + node:test, no worker import (this exercises the helper directly).

const assert = require('node:assert/strict');
const test = require('node:test');
const { createSqliteD1, createMigratedDb } = require('./.helpers/d1');

async function freshTable() {
  const db = createSqliteD1();
  await db.exec(`
    CREATE TABLE t (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT,
      qty INTEGER,
      note TEXT
    );
  `);
  return db;
}

// ---------------------------------------------------------------------------

test('d1 shim: prepare/bind/run inserts a row and reports changes + last_row_id', async () => {
  const db = await freshTable();
  try {
    const res = await db.prepare('INSERT INTO t (name, qty) VALUES (?, ?)').bind('alpha', 3).run();
    assert.ok(res && res.meta, 'run() returns a { meta } envelope');
    assert.equal(res.meta.changes, 1, 'one row changed');
    assert.equal(res.meta.last_row_id, 1, 'last_row_id is the new AUTOINCREMENT id');

    const second = await db.prepare('INSERT INTO t (name, qty) VALUES (?, ?)').bind('beta', 7).run();
    assert.equal(second.meta.changes, 1, 'second insert: one row changed');
    assert.equal(second.meta.last_row_id, 2, 'last_row_id advances to 2');
  } finally {
    await db.close();
  }
});

test('d1 shim: first() returns a single row object, or null when nothing matches', async () => {
  const db = await freshTable();
  try {
    await db.prepare('INSERT INTO t (name, qty) VALUES (?, ?)').bind('alpha', 3).run();

    const row = await db.prepare('SELECT id, name, qty FROM t WHERE name = ?').bind('alpha').first();
    assert.deepEqual(row, { id: 1, name: 'alpha', qty: 3 }, 'first() yields the matched row as a plain object');

    const miss = await db.prepare('SELECT id FROM t WHERE name = ?').bind('nope').first();
    assert.equal(miss, null, 'first() yields null (not undefined) on no match');
  } finally {
    await db.close();
  }
});

test('d1 shim: all() returns a { results: [...] } envelope (empty array, never null)', async () => {
  const db = await freshTable();
  try {
    await db.prepare('INSERT INTO t (name, qty) VALUES (?, ?)').bind('alpha', 3).run();
    await db.prepare('INSERT INTO t (name, qty) VALUES (?, ?)').bind('beta', 7).run();

    const many = await db.prepare('SELECT name, qty FROM t ORDER BY id ASC').bind().all();
    assert.ok(many && Array.isArray(many.results), 'all() returns { results: [] }');
    assert.deepEqual(many.results, [{ name: 'alpha', qty: 3 }, { name: 'beta', qty: 7 }], 'rows arrive in query order');

    const none = await db.prepare('SELECT name FROM t WHERE qty > ?').bind(999).all();
    assert.deepEqual(none.results, [], 'all() yields an empty array (not null) when nothing matches');
  } finally {
    await db.close();
  }
});

test('d1 shim: a bound statement is reusable and bind() returns the statement (chaining)', async () => {
  const db = await freshTable();
  try {
    const insert = db.prepare('INSERT INTO t (name, qty) VALUES (?, ?)');
    // bind() returns `this`, so .bind(...).run() chains — the idiom every suite uses.
    const chained = insert.bind('alpha', 1);
    assert.equal(chained, insert, 'bind() returns the statement for chaining');
    await chained.run();

    // Re-binding the SAME prepared statement with new params overwrites cleanly.
    await insert.bind('beta', 2).run();
    const count = await db.prepare('SELECT COUNT(*) AS c FROM t').bind().first();
    assert.equal(count.c, 2, 'the re-bound statement inserted a distinct second row');
  } finally {
    await db.close();
  }
});

test('d1 shim: SQL NULL round-trips as JS null, and a null bind param stores NULL', async () => {
  const db = await freshTable();
  try {
    // note is omitted → stored NULL; qty bound explicitly to null → stored NULL.
    await db.prepare('INSERT INTO t (name, qty, note) VALUES (?, ?, ?)').bind('alpha', null, null).run();

    const row = await db.prepare('SELECT name, qty, note FROM t WHERE name = ?').bind('alpha').first();
    assert.equal(row.qty, null, 'a null bind param is stored + read back as JS null');
    assert.equal(row.note, null, 'an explicit null TEXT is read back as null');

    // IS NULL matches the stored NULL — proving it is a real SQL NULL, not the string "null".
    const byNull = await db.prepare('SELECT name FROM t WHERE qty IS NULL').bind().first();
    assert.equal(byNull.name, 'alpha', 'IS NULL finds the row → it is a true SQL NULL');
    const byString = await db.prepare("SELECT COUNT(*) AS c FROM t WHERE qty = 'null'").bind().first();
    assert.equal(byString.c, 0, 'the NULL was not coerced to the string "null"');
  } finally {
    await db.close();
  }
});

test('d1 shim: run() on UPDATE/DELETE reports the affected-row count', async () => {
  const db = await freshTable();
  try {
    await db.prepare('INSERT INTO t (name, qty) VALUES (?, ?)').bind('alpha', 1).run();
    await db.prepare('INSERT INTO t (name, qty) VALUES (?, ?)').bind('beta', 1).run();
    await db.prepare('INSERT INTO t (name, qty) VALUES (?, ?)').bind('gamma', 9).run();

    const upd = await db.prepare('UPDATE t SET qty = qty + 1 WHERE qty = ?').bind(1).run();
    assert.equal(upd.meta.changes, 2, 'UPDATE reports the two matched rows');

    const del = await db.prepare('DELETE FROM t WHERE qty = ?').bind(9).run();
    assert.equal(del.meta.changes, 1, 'DELETE reports the one matched row');

    const noop = await db.prepare('DELETE FROM t WHERE name = ?').bind('absent').run();
    assert.equal(noop.meta.changes, 0, 'a no-op DELETE reports zero changes');
  } finally {
    await db.close();
  }
});

test('d1 shim: createMigratedDb applies the migrations (a known table + seeded tick exist)', async () => {
  const db = await createMigratedDb();
  try {
    // The users table is the spine of the schema — its presence proves the migration
    // runner walked migrations/ and applied them in order.
    const usersTable = await db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'users'"
    ).bind().first();
    assert.ok(usersTable, 'createMigratedDb created the users table from migrations/');

    // The tick row is seeded by a migration — a fresh DB starts at a defined value.
    const tick = await db.prepare('SELECT value FROM tick WHERE id = 1').bind().first();
    assert.ok(tick && Number.isFinite(tick.value), 'the global tick row is seeded with a numeric value');
  } finally {
    await db.close();
  }
});
