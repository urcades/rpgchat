const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const sqlite3 = require('sqlite3').verbose();

function createSqliteD1() {
  const raw = new sqlite3.Database(':memory:');
  return {
    raw,
    exec(sql) {
      return new Promise((resolve, reject) => {
        raw.exec(sql, err => (err ? reject(err) : resolve()));
      });
    },
    close() {
      return new Promise((resolve, reject) => {
        raw.close(err => (err ? reject(err) : resolve()));
      });
    },
    prepare(sql) {
      const statement = {
        params: [],
        bind(...params) {
          this.params = params;
          return this;
        },
        first() {
          return new Promise((resolve, reject) => {
            raw.get(sql, this.params, (err, row) => (err ? reject(err) : resolve(row || null)));
          });
        },
        all() {
          return new Promise((resolve, reject) => {
            raw.all(sql, this.params, (err, rows) => (err ? reject(err) : resolve({ results: rows })));
          });
        },
        run() {
          return new Promise((resolve, reject) => {
            raw.run(sql, this.params, function onRun(err) {
              if (err) {
                reject(err);
                return;
              }
              resolve({
                meta: {
                  changes: this.changes,
                  last_row_id: this.lastID
                }
              });
            });
          });
        }
      };
      return statement;
    }
  };
}

async function createMigratedDb() {
  const db = createSqliteD1();
  const migrationsDir = path.join(__dirname, '../migrations');
  const migrations = fs.readdirSync(migrationsDir)
    .filter(file => file.endsWith('.sql'))
    .sort();
  for (const migrationFile of migrations) {
    const migration = fs.readFileSync(path.join(migrationsDir, migrationFile), 'utf8');
    await db.exec(migration);
  }
  return db;
}

async function withMockedRandom(values, callback) {
  const originalRandom = Math.random;
  let index = 0;
  Math.random = () => {
    const value = values[Math.min(index, values.length - 1)];
    index += 1;
    return value;
  };

  try {
    return await callback();
  } finally {
    Math.random = originalRandom;
  }
}

test('Speed hit chance uses a clamped contested curve', async () => {
  const { calculateSpeedHitChance } = await import('../worker/game.mjs');

  assert.equal(calculateSpeedHitChance({ speed: 3 }, { speed: 3 }), 0.7);
  assert.equal(calculateSpeedHitChance({ speed: 5 }, { speed: 3 }), 0.8);
  assert.equal(calculateSpeedHitChance({ speed: 3 }, { speed: 5 }), 0.6);
  assert.equal(calculateSpeedHitChance({ speed: 20 }, { speed: 1 }), 0.95);
  assert.equal(calculateSpeedHitChance({ speed: 1 }, { speed: 20 }), 0.25);
});

test('Worker D1 migration creates a fresh normalized world schema', async () => {
  const db = await createMigratedDb();
  try {
    const tick = await db.prepare('SELECT value FROM tick WHERE id = 1').first();
    const system = await db.prepare("SELECT username, job FROM users WHERE username = 'System'").first();
    const messageTable = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'messages'").first();
    const oldRoomTable = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'messages_1_1'").first();

    assert.equal(tick.value, 0);
    assert.deepEqual(system, { username: 'System', job: 'Novice' });
    assert.equal(messageTable.name, 'messages');
    assert.equal(oldRoomTable, null);
  } finally {
    await db.close();
  }
});

test('Worker room ecology includes active players present in the room', async () => {
  const db = await createMigratedDb();
  const { getRoomEcology, updatePresence } = await import('../worker/game.mjs');

  try {
    await db.prepare(
      `INSERT INTO users
        (username, password, job, health, maxHealth, stamina, maxStamina, speed, strength, intelligence)
       VALUES
        ('ed', 'pw', 'Novice', 12, 12, 100, 100, 1, 1, 1),
        ('angel', 'pw', 'Novice', 12, 12, 100, 100, 1, 1, 1),
        ('away', 'pw', 'Novice', 12, 12, 100, 100, 1, 1, 1)`
    ).run();

    await updatePresence(db, 'ed', 1, 1);
    await updatePresence(db, 'angel', 1, 1);
    await updatePresence(db, 'away', 2, 1);

    const ecology = await getRoomEcology(db, 'ed', 1, 1);

    assert.deepEqual(ecology.presence.map(player => player.username), ['angel', 'ed']);
  } finally {
    await db.close();
  }
});

test('Worker world event migration adds XP, NPC, event, entity, and achievement storage', async () => {
  const db = await createMigratedDb();
  try {
    const userColumns = await db.prepare('PRAGMA table_info(users)').all();
    const columnNames = userColumns.results.map(column => column.name);
    const worldEvents = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'worldEvents'").first();
    const worldEventEntities = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'worldEventEntities'").first();
    const worldEventAchievements = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'worldEventAchievements'").first();
    const killHistory = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'killHistory'").first();

    assert.ok(columnNames.includes('experience'));
    assert.ok(columnNames.includes('isNpc'));
    assert.ok(columnNames.includes('displayName'));
    assert.ok(columnNames.includes('npcKind'));
    assert.ok(columnNames.includes('worldEventId'));
    assert.equal(worldEvents.name, 'worldEvents');
    assert.equal(worldEventEntities.name, 'worldEventEntities');
    assert.equal(worldEventAchievements.name, 'worldEventAchievements');
    assert.equal(killHistory.name, 'killHistory');
  } finally {
    await db.close();
  }
});

