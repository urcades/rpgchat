const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3').verbose();

const {
  spendStamina,
  runPlayerAction,
  createActionError
} = require('../utils/playerActions');

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

async function createDb(stamina = 2) {
  const db = new sqlite3.Database(':memory:');
  await dbRun(db, 'CREATE TABLE users (username TEXT, stamina INTEGER, maxStamina INTEGER)');
  await dbRun(db, 'INSERT INTO users (username, stamina, maxStamina) VALUES (?, ?, ?)', ['ed', stamina, 10]);
  return db;
}

test('spendStamina atomically spends only when enough stamina is available', async () => {
  const db = await createDb(2);

  await spendStamina(db, 'ed', 2);

  const user = await dbGet(db, 'SELECT stamina FROM users WHERE username = ?', ['ed']);
  assert.equal(user.stamina, 0);
  db.close();
});

test('spendStamina rejects low stamina without changing the user', async () => {
  const db = await createDb(0);

  await assert.rejects(
    spendStamina(db, 'ed', 1),
    (err) => err.statusCode === 400 && /stamina/i.test(err.message)
  );

  const user = await dbGet(db, 'SELECT stamina FROM users WHERE username = ?', ['ed']);
  assert.equal(user.stamina, 0);
  db.close();
});

test('createActionError carries an HTTP status code', () => {
  const err = createActionError('No target found.', 404);

  assert.equal(err.message, 'No target found.');
  assert.equal(err.statusCode, 404);
});

test('runPlayerAction spends stamina, performs the action, then advances time once', async () => {
  const db = await createDb(3);
  const events = [];

  const result = await runPlayerAction(db, {
    username: 'ed',
    staminaCost: 1,
    perform: async () => {
      events.push('perform');
      return { message: 'acted' };
    },
    advanceTick: async () => {
      events.push('tick');
      return { tick: 42 };
    }
  });

  const user = await dbGet(db, 'SELECT stamina FROM users WHERE username = ?', ['ed']);
  assert.equal(user.stamina, 2);
  assert.deepEqual(events, ['perform', 'tick']);
  assert.deepEqual(result, { message: 'acted', tick: { tick: 42 } });
  db.close();
});

test('runPlayerAction blocks low stamina before performing or advancing time', async () => {
  const db = await createDb(0);
  let performed = false;
  let advanced = false;

  await assert.rejects(
    runPlayerAction(db, {
      username: 'ed',
      staminaCost: 1,
      perform: async () => {
        performed = true;
      },
      advanceTick: async () => {
        advanced = true;
      }
    }),
    (err) => err.statusCode === 400 && /stamina/i.test(err.message)
  );

  assert.equal(performed, false);
  assert.equal(advanced, false);
  db.close();
});

test('runPlayerAction validation failure does not spend stamina or advance time', async () => {
  const db = await createDb(3);
  let performed = false;
  let advanced = false;

  await assert.rejects(
    runPlayerAction(db, {
      username: 'ed',
      staminaCost: 1,
      validate: async () => {
        throw createActionError('Bad target.', 404);
      },
      perform: async () => {
        performed = true;
      },
      advanceTick: async () => {
        advanced = true;
      }
    }),
    (err) => err.statusCode === 404 && err.message === 'Bad target.'
  );

  const user = await dbGet(db, 'SELECT stamina FROM users WHERE username = ?', ['ed']);
  assert.equal(user.stamina, 3);
  assert.equal(performed, false);
  assert.equal(advanced, false);
  db.close();
});
