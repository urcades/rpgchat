const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3').verbose();

const { switchJob } = require('../utils/jobSwitching');

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

async function createDb() {
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
  await dbRun(db, 'CREATE TABLE messages_1_1 (username TEXT, message TEXT)');
  await dbRun(db, `INSERT INTO users
    (username, job, health, maxHealth, stamina, maxStamina, speed, strength, intelligence)
    VALUES ('ed', 'Paladin', 13, 12, 140, 130, 1, 1, 1)`);
  return db;
}

test('switchJob updates job and clamps health and stamina to the new effective maximums', async () => {
  const db = await createDb();

  const result = await switchJob(db, {
    username: 'ed',
    nextJob: 'Mage',
    row: 1,
    col: 1
  });

  const user = await dbGet(db, 'SELECT job, health, stamina FROM users WHERE username = ?', ['ed']);
  const message = await dbGet(db, 'SELECT message FROM messages_1_1 WHERE username = ?', ['System']);

  assert.equal(result.message, 'ed changes job to Mage.');
  assert.deepEqual(user, { job: 'Mage', health: 12, stamina: 130 });
  assert.match(message.message, /Mage/);
  db.close();
});

test('switchJob rejects unknown jobs', async () => {
  const db = await createDb();

  await assert.rejects(
    switchJob(db, {
      username: 'ed',
      nextJob: 'Chef',
      row: 1,
      col: 1
    }),
    (err) => err.statusCode === 400 && /job/i.test(err.message)
  );

  db.close();
});