test('Scheduled world pulse advances one tick and runs five-minute environmental work only on fifth ticks', async () => {
  const db = await createMigratedDb();
  const { getCurrentTickValue, runScheduledWorldPulse } = await import('../worker/game.mjs');

  try {
    const first = await runScheduledWorldPulse(db);
    assert.equal(first.tick.tick, 1);
    assert.equal(first.environmental, false);
    assert.equal(await getCurrentTickValue(db), 1);

    await runScheduledWorldPulse(db);
    await runScheduledWorldPulse(db);
    await runScheduledWorldPulse(db);
    const fifth = await runScheduledWorldPulse(db);

    assert.equal(fifth.tick.tick, 5);
    assert.equal(fifth.environmental, true);
    assert.equal(await getCurrentTickValue(db), 5);
  } finally {
    await db.close();
  }
});

test('Daily world event seeding backfills missing hostile rooms for an existing world day', async () => {
  const db = await createMigratedDb();
  const { ensureDailyWorldEvents } = await import('../worker/game.mjs');
  const { generateDailyWorldEvents } = require('../utils/worldEvents');
  const expectedEvents = generateDailyWorldEvents('2026-05-29');
  const expectedHostiles = expectedEvents.filter(event => event.eventType === 'hostile').length;

  try {
    await db.prepare(
      `INSERT INTO worldEvents
        (id, worldDay, eventType, roomRow, roomCol, status, title, description, rewardExperience, rewardGold, createdTick, expiresTick)
       VALUES
        ('legacy_raid', '2026-05-29', 'raid', 1, 1, 'active', 'Legacy Raid', 'Already existed.', 120, 25, 1, 1441)`
    ).run();

    await ensureDailyWorldEvents(db, '2026-05-29', 2);

    const hostileCount = await db.prepare(
      "SELECT COUNT(*) AS count FROM worldEvents WHERE worldDay = '2026-05-29' AND eventType = 'hostile'"
    ).first();
    const totalCount = await db.prepare(
      "SELECT COUNT(*) AS count FROM worldEvents WHERE worldDay = '2026-05-29'"
    ).first();

    assert.equal(hostileCount.count, expectedHostiles);
    assert.equal(totalCount.count, expectedEvents.length + 1);
  } finally {
    await db.close();
  }
});

test('Chat ticks respawn cleared ambient hostiles after their respawn interval', async () => {
  const db = await createMigratedDb();
  const { ensureDailyWorldEvents, handleAttack, handleChatAction } = await import('../worker/game.mjs');
  const { getWorldDay } = require('../utils/roomEcology');
  const worldDay = getWorldDay();

  try {
    await ensureDailyWorldEvents(db, worldDay, 1);
    const hostile = await db.prepare(
      `SELECT we.id, we.roomRow, we.roomCol, u.username AS npcUsername
       FROM worldEvents we
       JOIN users u ON u.worldEventId = we.id
       WHERE we.worldDay = ?
         AND we.eventType = 'hostile'
         AND we.status = 'active'
       ORDER BY we.id ASC
       LIMIT 1`
    ).bind(worldDay).first();

    await db.prepare(
      `INSERT INTO users
        (username, password, job, health, maxHealth, stamina, maxStamina, speed, strength, intelligence)
       VALUES ('fighter', 'pw', 'Fighter', 100, 100, 100, 100, 20, 40, 1)`
    ).run();
    await db.prepare(
      `INSERT INTO roomPresence
        (username, roomRow, roomCol, lastSeenTick, worldDay)
       VALUES ('fighter', ?, ?, 1, ?)`
    ).bind(hostile.roomRow, hostile.roomCol, worldDay).run();
    await db.prepare('UPDATE users SET health = 1 WHERE username = ?').bind(hostile.npcUsername).run();

    await withMockedRandom([0.1, 0.99], () => handleAttack(db, 'fighter', `@${hostile.npcUsername}`, hostile.roomRow, hostile.roomCol));

    const defeated = await db.prepare('SELECT lastDefeatedTick, respawnInterval FROM worldEventEntities WHERE username = ?')
      .bind(hostile.npcUsername)
      .first();
    await db.prepare('UPDATE tick SET value = ? WHERE id = 1')
      .bind(defeated.lastDefeatedTick + defeated.respawnInterval - 1)
      .run();

    await handleChatAction(db, 'fighter', hostile.roomRow, hostile.roomCol, 'keeping watch');

    const respawnedNpc = await db.prepare('SELECT username FROM users WHERE username = ? AND isNpc = 1')
      .bind(hostile.npcUsername)
      .first();
    const respawnedPresence = await db.prepare('SELECT username FROM roomPresence WHERE username = ? AND roomRow = ? AND roomCol = ?')
      .bind(hostile.npcUsername, hostile.roomRow, hostile.roomCol)
      .first();

    assert.equal(respawnedNpc.username, hostile.npcUsername);
    assert.equal(respawnedPresence.username, hostile.npcUsername);
  } finally {
    await db.close();
  }
});

