// Plan 013f: NPCs die for real (no respawn on the next presence heartbeat) and die LIKE
// players — a last broken plea, and the surviving room reacts. CommonJS + node:test.

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

function findPub(game, tick) {
  const wd = getWorldDay();
  for (let r = 1; r <= 16; r += 1) for (let c = 1; c <= 16; c += 1) {
    if (game.roomHasEffect(r, c, tick, 'pub', wd)) return { row: r, col: c };
  }
  return null;
}

async function addHuman(db, game, username, row, col) {
  await db.prepare(
    `INSERT INTO users (username, password, job, health, maxHealth, stamina, maxStamina, speed, strength, intelligence, level)
     VALUES (?, 'pw', 'Fighter', 30, 30, 100, 100, 5, 5, 5, 1)`
  ).bind(username).run();
  await game.updatePresence(db, username, row, col);
}

async function addSocialNpc(db, game, username, displayName, disposition, row, col) {
  await db.prepare(
    `INSERT INTO users (username, password, job, health, maxHealth, stamina, maxStamina, speed, strength, intelligence, level, isNpc, displayName, npcKind, disposition, role, npcWorldDay)
     VALUES (?, 'npc', 'Fighter', 20, 20, 100, 100, 4, 5, 1, 2, 1, ?, 'social', ?, 'patron', ?)`
  ).bind(username, displayName, disposition, getWorldDay()).run();
  await game.updatePresence(db, username, row, col);
}

test('Plan 013f: a killed social NPC stays dead — not respawned on the next heartbeat', async () => {
  const db = await createMigratedDb();
  const game = await import('../worker/game.mjs');
  try {
    const tick = await game.getCurrentTickValue(db);
    const pub = findPub(game, tick);
    assert.ok(pub, 'need an active pub room');
    await addHuman(db, game, 'slayer', pub.row, pub.col);

    const first = await game.ensureSocialPopulation(db, pub.row, pub.col);
    assert.ok(first.spawned >= 3, 'cast spawned');
    const victimName = `soc:${getWorldDay()}:${pub.row}:${pub.col}:bartender:0`;
    const victim = await db.prepare('SELECT * FROM users WHERE username = ?').bind(victimName).first();
    assert.ok(victim, 'the bartender slot exists');

    await game.defeatNpc(db, victim, { killer: 'slayer', row: pub.row, col: pub.col, currentTick: tick });
    assert.equal(await db.prepare('SELECT username FROM users WHERE username = ?').bind(victimName).first(), null, 'bartender is dead');

    // Re-running the populator (the heartbeat) must NOT bring them back.
    const second = await game.ensureSocialPopulation(db, pub.row, pub.col);
    const reborn = await db.prepare('SELECT username FROM users WHERE username = ?').bind(victimName).first();
    assert.equal(reborn, null, 'the slain bartender is NOT resurrected');
    assert.ok(!String(second.spawned).includes('NaN'));
  } finally {
    await db.close();
  }
});

test('Plan 013f: a dying NPC begs, and a surviving bystander reacts in horror', async () => {
  const db = await createMigratedDb();
  const game = await import('../worker/game.mjs');
  try {
    const room = findCalmRoom(getWorldDay());
    await addHuman(db, game, 'killer', room.row, room.col);
    await addSocialNpc(db, game, 'soc:victim', 'Mara', 'friendly', room.row, room.col);
    await addSocialNpc(db, game, 'soc:witness', 'Joss', 'friendly', room.row, room.col);

    // Plan 013g: NPCs go through the band like players. A killing blow DOWNS Mara — she
    // gasps a plea (incapacitation), not an instant death.
    await game.descendTowardDeath(db, 'soc:victim', { cause: 'attack by killer', row: room.row, col: room.col, blowDamage: 6, overkill: 2, currentTick: 1 });
    const throes = await db.prepare("SELECT message FROM messages WHERE message LIKE 'Mara falls, gasping:%' LIMIT 1").first();
    assert.ok(throes, 'the downed NPC gasped a plea');
    const down = await db.prepare("SELECT incapacitated FROM users WHERE username = 'soc:victim'").first();
    assert.equal(down.incapacitated, 1, 'Mara is downed, not yet dead');

    // A finishing blow ends her (true death -> defeatNpc), and the surviving witness reacts.
    await game.descendTowardDeath(db, 'soc:victim', { cause: 'attack by killer', row: room.row, col: room.col, blowDamage: 20, overkill: 20, currentTick: 2 });
    assert.equal(await db.prepare("SELECT username FROM users WHERE username = 'soc:victim'").first(), null, 'Mara is truly dead');
    const reaction = await db.prepare("SELECT message FROM messages WHERE message LIKE 'Joss:%' ORDER BY id DESC LIMIT 1").first();
    assert.ok(reaction, 'a bystander reacted to the death');
  } finally {
    await db.close();
  }
});

