// Plan 024: the living leaderboard surfaces LEVEL and KILL COUNT next to gold.
// getLeaderboard derives kills from killHistory with the same correlated COUNT(*)
// the cemetery/death pages use — no kills column, no migration. These tests pin
// the count-per-killer, the NPC exclusion, and the kills -> level -> gold sort.
// CommonJS + node:test, in-memory sqlite3 D1 shim, mirroring brutalTombstone.test.js.

const assert = require('node:assert/strict');
const test = require('node:test');
const { createMigratedDb } = require('./.helpers/d1');

const { dbRun } = require('../worker/db.mjs');

async function seedPlayer(db, username, { level = 0, gold = 0, isNpc = 0 } = {}) {
  await dbRun(
    db,
    `INSERT INTO users (username, password, job, health, maxHealth, stamina, maxStamina, speed, strength, intelligence, level, gold, isNpc)
     VALUES (?, 'pw', 'Novice', 10, 10, 100, 100, 1, 1, 1, ?, ?, ?)`,
    [username, level, gold, isNpc]
  );
}

async function recordKill(db, killer, victim, kind = 'player') {
  await dbRun(
    db,
    `INSERT INTO killHistory (killerUsername, defeatedUsername, defeatedName, defeatedKind, defeatedLevel, worldDay, tick)
     VALUES (?, ?, ?, ?, 1, '2026-06-16', 1)`,
    [killer, victim, victim, kind]
  );
}

test('Plan 024: kills are counted per killer from killHistory (players and NPCs both count)', async () => {
  const db = await createMigratedDb();
  try {
    await seedPlayer(db, 'reaper', { level: 5, gold: 10 });
    await seedPlayer(db, 'pacifist', { level: 5, gold: 10 });

    await recordKill(db, 'reaper', 'victimA');
    await recordKill(db, 'reaper', 'victimB');
    await recordKill(db, 'reaper', 'a_rat', 'npc');

    const { getLeaderboard } = await import('../worker/game.mjs');
    const board = await getLeaderboard(db);

    const reaper = board.find(p => p.username === 'reaper');
    const pacifist = board.find(p => p.username === 'pacifist');
    assert.equal(reaper.kills, 3, 'every recorded kill counts, NPC or player');
    assert.equal(pacifist.kills, 0, 'a killer with no killHistory rows has 0 kills');
  } finally {
    await db.close();
  }
});

test('Plan 024: NPCs are excluded from the leaderboard, even if they have kills', async () => {
  const db = await createMigratedDb();
  try {
    await seedPlayer(db, 'hero', { level: 3, gold: 5 });
    await seedPlayer(db, 'a_goblin', { level: 9, gold: 99, isNpc: 1 });

    // The NPC has the most kills, the highest level, and the most gold — it must
    // still never appear on the board (and a player's kills tally NPC victims).
    await recordKill(db, 'a_goblin', 'hero');
    await recordKill(db, 'a_goblin', 'someone');
    await recordKill(db, 'hero', 'a_goblin', 'npc');

    const { getLeaderboard } = await import('../worker/game.mjs');
    const board = await getLeaderboard(db);

    const usernames = board.map(p => p.username);
    assert.ok(!usernames.includes('a_goblin'), 'the NPC never appears, despite leading on kills/level/gold');
    assert.ok(usernames.includes('hero'), 'living players still appear');
    const hero = board.find(p => p.username === 'hero');
    assert.equal(hero.kills, 1, "a player's kill of an NPC still counts");
  } finally {
    await db.close();
  }
});

test('Plan 024: ordering is kills desc, then level desc, then gold desc', async () => {
  const db = await createMigratedDb();
  try {
    // The migration seeds a 'System' player (isNpc 0, gold 9999). getLeaderboard now
    // excludes it by name, so it must not appear on the board at all (asserted below).
    await seedPlayer(db, 'topKills', { level: 1, gold: 1 });   // 2 kills
    await seedPlayer(db, 'tieKillsHiLvl', { level: 9, gold: 1 }); // 1 kill, high level
    await seedPlayer(db, 'tieKillsLoLvl', { level: 2, gold: 999 }); // 1 kill, low level, most gold
    await seedPlayer(db, 'tieAllButGold', { level: 2, gold: 500 }); // 1 kill, same level as above, less gold

    await recordKill(db, 'topKills', 'a');
    await recordKill(db, 'topKills', 'b');
    await recordKill(db, 'tieKillsHiLvl', 'c');
    await recordKill(db, 'tieKillsLoLvl', 'd');
    await recordKill(db, 'tieAllButGold', 'e');

    const { getLeaderboard } = await import('../worker/game.mjs');
    const board = await getLeaderboard(db);
    const ranked = board.map(p => p.username);

    assert.deepEqual(
      ranked,
      ['topKills', 'tieKillsHiLvl', 'tieKillsLoLvl', 'tieAllButGold'],
      'kills break ties first, then level, then gold'
    );
    // The System account is excluded from the player leaderboard entirely.
    assert.ok(!board.some(p => p.username === 'System'), 'System never appears on the board');
  } finally {
    await db.close();
  }
});

test('adv-006: an all-equal tie (same kills/level/gold) is broken DETERMINISTICALLY by username ASC', async () => {
  const db = await createMigratedDb();
  try {
    // Three players identical on every ranking key, seeded out of alphabetical order.
    // Without the username tie-break the order would be insertion/rowid-dependent;
    // with it the board is stable and sorted by username ascending.
    await seedPlayer(db, 'charlie', { level: 4, gold: 50 });
    await seedPlayer(db, 'alice', { level: 4, gold: 50 });
    await seedPlayer(db, 'bob', { level: 4, gold: 50 });

    // One kill each — equal kills too, so ONLY the username tie-break can order them.
    await recordKill(db, 'charlie', 'v1');
    await recordKill(db, 'alice', 'v2');
    await recordKill(db, 'bob', 'v3');

    const { getLeaderboard } = await import('../worker/game.mjs');
    const board = await getLeaderboard(db);
    const ranked = board.filter(p => ['alice', 'bob', 'charlie'].includes(p.username)).map(p => p.username);

    assert.deepEqual(ranked, ['alice', 'bob', 'charlie'], 'all-equal ties resolve by username ASC, stably');
  } finally {
    await db.close();
  }
});

test('Plan 024: each row carries username, level, kills, and gold', async () => {
  const db = await createMigratedDb();
  try {
    await seedPlayer(db, 'sole', { level: 7, gold: 42 });
    await recordKill(db, 'sole', 'x');
    await recordKill(db, 'sole', 'y');

    const { getLeaderboard } = await import('../worker/game.mjs');
    const board = await getLeaderboard(db);
    const sole = board.find(p => p.username === 'sole');

    assert.deepEqual(
      { username: sole.username, level: sole.level, kills: sole.kills, gold: sole.gold },
      { username: 'sole', level: 7, kills: 2, gold: 42 },
      'the row shape the leaderboard.html table renders'
    );
  } finally {
    await db.close();
  }
});