test('Raid event completion awards XP, gold, and achievement to present players when boss dies', async () => {
  const db = await createMigratedDb();
  const {
    ensureDailyWorldEvents,
    getRoomEcology,
    handleAttackAction,
    updatePresence
  } = await import('../worker/game.mjs');

  try {
    await db.prepare(
      `INSERT INTO users
        (username, password, job, health, maxHealth, stamina, maxStamina, speed, strength, intelligence)
       VALUES ('raider', 'pw', 'Novice', 20, 20, 100, 100, 20, 80, 1)`
    ).run();

    const { raid } = await ensureDailyWorldEvents(db, '2026-05-29', 1);
    await updatePresence(db, 'raider', raid.roomRow, raid.roomCol);
    const before = await getRoomEcology(db, 'raider', raid.roomRow, raid.roomCol);
    const boss = before.presence.find(entity => entity.npcKind === 'raid_boss');

    assert.ok(boss);

    await withMockedRandom([0.1, 0.99, 0.99], () => handleAttackAction(db, 'raider', raid.roomRow, raid.roomCol, `@${boss.username}`));

    const player = await db.prepare("SELECT experience, level, gold, attributePoints FROM users WHERE username = 'raider'").first();
    const achievement = await db.prepare("SELECT achievementType FROM worldEventAchievements WHERE username = 'raider'").first();
    const event = await db.prepare("SELECT status FROM worldEvents WHERE id = ?").bind(raid.id).first();
    const defeatedBoss = await db.prepare("SELECT username FROM users WHERE username = ?").bind(boss.username).first();
    const kill = await db.prepare("SELECT defeatedName, defeatedKind, defeatedLevel, experienceGained FROM killHistory WHERE killerUsername = 'raider'").first();

    assert.equal(event.status, 'completed');
    assert.equal(achievement.achievementType, 'raid_victory');
    assert.equal(defeatedBoss, null);
    assert.equal(kill.defeatedName, boss.displayName);
    assert.equal(kill.defeatedKind, 'raid_boss');
    assert.equal(kill.defeatedLevel, boss.level);
    assert.equal(kill.experienceGained, raid.rewardExperience);
    assert.ok(player.experience >= raid.rewardExperience);
    assert.ok(player.gold >= raid.rewardGold);
    assert.ok(player.level >= 1);
    assert.ok(player.attributePoints >= 10);
  } finally {
    await db.close();
  }
});

test('Player and NPC kills are recorded with defeated level and XP gained', async () => {
  const db = await createMigratedDb();
  const { handleAttack } = await import('../worker/game.mjs');

  try {
    await db.prepare(
      `INSERT INTO users
        (username, password, job, health, maxHealth, stamina, maxStamina, speed, strength, intelligence, level)
       VALUES ('fighter', 'pw', 'Fighter', 12, 12, 100, 100, 20, 80, 1, 4)`
    ).run();
    await db.prepare(
      `INSERT INTO users
        (username, password, job, health, maxHealth, stamina, maxStamina, speed, strength, intelligence, level)
       VALUES ('rival', 'pw', 'Novice', 1, 10, 100, 100, 1, 1, 1, 3)`
    ).run();
    await db.prepare(
      `INSERT INTO users
        (username, password, job, health, maxHealth, stamina, maxStamina, speed, strength, intelligence, level, isNpc, displayName, npcKind)
       VALUES ('npc_scout', 'pw', 'Novice', 1, 10, 100, 100, 1, 1, 1, 2, 1, 'Ash Scout', 'hostile')`
    ).run();
    await db.prepare(
      `INSERT INTO worldEventEntities
        (eventId, username, entityKind, rewardExperience, rewardGold)
       VALUES ('hostile_test', 'npc_scout', 'hostile', 8, 1)`
    ).run();

    await withMockedRandom([0.1, 0.99], () => handleAttack(db, 'fighter', '@rival', 2, 3));
    await withMockedRandom([0.1, 0.99], () => handleAttack(db, 'fighter', '@npc_scout', 2, 3));

    const kills = await db.prepare(
      "SELECT defeatedUsername, defeatedName, defeatedKind, defeatedLevel, experienceGained FROM killHistory WHERE killerUsername = 'fighter' ORDER BY id ASC"
    ).all();

    assert.deepEqual(kills.results, [
      {
        defeatedUsername: 'rival',
        defeatedName: 'rival',
        defeatedKind: 'player',
        defeatedLevel: 3,
        experienceGained: 0
      },
      {
        defeatedUsername: 'npc_scout',
        defeatedName: 'Ash Scout',
        defeatedKind: 'hostile',
        defeatedLevel: 2,
        experienceGained: 8
      }
    ]);
  } finally {
    await db.close();
  }
});

