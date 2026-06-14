// Resurrection fulfillment integration coverage. The fix under test: fulfillment
// must claim the request atomically (conditional UPDATE pending->completed)
// BEFORE running side effects, so a retried or concurrent Stripe webhook for the
// same token is an idempotent no-op instead of racing on the user INSERT.
//
// CommonJS + node:test to match the rest of test/.

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
              resolve({ meta: { changes: this.changes, last_row_id: this.lastID } });
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
  const migrations = fs.readdirSync(migrationsDir).filter(file => file.endsWith('.sql')).sort();
  for (const migrationFile of migrations) {
    await db.exec(fs.readFileSync(path.join(migrationsDir, migrationFile), 'utf8'));
  }
  return db;
}

async function seedGrave(db, username, overrides = {}) {
  const grave = { password: 'pw', level: 3, gold: 50, job: 'Fighter', ...overrides };
  await db.prepare(
    'INSERT INTO cemetery (username, password, level, gold, job) VALUES (?, ?, ?, ?, ?)'
  ).bind(username, grave.password, grave.level, grave.gold, grave.job).run();
}

async function countUsers(db, username) {
  const row = await db.prepare('SELECT COUNT(*) AS n FROM users WHERE username = ?').bind(username).first();
  return row.n;
}

// ---------------------------------------------------------------------------

test('resurrection: happy path revives the grave exactly once', async () => {
  const db = await createMigratedDb();
  const { createResurrectionCheckout, fulfillResurrectionCheckout } = await import('../worker/resurrection.mjs');

  try {
    await seedGrave(db, 'ghost', { gold: 50, level: 3 });
    const checkout = await createResurrectionCheckout(db, 'ghost', 'https://pay.example/x');
    assert.ok(checkout.token, 'checkout returns a token');

    const result = await fulfillResurrectionCheckout(db, checkout.token, 'sess_1');
    assert.deepEqual(result, { revived: true, username: 'ghost' });

    const user = await db.prepare("SELECT gold, level FROM users WHERE username = 'ghost'").first();
    assert.equal(user.gold, 50, 'gold carried over from the grave');
    assert.equal(user.level, 3, 'level carried over from the grave');
    const grave = await db.prepare("SELECT id FROM cemetery WHERE username = 'ghost'").first();
    assert.equal(grave, null, 'grave row removed');
    const request = await db.prepare('SELECT status FROM resurrectionRequests WHERE token = ?').bind(checkout.token).first();
    assert.equal(request.status, 'completed');
  } finally {
    await db.close();
  }
});

test('resurrection: a retried webhook for the same token is an idempotent no-op', async () => {
  const db = await createMigratedDb();
  const { createResurrectionCheckout, fulfillResurrectionCheckout } = await import('../worker/resurrection.mjs');

  try {
    await seedGrave(db, 'ghost');
    const { token } = await createResurrectionCheckout(db, 'ghost', 'https://pay.example/x');

    const first = await fulfillResurrectionCheckout(db, token, 'sess_1');
    assert.equal(first.revived, true);

    const second = await fulfillResurrectionCheckout(db, token, 'sess_1');
    assert.deepEqual(second, { revived: false, reason: 'already_completed' });

    assert.equal(await countUsers(db, 'ghost'), 1, 'exactly one user row — no duplicate from the retry');
  } finally {
    await db.close();
  }
});

test('resurrection: two concurrent webhooks for one token revive exactly once', async () => {
  const db = await createMigratedDb();
  const { createResurrectionCheckout, fulfillResurrectionCheckout } = await import('../worker/resurrection.mjs');

  try {
    await seedGrave(db, 'ghost');
    const { token } = await createResurrectionCheckout(db, 'ghost', 'https://pay.example/x');

    // Both fire together. Pre-fix, both could pass the pending read and collide on
    // the user INSERT (a PK violation, rejecting the race). Post-fix, the atomic
    // claim lets exactly one win.
    const results = await Promise.all([
      fulfillResurrectionCheckout(db, token, 'sess_a'),
      fulfillResurrectionCheckout(db, token, 'sess_b')
    ]);

    assert.equal(results.filter(r => r.revived).length, 1, 'exactly one revival won the claim');
    const skipped = results.filter(r => !r.revived);
    assert.equal(skipped.length, 1, 'the other call is a clean no-op');
    assert.equal(skipped[0].reason, 'already_completed');
    assert.equal(await countUsers(db, 'ghost'), 1, 'exactly one user row');
  } finally {
    await db.close();
  }
});

test('resurrection: a request whose grave is gone reports grave_not_found', async () => {
  const db = await createMigratedDb();
  const { createResurrectionCheckout, fulfillResurrectionCheckout } = await import('../worker/resurrection.mjs');

  try {
    await seedGrave(db, 'ghost');
    const { token } = await createResurrectionCheckout(db, 'ghost', 'https://pay.example/x');
    await db.prepare("DELETE FROM cemetery WHERE username = 'ghost'").run();

    const result = await fulfillResurrectionCheckout(db, token, 'sess_1');
    assert.deepEqual(result, { revived: false, reason: 'grave_not_found' });

    const request = await db.prepare('SELECT status FROM resurrectionRequests WHERE token = ?').bind(token).first();
    assert.equal(request.status, 'missing_grave', 'request lands in a terminal state, not retried forever');
    assert.equal(await countUsers(db, 'ghost'), 0, 'no user created when the grave is gone');
  } finally {
    await db.close();
  }
});

test('resurrection: unknown and missing tokens are rejected cleanly', async () => {
  const db = await createMigratedDb();
  const { fulfillResurrectionCheckout } = await import('../worker/resurrection.mjs');

  try {
    assert.deepEqual(
      await fulfillResurrectionCheckout(db, 'no-such-token', 'sess_1'),
      { revived: false, reason: 'request_not_found' }
    );
    assert.deepEqual(
      await fulfillResurrectionCheckout(db, '', 'sess_1'),
      { revived: false, reason: 'missing_token' }
    );
  } finally {
    await db.close();
  }
});
