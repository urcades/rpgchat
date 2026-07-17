const assert = require('node:assert/strict');
const test = require('node:test');
const { createSqliteD1, createMigratedDb } = require('./.helpers/d1');
const { getWorldDay, generateRoomFeatures, calculateInnFee } = require('../utils/roomEcology');

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

function findCalmRoom(worldDay) {
  for (let row = 1; row <= 16; row += 1) {
    for (let col = 1; col <= 16; col += 1) {
      const features = generateRoomFeatures(row, col, worldDay);
      // poison_marsh / moon_room can kill the 1-HP victim during the tick;
      // echo_chamber consumes a Math.random() in processEchoChamber
      // (worker/game.mjs, `Math.random() >= 0.35`) BEFORE the speed contest,
      // desynchronizing withMockedRandom's value sequence. The remaining health
      // passives (pub/inn/sun_room/cold_room/guild) heal or hurt body parts on
      // the post-action tick, which emits extra condition-transition system
      // messages (plan 004) and shifts the tail of the message log.
      const hazardous = features.some(feature =>
        ['poison_marsh', 'moon_room', 'echo_chamber', 'pub', 'inn', 'sun_room', 'cold_room', 'guild']
          .includes(feature.effect?.type));
      if (!hazardous) {
        return { row, col };
      }
    }
  }
  throw new Error('No calm room found for ' + worldDay);
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

test('Scheduled world pulse reports active player rooms for live refresh', async () => {
  const db = await createMigratedDb();
  const { runScheduledWorldPulse } = await import('../worker/game.mjs');
  const { getWorldDay } = require('../utils/roomEcology');
  const worldDay = getWorldDay();

  try {
    await db.prepare(
      `INSERT INTO users
        (username, password, job, health, maxHealth, stamina, maxStamina, speed, strength, intelligence)
       VALUES
        ('awake_one', 'pw', 'Novice', 12, 12, 100, 100, 1, 1, 1),
        ('awake_two', 'pw', 'Novice', 12, 12, 100, 100, 1, 1, 1),
        ('stale_one', 'pw', 'Novice', 12, 12, 100, 100, 1, 1, 1)`
    ).run();
    await db.prepare(
      `INSERT INTO roomPresence
        (username, roomRow, roomCol, lastSeenTick, worldDay, lastSeenAt)
       VALUES
        ('awake_one', 2, 3, 0, ?, CURRENT_TIMESTAMP),
        ('awake_two', 4, 5, 0, ?, CURRENT_TIMESTAMP),
        ('stale_one', 6, 7, 0, ?, datetime('now', '-10 minutes'))`
    ).bind(worldDay, worldDay, worldDay).run();

    const pulse = await runScheduledWorldPulse(db);

    assert.deepEqual(pulse.activeRooms, [
      { row: 2, col: 3 },
      { row: 4, col: 5 }
    ]);
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

test('Room and map reads do not seed daily world events', async () => {
  const db = await createMigratedDb();
  const {
    getActiveWorldEvents,
    getRoomEcology
  } = await import('../worker/game.mjs');

  try {
    await db.prepare(
      `INSERT INTO users
        (username, password, job, health, maxHealth, stamina, maxStamina, speed, strength, intelligence)
       VALUES ('reader', 'pw', 'Novice', 12, 12, 100, 100, 1, 1, 1)`
    ).run();

    assert.deepEqual(await getActiveWorldEvents(db, '2026-05-29'), []);
    await getRoomEcology(db, 'reader', 1, 1, '2026-05-29');

    const eventCount = await db.prepare('SELECT COUNT(*) AS count FROM worldEvents').first();
    const npcCount = await db.prepare('SELECT COUNT(*) AS count FROM users WHERE isNpc = 1').first();

    assert.equal(eventCount.count, 0);
    assert.equal(npcCount.count, 0);
  } finally {
    await db.close();
  }
});

test('NPC presence stays visible while stale player presence expires', async () => {
  const db = await createMigratedDb();
  const {
    getRoomEcology
  } = await import('../worker/game.mjs');

  try {
    await db.prepare(
      `INSERT INTO users
        (username, password, job, health, maxHealth, stamina, maxStamina, speed, strength, intelligence, isNpc, displayName, npcKind, worldEventId)
       VALUES
        ('stale_player', 'pw', 'Novice', 12, 12, 100, 100, 1, 1, 1, 0, NULL, NULL, NULL),
        ('old_lurker', 'npc', 'Novice', 8, 8, 60, 60, 3, 4, 1, 1, 'Room Lurker', 'ambient_hostile', 'old_event')`
    ).run();
    await db.prepare(
      `INSERT INTO roomPresence
        (username, roomRow, roomCol, lastSeenTick, worldDay, lastSeenAt)
       VALUES
        ('stale_player', 2, 2, 1, '2026-05-29', datetime('now', '-10 minutes')),
        ('old_lurker', 2, 2, 1, '2026-05-29', datetime('now', '-10 minutes'))`
    ).run();

    const ecology = await getRoomEcology(db, 'stale_player', 2, 2, '2026-05-29');

    assert.deepEqual(ecology.presence.map(entity => entity.username), ['old_lurker']);
  } finally {
    await db.close();
  }
});

test('Room state combines room, messages, user, and tick without seeding world events', async () => {
  const db = await createMigratedDb();
  const { getRoomState } = await import('../worker/game.mjs');

  try {
    await db.prepare(
      `INSERT INTO users
        (username, password, job, health, maxHealth, stamina, maxStamina, speed, strength, intelligence, level, gold, experience)
       VALUES ('state_player', 'pw', 'Fighter', 12, 12, 100, 100, 3, 4, 2, 1, 7, 9)`
    ).run();
    await db.prepare(
      `INSERT INTO messages (roomRow, roomCol, username, message)
       VALUES (3, 3, 'state_player', 'hello room')`
    ).run();

    const state = await getRoomState(db, 'state_player', 3, 3);

    assert.equal(state.tick, 0);
    assert.equal(state.room.room.row, 3);
    assert.equal(state.messages.length, 1);
    assert.equal(state.messages[0].message, 'hello room');
    assert.equal(state.user.username, 'state_player');
    assert.equal(state.user.gold, 7);
    assert.equal(state.user.experience, 9);
    assert.deepEqual(state.user.achievements, []);
    assert.deepEqual(state.user.kills, []);

    const eventCount = await db.prepare('SELECT COUNT(*) AS count FROM worldEvents').first();
    assert.equal(eventCount.count, 0);

    // adv PERF-01: the room-state path uses the lean HUD scope — kill/achievement
    // history stays out of the hot poll even when it exists; the full-scope call
    // (character page / user-attributes) still carries it.
    await db.prepare(
      `INSERT INTO killHistory (killerUsername, defeatedUsername, defeatedName, defeatedKind, defeatedLevel, experienceGained, goldGained, roomRow, roomCol, worldDay, tick)
       VALUES ('state_player', 'some_brute', 'Some Brute', 'lesser_hostile', 2, 8, 2, 3, 3, '2026-01-01', 5)`
    ).run();
    const hudState = await getRoomState(db, 'state_player', 3, 3);
    assert.deepEqual(hudState.user.kills, [], 'HUD scope skips the kill log');
    const { getUserState } = await import('../worker/game.mjs');
    const fullState = await getUserState(db, 'state_player');
    assert.equal(fullState.kills.length, 1, 'full scope still surfaces kills');
  } finally {
    await db.close();
  }
});

test('Ajax action requests prefer JSON responses instead of page redirects', async () => {
  const { wantsJsonResponse } = await import('../worker/http.mjs');

  assert.equal(wantsJsonResponse(new Request('https://rpgchat.test/chat/1/12', {
    method: 'POST',
    headers: { Accept: 'application/json' }
  })), true);
  assert.equal(wantsJsonResponse(new Request('https://rpgchat.test/chat/1/12', {
    method: 'POST',
    headers: { Accept: '*/*' }
  })), true);
  assert.equal(wantsJsonResponse(new Request('https://rpgchat.test/chat/1/12', {
    method: 'POST',
    headers: { Accept: 'text/html' }
  })), false);
});

test('Scheduled pulses respawn cleared ambient hostiles after their respawn interval', async () => {
  const db = await createMigratedDb();
  const { ensureDailyWorldEvents, handleAttack, runScheduledWorldPulse } = await import('../worker/game.mjs');
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

    await runScheduledWorldPulse(db);

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

    const { raid } = await ensureDailyWorldEvents(db, getWorldDay(), 1);
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
  const { handleAttack, updatePresence } = await import('../worker/game.mjs');

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

    await updatePresence(db, 'fighter', 2, 3);
    await updatePresence(db, 'rival', 2, 3);
    await updatePresence(db, 'npc_scout', 2, 3);

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
  const { getMessages, handleAttackAction, updatePresence } = await import('../worker/game.mjs');

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

    const calm = findCalmRoom(getWorldDay());
    await updatePresence(db, 'fighter', calm.row, calm.col);
    await updatePresence(db, 'rival', calm.row, calm.col);
    await updatePresence(db, 'npc_scout', calm.row, calm.col);

    await withMockedRandom([0.1, 0.99], () => handleAttackAction(db, 'fighter', calm.row, calm.col, '@npc_scout'));

    const messages = await getMessages(db, calm.row, calm.col);
    // Plan 013f: a death-throes line now precedes the defeat line, and remains drop after,
    // so assert the ORDER (attack -> throes -> defeated) rather than fixed slice positions.
    const lines = messages.map(m => m.message);
    const atkIdx = lines.findIndex(m => /fighter .*Ash Scout.*\(\d+\)/.test(m));
    const defeatIdx = lines.findIndex(m => m === 'Ash Scout is defeated by fighter.');
    assert.ok(atkIdx >= 0, 'attack line present');
    assert.ok(defeatIdx >= 0, 'defeat line present');
    assert.ok(atkIdx < defeatIdx, 'attack precedes defeat');
    assert.ok(lines.some(m => /Ash Scout leaves behind remains\./.test(m)), 'remains dropped');
    assert.ok(
      lines.some((m, i) => i < defeatIdx && /Ash Scout (is torn apart|lets out|collapses|shudders|crumples)/.test(m)),
      'a death-throes/gib line precedes the defeat'
    );

    await withMockedRandom([0.1, 0.99], () => handleAttackAction(db, 'fighter', calm.row, calm.col, '@rival'));

    const updatedMessages = await getMessages(db, calm.row, calm.col);
    // Plan 023b: a one-shot blow this far past 0 HP gibs the victim outright (overkill
    // >= the gib threshold), so gore + "torn apart" lines precede the corpse and death
    // lines. The ordering contract still holds: the attack line precedes the death line,
    // and the death line is last.
    const msgs = updatedMessages.map(m => m.message);
    const attackIdx = msgs.findIndex(m => /fighter .*\brival\b.*\(\d+\)/.test(m));
    const diedIdx = msgs.findIndex(m => m === 'rival has died from attack by fighter.');
    assert.ok(attackIdx >= 0, 'attack line present');
    assert.ok(diedIdx >= 0, 'death line present');
    assert.ok(attackIdx < diedIdx, 'attack precedes death');
    assert.ok(msgs.some(m => /rival is torn apart\./.test(m)), 'gib line present');
    assert.match(updatedMessages[updatedMessages.length - 1].message, /rival has died from attack by fighter\./);
    assert.match(updatedMessages[updatedMessages.length - 2].message, /rival's corpse lies here\./);
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
    const calm = findCalmRoom(getWorldDay());
    await updatePresence(db, 'victim', calm.row, calm.col);
    await createNpcForEvent(db, {
      username: 'raid_brute_test',
      displayName: 'Raid Brute',
      npcKind: 'raid_add',
      worldEventId: 'test-event',
      row: calm.row,
      col: calm.col,
      health: 10,
      stamina: 100,
      speed: 20,
      strength: 80,
      intelligence: 1
    });

    await withMockedRandom([0.1, 0.99], () => runHostileRoomAction(db, calm.row, calm.col));

    const livePlayer = await db.prepare("SELECT username FROM users WHERE username = 'victim'").first();
    const grave = await db.prepare("SELECT username, cause FROM cemetery WHERE username = 'victim'").first();

    assert.equal(livePlayer, null);
    assert.equal(grave.username, 'victim');
    assert.match(grave.cause, /Raid Brute/);
  } finally {
    await db.close();
  }
});

test('Worker attacks can miss through speed contest without damaging the target', async () => {
  const db = await createMigratedDb();
  const { getCurrentTickValue, getMessages, handleAttackAction, updatePresence } = await import('../worker/game.mjs');

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

    const calm = findCalmRoom(getWorldDay());
    await updatePresence(db, 'slow', calm.row, calm.col);
    await updatePresence(db, 'quick', calm.row, calm.col);

    await withMockedRandom([0.99, 0.99], () => handleAttackAction(db, 'slow', calm.row, calm.col, '@quick'));

    const attacker = await db.prepare("SELECT stamina FROM users WHERE username = 'slow'").first();
    const target = await db.prepare("SELECT health FROM users WHERE username = 'quick'").first();
    const messages = await getMessages(db, calm.row, calm.col);
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
  const { handleAttackAction, updatePresence } = await import('../worker/game.mjs');

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

    const calm = findCalmRoom(getWorldDay());
    await updatePresence(db, 'fast', calm.row, calm.col);
    await updatePresence(db, 'slow_target', calm.row, calm.col);

    await withMockedRandom([0.1, 0.99, 0.99], () => handleAttackAction(db, 'fast', calm.row, calm.col, '@slow_target'));

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
  const { getMessages, handleSkillAction, updatePresence } = await import('../worker/game.mjs');

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
    // adv-014: a skill aimed at another PLAYER now requires co-location; place the
    // casters and their target together in a calm room (no passive that heals/hurts the
    // target on the post-action tick) so these casts can land.
    const calm = findCalmRoom(getWorldDay());
    for (const u of ['fighter', 'chemist', 'mage', 'assassin', 'quick_target']) {
      await updatePresence(db, u, calm.row, calm.col);
    }

    await withMockedRandom([0.99], () => handleSkillAction(db, 'fighter', calm.row, calm.col, 'power_strike', 'quick_target', 1));
    await withMockedRandom([0.99], () => handleSkillAction(db, 'chemist', calm.row, calm.col, 'dose', 'quick_target', 51));
    await withMockedRandom([0.99], () => handleSkillAction(db, 'mage', calm.row, calm.col, 'arcane_pin', 'quick_target', 1));
    await withMockedRandom([0.99], () => handleSkillAction(db, 'assassin', calm.row, calm.col, 'mark', 'quick_target', 1));

    const target = await db.prepare("SELECT health, stamina FROM users WHERE username = 'quick_target'").first();
    const statusEffects = await db.prepare("SELECT effectType FROM statusEffects WHERE username = 'quick_target'").all();
    const messages = await getMessages(db, calm.row, calm.col);

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
  const { handleSkillAction, updatePresence, runDeferredWorldSweeps } = await import('../worker/game.mjs');

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
    // adv-014: ward/dose/bless aim at another PLAYER, so the target must be co-located;
    // place every actor and the target together in a calm room (no passive that would
    // heal the target an extra point on the post-action tick and skew the health check).
    const calm = findCalmRoom(getWorldDay());
    for (const u of ['novice', 'paladin', 'chemist', 'dungeoneer', 'cleric', 'quick_target']) {
      await updatePresence(db, u, calm.row, calm.col);
    }
    await db.prepare(
      `INSERT INTO statusEffects
        (username, source, effectType, magnitude, createdTick, expiryTick, roomRow, roomCol, sourceUsername)
       VALUES ('quick_target', 'assassin', 'marked', 2, 1, 10, ?, ?, 'assassin')`
    ).bind(calm.row, calm.col).run();

    // adv-013: each action now only advances the tick synchronously; the route fires the
    // global sweeps (incl. the bless heal-over-time the target receives) from
    // runAfterResponse on the tick that action produced. Mirror that here — drive the
    // deferred sweep per action on its own advanced tick — so the post-action target state
    // is observed exactly as a player would experience it (each tick-window sweeps once).
    await withMockedRandom([0.99], async () => {
      const sweepAfter = async result => { await runDeferredWorldSweeps(db, result.tick.tick); return result; };
      await sweepAfter(await handleSkillAction(db, 'novice', calm.row, calm.col, 'scrounge', '', 1));
      await sweepAfter(await handleSkillAction(db, 'paladin', calm.row, calm.col, 'ward', 'quick_target', 1));
      await sweepAfter(await handleSkillAction(db, 'chemist', calm.row, calm.col, 'dose', 'quick_target', 1));
      await sweepAfter(await handleSkillAction(db, 'dungeoneer', calm.row, calm.col, 'survey', '', 1));
      await sweepAfter(await handleSkillAction(db, 'cleric', calm.row, calm.col, 'bless', 'quick_target', 1));
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
  const { handleAttackAction, updatePresence } = await import('../worker/game.mjs');

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

    await updatePresence(db, 'attacker', 1, 1);
    await updatePresence(db, 'target', 1, 1);

    await withMockedRandom([0.99], () => handleAttackAction(db, 'attacker', 1, 1, '@target'));

    const afterMiss = await db.prepare(
      "SELECT effectType FROM statusEffects WHERE username = 'target' ORDER BY effectType"
    ).all();
    assert.deepEqual(afterMiss.results.map(effect => effect.effectType), ['marked', 'ward']);

    await withMockedRandom([0.1, 0.99, 0.99], () => handleAttackAction(db, 'attacker', 1, 1, '@target'));

    const afterHit = await db.prepare(
      "SELECT effectType FROM statusEffects WHERE username = 'target' ORDER BY effectType"
    ).all();
    // mark + ward are consumed by the landed hit. The blow may ALSO have opened
    // a wound (layered-combat bleed rides the same table) — assert the
    // consumption, not table emptiness.
    const kinds = afterHit.results.map(effect => effect.effectType);
    assert.ok(!kinds.includes('marked'), 'mark consumed by the hit');
    assert.ok(!kinds.includes('ward'), 'ward consumed by the hit');
  } finally {
    await db.close();
  }
});

test('Worker skill deaths record the skill and source in the cemetery cause', async () => {
  const db = await createMigratedDb();
  const { handleSkillAction, processStatusEffects, processIncapacitationBleed, updatePresence } = await import('../worker/game.mjs');

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
    // adv-014: power_strike aims at another PLAYER, so co-locate the fighter and target
    // in a calm room (a healing passive would revive the downed target on the post-action
    // tick) for the killing blow to land and the victim to STAY downed.
    const calm = findCalmRoom(getWorldDay());
    await updatePresence(db, 'fighter', calm.row, calm.col);
    await updatePresence(db, 'target', calm.row, calm.col);

    // Plan 023b: a killing skill blow now DOWNS the victim (incapacitated) rather than
    // entombing them instantly. The skill + source is recorded immediately as the
    // downedCause, and rides into the cemetery cause when they finally bleed out.
    await withMockedRandom([0.1], () => handleSkillAction(db, 'fighter', calm.row, calm.col, 'power_strike', 'target', 1));
    const downedByStrike = await db.prepare(
      "SELECT incapacitated, downedCause FROM users WHERE username = 'target'"
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
    const downedByPoison = await db.prepare(
      "SELECT incapacitated, downedCause FROM users WHERE username = 'poisoned'"
    ).first();

    // Bleed the poisoned victim all the way out (clock 0 -> -30 at -1/tick) and confirm
    // the skill+source survives into the cemetery cause.
    for (let i = 0; i < 31; i += 1) {
      await processIncapacitationBleed(db, 3 + i);
    }
    const poisonGrave = await db.prepare(
      "SELECT cause FROM cemetery WHERE username = 'poisoned'"
    ).first();

    assert.equal(downedByStrike.incapacitated, 1, 'power strike downs the target');
    assert.equal(downedByStrike.downedCause, 'power strike by fighter');
    assert.equal(downedByPoison.incapacitated, 1, 'poison downs the target');
    assert.equal(downedByPoison.downedCause, 'dose by chemist');
    assert.equal(poisonGrave.cause, 'bled out after dose by chemist');
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
    // Plan 022c: resurrection requires the corpse to still exist.
    await db.prepare(
      "INSERT INTO items (templateId, name, slotType, rarity, modifiers, roomRow, roomCol, corpseOf) VALUES ('player_corpse', ?, 'corpse', 'common', '{}', 2, 3, 'fallen')"
    ).bind("fallen's Corpse").run();

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
    // Plan 022c: resurrection requires the corpse to still exist.
    await db.prepare(
      "INSERT INTO items (templateId, name, slotType, rarity, modifiers, roomRow, roomCol, corpseOf) VALUES ('player_corpse', ?, 'corpse', 'common', '{}', 2, 3, 'fallen')"
    ).bind("fallen's Corpse").run();

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
      health: 30,
      maxHealth: 30,
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

test('Worker attacks reject targets in a different room', async () => {
  const db = await createMigratedDb();
  const { handleAttack, updatePresence } = await import('../worker/game.mjs');

  try {
    await db.prepare(
      `INSERT INTO users
        (username, password, job, health, maxHealth, stamina, maxStamina, speed, strength, intelligence)
       VALUES ('attacker', 'pw', 'Novice', 12, 12, 100, 100, 20, 12, 1)`
    ).run();
    await db.prepare(
      `INSERT INTO users
        (username, password, job, health, maxHealth, stamina, maxStamina, speed, strength, intelligence)
       VALUES ('victim', 'pw', 'Novice', 12, 12, 100, 100, 1, 1, 1)`
    ).run();

    await updatePresence(db, 'attacker', 2, 2);
    await updatePresence(db, 'victim', 5, 5);

    await assert.rejects(
      () => withMockedRandom([0.1, 0.99, 0.99], () => handleAttack(db, 'attacker', '@victim', 2, 2)),
      /No such target here/
    );

    const victim = await db.prepare("SELECT health FROM users WHERE username = 'victim'").first();
    assert.equal(victim.health, 12);
  } finally {
    await db.close();
  }
});

test('Worker attacks match whole names instead of substrings', async () => {
  const db = await createMigratedDb();
  const { handleAttack, updatePresence } = await import('../worker/game.mjs');

  try {
    await db.prepare(
      `INSERT INTO users
        (username, password, job, health, maxHealth, stamina, maxStamina, speed, strength, intelligence)
       VALUES ('striker', 'pw', 'Novice', 12, 12, 100, 100, 20, 12, 1)`
    ).run();
    await db.prepare(
      `INSERT INTO users
        (username, password, job, health, maxHealth, stamina, maxStamina, speed, strength, intelligence)
       VALUES ('a', 'pw', 'Novice', 12, 12, 100, 100, 1, 1, 1)`
    ).run();
    await db.prepare(
      `INSERT INTO users
        (username, password, job, health, maxHealth, stamina, maxStamina, speed, strength, intelligence)
       VALUES ('ab', 'pw', 'Novice', 12, 12, 100, 100, 1, 1, 1)`
    ).run();

    await updatePresence(db, 'striker', 1, 1);
    await updatePresence(db, 'a', 1, 1);
    await updatePresence(db, 'ab', 1, 1);

    await withMockedRandom([0.1, 0.99, 0.99], () => handleAttack(db, 'striker', 'attacking ab now', 1, 1));

    const userA = await db.prepare("SELECT health FROM users WHERE username = 'a'").first();
    const userAb = await db.prepare("SELECT health FROM users WHERE username = 'ab'").first();
    assert.equal(userA.health, 12);
    assert.ok(userAb.health < 12, `expected ab to take damage, health was ${userAb.health}`);
  } finally {
    await db.close();
  }
});

test('Worker attacks cannot target the System account', async () => {
  const db = await createMigratedDb();
  const { handleAttack, updatePresence } = await import('../worker/game.mjs');

  try {
    await db.prepare(
      `INSERT INTO users
        (username, password, job, health, maxHealth, stamina, maxStamina, speed, strength, intelligence)
       VALUES ('attacker', 'pw', 'Novice', 12, 12, 100, 100, 20, 12, 1)`
    ).run();

    await updatePresence(db, 'attacker', 1, 1);
    await updatePresence(db, 'System', 1, 1);

    await assert.rejects(
      () => withMockedRandom([0.1, 0.99, 0.99], () => handleAttack(db, 'attacker', '@System die', 1, 1)),
      /No such target here/
    );

    const system = await db.prepare("SELECT health FROM users WHERE username = 'System'").first();
    assert.equal(system.health, 9999);
  } finally {
    await db.close();
  }
});

test('Worker attacks ignore stale players who left the room', async () => {
  const db = await createMigratedDb();
  const { handleAttack, updatePresence } = await import('../worker/game.mjs');

  try {
    await db.prepare(
      `INSERT INTO users
        (username, password, job, health, maxHealth, stamina, maxStamina, speed, strength, intelligence)
       VALUES ('attacker', 'pw', 'Novice', 12, 12, 100, 100, 20, 12, 1)`
    ).run();
    await db.prepare(
      `INSERT INTO users
        (username, password, job, health, maxHealth, stamina, maxStamina, speed, strength, intelligence)
       VALUES ('victim', 'pw', 'Novice', 12, 12, 100, 100, 1, 1, 1)`
    ).run();

    await updatePresence(db, 'attacker', 1, 1);
    await db.prepare(
      `INSERT INTO roomPresence
        (username, roomRow, roomCol, lastSeenTick, worldDay, lastSeenAt)
       VALUES ('victim', 1, 1, 0, ?, datetime('now', '-120 seconds'))`
    ).bind(getWorldDay()).run();

    await assert.rejects(
      () => withMockedRandom([0.1, 0.99, 0.99], () => handleAttack(db, 'attacker', '@victim', 1, 1)),
      /No such target here/
    );

    const victim = await db.prepare("SELECT health FROM users WHERE username = 'victim'").first();
    assert.equal(victim.health, 12);
  } finally {
    await db.close();
  }
});

function findInnRoom(worldDay) {
  for (let row = 1; row <= 16; row += 1) {
    for (let col = 1; col <= 16; col += 1) {
      const features = generateRoomFeatures(row, col, worldDay);
      if (features.some(feature => feature.effect?.type === 'inn')) {
        return { row, col };
      }
    }
  }
  throw new Error('No inn room found for ' + worldDay);
}

test('Inn payment cannot overdraw a player below zero gold', async () => {
  const db = await createMigratedDb();
  const { payInnAccess } = await import('../worker/game.mjs');
  const worldDay = getWorldDay();
  const { row, col } = findInnRoom(worldDay);
  const fee = calculateInnFee(row, col, worldDay);

  try {
    await db.prepare(
      "INSERT INTO users (username, password, gold) VALUES ('innguest', 'pw', ?)"
    ).bind(fee - 1).run();

    await assert.rejects(
      () => payInnAccess(db, 'innguest', row, col),
      /Not enough gold/
    );
    const afterReject = await db.prepare(
      'SELECT gold FROM users WHERE username = ?'
    ).bind('innguest').first();
    assert.equal(afterReject.gold, fee - 1);

    await db.prepare(
      'UPDATE users SET gold = ? WHERE username = ?'
    ).bind(fee, 'innguest').run();

    const paid = await payInnAccess(db, 'innguest', row, col);
    assert.equal(paid.paid, true);
    const afterPay = await db.prepare(
      'SELECT gold FROM users WHERE username = ?'
    ).bind('innguest').first();
    assert.equal(afterPay.gold, 0);
    const access = await db.prepare(
      'SELECT username FROM roomAccess WHERE username = ? AND roomRow = ? AND roomCol = ? AND worldDay = ?'
    ).bind('innguest', row, col, worldDay).first();
    assert.ok(access);

    const again = await payInnAccess(db, 'innguest', row, col);
    assert.equal(again.paid, true);
    const afterRepeat = await db.prepare(
      'SELECT gold FROM users WHERE username = ?'
    ).bind('innguest').first();
    assert.equal(afterRepeat.gold, 0);
  } finally {
    await db.close();
  }
});

test('Daily cleanup prunes expired sessions but keeps live ones', async () => {
  const db = await createMigratedDb();
  const { cleanupOldWorldDayData } = await import('../worker/game.mjs');

  try {
    await db.prepare(
      "INSERT INTO sessions (id, username, expiresAt) VALUES ('dead-session', 'a', datetime('now', '-1 hour'))"
    ).run();
    await db.prepare(
      "INSERT INTO sessions (id, username, expiresAt) VALUES ('live-session', 'b', datetime('now', '+1 hour'))"
    ).run();

    await cleanupOldWorldDayData(db);

    const remaining = await db.prepare('SELECT id FROM sessions ORDER BY id').all();
    assert.deepEqual(remaining.results.map(row => row.id), ['live-session']);
  } finally {
    await db.close();
  }
});

test('Daily cleanup prunes messages older than seven days', async () => {
  const db = await createMigratedDb();
  const { cleanupOldWorldDayData } = await import('../worker/game.mjs');

  try {
    await db.prepare(
      "INSERT INTO messages (roomRow, roomCol, username, message, timestamp) VALUES (1, 1, 'old', 'stale', datetime('now', '-8 days'))"
    ).run();
    await db.prepare(
      "INSERT INTO messages (roomRow, roomCol, username, message, timestamp) VALUES (1, 1, 'fresh', 'recent', datetime('now'))"
    ).run();

    await cleanupOldWorldDayData(db);

    const remaining = await db.prepare('SELECT username FROM messages ORDER BY id').all();
    assert.deepEqual(remaining.results.map(row => row.username), ['fresh']);
  } finally {
    await db.close();
  }
});

async function seedLiveUser(db, username, overrides = {}) {
  const stats = {
    job: 'Novice',
    health: 30,
    maxHealth: 30,
    stamina: 100,
    maxStamina: 100,
    speed: 1,
    strength: 1,
    intelligence: 1,
    level: 0,
    ...overrides
  };
  await db.prepare(
    `INSERT INTO users
      (username, password, job, health, maxHealth, stamina, maxStamina, speed, strength, intelligence, level)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    username, 'pw', stats.job, stats.health, stats.maxHealth, stats.stamina,
    stats.maxStamina, stats.speed, stats.strength, stats.intelligence, stats.level
  ).run();
}

async function sumBodyHp(db, username) {
  const row = await db.prepare('SELECT COALESCE(SUM(hp), 0) AS total FROM bodyParts WHERE username = ?')
    .bind(username).first();
  return row.total;
}

test('Body invariant holds after a battle: users.health equals sum of part hp', async () => {
  const db = await createMigratedDb();
  const { handleAttack, updatePresence } = await import('../worker/game.mjs');

  try {
    // Attacker hits hard enough to wound but the victim has a deep pool so it
    // survives several rounds; the invariant must hold after every blow. Plan 023b:
    // strength is kept modest so the bag never bleeds out / falls incapacitated mid-test
    // (a downed body zeroes to 0==0, which would trivially satisfy the invariant and
    // stop testing the live-combat lockstep this guards).
    await seedLiveUser(db, 'striker', { job: 'Fighter', health: 30, maxHealth: 30, speed: 20, strength: 8 });
    await seedLiveUser(db, 'punching_bag', { health: 90, maxHealth: 90, speed: 1 });

    const calm = findCalmRoom(getWorldDay());
    await updatePresence(db, 'striker', calm.row, calm.col);
    await updatePresence(db, 'punching_bag', calm.row, calm.col);

    // RNG per attack: speed contest (hit), crit roll (no crit), pickTargetPart,
    // then awardGoldMaybe + tick effects fall back to the repeated last value.
    for (let round = 0; round < 4; round += 1) {
      await withMockedRandom([0.1, 0.99, 0.5, 0.99], () =>
        handleAttack(db, 'striker', '@punching_bag', calm.row, calm.col));

      const user = await db.prepare("SELECT health FROM users WHERE username = 'punching_bag'").first();
      if (!user) {
        break; // died — invariant no longer applies (rows deleted)
      }
      const bodySum = await sumBodyHp(db, 'punching_bag');
      assert.equal(user.health, bodySum, `invariant after round ${round}`);
    }
  } finally {
    await db.close();
  }
});

test('Body damage severs a non-vital part driven to zero without killing the victim', async () => {
  const db = await createMigratedDb();
  const { applyBodyDamage, getBodyParts } = await import('../worker/game.mjs');

  try {
    await seedLiveUser(db, 'amputee', { health: 30, maxHealth: 30 });
    const victim = await db.prepare("SELECT * FROM users WHERE username = 'amputee'").first();

    // maxHealth 30, 11-part plan -> left arm has maxHp 3 and occupies roll range
    // [0.500, 0.600). random = 0.5 lands pickTargetPart on the left arm; 4 damage
    // drives it 3->0 (1 spills to the torso), severing it — and the distal cascade
    // takes the left hand (maxHp 1) with it.
    const result = await applyBodyDamage(db, victim, 4, {
      cause: 'a test blade',
      row: 1,
      col: 1,
      random: () => 0.5
    });

    assert.equal(result.died, false);
    assert.deepEqual(result.severedLabels, ['left arm', 'left hand']);

    const parts = await getBodyParts(db, 'amputee');
    const leftArm = parts.find(part => part.label === 'left arm');
    assert.equal(leftArm.severed, 1);
    assert.equal(leftArm.hp, 0);
    const leftHand = parts.find(part => part.label === 'left hand');
    assert.equal(leftHand.severed, 1, 'the distal hand cascades off with the arm');
    assert.equal(leftHand.hp, 0);

    const after = await db.prepare("SELECT health, maxHealth FROM users WHERE username = 'amputee'").first();
    assert.equal(after.maxHealth, 26); // 30 - arm maxHp (3) - cascaded hand maxHp (1)
    assert.equal(after.health, 25); // 30 - 4 dealt - 1 hand hp shed by the cascade

    const messages = await db.prepare("SELECT message FROM messages WHERE username = 'System' ORDER BY id").all();
    assert.ok(messages.results.some(row => row.message === "amputee's left arm is destroyed."));
  } finally {
    await db.close();
  }
});

test('Destroying a vital part kills the victim through the normal death flow', async () => {
  const db = await createMigratedDb();
  const { applyBodyDamage, getBodyParts, moveUserToCemetery } = await import('../worker/game.mjs');

  try {
    await seedLiveUser(db, 'doomed', { health: 30, maxHealth: 30 });
    const victim = await db.prepare("SELECT * FROM users WHERE username = 'doomed'").first();

    // torso (vital) occupies roll range [0.133, 0.433); random 0.2 lands there.
    // Overwhelming damage drives torso >0 -> 0 which is a vital-part death.
    const result = await applyBodyDamage(db, victim, 100, {
      cause: 'a test impaling',
      row: 1,
      col: 1,
      random: () => 0.2
    });

    assert.equal(result.died, true);

    // The caller owns the cemetery move (preserving the existing death flow).
    await moveUserToCemetery(db, 'doomed', 'a test impaling', 1, 1);

    const live = await db.prepare("SELECT username FROM users WHERE username = 'doomed'").first();
    const grave = await db.prepare("SELECT username, cause FROM cemetery WHERE username = 'doomed'").first();
    const parts = await getBodyParts(db, 'doomed');

    assert.equal(live, null);
    assert.equal(grave.username, 'doomed');
    assert.equal(parts.length, 0);

    const death = await db.prepare(
      "SELECT message FROM messages WHERE username = 'System' AND message LIKE 'doomed has died%' LIMIT 1"
    ).first();
    assert.ok(death);
  } finally {
    await db.close();
  }
});

test('Attrition death: total health reaching zero kills even when no vital part hits zero', async () => {
  const db = await createMigratedDb();
  const { applyBodyDamage, getBodyParts } = await import('../worker/game.mjs');

  try {
    // Instantiate the body, then put the victim in a state where both vital
    // parts are ALREADY empty (badly hurt earlier) and the only remaining HP
    // lives in a non-vital arm. The final blow empties that arm: total health
    // reaches 0 and the victim dies via attrition, not via a vital part going
    // from >0 to 0 (the vital parts were already at 0 before this blow).
    await seedLiveUser(db, 'bleeder', { health: 30, maxHealth: 30 });
    await getBodyParts(db, 'bleeder');
    // ensureBody has not run yet (no read path triggered it); force it.
    const seeded = await db.prepare("SELECT * FROM users WHERE username = 'bleeder'").first();
    await applyBodyDamage(db, seeded, 0, { cause: 'noop', random: () => 0.5 }); // instantiates body

    // Hand-set the body: head and torso empty, left arm holds the last 2 HP.
    await db.prepare("UPDATE bodyParts SET hp = 0 WHERE username = 'bleeder'").run();
    await db.prepare("UPDATE bodyParts SET hp = 2 WHERE username = 'bleeder' AND label = 'left arm'").run();
    await db.prepare("UPDATE users SET health = 2 WHERE username = 'bleeder'").run();

    const victim = await db.prepare("SELECT * FROM users WHERE username = 'bleeder'").first();
    // random 0.5 lands on the left arm; 2 damage empties it -> total 0 -> death.
    const result = await applyBodyDamage(db, victim, 2, {
      cause: 'slow bleeding',
      row: 1,
      col: 1,
      random: () => 0.5
    });

    assert.equal(result.died, true);
    assert.equal(result.healthAfter, 0);
    // The fatal blow severed the non-vital arm rather than destroying a vital part;
    // the already-empty left hand cascades off with it (distal sever cascade).
    assert.deepEqual(result.severedLabels, ['left arm', 'left hand']);
  } finally {
    await db.close();
  }
});

test('Instantiation never kills or severs a badly hurt player', async () => {
  const db = await createMigratedDb();
  const { getUserState } = await import('../worker/game.mjs');

  try {
    // Raw insert with health 1, maxHealth 10 (NOT through buildStartingStats).
    await db.prepare(
      `INSERT INTO users
        (username, password, job, health, maxHealth, stamina, maxStamina, speed, strength, intelligence)
       VALUES ('frail', 'pw', 'Novice', 1, 10, 100, 100, 1, 1, 1)`
    ).run();

    const state = await getUserState(db, 'frail'); // triggers ensureBody

    const live = await db.prepare("SELECT username FROM users WHERE username = 'frail'").first();
    assert.ok(live);

    const parts = await db.prepare('SELECT severed FROM bodyParts WHERE username = ?').bind('frail').all();
    assert.equal(parts.results.length, 11);
    assert.ok(parts.results.every(part => part.severed === 0));

    // Body payload is qualitative only — no numeric HP leaks.
    assert.ok(Array.isArray(state.body));
    assert.equal(state.body.length, 11);
    for (const part of state.body) {
      assert.equal(part.hp, undefined);
      assert.equal(part.maxHp, undefined);
      assert.ok(['healthy', 'hurt', 'mangled', 'missing'].includes(part.condition));
    }

    const bodySum = await sumBodyHp(db, 'frail');
    assert.equal(bodySum, 1); // mirrors stored health, no kill
  } finally {
    await db.close();
  }
});

test('Body heal restores the worst-ratio part first and emits a recovery message', async () => {
  const db = await createMigratedDb();
  const { applyBodyDamage, applyBodyHeal, getBodyParts } = await import('../worker/game.mjs');

  try {
    await seedLiveUser(db, 'mender', { health: 30, maxHealth: 30 });
    let victim = await db.prepare("SELECT * FROM users WHERE username = 'mender'").first();

    // Hurt the left arm (11-part plan: maxHp 3, range [0.500, 0.600)) down to a
    // low ratio without severing it.
    await applyBodyDamage(db, victim, 2, { cause: 'a scratch', row: 1, col: 1, random: () => 0.5 });

    const beforeHeal = await getBodyParts(db, 'mender');
    const armBefore = beforeHeal.find(part => part.label === 'left arm');
    assert.equal(armBefore.hp, 1); // 3 -> 1 (worst ratio in the body now)

    victim = await db.prepare("SELECT * FROM users WHERE username = 'mender'").first();
    await applyBodyHeal(db, victim, 2, { row: 1, col: 1 });

    const afterHeal = await getBodyParts(db, 'mender');
    const armAfter = afterHeal.find(part => part.label === 'left arm');
    // Worst-ratio-first: the damaged arm recovers before any full part changes.
    assert.equal(armAfter.hp, 3);

    const recovery = await db.prepare(
      "SELECT message FROM messages WHERE username = 'System' AND message LIKE \"mender's left arm%\" ORDER BY id"
    ).all();
    assert.ok(recovery.results.length >= 1);
  } finally {
    await db.close();
  }
});

test('Condition penalties bite: a mangled arm reduces attack damage by the strength penalty', async () => {
  const db = await createMigratedDb();
  const { applyBodyDamage, getBodyConditionModifiers, handleAttack, updatePresence } = await import('../worker/game.mjs');

  try {
    // Novice strikers (no job strength bonus) at strength 41 so the -2 arm
    // penalty crosses a floor(strength/4) boundary and the damage visibly drops.
    // health 100 so the left arm pool (0.08 * 100 = 8) is big enough that a
    // 6-damage prep blow leaves it MANGLED (2/8 = 0.25) rather than severed.
    await seedLiveUser(db, 'healthy_hand', { job: 'Novice', health: 100, maxHealth: 100, speed: 20, strength: 41 });
    await seedLiveUser(db, 'dummy_a', { health: 90, maxHealth: 90, speed: 1 });
    // Identical striker whose left arm we mangle (strength -2).
    await seedLiveUser(db, 'hurt_hand', { job: 'Novice', health: 100, maxHealth: 100, speed: 20, strength: 41 });
    await seedLiveUser(db, 'dummy_b', { health: 90, maxHealth: 90, speed: 1 });

    const calm = findCalmRoom(getWorldDay());
    for (const name of ['healthy_hand', 'dummy_a', 'hurt_hand', 'dummy_b']) {
      await updatePresence(db, name, calm.row, calm.col);
    }

    // Mangle hurt_hand's left arm (range [0.490,0.570) at health 100) to ratio 0.25.
    const hurtUser = await db.prepare("SELECT * FROM users WHERE username = 'hurt_hand'").first();
    await applyBodyDamage(db, hurtUser, 6, { cause: 'prep', random: () => 0.5 });
    const mods = await getBodyConditionModifiers(db, 'hurt_hand');
    assert.equal(mods.strength, -2);

    // Measure damage as the drop in users.health (kept equal to Σ part hp by
    // the invariant); reading health avoids any instantiation-timing skew.
    const dummyHealth = async name =>
      (await db.prepare('SELECT health FROM users WHERE username = ?').bind(name).first()).health;

    // Pick draw 0.2 lands the blow on the torso (27 hp at health 90): big enough
    // that neither blow severs anything, so no cascade skews the health delta.
    const healthyBefore = await dummyHealth('dummy_a');
    await withMockedRandom([0.1, 0.99, 0.2, 0.99], () =>
      handleAttack(db, 'healthy_hand', '@dummy_a', calm.row, calm.col));
    const healthyDamage = healthyBefore - (await dummyHealth('dummy_a'));

    const hurtBefore = await dummyHealth('dummy_b');
    await withMockedRandom([0.1, 0.99, 0.2, 0.99], () =>
      handleAttack(db, 'hurt_hand', '@dummy_b', calm.row, calm.col));
    const hurtDamage = hurtBefore - (await dummyHealth('dummy_b'));

    // strength 41 -> base damage 1 + floor(41/4) = 11. With -2 strength the
    // mangled striker swings as strength 39 -> 1 + floor(39/4) = 10.
    assert.equal(healthyDamage, 11);
    assert.equal(hurtDamage, 10);
    assert.ok(hurtDamage < healthyDamage);
  } finally {
    await db.close();
  }
});

test('HP rebase migration triples live players while sparing System', async () => {
  const db = await createMigratedDb();
  const { buildStartingStats } = await import('../worker/game.mjs');
  const { BASE_STATS } = require('../utils/jobs');

  try {
    // createMigratedDb applies every migration before we can seed, so we assert
    // the rebase via the System exclusion and the rebased BASE_STATS that a
    // normal signup-path user is built from.
    const system = await db.prepare("SELECT health, maxHealth FROM users WHERE username = 'System'").first();
    assert.equal(system.health, 9999);
    assert.equal(system.maxHealth, 9999);

    assert.equal(BASE_STATS.health, 30);
    assert.equal(BASE_STATS.maxHealth, 30);

    const startStats = buildStartingStats({ health: 0, stamina: 0, speed: 4, strength: 4, intelligence: 4 });
    assert.equal(startStats.health, 30); // 30 + 0*3
    assert.equal(startStats.maxHealth, 30);
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// Plan 014: equipment and inventory attached to body parts.
// Items are created here via raw INSERT (no item content lands until plan 005).
// A carried item has ownerUsername set, equippedPartId NULL, room columns NULL.
// ---------------------------------------------------------------------------
async function insertCarriedItem(db, owner, { templateId = 'tmpl', name, slotType, modifiers = {} }) {
  const result = await db.prepare(
    `INSERT INTO items (templateId, name, slotType, modifiers, ownerUsername)
     VALUES (?, ?, ?, ?, ?)`
  ).bind(templateId, name, slotType, JSON.stringify(modifiers), owner).run();
  return result.meta.last_row_id;
}

test('Equip lands an item on a matching body part and spends stamina and a tick', async () => {
  const db = await createMigratedDb();
  const { handleChatAction, getUserState, updatePresence } = await import('../worker/game.mjs');

  try {
    const calm = findCalmRoom(getWorldDay());
    await seedLiveUser(db, 'wielder', { health: 30, maxHealth: 30 });
    await updatePresence(db, 'wielder', calm.row, calm.col);
    // Trigger body instantiation so the arm part rows exist.
    await getUserState(db, 'wielder');
    await insertCarriedItem(db, 'wielder', { name: 'Rusty Sword', slotType: 'hand', modifiers: { strength: 2 } });

    const staminaBefore = (await db.prepare("SELECT stamina FROM users WHERE username = 'wielder'").first()).stamina;
    const tickBefore = (await db.prepare('SELECT value FROM tick WHERE id = 1').first()).value;

    const action = await handleChatAction(db, 'wielder', calm.row, calm.col, '/equip Rusty Sword');
    assert.equal(action.equipped, 'Rusty Sword');

    // The item is now equipped on a `hand` part (left arm = the lower id).
    const equipped = await db.prepare(
      `SELECT bp.label FROM items i JOIN bodyParts bp ON bp.id = i.equippedPartId
       WHERE i.ownerUsername = 'wielder'`
    ).first();
    assert.equal(equipped.label, 'left arm');

    const message = await db.prepare(
      "SELECT message FROM messages WHERE username = 'System' AND message LIKE 'wielder equips%' LIMIT 1"
    ).first();
    assert.equal(message.message, 'wielder equips Rusty Sword on their left arm.');

    const staminaAfter = (await db.prepare("SELECT stamina FROM users WHERE username = 'wielder'").first()).stamina;
    const tickAfter = (await db.prepare('SELECT value FROM tick WHERE id = 1').first()).value;
    assert.equal(staminaAfter, staminaBefore - 1);
    assert.equal(tickAfter, tickBefore + 1);
  } finally {
    await db.close();
  }
});

test('Two hand items fill both arms; a third swaps the first occupied arm', async () => {
  const db = await createMigratedDb();
  const { handleChatAction, getUserState, updatePresence } = await import('../worker/game.mjs');

  try {
    await seedLiveUser(db, 'twohands', { health: 30, maxHealth: 30 });
    await updatePresence(db, 'twohands', 1, 1);
    await getUserState(db, 'twohands');
    await insertCarriedItem(db, 'twohands', { name: 'Sword A', slotType: 'hand' });
    await insertCarriedItem(db, 'twohands', { name: 'Sword B', slotType: 'hand' });
    await insertCarriedItem(db, 'twohands', { name: 'Sword C', slotType: 'hand' });

    await handleChatAction(db, 'twohands', 1, 1, '/equip Sword A'); // left arm (empty preferred)
    await handleChatAction(db, 'twohands', 1, 1, '/equip Sword B'); // right arm (the other empty arm)

    const equippedAfterTwo = await db.prepare(
      `SELECT i.name, bp.label FROM items i JOIN bodyParts bp ON bp.id = i.equippedPartId
       WHERE i.ownerUsername = 'twohands' ORDER BY bp.label ASC`
    ).all();
    assert.deepEqual(equippedAfterTwo.results, [
      { name: 'Sword A', label: 'left arm' },
      { name: 'Sword B', label: 'right arm' }
    ]);

    await handleChatAction(db, 'twohands', 1, 1, '/equip Sword C'); // both full -> swap first arm

    const swordC = await db.prepare(
      `SELECT bp.label FROM items i JOIN bodyParts bp ON bp.id = i.equippedPartId
       WHERE i.name = 'Sword C'`
    ).first();
    assert.equal(swordC.label, 'left arm'); // first candidate (lowest id) is the swap target

    // Sword A is now carried again (equippedPartId NULL).
    const swordA = await db.prepare("SELECT equippedPartId FROM items WHERE name = 'Sword A'").first();
    assert.equal(swordA.equippedPartId, null);
    // Still exactly two items equipped (no part holds two).
    const equippedCount = await db.prepare(
      "SELECT COUNT(*) AS n FROM items WHERE ownerUsername = 'twohands' AND equippedPartId IS NOT NULL"
    ).first();
    assert.equal(equippedCount.n, 2);
  } finally {
    await db.close();
  }
});

test('Unequip works by part label and by item name', async () => {
  const db = await createMigratedDb();
  const { handleChatAction, getUserState, updatePresence } = await import('../worker/game.mjs');

  try {
    await seedLiveUser(db, 'stower', { health: 30, maxHealth: 30 });
    await updatePresence(db, 'stower', 1, 1);
    await getUserState(db, 'stower');
    await insertCarriedItem(db, 'stower', { name: 'Rusty Sword', slotType: 'hand' });

    await handleChatAction(db, 'stower', 1, 1, '/equip Rusty Sword'); // left arm

    // Unequip by part label.
    const byLabel = await handleChatAction(db, 'stower', 1, 1, '/unequip left arm');
    assert.equal(byLabel.unequipped, 'Rusty Sword');
    let row = await db.prepare("SELECT equippedPartId FROM items WHERE name = 'Rusty Sword'").first();
    assert.equal(row.equippedPartId, null);

    // Re-equip, then unequip by item name.
    await handleChatAction(db, 'stower', 1, 1, '/equip Rusty Sword');
    const byName = await handleChatAction(db, 'stower', 1, 1, '/unequip Rusty Sword');
    assert.equal(byName.unequipped, 'Rusty Sword');
    row = await db.prepare("SELECT equippedPartId FROM items WHERE name = 'Rusty Sword'").first();
    assert.equal(row.equippedPartId, null);

    const stowMessages = await db.prepare(
      "SELECT COUNT(*) AS n FROM messages WHERE username = 'System' AND message = 'stower stows Rusty Sword.'"
    ).first();
    assert.equal(stowMessages.n, 2);
  } finally {
    await db.close();
  }
});

test('Severed mount is never chosen: equip swaps the surviving arm instead', async () => {
  const db = await createMigratedDb();
  const { applyBodyDamage, handleChatAction, getUserState, updatePresence } = await import('../worker/game.mjs');

  try {
    await seedLiveUser(db, 'maimed', { health: 30, maxHealth: 30 });
    await updatePresence(db, 'maimed', 1, 1);
    await getUserState(db, 'maimed'); // instantiate body

    // Occupy the RIGHT arm first (equip while both arms live; left arm is the
    // empty-preferred target, so equip a second hand item to land on the right).
    await insertCarriedItem(db, 'maimed', { name: 'Held A', slotType: 'hand' });
    await insertCarriedItem(db, 'maimed', { name: 'Held B', slotType: 'hand' });
    await insertCarriedItem(db, 'maimed', { name: 'New Blade', slotType: 'hand' });
    // First unequip Held A from the left arm after equipping, so only the right
    // arm holds an item when we then sever the left.
    await handleChatAction(db, 'maimed', 1, 1, '/equip Held A'); // left arm
    await handleChatAction(db, 'maimed', 1, 1, '/equip Held B'); // right arm
    await handleChatAction(db, 'maimed', 1, 1, '/unequip left arm'); // free the left arm

    // Sever the left arm. left arm roll range [0.500,0.600); random 0.5 lands it,
    // 4 damage drives it 3->0 and severs it; the left hand cascades off with it.
    const victim = await db.prepare("SELECT * FROM users WHERE username = 'maimed'").first();
    const sever = await applyBodyDamage(db, victim, 4, { cause: 'a blade', row: 1, col: 1, random: () => 0.5 });
    assert.deepEqual(sever.severedLabels, ['left arm', 'left hand']);

    // With the left arm severed and the right occupied by Held B, equipping a
    // new hand item must SWAP the right arm, never land on the severed left.
    await handleChatAction(db, 'maimed', 1, 1, '/equip New Blade');
    const placed = await db.prepare(
      `SELECT bp.label FROM items i JOIN bodyParts bp ON bp.id = i.equippedPartId WHERE i.name = 'New Blade'`
    ).first();
    assert.equal(placed.label, 'right arm');

    // The severed left arm holds nothing.
    const leftArmItems = await db.prepare(
      `SELECT COUNT(*) AS n FROM items i JOIN bodyParts bp ON bp.id = i.equippedPartId
       WHERE bp.username = 'maimed' AND bp.label = 'left arm'`
    ).first();
    assert.equal(leftArmItems.n, 0);
  } finally {
    await db.close();
  }
});

test('Gear flows into effective stats and combat, stacking with wound penalties', async () => {
  const db = await createMigratedDb();
  const { handleAttack, handleChatAction, getUserState, applyBodyDamage, updatePresence } = await import('../worker/game.mjs');

  try {
    // Novice (no job strength) at strength 41 so +8 gear crosses floor(/4) bands.
    // health 100 so the left arm pool (8) can be MANGLED (6 damage -> 2/8 = 0.25)
    // later without severing it (a sever would knock the axe off).
    await seedLiveUser(db, 'geared', { job: 'Novice', health: 100, maxHealth: 100, speed: 20, strength: 41 });
    await seedLiveUser(db, 'dummy_g', { health: 90, maxHealth: 90, speed: 1 });
    const calm = findCalmRoom(getWorldDay());
    await updatePresence(db, 'geared', calm.row, calm.col);
    await updatePresence(db, 'dummy_g', calm.row, calm.col);
    await getUserState(db, 'geared'); // instantiate body

    // Baseline effective strength with no gear: 41.
    const before = await getUserState(db, 'geared');
    assert.equal(before.effectiveStats.strength, 41);

    await insertCarriedItem(db, 'geared', { name: 'Brutal Axe', slotType: 'hand', modifiers: { strength: 8 } });
    await handleChatAction(db, 'geared', calm.row, calm.col, '/equip Brutal Axe');

    // Effective strength now reflects gear: 41 + 8 = 49.
    const afterGear = await getUserState(db, 'geared');
    assert.equal(afterGear.effectiveStats.strength, 49);
    assert.equal(afterGear.gearBonuses.strength, 8);

    // Gear feeds combat damage: strength 49 -> 1 + floor(49/4) = 13.
    // RNG order per attack: speed hit (0.1), crit roll (0.99 no crit),
    // pickTargetPart (0.2 = torso, 27 hp at health 90 so no sever/cascade
    // contaminates the health delta), torso-spill buffer (0.99).
    const dummyHealth = async name =>
      (await db.prepare('SELECT health FROM users WHERE username = ?').bind(name).first()).health;
    const gearedBefore = await dummyHealth('dummy_g');
    await withMockedRandom([0.1, 0.99, 0.2, 0.99], () =>
      handleAttack(db, 'geared', '@dummy_g', calm.row, calm.col));
    const gearedDamage = gearedBefore - (await dummyHealth('dummy_g'));
    assert.equal(gearedDamage, 13);

    // Now mangle the geared striker's own left arm (strength -2). The equipped
    // axe is on the left arm; mangling it leaves the item equipped (only sever
    // knocks gear off) so +8 gear and -2 wound stack to a net +6 over base 41.
    const self = await db.prepare("SELECT * FROM users WHERE username = 'geared'").first();
    await applyBodyDamage(db, self, 6, { cause: 'prep', row: calm.row, col: calm.col, random: () => 0.5 });
    const stacked = await getUserState(db, 'geared');
    assert.equal(stacked.bonusModifiers.strength, 6); // +8 gear - 2 wound
    assert.equal(stacked.effectiveStats.strength, 47); // 41 + 6
  } finally {
    await db.close();
  }
});

test('Sever knock-off drops the equipped item to the room floor', async () => {
  const db = await createMigratedDb();
  const { applyBodyDamage, handleChatAction, getUserState, updatePresence } = await import('../worker/game.mjs');

  try {
    await seedLiveUser(db, 'dropper', { health: 30, maxHealth: 30 });
    await updatePresence(db, 'dropper', 4, 5);
    await getUserState(db, 'dropper'); // instantiate body
    await insertCarriedItem(db, 'dropper', { name: 'Lost Dagger', slotType: 'hand' });
    await handleChatAction(db, 'dropper', 4, 5, '/equip Lost Dagger'); // left arm

    // Sever the left arm (range [0.500,0.600); random 0.5; 4 damage 3->0, 1 spills
    // to the torso; the left hand cascades off with the arm).
    const victim = await db.prepare("SELECT * FROM users WHERE username = 'dropper'").first();
    const sever = await applyBodyDamage(db, victim, 4, { cause: 'a cleaver', row: 4, col: 5, random: () => 0.5 });
    assert.deepEqual(sever.severedLabels, ['left arm', 'left hand']);

    // The item is on the floor: owner NULL, part NULL, room set.
    const floored = await db.prepare("SELECT ownerUsername, equippedPartId, roomRow, roomCol FROM items WHERE name = 'Lost Dagger'").first();
    assert.equal(floored.ownerUsername, null);
    assert.equal(floored.equippedPartId, null);
    assert.equal(floored.roomRow, 4);
    assert.equal(floored.roomCol, 5);

    const message = await db.prepare(
      "SELECT message FROM messages WHERE username = 'System' AND message LIKE 'Lost Dagger falls%' LIMIT 1"
    ).first();
    assert.equal(message.message, "Lost Dagger falls to the floor with dropper's left arm.");
  } finally {
    await db.close();
  }
});

test('One item per part: a second INSERT on the same part is rejected', async () => {
  const db = await createMigratedDb();
  const { getUserState, updatePresence } = await import('../worker/game.mjs');

  try {
    await seedLiveUser(db, 'unique_part', { health: 30, maxHealth: 30 });
    await updatePresence(db, 'unique_part', 1, 1);
    await getUserState(db, 'unique_part'); // instantiate body
    const leftArm = await db.prepare(
      "SELECT id FROM bodyParts WHERE username = 'unique_part' AND label = 'left arm'"
    ).first();

    await db.prepare(
      `INSERT INTO items (templateId, name, slotType, ownerUsername, equippedPartId)
       VALUES ('t', 'First', 'hand', 'unique_part', ?)`
    ).bind(leftArm.id).run();

    await assert.rejects(
      () => db.prepare(
        `INSERT INTO items (templateId, name, slotType, ownerUsername, equippedPartId)
         VALUES ('t', 'Second', 'hand', 'unique_part', ?)`
      ).bind(leftArm.id).run(),
      /UNIQUE|constraint/i
    );
  } finally {
    await db.close();
  }
});

test('maxHealth gear is structural (plan 015): it raises effective maxHealth via stored max but never appears as a gear bonus', async () => {
  const db = await createMigratedDb();
  const { handleChatAction, getUserState, updatePresence } = await import('../worker/game.mjs');

  try {
    await seedLiveUser(db, 'plated', { health: 30, maxHealth: 30 });
    await updatePresence(db, 'plated', 1, 1);
    const noGear = await getUserState(db, 'plated'); // instantiate body
    const baselineMaxHealth = noGear.effectiveStats.maxHealth;

    await insertCarriedItem(db, 'plated', { name: 'Iron Plate', slotType: 'torso', modifiers: { maxHealth: 9 } });
    await handleChatAction(db, 'plated', 1, 1, '/equip Iron Plate');

    const withGear = await getUserState(db, 'plated');
    // Plan 015: maxHealth gear is now real and STRUCTURAL. Equip folds the +9
    // into the torso's maxHp and into stored users.maxHealth, so effective
    // maxHealth rises by exactly the bonus.
    assert.equal(withGear.effectiveStats.maxHealth, baselineMaxHealth + 9);
    // The effective-layer guard is still in force: gear maxHealth must NOT ride
    // getEquippedModifiers (that would double-count on top of the structural
    // contribution). So it never surfaces as a gearBonus.
    assert.equal(withGear.gearBonuses.maxHealth, undefined);
  } finally {
    await db.close();
  }
});

// --- Plan 015: on-part gear HP ---------------------------------------------
// The invariant (plan 004), re-asserted after every HP-gear write path:
//   users.health == Σ bodyParts.hp
//   users.maxHealth == Σ (non-severed bodyParts.maxHp)
async function assertHpInvariant(db, username) {
  const user = await db.prepare('SELECT health, maxHealth FROM users WHERE username = ?')
    .bind(username).first();
  const sums = await db.prepare(
    `SELECT COALESCE(SUM(hp), 0) AS hpSum,
            COALESCE(SUM(CASE WHEN severed = 0 THEN maxHp ELSE 0 END), 0) AS maxHpSum
     FROM bodyParts WHERE username = ?`
  ).bind(username).first();
  assert.equal(user.health, sums.hpSum, `health (${user.health}) == Σ hp (${sums.hpSum})`);
  assert.equal(
    user.maxHealth,
    sums.maxHpSum,
    `maxHealth (${user.maxHealth}) == Σ non-severed maxHp (${sums.maxHpSum})`
  );
}

async function partRow(db, username, label) {
  return db.prepare('SELECT id, hp, maxHp, baseMaxHp, severed FROM bodyParts WHERE username = ? AND label = ?')
    .bind(username, label).first();
}

test('Plan 015: equipping HP gear raises the worn part and the pool without a free heal', async () => {
  const db = await createMigratedDb();
  const { equipItem, getUser, ensureBody } = await import('../worker/game.mjs');

  try {
    await seedLiveUser(db, 'fortify', { health: 30, maxHealth: 30 });
    const seeded = await getUser(db, 'fortify');
    await ensureBody(db, seeded); // instantiate parts from the stored pool

    const torsoBefore = await partRow(db, 'fortify', 'torso');
    await assertHpInvariant(db, 'fortify');

    await insertCarriedItem(db, 'fortify', { name: 'Iron Plate', slotType: 'torso', modifiers: { maxHealth: 9 } });
    await equipItem(db, await getUser(db, 'fortify'), 'Iron Plate', 1, 1);

    const torsoAfter = await partRow(db, 'fortify', 'torso');
    assert.equal(torsoAfter.maxHp, torsoBefore.maxHp + 9, 'torso maxHp rose by exactly the bonus');
    assert.equal(torsoAfter.hp, torsoBefore.hp, 'equip is no free heal: hp unchanged');

    const user = await db.prepare("SELECT health, maxHealth FROM users WHERE username = 'fortify'").first();
    assert.equal(user.maxHealth, 39, 'pool maxHealth 30 -> 39');
    assert.equal(user.health, 30, 'health unchanged by equip');
    await assertHpInvariant(db, 'fortify');
  } finally {
    await db.close();
  }
});

test('Plan 015: a heal fills the headroom opened by HP gear (no longer a dead stat)', async () => {
  const db = await createMigratedDb();
  const { equipItem, applyBodyHeal, getUser, ensureBody } = await import('../worker/game.mjs');

  try {
    await seedLiveUser(db, 'topup', { health: 30, maxHealth: 30 });
    await ensureBody(db, await getUser(db, 'topup'));

    await insertCarriedItem(db, 'topup', { name: 'Iron Plate', slotType: 'torso', modifiers: { maxHealth: 9 } });
    await equipItem(db, await getUser(db, 'topup'), 'Iron Plate', 1, 1);

    // Full at 30, capped at 39 now; heal 20 should fill exactly 9 into the new headroom.
    const healed = await applyBodyHeal(db, await getUser(db, 'topup'), 20, {});
    assert.equal(healed, 39, 'heal fills up to the fortified cap of 39');
    const user = await db.prepare("SELECT health, maxHealth FROM users WHERE username = 'topup'").first();
    assert.equal(user.health, 39);
    assert.equal(user.maxHealth, 39);
    await assertHpInvariant(db, 'topup');
  } finally {
    await db.close();
  }
});

test('Plan 015: unequipping HP gear reverses the part and pool exactly, clamping overfill', async () => {
  const db = await createMigratedDb();
  const { equipItem, unequipItem, applyBodyHeal, getUser, ensureBody } = await import('../worker/game.mjs');

  try {
    await seedLiveUser(db, 'doff', { health: 30, maxHealth: 30 });
    await ensureBody(db, await getUser(db, 'doff'));
    const torsoBase = await partRow(db, 'doff', 'torso');

    await insertCarriedItem(db, 'doff', { name: 'Iron Plate', slotType: 'torso', modifiers: { maxHealth: 9 } });
    await equipItem(db, await getUser(db, 'doff'), 'Iron Plate', 1, 1);
    // Fill the new headroom so the unequip clamp has something to bite on.
    await applyBodyHeal(db, await getUser(db, 'doff'), 9, {});
    assert.equal((await db.prepare("SELECT health FROM users WHERE username = 'doff'").first()).health, 39);

    await unequipItem(db, await getUser(db, 'doff'), 'Iron Plate', 1, 1);

    const torsoAfter = await partRow(db, 'doff', 'torso');
    assert.equal(torsoAfter.maxHp, torsoBase.maxHp, 'torso maxHp returns to base (lossless round-trip)');
    assert.equal(torsoAfter.hp, torsoBase.maxHp, 'torso hp clamped down to its base maxHp');
    const user = await db.prepare("SELECT health, maxHealth FROM users WHERE username = 'doff'").first();
    assert.equal(user.maxHealth, 30, 'pool maxHealth back to 30');
    assert.equal(user.health, 30, 'health clamped from 39 down to 30');
    await assertHpInvariant(db, 'doff');
  } finally {
    await db.close();
  }
});

test('Plan 015: negative HP gear lowers the worn part and clamps, and unequip restores it', async () => {
  const db = await createMigratedDb();
  const { equipItem, unequipItem, getUser, ensureBody } = await import('../worker/game.mjs');

  try {
    await seedLiveUser(db, 'mage', { health: 30, maxHealth: 30 });
    await ensureBody(db, await getUser(db, 'mage'));
    const armBase = await partRow(db, 'mage', 'left arm'); // hand slot, maxHp 4 at pool 30

    await insertCarriedItem(db, 'mage', { name: 'Humming Focus', slotType: 'hand', modifiers: { maxHealth: -3 } });
    await equipItem(db, await getUser(db, 'mage'), 'Humming Focus', 1, 1); // left arm (empty-preferred)

    const armAfter = await partRow(db, 'mage', 'left arm');
    assert.equal(armAfter.maxHp, armBase.maxHp - 3, 'arm maxHp dropped by 3');
    assert.equal(armAfter.hp, armBase.maxHp - 3, 'arm hp clamped to the lowered cap');
    const lowered = await db.prepare("SELECT health, maxHealth FROM users WHERE username = 'mage'").first();
    assert.equal(lowered.maxHealth, 27, 'pool maxHealth 30 -> 27');
    assert.equal(lowered.health, 27, 'health clamped to 27');
    await assertHpInvariant(db, 'mage');

    // Unequip a negative-bonus item RAISES the cap back; hp stays (headroom opens).
    await unequipItem(db, await getUser(db, 'mage'), 'Humming Focus', 1, 1);
    const armRestored = await partRow(db, 'mage', 'left arm');
    assert.equal(armRestored.maxHp, armBase.maxHp, 'arm maxHp restored');
    assert.equal(armRestored.hp, armBase.maxHp - 3, 'hp unchanged on unequip (no auto-heal)');
    const restored = await db.prepare("SELECT health, maxHealth FROM users WHERE username = 'mage'").first();
    assert.equal(restored.maxHealth, 30, 'pool maxHealth restored to 30');
    assert.equal(restored.health, 27, 'health stays at 27 (headroom opens, no free heal)');
    await assertHpInvariant(db, 'mage');
  } finally {
    await db.close();
  }
});

test('Plan 015: severing an armored limb takes the fortified maxHp with it and drops the item', async () => {
  const db = await createMigratedDb();
  const { equipItem, applyBodyHeal, applyBodyDamage, getUser, ensureBody } = await import('../worker/game.mjs');

  try {
    await seedLiveUser(db, 'gallant', { health: 30, maxHealth: 30 });
    await ensureBody(db, await getUser(db, 'gallant'));

    await insertCarriedItem(db, 'gallant', { name: 'Vambrace', slotType: 'hand', modifiers: { maxHealth: 9 } });
    await equipItem(db, await getUser(db, 'gallant'), 'Vambrace', 4, 5); // left arm
    // Fill so the arm is at its fortified cap (11-part base 3 + 9 = 12).
    await applyBodyHeal(db, await getUser(db, 'gallant'), 9, {});
    const armFort = await partRow(db, 'gallant', 'left arm');
    assert.equal(armFort.maxHp, 12, 'arm fortified to base 3 + gear 9');
    assert.equal(armFort.hp, 12);
    await assertHpInvariant(db, 'gallant');

    const maxBeforeSever = (await db.prepare("SELECT maxHealth FROM users WHERE username = 'gallant'").first()).maxHealth;
    // Sever the left arm. With the arm fortified to 12 the weights become
    // torso[0,9) head[9,14) neck[14,15) left-arm[15,27) of total 39: random 0.5
    // (roll 19.5) lands the left arm. 12 damage drives it 12->0 and severs it;
    // the left hand (maxHp 1) cascades off with it.
    const sever = await applyBodyDamage(db, await getUser(db, 'gallant'), 12, {
      cause: 'a greataxe', row: 4, col: 5, random: () => 0.5
    });
    assert.deepEqual(sever.severedLabels, ['left arm', 'left hand']);

    const armSevered = await partRow(db, 'gallant', 'left arm');
    assert.equal(armSevered.severed, 1);
    const maxAfter = (await db.prepare("SELECT maxHealth FROM users WHERE username = 'gallant'").first()).maxHealth;
    assert.equal(maxAfter, maxBeforeSever - 13, 'maxHealth dropped by the FULL fortified maxHp (3 + 9) plus the cascaded hand pool (1)');

    // The armor clattered to the floor: no owner, no part, room set.
    const floored = await db.prepare("SELECT ownerUsername, equippedPartId, roomRow, roomCol FROM items WHERE name = 'Vambrace'").first();
    assert.equal(floored.ownerUsername, null);
    assert.equal(floored.equippedPartId, null);
    assert.equal(floored.roomRow, 4);
    assert.equal(floored.roomCol, 5);
    await assertHpInvariant(db, 'gallant');
  } finally {
    await db.close();
  }
});

test('Plan 015: re-equipping a severed-and-floored armor applies its bonus exactly once', async () => {
  const db = await createMigratedDb();
  const { equipItem, applyBodyHeal, applyBodyDamage, getUser, ensureBody } = await import('../worker/game.mjs');

  try {
    await seedLiveUser(db, 'reclaim', { health: 30, maxHealth: 30 });
    await ensureBody(db, await getUser(db, 'reclaim'));

    await insertCarriedItem(db, 'reclaim', { name: 'Vambrace', slotType: 'hand', modifiers: { maxHealth: 9 } });
    await equipItem(db, await getUser(db, 'reclaim'), 'Vambrace', 4, 5); // left arm
    await applyBodyHeal(db, await getUser(db, 'reclaim'), 9, {}); // fill arm to 13

    // Sever the left arm; the Vambrace drops to the floor (owner NULL).
    await applyBodyDamage(db, await getUser(db, 'reclaim'), 13, {
      cause: 'a cleaver', row: 4, col: 5, random: () => 0.5
    });
    await assertHpInvariant(db, 'reclaim');

    const rightArmBase = await partRow(db, 'reclaim', 'right arm'); // surviving hand part
    const maxAfterSever = (await db.prepare("SELECT maxHealth FROM users WHERE username = 'reclaim'").first()).maxHealth;

    // Take the floored item back and equip on the surviving right arm.
    const itemId = (await db.prepare("SELECT id FROM items WHERE name = 'Vambrace'").first()).id;
    await db.prepare('UPDATE items SET ownerUsername = ?, roomRow = NULL, roomCol = NULL WHERE id = ?')
      .bind('reclaim', itemId).run();
    await equipItem(db, await getUser(db, 'reclaim'), 'Vambrace', 4, 5); // right arm (left is severed)

    const rightArmAfter = await partRow(db, 'reclaim', 'right arm');
    assert.equal(rightArmAfter.maxHp, rightArmBase.maxHp + 9, 'bonus applied once, not twice');
    const maxFinal = (await db.prepare("SELECT maxHealth FROM users WHERE username = 'reclaim'").first()).maxHealth;
    assert.equal(maxFinal, maxAfterSever + 9, 'pool rose by exactly one +9 on re-equip');
    await assertHpInvariant(db, 'reclaim');
  } finally {
    await db.close();
  }
});

test('Plan 015: swapping HP gear on a full part keeps exactly one bonus, not two', async () => {
  const db = await createMigratedDb();
  const { equipItem, getUser, ensureBody } = await import('../worker/game.mjs');

  try {
    await seedLiveUser(db, 'swapper', { health: 30, maxHealth: 30 });
    await ensureBody(db, await getUser(db, 'swapper'));
    const leftBase = await partRow(db, 'swapper', 'left arm');
    const rightBase = await partRow(db, 'swapper', 'right arm');

    await insertCarriedItem(db, 'swapper', { name: 'Bracer A', slotType: 'hand', modifiers: { maxHealth: 9 } });
    await insertCarriedItem(db, 'swapper', { name: 'Bracer B', slotType: 'hand', modifiers: { maxHealth: 9 } });
    await insertCarriedItem(db, 'swapper', { name: 'Bracer C', slotType: 'hand', modifiers: { maxHealth: 9 } });

    await equipItem(db, await getUser(db, 'swapper'), 'Bracer A', 1, 1); // left arm
    await equipItem(db, await getUser(db, 'swapper'), 'Bracer B', 1, 1); // right arm
    // Both arms full; equipping C swaps the first candidate (left arm).
    await equipItem(db, await getUser(db, 'swapper'), 'Bracer C', 1, 1);

    const leftAfter = await partRow(db, 'swapper', 'left arm');
    assert.equal(leftAfter.maxHp, leftBase.maxHp + 9, 'swapped part carries exactly ONE +9 (A removed, C added)');
    const rightAfter = await partRow(db, 'swapper', 'right arm');
    assert.equal(rightAfter.maxHp, rightBase.maxHp + 9, 'untouched arm still +9 from B');

    // Bracer A is carried again and contributes nothing.
    const bracerA = await db.prepare("SELECT equippedPartId FROM items WHERE name = 'Bracer A'").first();
    assert.equal(bracerA.equippedPartId, null);
    // Pool reflects exactly two +9 bonuses across two arms (not three).
    const user = await db.prepare("SELECT maxHealth FROM users WHERE username = 'swapper'").first();
    assert.equal(user.maxHealth, 30 + 18, 'pool = base 30 + two equipped +9');
    await assertHpInvariant(db, 'swapper');
  } finally {
    await db.close();
  }
});

test('Plan 015: invariant fuzz — equip, heal, attack, unequip, equip-elsewhere stays balanced', async () => {
  const db = await createMigratedDb();
  const { equipItem, unequipItem, applyBodyHeal, applyBodyDamage, getUser, ensureBody } = await import('../worker/game.mjs');

  try {
    await seedLiveUser(db, 'fuzz', { health: 30, maxHealth: 30 });
    await ensureBody(db, await getUser(db, 'fuzz'));
    await assertHpInvariant(db, 'fuzz');

    await insertCarriedItem(db, 'fuzz', { name: 'Plate', slotType: 'torso', modifiers: { maxHealth: 9 } });
    await insertCarriedItem(db, 'fuzz', { name: 'Greave', slotType: 'leg', modifiers: { maxHealth: 4 } });

    // 1. equip torso armor
    await equipItem(db, await getUser(db, 'fuzz'), 'Plate', 1, 1);
    await assertHpInvariant(db, 'fuzz');

    // 2. heal into the new headroom
    await applyBodyHeal(db, await getUser(db, 'fuzz'), 6, {});
    await assertHpInvariant(db, 'fuzz');

    // 3. take a non-severing hit (3 damage to a part)
    await applyBodyDamage(db, await getUser(db, 'fuzz'), 3, { cause: 'a jab', random: () => 0.5 });
    await assertHpInvariant(db, 'fuzz');

    // 4. unequip the torso armor (clamps maxHealth/health back down)
    await unequipItem(db, await getUser(db, 'fuzz'), 'Plate', 1, 1);
    await assertHpInvariant(db, 'fuzz');

    // 5. equip elsewhere (a leg)
    await equipItem(db, await getUser(db, 'fuzz'), 'Greave', 1, 1);
    await assertHpInvariant(db, 'fuzz');
  } finally {
    await db.close();
  }
});

// ---- Plan 005: item templates, starting gear, and drops ----

// Returns mocked random() values in order (then repeats the last), so a test
// can assert exactly which value each consumer reads.
function makeSeq(values) {
  let index = 0;
  return () => {
    const value = values[Math.min(index, values.length - 1)];
    index += 1;
    return value;
  };
}

test('Plan 005: rollNpcDrop respects the chance gate and weighted pick', async () => {
  const { rollNpcDrop } = require('../utils/items');

  // Chance gate: ambient_hostile drops at 0.15; a high roll fails the gate.
  assert.equal(rollNpcDrop('ambient_hostile', () => 0.99), null);

  // raid_boss always drops (chance 1.0); the second value picks within the rare
  // pool. [0.0, 0.0] passes the gate and selects the first rare template.
  const boss = rollNpcDrop('raid_boss', makeSeq([0.0, 0.0]));
  assert.equal(boss.rarity, 'rare');
  assert.equal(boss.templateId, 'wyrmscale_cloak');

  // Unknown kind has no table entry.
  assert.equal(rollNpcDrop('not_a_kind', () => 0.0), null);
});

test('Plan 005: defeating an NPC drops loot onto the room floor', async () => {
  const db = await createMigratedDb();
  const { createNpcForEvent, handleAttack, updatePresence } = await import('../worker/game.mjs');

  try {
    // Plan 013g: NPCs now go through the incapacitation band, so a weak blow only DOWNS
    // them. A heavy hit (strength 60 -> 16 base damage, overkill >= the gib threshold)
    // kills outright in one blow, which is what this loot-on-defeat test needs.
    await seedLiveUser(db, 'looter', { job: 'Fighter', health: 30, maxHealth: 30, speed: 20, strength: 60 });
    const calm = findCalmRoom(getWorldDay());
    await updatePresence(db, 'looter', calm.row, calm.col);
    await createNpcForEvent(db, {
      username: 'ambient_beast',
      displayName: 'Ambient Beast',
      npcKind: 'ambient_hostile',
      worldEventId: 'test-event',
      row: calm.row,
      col: calm.col,
      health: 1,
      stamina: 100,
      speed: 1,
      strength: 1,
      intelligence: 1
    });

    // RNG consumption order for a player killing a bodyless NPC in one blow:
    //   1) speed contest (0.1 -> hit, attacker far faster)
    //   2) crit gate in calculateAttackDamage (0.99 -> no crit)
    //   3) rollNpcDrop chance gate (0.1 < 0.15 -> drops)
    //   4) rollNpcDrop weighted pick (0.0 -> first common = Rusty Knife)
    //   5) rollTrophyDrop chance gate (plan 022 tail; 0.9 >= 0.1 -> NO trophy,
    //      so this test still expects only the gear drop + remains).
    // applyBodyDamage takes the bodyless NPC branch and consumes no random.
    await withMockedRandom([0.1, 0.99, 0.1, 0.0, 0.9], () =>
      handleAttack(db, 'looter', '@ambient_beast', calm.row, calm.col));

    const floorItems = await db.prepare(
      'SELECT name, ownerUsername, roomRow, roomCol FROM items WHERE ownerUsername IS NULL'
    ).all();
    // Plan 022a: the gear drop (Rusty Knife) PLUS the always-dropped Monster Remains.
    const names = floorItems.results.map(i => i.name).sort();
    assert.deepEqual(names, ['Monster Remains', 'Rusty Knife']);
    for (const item of floorItems.results) {
      assert.equal(item.roomRow, calm.row);
      assert.equal(item.roomCol, calm.col);
    }

    const dropMessage = await db.prepare(
      "SELECT message FROM messages WHERE username = 'System' AND message LIKE '%drops%' LIMIT 1"
    ).first();
    assert.equal(dropMessage.message, 'Ambient Beast drops Rusty Knife.');
  } finally {
    await db.close();
  }
});

test('Plan 005: a dying player scatters all carried and equipped items', async () => {
  const db = await createMigratedDb();
  const { equipItem, getUser, ensureBody, moveUserToCemetery } = await import('../worker/game.mjs');

  try {
    await seedLiveUser(db, 'corpse', { health: 30, maxHealth: 30 });
    await ensureBody(db, await getUser(db, 'corpse'));
    // One carried, one equipped.
    await insertCarriedItem(db, 'corpse', { name: 'Carried Blade', slotType: 'hand' });
    await insertCarriedItem(db, 'corpse', { name: 'Worn Plate', slotType: 'torso', modifiers: { maxHealth: 5 } });
    await equipItem(db, await getUser(db, 'corpse'), 'Worn Plate', 4, 7);

    await moveUserToCemetery(db, 'corpse', 'a test fall', 4, 7);

    // Plan 022c: exclude the corpse (also dropped on death) — this asserts the
    // scattered belongings.
    const items = await db.prepare(
      "SELECT name, ownerUsername, equippedPartId, roomRow, roomCol FROM items WHERE corpseOf IS NULL ORDER BY name"
    ).all();
    assert.equal(items.results.length, 2);
    for (const item of items.results) {
      assert.equal(item.ownerUsername, null, `${item.name} no longer owned`);
      assert.equal(item.equippedPartId, null, `${item.name} no longer equipped`);
      assert.equal(item.roomRow, 4);
      assert.equal(item.roomCol, 7);
    }
    const corpse = await db.prepare("SELECT 1 AS c FROM items WHERE corpseOf = 'corpse'").first();
    assert.ok(corpse, 'the body itself dropped as a corpse');

    const scatterMessage = await db.prepare(
      "SELECT message FROM messages WHERE username = 'System' AND message LIKE '%belongings scatter%' LIMIT 1"
    ).first();
    assert.equal(scatterMessage.message, "corpse's belongings scatter across the floor.");
  } finally {
    await db.close();
  }
});

test('Plan 005: /take claims a floor item exactly once', async () => {
  const db = await createMigratedDb();
  const { handleChatAction, dropItemOnFloor, getUserState, updatePresence } = await import('../worker/game.mjs');

  try {
    await seedLiveUser(db, 'grabber', { health: 30, maxHealth: 30 });
    await seedLiveUser(db, 'rival', { health: 30, maxHealth: 30 });
    await updatePresence(db, 'grabber', 1, 1);
    await updatePresence(db, 'rival', 1, 1);
    await getUserState(db, 'grabber');
    await getUserState(db, 'rival');
    await dropItemOnFloor(db, 'rusty_knife', 1, 1);

    const taken = await handleChatAction(db, 'grabber', 1, 1, '/take Rusty Knife');
    assert.equal(taken.taken, 'Rusty Knife');

    // Now owned (carried), off the floor.
    const owned = await db.prepare(
      "SELECT ownerUsername, equippedPartId, roomRow, roomCol FROM items WHERE name = 'Rusty Knife'"
    ).first();
    assert.equal(owned.ownerUsername, 'grabber');
    assert.equal(owned.equippedPartId, null);
    assert.equal(owned.roomRow, null);
    assert.equal(owned.roomCol, null);

    // Second /take of the same name rejects (nothing left on the floor).
    await assert.rejects(
      () => handleChatAction(db, 'rival', 1, 1, '/take Rusty Knife'),
      /no such thing here/i
    );

    const takeMessage = await db.prepare(
      "SELECT COUNT(*) AS n FROM messages WHERE username = 'System' AND message = 'grabber takes Rusty Knife.'"
    ).first();
    assert.equal(takeMessage.n, 1);
  } finally {
    await db.close();
  }
});

test('Plan 005: signup grants the class signature item, equipped', async () => {
  const db = await createMigratedDb();
  const { createItemForOwner, SIGNATURE_ITEMS_BY_JOB } = await import('../worker/game.mjs');

  try {
    await seedLiveUser(db, 'newbie', { job: 'Fighter', health: 30, maxHealth: 30 });

    const itemId = await createItemForOwner(db, SIGNATURE_ITEMS_BY_JOB.Fighter, 'newbie', { equip: true });
    assert.ok(itemId > 0);

    // The granted item is equipped on one of newbie's hand-slotType parts.
    const equipped = await db.prepare(
      `SELECT i.name, i.equippedPartId, bp.slotType
       FROM items i JOIN bodyParts bp ON bp.id = i.equippedPartId
       WHERE i.ownerUsername = 'newbie' AND i.id = ?`
    ).bind(itemId).first();
    assert.equal(equipped.name, 'Iron Cleaver');
    assert.equal(equipped.slotType, 'hand');
    assert.ok(equipped.equippedPartId);
  } finally {
    await db.close();
  }
});

test('Plan 005: granting signature armor folds its HP into the worn part', async () => {
  const db = await createMigratedDb();
  const { createItemForOwner, SIGNATURE_ITEMS_BY_JOB, getUser, ensureBody } = await import('../worker/game.mjs');

  try {
    await seedLiveUser(db, 'pally', { job: 'Paladin', health: 30, maxHealth: 30 });
    await ensureBody(db, await getUser(db, 'pally')); // instantiate parts from the stored pool
    const torsoBefore = await partRow(db, 'pally', 'torso');

    // Oath Plate { maxHealth: 6 } worn on the torso must reuse plan 015's fold.
    await createItemForOwner(db, SIGNATURE_ITEMS_BY_JOB.Paladin, 'pally', { equip: true });

    const torsoAfter = await partRow(db, 'pally', 'torso');
    assert.equal(torsoAfter.maxHp, torsoBefore.maxHp + 6, 'torso maxHp rose by the bonus');

    const user = await db.prepare("SELECT health, maxHealth FROM users WHERE username = 'pally'").first();
    assert.equal(user.maxHealth, 36, 'pool maxHealth 30 -> 36');
    assert.equal(user.health, 30, 'grant is no free heal');
    await assertHpInvariant(db, 'pally');
  } finally {
    await db.close();
  }
});

test('Plan 005: floor items surface in the room payload as groundItems', async () => {
  const db = await createMigratedDb();
  const { dropItemOnFloor, getRoomEcology } = await import('../worker/game.mjs');

  try {
    const calm = findCalmRoom(getWorldDay());
    await dropItemOnFloor(db, 'padded_vest', calm.row, calm.col);

    const ecology = await getRoomEcology(db, 'observer', calm.row, calm.col);
    assert.ok(Array.isArray(ecology.groundItems));
    assert.equal(ecology.groundItems.length, 1);
    assert.equal(ecology.groundItems[0].name, 'Padded Vest');
    assert.equal(ecology.groundItems[0].slotType, 'torso');
  } finally {
    await db.close();
  }
});

// ── Plan 006: called shots, stances, regrowth ──────────────────────────────

test('Plan 006: a called shot misses where an unaimed swing would land', async () => {
  const db = await createMigratedDb();
  const { handleAttack, updatePresence } = await import('../worker/game.mjs');

  try {
    // Equal speeds => base hit chance 0.7. A called shot subtracts the 0.15
    // accuracy penalty => aimed chance 0.55. A mocked contest roll of 0.6 is
    // ABOVE 0.55 (aimed misses: 0.6 < 0.55 is false) but BELOW 0.7 (unaimed
    // hits: 0.6 < 0.7 is true). Only one Math.random() draw is consumed before
    // the hit/miss branch decides; the repeated tail value covers crit + pick.
    await seedLiveUser(db, 'sniper', { health: 30, maxHealth: 30, speed: 1, strength: 1 });
    await seedLiveUser(db, 'mark_a', { health: 30, maxHealth: 30, speed: 1 });
    await seedLiveUser(db, 'mark_b', { health: 30, maxHealth: 30, speed: 1 });

    const calm = findCalmRoom(getWorldDay());
    await updatePresence(db, 'sniper', calm.row, calm.col);
    await updatePresence(db, 'mark_a', calm.row, calm.col);
    await updatePresence(db, 'mark_b', calm.row, calm.col);

    // Aimed at mark_a's left arm: chance 0.55, roll 0.6 -> miss.
    const aimed = await withMockedRandom([0.6], () =>
      handleAttack(db, 'sniper', 'I aim for @mark_a left_arm', calm.row, calm.col));
    assert.match(aimed, /mark_a dodged/);

    // Unaimed at mark_b: chance 0.7, same roll 0.6 -> hit.
    const unaimed = await withMockedRandom([0.6, 0.99, 0.5], () =>
      handleAttack(db, 'sniper', 'I swing at @mark_b', calm.row, calm.col));
    assert.match(unaimed, /sniper .*mark_b.*\(\d+\)/);
  } finally {
    await db.close();
  }
});

test('Plan 006: a called shot lands on exactly the named part', async () => {
  const db = await createMigratedDb();
  const { handleAttack, getBodyParts, updatePresence } = await import('../worker/game.mjs');

  try {
    // Force the hit (roll 0.1 < 0.55 aimed chance), no crit (0.99), and a
    // pickTargetPart draw (0.95 -> a leg) that the called shot OVERRIDES: damage
    // must land on the left arm, never the leg the random pick chose.
    await seedLiveUser(db, 'placer', { health: 30, maxHealth: 30, speed: 1, strength: 1 });
    await seedLiveUser(db, 'limb', { health: 30, maxHealth: 30, speed: 1 });

    const calm = findCalmRoom(getWorldDay());
    await updatePresence(db, 'placer', calm.row, calm.col);
    await updatePresence(db, 'limb', calm.row, calm.col);

    // base damage = 1 + floor(1/4) = 1; left arm has hp 3 so no sever/spill.
    await withMockedRandom([0.1, 0.99, 0.95], () =>
      handleAttack(db, 'placer', 'I cut @limb left_arm', calm.row, calm.col));

    const parts = await getBodyParts(db, 'limb');
    const leftArm = parts.find(p => p.label === 'left arm');
    const rightLeg = parts.find(p => p.label === 'right leg');
    assert.equal(leftArm.hp, 2, 'left arm took the 1 damage (3 -> 2)');
    assert.equal(rightLeg.hp, 3, 'the randomly-picked leg was untouched');

    // Invariant: users.health == Σ part hp.
    const user = await db.prepare("SELECT health FROM users WHERE username = 'limb'").first();
    assert.equal(user.health, await sumBodyHp(db, 'limb'));
  } finally {
    await db.close();
  }
});

test('Plan 006: an aimed head hit does +1 damage versus an unaimed head hit', async () => {
  const db = await createMigratedDb();
  const { handleAttack, getBodyParts, updatePresence } = await import('../worker/game.mjs');

  try {
    // getBodyParts orders torso first, so the 11-part weighted roll ranges are:
    // torso [0.0,0.30), head [0.30,0.4667). A pick draw of 0.35 lands
    // pickTargetPart on the head, letting us compare the same part with and
    // without aiming. head maxHp is 5 at maxHealth 30.
    await seedLiveUser(db, 'archer', { health: 30, maxHealth: 30, speed: 1, strength: 1 });
    await seedLiveUser(db, 'head_a', { health: 30, maxHealth: 30, speed: 1 });
    await seedLiveUser(db, 'head_b', { health: 30, maxHealth: 30, speed: 1 });

    const calm = findCalmRoom(getWorldDay());
    await updatePresence(db, 'archer', calm.row, calm.col);
    await updatePresence(db, 'head_a', calm.row, calm.col);
    await updatePresence(db, 'head_b', calm.row, calm.col);

    // Aimed head: hit (0.1 < 0.55), no crit (0.99), pick draw 0.35 (overridden by
    // the called shot). base 1 + head bonus 1 = 2 damage -> head 5 -> 3.
    await withMockedRandom([0.1, 0.99, 0.35], () =>
      handleAttack(db, 'archer', 'arrow to the head @head_a', calm.row, calm.col));
    const headA = (await getBodyParts(db, 'head_a')).find(p => p.label === 'head');
    assert.equal(headA.hp, 3, 'aimed head took 2 damage (base 1 + head bonus 1)');

    // Unaimed but forced to the head via the pick draw 0.35: hit (0.1 < 0.7),
    // no crit (0.99), pick 0.35 -> head. base 1, no bonus -> head 5 -> 4.
    await withMockedRandom([0.1, 0.99, 0.35], () =>
      handleAttack(db, 'archer', 'I swing at @head_b', calm.row, calm.col));
    const headB = (await getBodyParts(db, 'head_b')).find(p => p.label === 'head');
    assert.equal(headB.hp, 4, 'unaimed head took 1 damage');

    assert.equal((headB.hp - headA.hp), 1, 'aimed head dealt exactly 1 more');
  } finally {
    await db.close();
  }
});

test('Aim never blocks: aiming at a SEVERED part LANDS un-aimed (no rejection) and emits the clean-shot note', async () => {
  const db = await createMigratedDb();
  const { handleAttackAction, applyBodyDamage, getUser, getBodyParts, updatePresence } = await import('../worker/game.mjs');

  try {
    // Was "Plan 006: aiming at a severed part rejects before any stamina is spent": the
    // old contract REJECTED a called shot at a gone part with "There is nothing left to
    // aim at." (a blocking alert client-side). New contract: aiming is best-effort, so the
    // attack STILL LANDS as a normal weighted-random hit and the player gets a flavor note.
    // strength 1 keeps the blow small so a torso/limb hit can't kill the 30-HP target — we
    // only need to prove the attack resolved (no throw) and struck somewhere.
    await seedLiveUser(db, 'duelist', { health: 30, maxHealth: 30, speed: 5, strength: 1, stamina: 100, maxStamina: 100 });
    await seedLiveUser(db, 'stump', { health: 30, maxHealth: 30, speed: 1 });

    const calm = findCalmRoom(getWorldDay());
    await updatePresence(db, 'duelist', calm.row, calm.col);
    await updatePresence(db, 'stump', calm.row, calm.col);

    // Sever stump's left arm first (random 0.5 -> left arm; 4 damage -> sever).
    await applyBodyDamage(db, await getUser(db, 'stump'), 4, {
      cause: 'a prior wound', row: calm.row, col: calm.col, random: () => 0.5
    });
    const armBefore = (await getBodyParts(db, 'stump')).find(p => p.label === 'left arm');
    assert.equal(armBefore.severed, 1, 'the left arm is severed going in');
    const healthBefore = (await db.prepare("SELECT health FROM users WHERE username = 'stump'").first()).health;
    const staminaBefore = (await db.prepare("SELECT stamina FROM users WHERE username = 'duelist'").first()).stamina;

    // Aim at the severed left arm via the toolbar field. The aim is dropped to a random
    // hit; the attack resolves rather than throwing. RNG (handleAttack per target): speed
    // contest (0.0 -> hit), crit gate (0.99 -> none), pickTargetPart (0.0 -> torso).
    let result;
    await withMockedRandom([0.0, 0.99, 0.0], async () => {
      result = await handleAttackAction(db, 'duelist', calm.row, calm.col, '@stump', 'left_arm');
    });

    // No rejection: the attack landed and produced the clean-shot note (the arm is gone).
    assert.match(result.updatedMessage, /can't get a clean shot at the left arm — strikes where they can\./);
    assert.doesNotMatch(result.updatedMessage, /There is nothing left to aim at/);
    const healthAfter = (await db.prepare("SELECT health FROM users WHERE username = 'stump'").first()).health;
    assert.ok(healthAfter < healthBefore, 'the attack landed somewhere (the random fallback hit)');

    // A landed action spends its stamina (the whole point — the attack is no longer blocked).
    const staminaAfter = (await db.prepare("SELECT stamina FROM users WHERE username = 'duelist'").first()).stamina;
    assert.equal(staminaAfter, staminaBefore - 1, 'a landed attack spent its 1 stamina');
  } finally {
    await db.close();
  }
});

test('Plan 006: /stance guarding cuts incoming damage by 1; /stance nonsense rejects', async () => {
  const db = await createMigratedDb();
  const { handleAttack, handleChatAction, getBodyParts, updatePresence } = await import('../worker/game.mjs');

  try {
    // Two identical defenders; one guards (damageTakenDelta -1). Same attacker,
    // same forced RNG. base damage = 1 + floor(8/4) = 3. Standing defender takes
    // 3; guarding defender takes 3 - 1 = 2. Pick draw 0.2 -> torso (hp 9) on
    // both, so neither severs and the comparison is clean.
    await seedLiveUser(db, 'basher', { health: 30, maxHealth: 30, speed: 1, strength: 8 });
    await seedLiveUser(db, 'plain', { health: 30, maxHealth: 30, speed: 1 });
    await seedLiveUser(db, 'turtle', { health: 30, maxHealth: 30, speed: 1, stamina: 100, maxStamina: 100 });

    const calm = findCalmRoom(getWorldDay());
    await updatePresence(db, 'basher', calm.row, calm.col);
    await updatePresence(db, 'plain', calm.row, calm.col);
    await updatePresence(db, 'turtle', calm.row, calm.col);

    // turtle adopts a guarding stance.
    const stanceResult = await handleChatAction(db, 'turtle', calm.row, calm.col, '/stance guarding');
    assert.equal(stanceResult.stance, 'guarding');
    const turtleRow = await db.prepare("SELECT stance FROM users WHERE username = 'turtle'").first();
    assert.equal(turtleRow.stance, 'guarding');

    // Standing defender: hit (0.1 < 0.7), no crit (0.99), pick 0.2 -> torso.
    await withMockedRandom([0.1, 0.99, 0.2], () =>
      handleAttack(db, 'basher', 'I clobber @plain', calm.row, calm.col));
    const plainTorso = (await getBodyParts(db, 'plain')).find(p => p.label === 'torso');
    assert.equal(plainTorso.hp, 6, 'standing defender took 3 damage (9 -> 6)');

    // Guarding defender: same rolls, damage 3 - 1 = 2 (9 -> 7).
    await withMockedRandom([0.1, 0.99, 0.2], () =>
      handleAttack(db, 'basher', 'I clobber @turtle', calm.row, calm.col));
    const turtleTorso = (await getBodyParts(db, 'turtle')).find(p => p.label === 'torso');
    assert.equal(turtleTorso.hp, 7, 'guarding defender took only 2 damage (9 -> 7)');

    // An unknown stance is rejected with the option list and changes nothing.
    await assert.rejects(
      () => handleChatAction(db, 'plain', calm.row, calm.col, '/stance nonsense'),
      /Unknown stance.*standing.*aggressive.*guarding.*crouched/
    );
    const plainStance = await db.prepare("SELECT stance FROM users WHERE username = 'plain'").first();
    assert.equal(plainStance.stance, 'standing', 'rejected stance left the default in place');
  } finally {
    await db.close();
  }
});

test('Plan 006: an aggressive attacker hits harder and lands where standing would miss', async () => {
  const db = await createMigratedDb();
  const { handleAttack, handleChatAction, getBodyParts, updatePresence } = await import('../worker/game.mjs');

  try {
    // Aggressive stance: hitBonus +0.05, damageBonus +1. Equal speeds => base
    // 0.7; aggressive attacker chance 0.75. A contest roll of 0.72 MISSES a
    // standing attacker (0.72 < 0.70 is false) but HITS an aggressive one
    // (0.72 < 0.75 is true). When it lands, damage = base 1 + 1 = 2.
    await seedLiveUser(db, 'standing_atk', { health: 30, maxHealth: 30, speed: 1, strength: 1, stamina: 100, maxStamina: 100 });
    await seedLiveUser(db, 'raging_atk', { health: 30, maxHealth: 30, speed: 1, strength: 1, stamina: 100, maxStamina: 100 });
    await seedLiveUser(db, 'dummy_a', { health: 30, maxHealth: 30, speed: 1 });
    await seedLiveUser(db, 'dummy_b', { health: 30, maxHealth: 30, speed: 1 });

    const calm = findCalmRoom(getWorldDay());
    await updatePresence(db, 'standing_atk', calm.row, calm.col);
    await updatePresence(db, 'raging_atk', calm.row, calm.col);
    await updatePresence(db, 'dummy_a', calm.row, calm.col);
    await updatePresence(db, 'dummy_b', calm.row, calm.col);

    // Standing attacker, roll 0.72 -> miss (chance 0.70).
    const standMiss = await withMockedRandom([0.72], () =>
      handleAttack(db, 'standing_atk', 'I jab @dummy_a', calm.row, calm.col));
    assert.match(standMiss, /dummy_a dodged/);

    // raging_atk goes aggressive, then same roll 0.72 -> hit (chance 0.75).
    await handleChatAction(db, 'raging_atk', calm.row, calm.col, '/stance aggressive');
    // hit (0.72 < 0.75), no crit (0.99), pick 0.5 -> left arm. damage 1+1 = 2.
    const rageHit = await withMockedRandom([0.72, 0.99, 0.5], () =>
      handleAttack(db, 'raging_atk', 'I jab @dummy_b', calm.row, calm.col));
    assert.match(rageHit, /raging_atk .*dummy_b.*\(2\)/);
    const dummyArm = (await getBodyParts(db, 'dummy_b')).find(p => p.label === 'left arm');
    assert.equal(dummyArm.hp, 1, 'aggressive attacker dealt 2 (base 1 + damageBonus 1): arm 3 -> 1');
  } finally {
    await db.close();
  }
});

async function grantInnAccess(db, username, row, col, worldDay, fee = 0) {
  await db.prepare(
    `INSERT INTO roomAccess (username, roomRow, roomCol, accessType, costPaid, worldDay)
     VALUES (?, ?, ?, 'inn', ?, ?)`
  ).bind(username, row, col, fee, worldDay).run();
}

test('Plan 006: /regrow at a paid inn restores a severed part and rejects repeats, non-inns, and the broke', async () => {
  const db = await createMigratedDb();
  // The regrow EFFECT (un-sever, hp 1, maxHp = baseMaxHp, pool bookkeeping,
  // gold, cooldown, message) is asserted through handleRegrowCommand directly:
  // that is the `perform` step, with NO tick advance, so the inn's post-action
  // passive heal (+2 hp/stamina) can't perturb the exact numbers. The full
  // handleChatAction path is exercised separately to confirm the staminaCost 20
  // and tick advance wiring, and to drive every validation rejection (which all
  // throw BEFORE spendStamina, so stamina stays exact).
  const {
    handleChatAction, handleRegrowCommand, applyBodyDamage,
    getBodyParts, getUser, ensureBody, updatePresence
  } = await import('../worker/game.mjs');

  try {
    const worldDay = getWorldDay();
    const inn = findInnRoom(worldDay);
    const calm = findCalmRoom(worldDay);

    await seedLiveUser(db, 'pilgrim', { health: 30, maxHealth: 30, speed: 1, stamina: 100, maxStamina: 100, gold: 100 });
    await updatePresence(db, 'pilgrim', inn.row, inn.col);
    await ensureBody(db, await getUser(db, 'pilgrim'));

    // Sever the left leg: random 0.8 -> left leg (range [0.7333, 0.8667)), 4
    // damage -> sever. baseMaxHp of that part is 4 (un-fortified).
    await applyBodyDamage(db, await getUser(db, 'pilgrim'), 4, {
      cause: 'a bad fall', row: inn.row, col: inn.col, random: () => 0.8
    });
    const severed = (await getBodyParts(db, 'pilgrim')).find(p => p.label === 'left leg');
    assert.equal(severed.severed, 1, 'left leg is severed before regrow');
    const baseMaxHp = severed.baseMaxHp;
    const maxBefore = (await db.prepare("SELECT maxHealth FROM users WHERE username = 'pilgrim'").first()).maxHealth;

    // Non-inn room rejects (no stamina spent) — full command path.
    await updatePresence(db, 'pilgrim', calm.row, calm.col);
    const staminaPreNonInn = (await db.prepare("SELECT stamina FROM users WHERE username = 'pilgrim'").first()).stamina;
    await assert.rejects(
      () => handleChatAction(db, 'pilgrim', calm.row, calm.col, '/regrow left leg'),
      /Regrowth rites require an inn\./
    );
    assert.equal(
      (await db.prepare("SELECT stamina FROM users WHERE username = 'pilgrim'").first()).stamina,
      staminaPreNonInn,
      'non-inn rejection spent no stamina'
    );

    // At the inn but unpaid -> rejects.
    await updatePresence(db, 'pilgrim', inn.row, inn.col);
    await assert.rejects(
      () => handleChatAction(db, 'pilgrim', inn.row, inn.col, '/regrow left leg'),
      /pay for inn access/
    );

    // Pay (grant access directly), then a broke player rejects with no stamina spent.
    await grantInnAccess(db, 'pilgrim', inn.row, inn.col, worldDay);
    await db.prepare("UPDATE users SET gold = 10 WHERE username = 'pilgrim'").run();
    const staminaPreBroke = (await db.prepare("SELECT stamina FROM users WHERE username = 'pilgrim'").first()).stamina;
    await assert.rejects(
      () => handleChatAction(db, 'pilgrim', inn.row, inn.col, '/regrow left leg'),
      /Not enough gold/
    );
    assert.equal(
      (await db.prepare("SELECT stamina FROM users WHERE username = 'pilgrim'").first()).stamina,
      staminaPreBroke,
      'broke rejection spent no stamina'
    );

    // Confirm the full command path's staminaCost (20) + tick advance wiring,
    // tolerating the inn passive's stamina top-up: a successful /regrow must
    // advance the tick and leave stamina strictly below the pre-call value.
    await db.prepare("UPDATE users SET gold = 100 WHERE username = 'pilgrim'").run();
    const tickBefore = (await db.prepare('SELECT value FROM tick WHERE id = 1').first()).value;
    const staminaPrePath = (await db.prepare("SELECT stamina FROM users WHERE username = 'pilgrim'").first()).stamina;
    const pathResult = await handleChatAction(db, 'pilgrim', inn.row, inn.col, '/regrow left leg');
    assert.equal(pathResult.regrew, 'left leg');
    const tickAfter = (await db.prepare('SELECT value FROM tick WHERE id = 1').first()).value;
    assert.equal(tickAfter, tickBefore + 1, 'a successful regrow advanced the tick');
    const staminaAfterPath = (await db.prepare("SELECT stamina FROM users WHERE username = 'pilgrim'").first()).stamina;
    assert.ok(staminaAfterPath <= staminaPrePath - 20 + 2, 'regrow spent ~20 stamina (inn may refund 2)');
    assert.ok(staminaAfterPath < staminaPrePath, 'regrow spent stamina');

    // The first /regrow above consumed the per-day cooldown, so to assert the
    // EXACT regrow effect we use a fresh user and call handleRegrowCommand (the
    // perform step, no tick/passive).
    await seedLiveUser(db, 'mendicant', { health: 30, maxHealth: 30, speed: 1, stamina: 100, maxStamina: 100 });
    await db.prepare("UPDATE users SET gold = 100 WHERE username = 'mendicant'").run(); // seedLiveUser ignores gold
    await updatePresence(db, 'mendicant', inn.row, inn.col);
    await ensureBody(db, await getUser(db, 'mendicant'));
    await applyBodyDamage(db, await getUser(db, 'mendicant'), 4, {
      cause: 'a bad fall', row: inn.row, col: inn.col, random: () => 0.8
    });
    const mendSevered = (await getBodyParts(db, 'mendicant')).find(p => p.label === 'left leg');
    const mendBase = mendSevered.baseMaxHp;
    const mendMaxBefore = (await db.prepare("SELECT maxHealth FROM users WHERE username = 'mendicant'").first()).maxHealth;
    await grantInnAccess(db, 'mendicant', inn.row, inn.col, worldDay);

    const result = await handleRegrowCommand(db, 'mendicant', inn.row, inn.col, '/regrow left leg');
    assert.equal(result.regrew, 'left leg');

    const regrown = (await getBodyParts(db, 'mendicant')).find(p => p.label === 'left leg');
    assert.equal(regrown.severed, 0, 'leg is no longer severed');
    assert.equal(regrown.hp, 1, 'regrown part returns at hp 1');
    assert.equal(regrown.maxHp, mendBase, 'regrown part returns at baseMaxHp');

    const after = await db.prepare("SELECT health, maxHealth, gold FROM users WHERE username = 'mendicant'").first();
    assert.equal(after.maxHealth, mendMaxBefore + mendBase, 'maxHealth restored by exactly baseMaxHp');
    assert.equal(after.gold, 75, 'regrow cost 25 gold');
    await assertHpInvariant(db, 'mendicant');

    const message = await db.prepare(
      "SELECT message FROM messages WHERE message LIKE '%regrows, pale and new%' AND message LIKE 'mendicant%' LIMIT 1"
    ).first();
    assert.ok(message, 'regrow emits the rite message');

    // A second regrow the same day is rejected (cooldown), no stamina spent —
    // back through the full command path.
    await db.prepare("UPDATE bodyParts SET severed = 1, hp = 0, maxHp = 0 WHERE username = 'mendicant' AND label = 'right leg'").run();
    const staminaPreSecond = (await db.prepare("SELECT stamina FROM users WHERE username = 'mendicant'").first()).stamina;
    await assert.rejects(
      () => handleChatAction(db, 'mendicant', inn.row, inn.col, '/regrow right leg'),
      /once per day/
    );
    assert.equal(
      (await db.prepare("SELECT stamina FROM users WHERE username = 'mendicant'").first()).stamina,
      staminaPreSecond,
      'second-regrow rejection spent no stamina'
    );
  } finally {
    await db.close();
  }
});

test('Plan 006: /regrow restores the BASE maxHp, not a lingering fortified one', async () => {
  const db = await createMigratedDb();
  // handleRegrowCommand directly (the perform step, no tick) so the inn's
  // post-action passive heal can't bump the freshly-regrown 1-hp part and muddy
  // the BASE-vs-fortified comparison.
  const { handleRegrowCommand, equipItem, applyBodyDamage, applyBodyHeal, getUser, ensureBody, updatePresence } = await import('../worker/game.mjs');

  try {
    const worldDay = getWorldDay();
    const inn = findInnRoom(worldDay);

    await seedLiveUser(db, 'relic', { health: 30, maxHealth: 30, speed: 1, stamina: 100, maxStamina: 100 });
    await db.prepare("UPDATE users SET gold = 100 WHERE username = 'relic'").run(); // seedLiveUser ignores gold
    await updatePresence(db, 'relic', inn.row, inn.col);
    await ensureBody(db, await getUser(db, 'relic'));

    // Base left arm maxHp is 4; equip armor with maxHealth 6 -> arm maxHp 10.
    const armBase = await partRow(db, 'relic', 'left arm');
    const baseMaxHp = armBase.baseMaxHp;
    assert.equal(armBase.maxHp, baseMaxHp, 'arm starts at its base maxHp');

    await insertCarriedItem(db, 'relic', { name: 'Bracer', slotType: 'hand', modifiers: { maxHealth: 6 } });
    await equipItem(db, await getUser(db, 'relic'), 'Bracer', inn.row, inn.col); // left arm
    await applyBodyHeal(db, await getUser(db, 'relic'), 6, {}); // fill the headroom

    const fortified = await partRow(db, 'relic', 'left arm');
    assert.equal(fortified.maxHp, baseMaxHp + 6, 'arm is fortified to base + 6');
    assert.equal(fortified.baseMaxHp, baseMaxHp, 'baseMaxHp untouched by armor');

    // Sever the fortified arm (random 0.5 -> left arm). The Bracer is knocked off.
    await applyBodyDamage(db, await getUser(db, 'relic'), fortified.maxHp, {
      cause: 'a cleaver', row: inn.row, col: inn.col, random: () => 0.5
    });
    const severed = await partRow(db, 'relic', 'left arm');
    assert.equal(severed.severed, 1, 'arm is severed');
    await assertHpInvariant(db, 'relic');

    // Pay inn access, then regrow.
    await grantInnAccess(db, 'relic', inn.row, inn.col, worldDay);
    const result = await handleRegrowCommand(db, 'relic', inn.row, inn.col, '/regrow left arm');
    assert.equal(result.regrew, 'left arm');

    const regrown = await partRow(db, 'relic', 'left arm');
    assert.equal(regrown.maxHp, baseMaxHp, 'arm returns at BASE maxHp, NOT base + 6');
    assert.notEqual(regrown.maxHp, baseMaxHp + 6, 'fortified maxHp did not linger');
    assert.equal(regrown.hp, 1);
    // Invariant: users.maxHealth == Σ non-severed maxHp still holds.
    await assertHpInvariant(db, 'relic');
  } finally {
    await db.close();
  }
});