test('Killing attack messages are shown before defeat and death system messages', async () => {
  const db = await createMigratedDb();
  const { getMessages, handleAttackAction } = await import('../worker/game.mjs');

  try {
    await db.prepare(
      `INSERT INTO users
        (username, password, job, health, maxHealth, stamina, maxStamina, speed, strength, intelligence, level)
       VALUES ('fighter', 'pw', 'Fighter', 12, 12, 100, 100, 20, 80, 1, 4)`
    ).run();
    await db.prepare(
      `INSERT INTO users
        (username, password, job, health, maxHealth, stamina, maxStamina, speed, strength, intelligence, level)
       VALUES ('rival', 'pw', 'Novice', 1, 10, 100, 100, 1, 1, 1, 3)`
    ).run();
    await db.prepare(
      `INSERT INTO users
        (username, password, job, health, maxHealth, stamina, maxStamina, speed, strength, intelligence, level, isNpc, displayName, npcKind)
       VALUES ('npc_scout', 'pw', 'Novice', 1, 10, 100, 100, 1, 1, 1, 2, 1, 'Ash Scout', 'hostile')`
    ).run();
    await db.prepare(
      `INSERT INTO worldEventEntities
        (eventId, username, entityKind, rewardExperience, rewardGold)
       VALUES ('hostile_test', 'npc_scout', 'hostile', 8, 1)`
    ).run();

    await withMockedRandom([0.1, 0.99], () => handleAttackAction(db, 'fighter', 2, 3, '@npc_scout'));

    const messages = await getMessages(db, 2, 3);
    const finalMessages = messages.slice(-2);

    assert.equal(finalMessages[0].username, 'fighter');
    assert.match(finalMessages[0].message, /fighter attacked npc_scout for \d+ damage/);
    assert.equal(finalMessages[1].username, 'System');
    assert.equal(finalMessages[1].message, 'Ash Scout is defeated by fighter.');

    await withMockedRandom([0.1, 0.99], () => handleAttackAction(db, 'fighter', 2, 3, '@rival'));

    const updatedMessages = await getMessages(db, 2, 3);
    const finalPlayerDeathMessages = updatedMessages.slice(-2);

    assert.equal(finalPlayerDeathMessages[0].username, 'fighter');
    assert.match(finalPlayerDeathMessages[0].message, /fighter attacked rival for \d+ damage/);
    assert.equal(finalPlayerDeathMessages[1].username, 'System');
    assert.equal(finalPlayerDeathMessages[1].message, 'rival has died from attack by fighter.');
  } finally {
    await db.close();
  }
});

test('Hostile NPC room action can kill a present player through the normal cemetery flow', async () => {
  const db = await createMigratedDb();
  const {
    createNpcForEvent,
    runHostileRoomAction,
    updatePresence
  } = await import('../worker/game.mjs');

  try {
    await db.prepare(
      `INSERT INTO users
        (username, password, job, health, maxHealth, stamina, maxStamina, speed, strength, intelligence)
       VALUES ('victim', 'pw', 'Novice', 1, 10, 100, 100, 1, 1, 1)`
    ).run();
    await updatePresence(db, 'victim', 1, 1);
    await createNpcForEvent(db, {
      username: 'raid_brute_test',
      displayName: 'Raid Brute',
      npcKind: 'raid_add',
      worldEventId: 'test-event',
      row: 1,
      col: 1,
      health: 10,
      stamina: 100,
      speed: 20,
      strength: 80,
      intelligence: 1
    });

    await withMockedRandom([0.1, 0.99], () => runHostileRoomAction(db, 1, 1));

    const livePlayer = await db.prepare("SELECT username FROM users WHERE username = 'victim'").first();
    const grave = await db.prepare("SELECT username, cause FROM cemetery WHERE username = 'victim'").first();

    assert.equal(livePlayer, null);
    assert.equal(grave.username, 'victim');
    assert.match(grave.cause, /raid_brute_test/);
  } finally {
    await db.close();
  }
});

test('Worker attacks can miss through speed contest without damaging the target', async () => {
  const db = await createMigratedDb();
  const { getCurrentTickValue, getMessages, handleAttackAction } = await import('../worker/game.mjs');

  try {
    await db.prepare(
      `INSERT INTO users
        (username, password, job, health, maxHealth, stamina, maxStamina, speed, strength, intelligence)
       VALUES ('slow', 'pw', 'Novice', 12, 12, 100, 100, 1, 12, 1)`
    ).run();
    await db.prepare(
      `INSERT INTO users
        (username, password, job, health, maxHealth, stamina, maxStamina, speed, strength, intelligence)
       VALUES ('quick', 'pw', 'Novice', 12, 12, 100, 100, 20, 1, 1)`
    ).run();

    await withMockedRandom([0.99, 0.99], () => handleAttackAction(db, 'slow', 1, 1, '@quick'));

    const attacker = await db.prepare("SELECT stamina FROM users WHERE username = 'slow'").first();
    const target = await db.prepare("SELECT health FROM users WHERE username = 'quick'").first();
    const messages = await getMessages(db, 1, 1);
    const traces = await db.prepare('SELECT traceType FROM roomTraces').all();

    assert.equal(await getCurrentTickValue(db), 1);
    assert.equal(attacker.stamina, 99);
    assert.equal(target.health, 12);
    assert.match(messages.at(-1).message, /quick dodged slow/);
    assert.deepEqual(traces.results, []);
  } finally {
    await db.close();
  }
});

