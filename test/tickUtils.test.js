const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3').verbose();

const { recoverStaminaForAllUsers } = require('../utils/tickUtils');

function dbRun(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) {
        reject(err);
        return;
      }
      resolve({ changes: this.changes });
    });
  });
}

function dbGet(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(row);
    });
  });
}

test('recoverStaminaForAllUsers uses effective job stamina caps', async () => {
  const db = new sqlite3.Database(':memory:');
  await dbRun(db, `CREATE TABLE users (
    username TEXT,
    job TEXT,
    health INTEGER,
    maxHealth INTEGER,
    stamina INTEGER,
    maxStamina INTEGER,
    speed INTEGER,
    strength INTEGER,
    intelligence INTEGER
  )`);
  await dbRun(db, `INSERT INTO users
    (username, job, health, maxHealth, stamina, maxStamina, speed, strength, intelligence)
    VALUES ('chemist', 'Chemist', 10, 10, 100, 100, 1, 1, 1)`);

  await recoverStaminaForAllUsers(db);

  const user = await dbGet(db, 'SELECT stamina FROM users WHERE username = ?', ['chemist']);
  assert.equal(user.stamina, 101);
  db.close();
});
