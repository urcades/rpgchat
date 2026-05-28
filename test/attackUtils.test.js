const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3').verbose();

const { validateAttackTargets } = require('../utils/attackUtils');

function dbRun(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, (err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });
}

async function createDb() {
  const db = new sqlite3.Database(':memory:');
  await dbRun(db, 'CREATE TABLE users (username TEXT)');
  await dbRun(db, "INSERT INTO users (username) VALUES ('attacker'), ('target')");
  return db;
}

test('validateAttackTargets rejects attacks with no named target', async () => {
  const db = await createDb();

  await assert.rejects(
    validateAttackTargets(db, 'attacker', 'swing wildly'),
    (err) => err.statusCode === 400 && /target/i.test(err.message)
  );

  db.close();
});

test('validateAttackTargets accepts attacks that name another player', async () => {
  const db = await createDb();
  const targets = await validateAttackTargets(db, 'attacker', 'hit target');

  assert.deepEqual(targets, [{ username: 'target' }]);
  db.close();
});

test('validateAttackTargets accepts self-targeted attacks', async () => {
  const db = await createDb();
  const targets = await validateAttackTargets(db, 'attacker', 'hit attacker');

  assert.deepEqual(targets, [{ username: 'attacker' }]);
  db.close();
});
