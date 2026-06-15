// Plan 013d: NPCs use their job skills — the cleric who saves you. A DOWNED player who
// pleads, with a friendly NPC cleric present, is raised by the engine (the model only
// asks; the engine gates on disposition + ability + the target being down). CommonJS.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const sqlite3 = require('sqlite3').verbose();
const { getWorldDay, generateRoomFeatures } = require('../utils/roomEcology');

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

function findCalmRoom(worldDay) {
  const hazardous = ['poison_marsh', 'moon_room', 'echo_chamber', 'pub', 'inn', 'sun_room', 'cold_room', 'guild'];
  for (let row = 1; row <= 16; row += 1) {
    for (let col = 1; col <= 16; col += 1) {
      if (!generateRoomFeatures(row, col, worldDay).map(f => f.effect?.type).some(t => hazardous.includes(t))) return { row, col };
    }
  }
  throw new Error('No calm room');
}

async function addHuman(db, game, username, row, col) {
  await db.prepare(
    `INSERT INTO users (username, password, job, health, maxHealth, stamina, maxStamina, speed, strength, intelligence, level)
     VALUES (?, 'pw', 'Fighter', 30, 30, 100, 100, 5, 5, 5, 1)`
  ).bind(username).run();
  await game.updatePresence(db, username, row, col);
  await game.getUserState(db, username); // instantiate body
}

async function addCleric(db, game, username, displayName, disposition, row, col) {
  await db.prepare(
    `INSERT INTO users (username, password, job, health, maxHealth, stamina, maxStamina, speed, strength, intelligence, level, isNpc, displayName, npcKind, disposition, role, npcWorldDay)
     VALUES (?, 'npc', 'Cleric', 24, 24, 100, 100, 4, 5, 5, 3, 1, ?, 'social', ?, 'healer', ?)`
  ).bind(username, displayName, disposition, getWorldDay()).run();
  await game.updatePresence(db, username, row, col);
}

async function downThePlayer(db, game, attacker, victim, room) {
  // Use a heavy enough blow to incapacitate (overkill stays under the gib threshold for low HP).
  await db.prepare(
    `INSERT INTO users (username, password, job, health, maxHealth, stamina, maxStamina, speed, strength, intelligence, level)
     VALUES (?, 'pw', 'Fighter', 30, 30, 100, 100, 20, 12, 1, 4)`
  ).bind(attacker).run();
  await game.updatePresence(db, attacker, room.row, room.col);
  await game.descendTowardDeath(db, victim, { cause: `attack by ${attacker}`, row: room.row, col: room.col, blowDamage: 6, overkill: 2, currentTick: 1 });
}

async function addWoundedHuman(db, game, username, row, col, health) {
  await db.prepare(
    `INSERT INTO users (username, password, job, health, maxHealth, stamina, maxStamina, speed, strength, intelligence, level)
     VALUES (?, 'pw', 'Fighter', ?, 30, 100, 100, 5, 5, 5, 1)`
  ).bind(username, health).run();
  await game.updatePresence(db, username, row, col);
  await game.getUserState(db, username); // body parts sum to health/maxHealth
}

async function humanSays(db, username, row, col, message) {
  await db.prepare('INSERT INTO messages (roomRow, roomCol, username, message, kind) VALUES (?, ?, ?, ?, ?)').bind(row, col, username, message, 'chat').run();
}

test('Plan 013d: a friendly NPC cleric raises a downed player who pleads', async () => {
  const db = await createMigratedDb();
  const game = await import('../worker/game.mjs');
  try {
    const room = findCalmRoom(getWorldDay());
    await addHuman(db, game, 'pilgrim', room.row, room.col);
    await addCleric(db, game, 'soc_healer_1', 'Sister Maeve', 'friendly', room.row, room.col);
    await downThePlayer(db, game, 'ogre', 'pilgrim', room);

    const downed = await db.prepare("SELECT incapacitated FROM users WHERE username = 'pilgrim'").first();
    assert.equal(downed.incapacitated, 1, 'precondition: the player is down');

    await humanSays(db, 'pilgrim', room.row, room.col, 'please... heal me... save me');
    const result = await game.runNpcReply(db, null, room.row, room.col); // no model: keyword floor + engine

    assert.ok(result.helped, 'the cleric acted');
    assert.equal(result.helped.action, 'revive');
    const after = await db.prepare("SELECT incapacitated, stance FROM users WHERE username = 'pilgrim'").first();
    assert.equal(after.incapacitated, 0, 'raised from the brink');
    assert.equal(after.stance, 'standing');
  } finally {
    await db.close();
  }
});

test('Plan 013d: a HOSTILE cleric does not heal you, no matter how nicely you ask', async () => {
  const db = await createMigratedDb();
  const game = await import('../worker/game.mjs');
  try {
    const room = findCalmRoom(getWorldDay());
    await addHuman(db, game, 'pilgrim', room.row, room.col);
    await addCleric(db, game, 'soc_healer_2', 'Brother Aldric', 'hostile', room.row, room.col);
    await downThePlayer(db, game, 'ogre', 'pilgrim', room);

    await humanSays(db, 'pilgrim', room.row, room.col, 'please heal me, save me');
    const result = await game.runNpcReply(db, null, room.row, room.col);

    assert.equal(result.helped, null, 'a hostile cleric will not lift a finger');
    const after = await db.prepare("SELECT incapacitated FROM users WHERE username = 'pilgrim'").first();
    assert.equal(after.incapacitated, 1, 'still down');
  } finally {
    await db.close();
  }
});

test('Plan 013d: a friendly NPC cleric TENDS a wounded (not downed) player who asks', async () => {
  const db = await createMigratedDb();
  const game = await import('../worker/game.mjs');
  try {
    const room = findCalmRoom(getWorldDay());
    await addWoundedHuman(db, game, 'scout', room.row, room.col, 10); // 10/30 health
    await addCleric(db, game, 'soc_healer_w', 'Sister Maeve', 'friendly', room.row, room.col);
    await humanSays(db, 'scout', room.row, room.col, 'please heal me, I am hurt');

    const before = (await db.prepare("SELECT health FROM users WHERE username = 'scout'").first()).health;
    const result = await game.runNpcReply(db, null, room.row, room.col);

    assert.ok(result.helped, 'the cleric acted');
    assert.equal(result.helped.action, 'heal');
    const after = await db.prepare("SELECT health, incapacitated FROM users WHERE username = 'scout'").first();
    assert.ok(after.health > before, `wounds tended (${before} -> ${after.health})`);
    assert.equal(after.incapacitated, 0, 'was wounded, never downed');
  } finally {
    await db.close();
  }
});

test('Plan 013d: an upright player asking for help is not revived (nothing to revive)', async () => {
  const db = await createMigratedDb();
  const game = await import('../worker/game.mjs');
  try {
    const room = findCalmRoom(getWorldDay());
    await addHuman(db, game, 'pilgrim', room.row, room.col);
    await addCleric(db, game, 'soc_healer_3', 'Sister Maeve', 'friendly', room.row, room.col);

    await humanSays(db, 'pilgrim', room.row, room.col, 'please help me find the road');
    const result = await game.runNpcReply(db, null, room.row, room.col);

    assert.equal(result.helped, null, 'a healthy asker triggers no revive');
    assert.equal(result.spoke, true, 'but the cleric still answers');
  } finally {
    await db.close();
  }
});
