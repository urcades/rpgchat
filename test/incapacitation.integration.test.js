// Plan 023b: "Bleeding Out". A killing blow no longer entombs a player — it downs
// them (incapacitated: prone, looted, mute but for garbled speech), and a death clock
// bleeds them out from 0 toward -30 on the world pulse. These tests pin the third
// state, its gating, the passive bleed, and the heal-back-up. CommonJS + node:test.

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

async function seedUser(db, username, opts = {}) {
  const { job = 'Novice', health = 30, speed = 1, strength = 1 } = opts;
  await db.prepare(
    `INSERT INTO users (username, password, job, health, maxHealth, stamina, maxStamina, speed, strength, intelligence, level, gold)
     VALUES (?, 'pw', ?, ?, 30, 100, 100, ?, ?, 1, 1, 0)`
  ).bind(username, job, health, speed, strength).run();
}

async function withForcedHit(fn) {
  const realRandom = Math.random;
  Math.random = () => 0; // low roll => attacker wins the speed contest, no crit branch flake
  try { return await fn(); } finally { Math.random = realRandom; }
}

// A modest attacker vs. a low-HP target: lethal, but overkill stays well under the gib
// threshold, so the blow DOWNS rather than dismembers.
async function downOneVictim(db, attacker, victim, room) {
  const { handleAttack, updatePresence, getUserState } = await import('../worker/game.mjs');
  await seedUser(db, attacker, { job: 'Fighter', strength: 12, speed: 20 });
  await seedUser(db, victim, { health: 3, speed: 1 });
  await updatePresence(db, attacker, room.row, room.col);
  await updatePresence(db, victim, room.row, room.col);
  await getUserState(db, victim); // instantiate body
  await withForcedHit(() => handleAttack(db, attacker, `@${victim}`, room.row, room.col));
}

test('Plan 023b: a killing blow downs the victim — incapacitated, prone, looted, no corpse yet', async () => {
  const db = await createMigratedDb();
  try {
    const room = findCalmRoom(getWorldDay());
    // Give the victim a carried item so we can prove loot scatters at the moment of downing.
    const { updatePresence, getUserState, handleAttack } = await import('../worker/game.mjs');
    await seedUser(db, 'brute', { job: 'Fighter', strength: 12, speed: 20 });
    await seedUser(db, 'wretch', { health: 3, speed: 1 });
    await db.prepare("INSERT INTO items (templateId, name, slotType, rarity, modifiers, ownerUsername) VALUES ('rusty_knife', 'Rusty Knife', 'hand', 'common', '{}', 'wretch')").run();
    await updatePresence(db, 'brute', room.row, room.col);
    await updatePresence(db, 'wretch', room.row, room.col);
    await getUserState(db, 'wretch');

    await withForcedHit(() => handleAttack(db, 'brute', '@wretch', room.row, room.col));

    const victim = await db.prepare("SELECT incapacitated, deathClock, health, stance FROM users WHERE username = 'wretch'").first();
    assert.ok(victim, 'the victim is NOT deleted — they are down, not dead');
    assert.equal(victim.incapacitated, 1);
    assert.equal(victim.deathClock, 0, 'the clock starts at 0');
    assert.equal(victim.health, 0, 'the body gives out to 0');
    assert.equal(victim.stance, 'prone');

    const corpse = await db.prepare("SELECT id FROM items WHERE corpseOf = 'wretch'").first();
    assert.equal(corpse, null, 'no corpse while they still cling to life');

    const loot = await db.prepare("SELECT ownerUsername, roomRow FROM items WHERE name = 'Rusty Knife'").first();
    assert.equal(loot.ownerUsername, null, 'their gear spills to the floor as they fall');
    assert.equal(loot.roomRow, room.row);
  } finally {
    await db.close();
  }
});

