// Plan 013c: disposition & aggro. Aggression — an attack, or hostile speech (model
// intent, or a keyword floor when the model is absent) — turns the room's friendly NPCs
// hostile, all at once. CommonJS + node:test, in-memory sqlite3 D1 shim, injected ai.

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
}

async function addSocialNpc(db, game, username, displayName, disposition, role, row, col) {
  await db.prepare(
    `INSERT INTO users (username, password, job, health, maxHealth, stamina, maxStamina, speed, strength, intelligence, level, isNpc, displayName, npcKind, disposition, role, npcWorldDay)
     VALUES (?, 'npc', 'Fighter', 20, 20, 100, 100, 4, 5, 1, 2, 1, ?, 'social', ?, ?, ?)`
  ).bind(username, displayName, disposition, role, getWorldDay()).run();
  await game.updatePresence(db, username, row, col);
}

async function humanSays(db, username, row, col, message) {
  await db.prepare('INSERT INTO messages (roomRow, roomCol, username, message, kind) VALUES (?, ?, ?, ?, ?)').bind(row, col, username, message, 'chat').run();
}

async function withForcedHit(fn) {
  const real = Math.random;
  Math.random = () => 0; // low roll => attacker wins the speed contest
  try { return await fn(); } finally { Math.random = real; }
}

test('Plan 013c: provoking the room flips every friendly NPC hostile, and combat wakes', async () => {
  const db = await createMigratedDb();
  const game = await import('../worker/game.mjs');
  try {
    const room = findCalmRoom(getWorldDay());
    await addHuman(db, game, 'brawler', room.row, room.col);
    await addSocialNpc(db, game, 'soc_bar_1', 'Sil', 'friendly', 'barmaid', room.row, room.col);
    await addSocialNpc(db, game, 'soc_guard_1', 'Bren', 'neutral', 'guard', room.row, room.col);

    assert.equal(await game.roomHasActiveHostiles(db, room.row, room.col), false, 'a friendly room is not a combat room');

    const result = await game.provokeRoomNpcs(db, room.row, room.col);
    assert.equal(result.provoked, 2, 'both social NPCs turn');

    const dispositions = await db.prepare("SELECT disposition FROM users WHERE npcKind = 'social'").all();
    assert.ok(dispositions.results.every(r => r.disposition === 'hostile'), 'the whole cast is now hostile');
    assert.equal(await game.roomHasActiveHostiles(db, room.row, room.col), true, 'combat is now live');
  } finally {
    await db.close();
  }
});

test('Plan 013c: classifyHostileText flags overt aggression, ignores pleasantries', async () => {
  const game = await import('../worker/game.mjs');
  assert.equal(game.classifyHostileText("I'll gut you where you stand"), true);
  assert.equal(game.classifyHostileText('attack the bartender'), true);
  assert.equal(game.classifyHostileText('lovely night, another ale please'), false);
});

test('Plan 013c: a model-classified hostile reply turns the room (even on civil-looking words)', async () => {
  const db = await createMigratedDb();
  const game = await import('../worker/game.mjs');
  try {
    const room = findCalmRoom(getWorldDay());
    await addHuman(db, game, 'smoothtalker', room.row, room.col);
    await addSocialNpc(db, game, 'soc_bar_2', 'Mara', 'friendly', 'barmaid', room.row, room.col);
    await humanSays(db, 'smoothtalker', room.row, room.col, 'hey gorgeous, come sit on my lap');

    const hostileAi = { run: async () => ({ response: '{"speech":"Hands off.","intent":"hostile","request":"none"}' }) };
    const result = await game.runNpcReply(db, hostileAi, room.row, room.col);
    assert.equal(result.spoke, true);
    assert.ok(result.provoked >= 1, 'the model flagged hostility and the room turned');
    const mara = await db.prepare("SELECT disposition FROM users WHERE username = 'soc_bar_2'").first();
    assert.equal(mara.disposition, 'hostile');
  } finally {
    await db.close();
  }
});

test('Plan 013c: a friendly exchange does NOT provoke', async () => {
  const db = await createMigratedDb();
  const game = await import('../worker/game.mjs');
  try {
    const room = findCalmRoom(getWorldDay());
    await addHuman(db, game, 'gent', room.row, room.col);
    await addSocialNpc(db, game, 'soc_bar_3', 'Joss', 'friendly', 'barmaid', room.row, room.col);
    await humanSays(db, 'gent', room.row, room.col, 'thank you, what a lovely evening');

    const friendlyAi = { run: async () => ({ response: '{"speech":"Aye, it is.","intent":"friendly","request":"none"}' }) };
    const result = await game.runNpcReply(db, friendlyAi, room.row, room.col);
    assert.equal(result.spoke, true);
    assert.equal(result.provoked, 0, 'no aggression, no flip');
    const joss = await db.prepare("SELECT disposition FROM users WHERE username = 'soc_bar_3'").first();
    assert.equal(joss.disposition, 'friendly');
  } finally {
    await db.close();
  }
});

