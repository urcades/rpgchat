// Plan 013a: runNpcReply — an NPC answers a human in-room. The model is injected (stub),
// so this exercises the real selection/cooldown/insert wiring without Workers AI. Also
// pins that getMessages surfaces NPC displayName. CommonJS + node:test.

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

const STUB_AI = { run: async () => ({ response: '{"speech":"Keep it civil in here.","intent":"wary","request":"none"}' }) };

async function seedHuman(db, username, row, col) {
  const { updatePresence } = await import('../worker/game.mjs');
  await db.prepare(
    `INSERT INTO users (username, password, job, health, maxHealth, stamina, maxStamina, speed, strength, intelligence, level)
     VALUES (?, 'pw', 'Fighter', 30, 30, 100, 100, 5, 5, 5, 1)`
  ).bind(username).run();
  await updatePresence(db, username, row, col);
}

async function seedNpc(db, username, displayName, row, col) {
  const { updatePresence } = await import('../worker/game.mjs');
  await db.prepare(
    `INSERT INTO users (username, password, job, health, maxHealth, stamina, maxStamina, speed, strength, intelligence, level, isNpc, displayName, npcKind)
     VALUES (?, 'pw', 'Fighter', 20, 20, 100, 100, 5, 5, 1, 2, 1, ?, 'lesser_hostile')`
  ).bind(username, displayName).run();
  await updatePresence(db, username, row, col);
}

async function seedSocialNpc(db, username, displayName, row, col) {
  const { updatePresence } = await import('../worker/game.mjs');
  await db.prepare(
    `INSERT INTO users (username, password, job, health, maxHealth, stamina, maxStamina, speed, strength, intelligence, level, isNpc, displayName, npcKind, disposition, role, npcWorldDay)
     VALUES (?, 'npc', 'Novice', 20, 20, 100, 100, 4, 5, 1, 1, 1, ?, 'social', 'friendly', 'patron', ?)`
  ).bind(username, displayName, getWorldDay()).run();
  await updatePresence(db, username, row, col);
}

async function humanSays(db, username, row, col, message) {
  await db.prepare('INSERT INTO messages (roomRow, roomCol, username, message, kind) VALUES (?, ?, ?, ?, ?)').bind(row, col, username, message, 'chat').run();
}

test('Plan 013a: an NPC answers a human and the line is stored as kind=npc by the NPC', async () => {
  const db = await createMigratedDb();
  const { runNpcReply, getMessages } = await import('../worker/game.mjs');
  try {
    const room = findCalmRoom(getWorldDay());
    await seedHuman(db, 'wanderer', room.row, room.col);
    await seedNpc(db, 'npc_grix_1', 'Grix', room.row, room.col);
    await humanSays(db, 'wanderer', room.row, room.col, 'oi Grix, pour me one');

    const result = await runNpcReply(db, STUB_AI, room.row, room.col);
    assert.equal(result.spoke, true);
    assert.equal(result.npc, 'npc_grix_1');

    const messages = await getMessages(db, room.row, room.col);
    const last = messages[messages.length - 1];
    assert.equal(last.username, 'npc_grix_1');
    assert.equal(last.kind, 'npc');
    assert.equal(last.message, 'Keep it civil in here.');
    assert.equal(last.displayName, 'Grix', 'getMessages surfaces the NPC display name for rendering');
  } finally {
    await db.close();
  }
});

test('Plan 013a: no human present => the NPC stays silent (alive only when observed)', async () => {
  const db = await createMigratedDb();
  const { runNpcReply } = await import('../worker/game.mjs');
  try {
    const room = findCalmRoom(getWorldDay());
    await seedNpc(db, 'npc_grix_2', 'Grix', room.row, room.col);
    await humanSays(db, 'ghost', room.row, room.col, 'anyone there?'); // a line, but no live human present
    const result = await runNpcReply(db, STUB_AI, room.row, room.col);
    assert.equal(result.spoke, false);
  } finally {
    await db.close();
  }
});

test('Plan 013a: the per-room cooldown prevents an immediate second reply', async () => {
  const db = await createMigratedDb();
  const { runNpcReply } = await import('../worker/game.mjs');
  try {
    const room = findCalmRoom(getWorldDay());
    await seedHuman(db, 'wanderer', room.row, room.col);
    await seedNpc(db, 'npc_grix_3', 'Grix', room.row, room.col);
    await humanSays(db, 'wanderer', room.row, room.col, 'hello Grix');

    const first = await runNpcReply(db, STUB_AI, room.row, room.col);
    assert.equal(first.spoke, true);
    // The NPC's own line is now last, and the cooldown is set — a second call is silent.
    const second = await runNpcReply(db, STUB_AI, room.row, room.col);
    assert.equal(second.spoke, false);
  } finally {
    await db.close();
  }
});

test('Plan 013f: proactive ambient chatter — a present human gets murmurs, an empty room gets silence', async () => {
  const db = await createMigratedDb();
  const { runNpcAmbient, getMessages } = await import('../worker/game.mjs');
  try {
    const room = findCalmRoom(getWorldDay());
    await seedSocialNpc(db, 'soc_amb_1', 'Sil', room.row, room.col);

    // No human present -> no ambient spend ("alive only when observed").
    const silent = await runNpcAmbient(db, STUB_AI, room.row, room.col);
    assert.equal(silent.spoke, false);

    await seedHuman(db, 'onlooker', room.row, room.col);
    const spoke = await runNpcAmbient(db, STUB_AI, room.row, room.col);
    assert.equal(spoke.spoke, true, 'with a human watching, an NPC murmurs unprompted');
    const last = (await getMessages(db, room.row, room.col)).slice(-1)[0];
    assert.equal(last.username, 'soc_amb_1');
    assert.equal(last.kind, 'npc');

    // Throttled: an immediate second tick stays quiet.
    const second = await runNpcAmbient(db, STUB_AI, room.row, room.col);
    assert.equal(second.spoke, false, 'ambient chatter is throttled per room');
  } finally {
    await db.close();
  }
});

test('Plan 013a: with no binding (null ai) the NPC still answers with a canned line', async () => {
  const db = await createMigratedDb();
  const { runNpcReply, getMessages } = await import('../worker/game.mjs');
  try {
    const room = findCalmRoom(getWorldDay());
    await seedHuman(db, 'wanderer', room.row, room.col);
    await seedNpc(db, 'npc_grix_4', 'Grix', room.row, room.col);
    await humanSays(db, 'wanderer', room.row, room.col, 'Grix!');

    const result = await runNpcReply(db, null, room.row, room.col);
    assert.equal(result.spoke, true, 'fallback-first: a missing binding still yields a line');
    const messages = await getMessages(db, room.row, room.col);
    assert.equal(messages[messages.length - 1].kind, 'npc');
  } finally {
    await db.close();
  }
});