test('Worker attacks that pass speed contest still use strength damage', async () => {
  const db = await createMigratedDb();
  const { handleAttackAction } = await import('../worker/game.mjs');

  try {
    await db.prepare(
      `INSERT INTO users
        (username, password, job, health, maxHealth, stamina, maxStamina, speed, strength, intelligence)
       VALUES ('fast', 'pw', 'Novice', 12, 12, 100, 100, 20, 12, 1)`
    ).run();
    await db.prepare(
      `INSERT INTO users
        (username, password, job, health, maxHealth, stamina, maxStamina, speed, strength, intelligence)
       VALUES ('slow_target', 'pw', 'Novice', 12, 12, 100, 100, 1, 1, 1)`
    ).run();

    await withMockedRandom([0.1, 0.99, 0.99], () => handleAttackAction(db, 'fast', 1, 1, '@slow_target'));

    const target = await db.prepare("SELECT health FROM users WHERE username = 'slow_target'").first();

    assert.equal(target.health, 8);
  } finally {
    await db.close();
  }
});

test('Worker chat actions spend stamina, write normalized messages, and advance one tick', async () => {
  const db = await createMigratedDb();
  const { getCurrentTickValue, getMessages, handleChatAction } = await import('../worker/game.mjs');

  try {
    await db.prepare(
      `INSERT INTO users
        (username, password, job, health, maxHealth, stamina, maxStamina, speed, strength, intelligence)
       VALUES ('worker_a', 'pw', 'Novice', 12, 12, 100, 100, 1, 1, 1)`
    ).run();

    const result = await handleChatAction(db, 'worker_a', 1, 1, 'hello worker');
    const user = await db.prepare("SELECT stamina FROM users WHERE username = 'worker_a'").first();
    const messages = await getMessages(db, 1, 1);

    assert.equal(result.tick.tick, 1);
    assert.equal(await getCurrentTickValue(db), 1);
    assert.equal(user.stamina, 99);
    assert.equal(messages.at(-1).message, 'hello worker');
  } finally {
    await db.close();
  }
});

test('Worker low-stamina failures do not mutate messages or ticks', async () => {
  const db = await createMigratedDb();
  const { getCurrentTickValue, getMessages, handleChatAction } = await import('../worker/game.mjs');

  try {
    await db.prepare(
      `INSERT INTO users
        (username, password, job, health, maxHealth, stamina, maxStamina, speed, strength, intelligence)
       VALUES ('tired', 'pw', 'Novice', 12, 12, 0, 100, 1, 1, 1)`
    ).run();

    await assert.rejects(
      () => handleChatAction(db, 'tired', 1, 1, 'too tired'),
      /Not enough stamina/
    );

    assert.equal(await getCurrentTickValue(db), 0);
    assert.equal((await getMessages(db, 1, 1)).length, 0);
  } finally {
    await db.close();
  }
});

test('Worker malformed roll commands fail before spending stamina or advancing ticks', async () => {
  const db = await createMigratedDb();
  const { getCurrentTickValue, getMessages, handleChatAction } = await import('../worker/game.mjs');

  try {
    await db.prepare(
      `INSERT INTO users
        (username, password, job, health, maxHealth, stamina, maxStamina, speed, strength, intelligence, gold)
       VALUES ('roller', 'pw', 'Novice', 12, 12, 100, 100, 1, 1, 1, 10)`
    ).run();

    await assert.rejects(
      () => handleChatAction(db, 'roller', 1, 1, '/roll nope'),
      /Use \/roll <gold>/
    );

    const user = await db.prepare("SELECT stamina, gold FROM users WHERE username = 'roller'").first();
    assert.deepEqual(user, { stamina: 100, gold: 10 });
    assert.equal(await getCurrentTickValue(db), 0);
    assert.equal((await getMessages(db, 1, 1)).length, 0);
  } finally {
    await db.close();
  }
});

test('Worker class skills write system messages and advance through the shared action lifecycle', async () => {
  const db = await createMigratedDb();
  const { getCurrentTickValue, getMessages, handleSkillAction } = await import('../worker/game.mjs');

  try {
    await db.prepare(
      `INSERT INTO users
        (username, password, job, health, maxHealth, stamina, maxStamina, speed, strength, intelligence, gold)
       VALUES ('scout', 'pw', 'Novice', 12, 12, 100, 100, 1, 1, 4, 0)`
    ).run();

    const result = await handleSkillAction(db, 'scout', 1, 1, 'scrounge', '', 1);
    const user = await db.prepare("SELECT stamina, gold FROM users WHERE username = 'scout'").first();
    const messages = await getMessages(db, 1, 1);

    assert.equal(result.tick.tick, 1);
    assert.equal(await getCurrentTickValue(db), 1);
    assert.equal(user.stamina, 99);
    assert.equal(user.gold, 3);
    assert.match(messages.at(-1).message, /scrounges up 3 gold/);
  } finally {
    await db.close();
  }
});

