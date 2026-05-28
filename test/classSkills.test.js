const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3').verbose();

const {
  getSkillForJob
} = require('../utils/jobs');
const {
  useClassSkill,
  validateClassSkillUse,
  processStatusEffects
} = require('../utils/classSkills');

function dbRun(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) {
        reject(err);
        return;
      }
      resolve({ lastID: this.lastID, changes: this.changes });
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

function dbAll(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(rows);
    });
  });
}

async function createSkillDb() {
  const db = new sqlite3.Database(':memory:');
  await dbRun(db, `CREATE TABLE users (
    username TEXT,
    password TEXT,
    job TEXT,
    health INTEGER,
    maxHealth INTEGER,
    stamina INTEGER,
    maxStamina INTEGER,
    speed INTEGER,
    strength INTEGER,
    intelligence INTEGER,
    level INTEGER,
    gold INTEGER
  )`);
  await dbRun(db, 'CREATE TABLE messages_1_1 (username TEXT, message TEXT)');
  await dbRun(db, `CREATE TABLE roomTraces (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    roomRow INTEGER,
    roomCol INTEGER,
    traceType TEXT,
    intensity INTEGER,
    attacker TEXT,
    target TEXT,
    createdTick INTEGER,
    expiryTick INTEGER,
    worldDay TEXT
  )`);
  await dbRun(db, `CREATE TABLE statusEffects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT,
    source TEXT,
    effectType TEXT,
    magnitude INTEGER,
    createdTick INTEGER,
    expiryTick INTEGER,
    roomRow INTEGER,
    roomCol INTEGER,
    sourceUsername TEXT
  )`);
  await dbRun(db, `CREATE TABLE cemetery (
    username TEXT,
    password TEXT,
    level INTEGER,
    gold INTEGER,
    job TEXT,
    cause TEXT,
    roomRow INTEGER,
    roomCol INTEGER,
    diedAt DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  await dbRun(db, `CREATE TABLE roomPresence (
    username TEXT,
    roomRow INTEGER,
    roomCol INTEGER,
    lastSeenTick INTEGER,
    worldDay TEXT,
    lastSeenAt DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  await dbRun(db, `INSERT INTO users
    (username, password, job, health, maxHealth, stamina, maxStamina, speed, strength, intelligence, level, gold)
    VALUES
    ('novice', 'pw', 'Novice', 10, 10, 10, 10, 1, 1, 1, 0, 0),
    ('chemist', 'pw', 'Chemist', 7, 10, 10, 10, 1, 1, 5, 0, 0),
    ('paladin', 'pw', 'Paladin', 10, 10, 10, 10, 1, 2, 1, 0, 0),
    ('target', 'pw', 'Fighter', 5, 10, 10, 10, 1, 3, 1, 0, 0)`);
  return db;
}

test('Novice Scrounge grants gold and writes a system message', async () => {
  const db = await createSkillDb();

  const result = await useClassSkill(db, {
    username: 'novice',
    skillId: getSkillForJob('Novice').id,
    row: 1,
    col: 1,
    currentTick: 12,
    phase: 'Day'
  });

  const user = await dbGet(db, 'SELECT gold FROM users WHERE username = ?', ['novice']);
  const message = await dbGet(db, 'SELECT message FROM messages_1_1 WHERE username = ?', ['System']);

  assert.equal(result.message, 'novice scrounges up 2 gold.');
  assert.equal(user.gold, 2);
  assert.match(message.message, /scrounges up 2 gold/i);
  db.close();
});

test('Chemist Dose heals during day and poisons during night', async () => {
  const db = await createSkillDb();

  await useClassSkill(db, {
    username: 'chemist',
    skillId: 'dose',
    targetUsername: 'target',
    row: 1,
    col: 1,
    currentTick: 20,
    phase: 'Day'
  });
  let target = await dbGet(db, 'SELECT health FROM users WHERE username = ?', ['target']);
  assert.equal(target.health, 8);

  await useClassSkill(db, {
    username: 'chemist',
    skillId: 'dose',
    targetUsername: 'target',
    row: 1,
    col: 1,
    currentTick: 55,
    phase: 'Night'
  });
  const effects = await dbAll(db, 'SELECT effectType, expiryTick FROM statusEffects WHERE username = ?', ['target']);
  assert.deepEqual(effects, [{ effectType: 'poison', expiryTick: 60 }]);
  db.close();
});

test('Paladin Ward reduces the next damage taken', async () => {
  const db = await createSkillDb();

  await useClassSkill(db, {
    username: 'paladin',
    skillId: 'ward',
    targetUsername: 'target',
    row: 1,
    col: 1,
    currentTick: 8,
    phase: 'Day'
  });

  const ward = await dbGet(db, 'SELECT effectType, magnitude, expiryTick FROM statusEffects WHERE username = ?', ['target']);
  assert.deepEqual(ward, { effectType: 'ward', magnitude: 2, expiryTick: 13 });
  db.close();
});

test('processStatusEffects applies poison damage and moves dead users to cemetery', async () => {
  const db = await createSkillDb();
  await dbRun(db, 'UPDATE users SET health = 1 WHERE username = ?', ['target']);
  await dbRun(db, `INSERT INTO statusEffects
    (username, source, effectType, magnitude, createdTick, expiryTick, roomRow, roomCol, sourceUsername)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ['target', 'chemist', 'poison', 2, 8, 12, 1, 1, 'chemist']);

  await processStatusEffects(db, 10);

  const deadUser = await dbGet(db, 'SELECT username FROM users WHERE username = ?', ['target']);
  const cemeteryUser = await dbGet(
    db,
    'SELECT username, password, job, cause, roomRow, roomCol FROM cemetery WHERE username = ?',
    ['target']
  );

  assert.equal(deadUser, undefined);
  assert.deepEqual(cemeteryUser, {
    username: 'target',
    password: 'pw',
    job: 'Fighter',
    cause: 'poison',
    roomRow: 1,
    roomCol: 1
  });
  db.close();
});

test('processStatusEffects does not apply an effect on the tick it was created', async () => {
  const db = await createSkillDb();
  await dbRun(db, `INSERT INTO statusEffects
    (username, source, effectType, magnitude, createdTick, expiryTick, roomRow, roomCol, sourceUsername)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ['target', 'chemist', 'poison', 1, 10, 15, 1, 1, 'chemist']);

  await processStatusEffects(db, 10);
  let target = await dbGet(db, 'SELECT health FROM users WHERE username = ?', ['target']);
  assert.equal(target.health, 5);

  await processStatusEffects(db, 11);
  target = await dbGet(db, 'SELECT health FROM users WHERE username = ?', ['target']);
  assert.equal(target.health, 4);
  db.close();
});

test('validateClassSkillUse rejects invalid targets before mutation', async () => {
  const db = await createSkillDb();

  await assert.rejects(
    validateClassSkillUse(db, {
      username: 'paladin',
      skillId: 'ward',
      targetUsername: 'missing'
    }),
    (err) => err.statusCode === 404 && /target/i.test(err.message)
  );

  const effects = await dbAll(db, 'SELECT * FROM statusEffects');
  assert.deepEqual(effects, []);
  db.close();
});