test('Plan 013g: a killing blow DOWNS an NPC (not instant death); a finisher ends it with loot', async () => {
  const db = await createMigratedDb();
  const game = await import('../worker/game.mjs');
  try {
    const room = findCalmRoom(getWorldDay());
    await addHuman(db, game, 'slayer', room.row, room.col);
    await addSocialNpc(db, game, 'soc:thug', 'Grix', 'hostile', room.row, room.col);

    // Modest blow (overkill under the gib threshold) -> DOWNED, not dead.
    await game.descendTowardDeath(db, 'soc:thug', { cause: 'attack by slayer', row: room.row, col: room.col, blowDamage: 6, overkill: 2, currentTick: 1 });
    const downed = await db.prepare("SELECT incapacitated, health FROM users WHERE username = 'soc:thug'").first();
    assert.ok(downed, 'still present — downed, not deleted');
    assert.equal(downed.incapacitated, 1);
    assert.equal(downed.health, 0);
    const lootBefore = await db.prepare("SELECT COUNT(*) AS n FROM items WHERE name = 'Monster Remains'").first();
    assert.equal(lootBefore.n, 0, 'no remains while still clinging on');

    // A finishing gib ends them via defeatNpc — loot/remains drop now.
    await game.descendTowardDeath(db, 'soc:thug', { cause: 'attack by slayer', row: room.row, col: room.col, blowDamage: 20, overkill: 20, currentTick: 2 });
    assert.equal(await db.prepare("SELECT username FROM users WHERE username = 'soc:thug'").first(), null, 'truly dead');
    const remains = await db.prepare("SELECT COUNT(*) AS n FROM items WHERE name = 'Monster Remains'").first();
    assert.ok(remains.n >= 1, 'defeatNpc dropped remains on true death');
  } finally {
    await db.close();
  }
});

test('Plan 013g: a downed NPC bleeds out on the tick and then truly dies (defeatNpc)', async () => {
  const db = await createMigratedDb();
  const game = await import('../worker/game.mjs');
  try {
    const room = findCalmRoom(getWorldDay());
    await addHuman(db, game, 'witness', room.row, room.col);
    await addSocialNpc(db, game, 'soc:bleeder', 'Mara', 'hostile', room.row, room.col);
    await game.descendTowardDeath(db, 'soc:bleeder', { cause: 'attack by witness', row: room.row, col: room.col, blowDamage: 6, overkill: 2, currentTick: 1 });
    assert.equal((await db.prepare("SELECT incapacitated FROM users WHERE username = 'soc:bleeder'").first()).incapacitated, 1);

    // The downed NPC bleeds out on the world tick (0 -> -30 at -1/tick), then defeatNpc.
    for (let i = 0; i < 31; i += 1) {
      await game.processIncapacitationBleed(db, 2 + i);
    }
    assert.equal(await db.prepare("SELECT username FROM users WHERE username = 'soc:bleeder'").first(), null, 'bled out to true death');
  } finally {
    await db.close();
  }
});

test('Plan 013g: an NPC that kills a player is credited in the graveyard (kill attribution)', async () => {
  const db = await createMigratedDb();
  const game = await import('../worker/game.mjs');
  try {
    const room = findCalmRoom(getWorldDay());
    await addHuman(db, game, 'victim', room.row, room.col);
    await game.getUserState(db, 'victim');

    // Bren (an NPC) downs then finishes the player; the cause carries Bren's display name.
    await game.descendTowardDeath(db, 'victim', { cause: 'attack by Bren', row: room.row, col: room.col, blowDamage: 6, overkill: 2, currentTick: 1 });
    await game.descendTowardDeath(db, 'victim', { cause: 'attack by Bren', row: room.row, col: room.col, blowDamage: 20, overkill: 20, currentTick: 2 });

    assert.equal(await db.prepare("SELECT username FROM users WHERE username = 'victim'").first(), null, 'the player is dead');
    const kill = await db.prepare("SELECT killerUsername, defeatedKind FROM killHistory WHERE defeatedUsername = 'victim'").first();
    assert.ok(kill, 'the kill was recorded');
    assert.equal(kill.killerUsername, 'Bren', 'the NPC slayer is credited (graveyard shows it)');
    assert.equal(kill.defeatedKind, 'player');
  } finally {
    await db.close();
  }
});

test('Plan 013f: when the room had turned hostile on a player, survivors GLOAT over their death', async () => {
  const db = await createMigratedDb();
  const game = await import('../worker/game.mjs');
  try {
    const room = findCalmRoom(getWorldDay());
    await addHuman(db, game, 'criminal', room.row, room.col);
    await addSocialNpc(db, game, 'soc:guard', 'Bren', 'hostile', room.row, room.col); // the room turned on them
    await game.getUserState(db, 'criminal');

    await game.moveUserToCemetery(db, 'criminal', 'attack by Bren', room.row, room.col);

    const reaction = await db.prepare("SELECT message FROM messages WHERE message LIKE 'Bren:%' ORDER BY id DESC LIMIT 1").first();
    assert.ok(reaction, 'the hostile survivor passed judgment on the slain player');
    assert.match(reaction.message, /Justice|coming|troublemaker|lesson/i, 'it is a gloat, not horror');
  } finally {
    await db.close();
  }
});