test('Worker harmful class skills can miss without applying damage or status effects', async () => {
  const db = await createMigratedDb();
  const { getMessages, handleSkillAction } = await import('../worker/game.mjs');

  try {
    await db.prepare(
      `INSERT INTO users
        (username, password, job, health, maxHealth, stamina, maxStamina, speed, strength, intelligence, gold)
       VALUES
        ('fighter', 'pw', 'Fighter', 12, 12, 100, 100, 1, 12, 1, 0),
        ('chemist', 'pw', 'Chemist', 12, 12, 100, 100, 1, 1, 4, 0),
        ('mage', 'pw', 'Mage', 12, 12, 100, 100, 1, 1, 4, 0),
        ('assassin', 'pw', 'Assassin', 12, 12, 100, 100, 1, 1, 1, 0),
        ('quick_target', 'pw', 'Novice', 20, 20, 100, 100, 20, 1, 1, 0)`
    ).run();

    await withMockedRandom([0.99], () => handleSkillAction(db, 'fighter', 1, 1, 'power_strike', 'quick_target', 1));
    await withMockedRandom([0.99], () => handleSkillAction(db, 'chemist', 1, 1, 'dose', 'quick_target', 51));
    await withMockedRandom([0.99], () => handleSkillAction(db, 'mage', 1, 1, 'arcane_pin', 'quick_target', 1));
    await withMockedRandom([0.99], () => handleSkillAction(db, 'assassin', 1, 1, 'mark', 'quick_target', 1));

    const target = await db.prepare("SELECT health, stamina FROM users WHERE username = 'quick_target'").first();
    const statusEffects = await db.prepare("SELECT effectType FROM statusEffects WHERE username = 'quick_target'").all();
    const messages = await getMessages(db, 1, 1);

    assert.deepEqual(target, { health: 20, stamina: 100 });
    assert.deepEqual(statusEffects.results, []);
    assert.match(messages.at(-4).message, /quick_target dodged fighter's Power Strike/);
    assert.match(messages.at(-3).message, /quick_target dodged chemist's Dose/);
    assert.match(messages.at(-2).message, /quick_target dodged mage's Arcane Pin/);
    assert.match(messages.at(-1).message, /quick_target dodged assassin's Mark/);
  } finally {
    await db.close();
  }
});

test('Worker helpful and neutral class skills bypass speed contests', async () => {
  const db = await createMigratedDb();
  const { handleSkillAction } = await import('../worker/game.mjs');

  try {
    await db.prepare(
      `INSERT INTO users
        (username, password, job, health, maxHealth, stamina, maxStamina, speed, strength, intelligence, gold)
       VALUES
        ('novice', 'pw', 'Novice', 12, 12, 100, 100, 1, 1, 4, 0),
        ('paladin', 'pw', 'Paladin', 12, 12, 100, 100, 1, 1, 1, 0),
        ('chemist', 'pw', 'Chemist', 12, 12, 100, 100, 1, 1, 4, 0),
        ('dungeoneer', 'pw', 'Dungeoneer', 12, 12, 100, 100, 1, 1, 1, 0),
        ('cleric', 'pw', 'Cleric', 12, 12, 100, 100, 1, 1, 4, 0),
        ('quick_target', 'pw', 'Novice', 10, 20, 100, 100, 20, 1, 1, 0)`
    ).run();
    await db.prepare(
      `INSERT INTO statusEffects
        (username, source, effectType, magnitude, createdTick, expiryTick, roomRow, roomCol, sourceUsername)
       VALUES ('quick_target', 'assassin', 'marked', 2, 1, 10, 1, 1, 'assassin')`
    ).run();

    await withMockedRandom([0.99], async () => {
      await handleSkillAction(db, 'novice', 1, 1, 'scrounge', '', 1);
      await handleSkillAction(db, 'paladin', 1, 1, 'ward', 'quick_target', 1);
      await handleSkillAction(db, 'chemist', 1, 1, 'dose', 'quick_target', 1);
      await handleSkillAction(db, 'dungeoneer', 1, 1, 'survey', '', 1);
      await handleSkillAction(db, 'cleric', 1, 1, 'bless', 'quick_target', 1);
    });

    const novice = await db.prepare("SELECT gold FROM users WHERE username = 'novice'").first();
    const dungeoneer = await db.prepare("SELECT gold FROM users WHERE username = 'dungeoneer'").first();
    const target = await db.prepare("SELECT health FROM users WHERE username = 'quick_target'").first();
    const effects = await db.prepare(
      "SELECT effectType FROM statusEffects WHERE username = 'quick_target' ORDER BY effectType"
    ).all();
    const traces = await db.prepare("SELECT traceType FROM roomTraces WHERE attacker = 'dungeoneer'").all();

    assert.equal(novice.gold, 3);
    assert.equal(dungeoneer.gold, 1);
    assert.equal(target.health, 14);
    assert.deepEqual(effects.results.map(effect => effect.effectType), ['bless', 'ward']);
    assert.deepEqual(traces.results.map(trace => trace.traceType), ['survey']);
  } finally {
    await db.close();
  }
});

test('Worker missed attacks do not consume mark or ward until a later hit', async () => {
  const db = await createMigratedDb();
  const { handleAttackAction } = await import('../worker/game.mjs');

  try {
    await db.prepare(
      `INSERT INTO users
        (username, password, job, health, maxHealth, stamina, maxStamina, speed, strength, intelligence)
       VALUES
        ('attacker', 'pw', 'Novice', 12, 12, 100, 100, 1, 4, 1),
        ('target', 'pw', 'Novice', 12, 12, 100, 100, 20, 1, 1)`
    ).run();
    await db.prepare(
      `INSERT INTO statusEffects
        (username, source, effectType, magnitude, createdTick, expiryTick, roomRow, roomCol, sourceUsername)
       VALUES
        ('target', 'assassin', 'marked', 2, 0, 10, 1, 1, 'assassin'),
        ('target', 'paladin', 'ward', 2, 0, 10, 1, 1, 'paladin')`
    ).run();

    await withMockedRandom([0.99], () => handleAttackAction(db, 'attacker', 1, 1, '@target'));

    const afterMiss = await db.prepare(
      "SELECT effectType FROM statusEffects WHERE username = 'target' ORDER BY effectType"
    ).all();
    assert.deepEqual(afterMiss.results.map(effect => effect.effectType), ['marked', 'ward']);

    await withMockedRandom([0.1, 0.99, 0.99], () => handleAttackAction(db, 'attacker', 1, 1, '@target'));

    const afterHit = await db.prepare(
      "SELECT effectType FROM statusEffects WHERE username = 'target' ORDER BY effectType"
    ).all();
    assert.deepEqual(afterHit.results, []);
  } finally {
    await db.close();
  }
});

test('Worker skill deaths record the skill and source in the cemetery cause', async () => {
  const db = await createMigratedDb();
  const { handleSkillAction, processStatusEffects } = await import('../worker/game.mjs');

  try {
    await db.prepare(
      `INSERT INTO users
        (username, password, job, health, maxHealth, stamina, maxStamina, speed, strength, intelligence, gold)
       VALUES ('fighter', 'pw', 'Fighter', 12, 12, 100, 100, 1, 12, 1, 0)`
    ).run();
    await db.prepare(
      `INSERT INTO users
        (username, password, job, health, maxHealth, stamina, maxStamina, speed, strength, intelligence, gold)
       VALUES ('target', 'pw', 'Novice', 1, 10, 100, 100, 1, 1, 1, 0)`
    ).run();

    await withMockedRandom([0.1], () => handleSkillAction(db, 'fighter', 1, 1, 'power_strike', 'target', 1));
    const powerStrikeGrave = await db.prepare(
      "SELECT cause FROM cemetery WHERE username = 'target'"
    ).first();

    await db.prepare(
      `INSERT INTO users
        (username, password, job, health, maxHealth, stamina, maxStamina, speed, strength, intelligence, gold)
       VALUES ('poisoned', 'pw', 'Novice', 1, 10, 100, 100, 1, 1, 1, 0)`
    ).run();
    await db.prepare(
      `INSERT INTO statusEffects
        (username, source, effectType, magnitude, createdTick, expiryTick, roomRow, roomCol, sourceUsername)
       VALUES ('poisoned', 'chemist', 'poison', 1, 1, 5, 2, 3, 'chemist')`
    ).run();

    await processStatusEffects(db, 2);
    const poisonGrave = await db.prepare(
      "SELECT cause FROM cemetery WHERE username = 'poisoned'"
    ).first();

    assert.equal(powerStrikeGrave.cause, 'power strike by fighter');
    assert.equal(poisonGrave.cause, 'dose by chemist');
  } finally {
    await db.close();
  }
});

test('Worker resurrection link creates a pending request for the current grave', async () => {
  const db = await createMigratedDb();
  const { createResurrectionCheckout } = await import('../worker/resurrection.mjs');

  try {
    await db.prepare(
      `INSERT INTO cemetery
        (username, password, level, gold, job, cause, roomRow, roomCol)
       VALUES ('fallen', 'pw', 4, 7, 'Mage', 'test', 2, 3)`
    ).run();

    const checkout = await createResurrectionCheckout(db, 'fallen', 'https://buy.stripe.com/test_link');
    const request = await db.prepare(
      'SELECT token, username, graveId, status FROM resurrectionRequests WHERE username = ?'
    ).bind('fallen').first();

    assert.equal(request.token, checkout.token);
    assert.equal(request.username, 'fallen');
    assert.equal(request.status, 'pending');
    assert.match(checkout.url, /^https:\/\/buy\.stripe\.com\/test_link\?client_reference_id=/);
  } finally {
    await db.close();
  }
});

test('Worker resurrection fulfillment revives a paid grave only once', async () => {
  const db = await createMigratedDb();
  const { createResurrectionCheckout, fulfillResurrectionCheckout } = await import('../worker/resurrection.mjs');

  try {
    await db.prepare(
      `INSERT INTO cemetery
        (username, password, level, gold, job, cause, roomRow, roomCol)
       VALUES ('fallen', 'pw', 4, 7, 'Mage', 'test', 2, 3)`
    ).run();

    const checkout = await createResurrectionCheckout(db, 'fallen', 'https://buy.stripe.com/test_link');
    const first = await fulfillResurrectionCheckout(db, checkout.token, 'cs_test_123');
    const second = await fulfillResurrectionCheckout(db, checkout.token, 'cs_test_123');
    const revived = await db.prepare(
      'SELECT username, password, level, gold, job, health, maxHealth, stamina, maxStamina FROM users WHERE username = ?'
    ).bind('fallen').first();
    const grave = await db.prepare('SELECT username FROM cemetery WHERE username = ?').bind('fallen').first();
    const request = await db.prepare(
      'SELECT status, stripeSessionId, completedAt FROM resurrectionRequests WHERE token = ?'
    ).bind(checkout.token).first();

    assert.equal(first.revived, true);
    assert.equal(second.revived, false);
    assert.deepEqual(revived, {
      username: 'fallen',
      password: 'pw',
      level: 4,
      gold: 7,
      job: 'Mage',
      health: 10,
      maxHealth: 10,
      stamina: 100,
      maxStamina: 100
    });
    assert.equal(grave, null);
    assert.equal(request.status, 'completed');
    assert.equal(request.stripeSessionId, 'cs_test_123');
    assert.ok(request.completedAt);
  } finally {
    await db.close();
  }
});

test('dead sessions remain death-aware after the live user is gone', async () => {
  const db = await createMigratedDb();
  const { createSession, requireLiveUser } = await import('../worker/auth.mjs');
  const env = { DB: db, SESSION_SECRET: 'test-secret' };

  try {
    await db.prepare(
      `INSERT INTO cemetery
        (username, password, level, gold, job, cause, roomRow, roomCol)
       VALUES ('fallen', 'pw', 0, 0, 'Novice', 'attack by fallen', 1, 1)`
    ).run();

    const session = await createSession(env, { deadUsername: 'fallen' });
    const request = new Request('http://localhost/messages/1/1', {
      headers: { Cookie: session.cookie }
    });

    const result = await requireLiveUser(env, request);

    assert.equal(result.dead, true);
    assert.equal(result.session.deadUsername, 'fallen');
  } finally {
    await db.close();
  }
});

test('new live session wins when an old dead session cookie is still present', async () => {
  const db = await createMigratedDb();
  const { createSession, requireLiveUser } = await import('../worker/auth.mjs');
  const env = { DB: db, SESSION_SECRET: 'test-secret' };

  try {
    await db.prepare(
      `INSERT INTO users
        (username, password, job, health, maxHealth, stamina, maxStamina, speed, strength, intelligence)
       VALUES ('being', 'being', 'Chemist', 10, 10, 100, 100, 3, 1, 1)`
    ).run();
    await db.prepare(
      `INSERT INTO cemetery
        (username, password, level, gold, job, cause, roomRow, roomCol)
       VALUES ('oldbeing', 'being', 0, 0, 'Chemist', 'poison marsh', 1, 1)`
    ).run();

    const oldDeadSession = await createSession(env, { deadUsername: 'oldbeing' });
    const liveSession = await createSession(env, { username: 'being' });
    await db.prepare(
      `UPDATE sessions
       SET createdAt = CASE id
         WHEN ? THEN '2026-05-29 10:00:00'
         WHEN ? THEN '2026-05-29 10:01:00'
         ELSE createdAt
       END`
    ).bind(oldDeadSession.id, liveSession.id).run();

    const oldDeadCookie = oldDeadSession.cookie.split(';')[0];
    const liveCookie = liveSession.cookie.split(';')[0];
    const request = new Request('https://rpgchat-worker.organelle.workers.dev/chat/1/1', {
      headers: { Cookie: `${liveCookie}; ${oldDeadCookie}` }
    });

    const result = await requireLiveUser(env, request);

    assert.equal(result.dead, undefined);
    assert.equal(result.user.username, 'being');
  } finally {
    await db.close();
  }
});

test('local development URLs canonicalize localhost to 127.0.0.1', async () => {
  const { canonicalLocalRequestUrl } = await import('../worker/localHost.mjs');

  assert.equal(
    canonicalLocalRequestUrl('http://localhost:8787/chat/1/1?from=map'),
    'http://127.0.0.1:8787/chat/1/1?from=map'
  );
  assert.equal(
    canonicalLocalRequestUrl('http://127.0.0.1:8787/chat/1/1'),
    null
  );
  assert.equal(
    canonicalLocalRequestUrl('https://example.com/chat/1/1'),
    null
  );
});