test('Plan 013c (fixed): a threat provokes even while NPC dialogue is on cooldown', async () => {
  const db = await createMigratedDb();
  const game = await import('../worker/game.mjs');
  try {
    const room = findCalmRoom(getWorldDay());
    await addHuman(db, game, 'menace', room.row, room.col);
    await addSocialNpc(db, game, 'soc_bar_cd', 'Mara', 'friendly', 'barmaid', room.row, room.col);
    // Put NPC dialogue on cooldown right now (an NPC "just spoke").
    const tick = await game.getCurrentTickValue(db);
    await db.prepare(
      "INSERT INTO roomEffectCooldowns (username, roomRow, roomCol, effectType, lastAppliedTick, worldDay) VALUES ('__npc_voice', ?, ?, 'npc_voice', ?, ?)"
    ).bind(room.row, room.col, tick, getWorldDay()).run();

    await humanSays(db, 'menace', room.row, room.col, 'I will gut you all');
    const result = await game.runNpcReply(db, null, room.row, room.col);

    assert.equal(result.spoke, false, 'on cooldown, no spoken reply');
    assert.ok(result.provoked >= 1, 'but the threat still turned the room (provoke decoupled from cooldown)');
    const mara = await db.prepare("SELECT disposition FROM users WHERE username = 'soc_bar_cd'").first();
    assert.equal(mara.disposition, 'hostile');
  } finally {
    await db.close();
  }
});

test('Plan 013e: a social NPC is attackable by DISPLAY NAME (its username is an unmentionable id)', async () => {
  const db = await createMigratedDb();
  const game = await import('../worker/game.mjs');
  try {
    const room = findCalmRoom(getWorldDay());
    await addHuman(db, game, 'brawler', room.row, room.col);
    // Username has colons (like a real social NPC) — unmentionable; only the display name works.
    await addSocialNpc(db, game, 'soc:2099:1:1:barmaid:0', 'Mara', 'friendly', 'barmaid', room.row, room.col);

    const result = await withForcedHit(() => game.handleAttack(db, 'brawler', 'attack Mara', room.row, room.col));

    // The combat log must read by display name, never the opaque soc:... username.
    assert.match(result, /attacked Mara|critical hit on Mara/, 'combat line uses the display name');
    assert.ok(!result.includes('soc:2099'), 'the internal username never leaks into the log');

    const mara = await db.prepare("SELECT disposition, health FROM users WHERE username = 'soc:2099:1:1:barmaid:0'").first();
    assert.equal(mara.disposition, 'hostile', 'striking her by name turned her hostile');
    assert.ok(mara.health < 20, `she took the blow (${mara.health})`);
    const snarl = await db.prepare("SELECT message FROM messages WHERE message LIKE '%snarls:%' ORDER BY id DESC LIMIT 1").first();
    assert.ok(snarl, 'an enmity bark was emitted on provocation');
  } finally {
    await db.close();
  }
});

test('Plan 013e: a player can attack themselves (@self)', async () => {
  const db = await createMigratedDb();
  const game = await import('../worker/game.mjs');
  try {
    const room = findCalmRoom(getWorldDay());
    await addHuman(db, game, 'masochist', room.row, room.col);
    await game.getUserState(db, 'masochist'); // instantiate body
    const before = (await db.prepare("SELECT health FROM users WHERE username = 'masochist'").first()).health;

    await withForcedHit(() => game.handleAttack(db, 'masochist', '@self', room.row, room.col));

    const after = (await db.prepare("SELECT health FROM users WHERE username = 'masochist'").first()).health;
    assert.ok(after < before, `self-harm dealt damage (${before} -> ${after})`);
  } finally {
    await db.close();
  }
});

test('Plan 013e: a downed (incapacitated) player keeps the hostile room active', async () => {
  const db = await createMigratedDb();
  const game = await import('../worker/game.mjs');
  try {
    const room = findCalmRoom(getWorldDay());
    await addSocialNpc(db, game, 'soc:2099:1:1:guard:0', 'Bren', 'hostile', 'guard', room.row, room.col);
    await addHuman(db, game, 'victim', room.row, room.col);
    await game.getUserState(db, 'victim');
    await game.descendTowardDeath(db, 'victim', { cause: 'attack by Bren', row: room.row, col: room.col, blowDamage: 6, overkill: 2, currentTick: 1 });

    const downed = await db.prepare("SELECT incapacitated, health FROM users WHERE username = 'victim'").first();
    assert.equal(downed.incapacitated, 1);
    assert.equal(downed.health, 0);
    assert.equal(await game.roomHasActiveHostiles(db, room.row, room.col), true, 'the mob keeps at the downed player');
  } finally {
    await db.close();
  }
});

test('Plan 013c: with no model, a threatening line still provokes via the keyword floor', async () => {
  const db = await createMigratedDb();
  const game = await import('../worker/game.mjs');
  try {
    const room = findCalmRoom(getWorldDay());
    await addHuman(db, game, 'thug', room.row, room.col);
    await addSocialNpc(db, game, 'soc_bar_4', 'Pell', 'neutral', 'bartender', room.row, room.col);
    await humanSays(db, 'thug', room.row, room.col, 'give me the coin or I will gut you');

    const result = await game.runNpcReply(db, null, room.row, room.col); // no binding
    assert.equal(result.spoke, true, 'fallback line still spoken');
    assert.ok(result.provoked >= 1, 'keyword floor provoked without a model');
  } finally {
    await db.close();
  }
});