test('Plan 023b: the incapacitated can only whisper — every action verb is refused', async () => {
  const db = await createMigratedDb();
  try {
    const room = findCalmRoom(getWorldDay());
    await downOneVictim(db, 'killer', 'downed', room);
    const { handleAttackAction, handleCastAction, handleChatAction, validateMovement } = await import('../worker/game.mjs');

    await assert.rejects(() => handleAttackAction(db, 'downed', room.row, room.col, '@killer'), /incapacitated/i);
    await assert.rejects(() => handleCastAction(db, 'downed', room.row, room.col, '/cast flee now @killer'), /incapacitated/i);
    await assert.rejects(() => handleChatAction(db, 'downed', room.row, room.col, '/use Healing Draught'), /incapacitated/i);

    // Movement: staying put (the presence heartbeat) is allowed; crawling away is not.
    const stay = await validateMovement(db, 'downed', room.row, room.col);
    assert.equal(stay.allowed, true, 'a downed body may keep its place');
    const crawl = await validateMovement(db, 'downed', room.row, room.col + 1);
    assert.equal(crawl.allowed, false);
    assert.equal(crawl.incapacitated, true);

    // Plain speech still goes through.
    const spoke = await handleChatAction(db, 'downed', room.row, room.col, 'please... help me');
    assert.ok(spoke && !spoke.error, 'the downed can still speak');
  } finally {
    await db.close();
  }
});

test('Plan 023b: the passive bleed drives the clock to the floor, then true death attributes the kill', async () => {
  const db = await createMigratedDb();
  try {
    const room = findCalmRoom(getWorldDay());
    await downOneVictim(db, 'slayer', 'fading', room);
    const { processIncapacitationBleed } = await import('../worker/game.mjs');

    // One pulse: clock -3, still alive.
    await processIncapacitationBleed(db, 1);
    const afterOne = await db.prepare("SELECT incapacitated, deathClock FROM users WHERE username = 'fading'").first();
    assert.equal(afterOne.deathClock, -3);
    assert.equal(afterOne.incapacitated, 1);

    // Bleed the rest of the way out (0 -> -30 at -3/pulse => 10 pulses total).
    for (let i = 0; i < 10; i += 1) {
      await processIncapacitationBleed(db, 2 + i);
    }

    const gone = await db.prepare("SELECT username FROM users WHERE username = 'fading'").first();
    assert.equal(gone, null, 'bled out — the user row is finally removed');
    const grave = await db.prepare("SELECT cause FROM cemetery WHERE username = 'fading'").first();
    assert.match(grave.cause, /bled out after attack by slayer/);
    const corpse = await db.prepare("SELECT id FROM items WHERE corpseOf = 'fading'").first();
    assert.ok(corpse, 'true death drops the corpse anchor');
    const kill = await db.prepare("SELECT killerUsername FROM killHistory WHERE defeatedUsername = 'fading'").first();
    assert.equal(kill.killerUsername, 'slayer', 'the kill is attributed to whoever downed them');
  } finally {
    await db.close();
  }
});

test('Plan 023b: healing a downed player above 0 stands them back up', async () => {
  const db = await createMigratedDb();
  try {
    const room = findCalmRoom(getWorldDay());
    await downOneVictim(db, 'aggressor', 'rescued', room);
    const { applyBodyHeal } = await import('../worker/game.mjs');

    const downed = await db.prepare("SELECT incapacitated FROM users WHERE username = 'rescued'").first();
    assert.equal(downed.incapacitated, 1);

    const user = await db.prepare("SELECT * FROM users WHERE username = 'rescued'").first();
    await applyBodyHeal(db, user, 20, { row: room.row, col: room.col });

    const up = await db.prepare("SELECT incapacitated, deathClock, stance, health FROM users WHERE username = 'rescued'").first();
    assert.equal(up.incapacitated, 0, 'back among the living');
    assert.equal(up.deathClock, 0);
    assert.equal(up.stance, 'standing');
    assert.ok(up.health > 0, 'health restored above 0');
  } finally {
    await db.close();
  }
});
