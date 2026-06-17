// adv-017/018: atomicity of the permadeath + resurrection transitions. D1 has no
// interactive transactions and the Durable Object does NOT serialize these writes — HTTP
// handlers, the cron, and the DO alarm all hit env.DB concurrently. Each lethal/revive
// transition is made single-effect with a claim-via-conditional-UPDATE + changes()===1
// gate. These tests reproduce the genuine racing interleaving by firing the same path
// twice CONCURRENTLY (Promise.all) against one shared in-memory DB — so both callers' reads
// land before either's write, exactly as the real race — and assert a SINGLE effect: one
// grave, one recorded kill, one recreated user, one payout. Without each claim the same
// interleaving deterministically double-applies (verified during development by neutering
// the guard). CommonJS + node:test.

const assert = require('node:assert/strict');
const test = require('node:test');
const { createSqliteD1, createMigratedDb } = require('./.helpers/d1');
const { getWorldDay, generateRoomFeatures } = require('../utils/roomEcology');

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
  const { job = 'Novice', health = 30, speed = 1, strength = 1, gold = 0 } = opts;
  await db.prepare(
    `INSERT INTO users (username, password, job, health, maxHealth, stamina, maxStamina, speed, strength, intelligence, level, gold)
     VALUES (?, 'pw', ?, ?, 30, 100, 100, ?, ?, 1, 1, ?)`
  ).bind(username, job, health, speed, strength, gold).run();
}

async function countRows(db, sql, params = []) {
  const stmt = db.prepare(sql);
  const row = await (params.length ? stmt.bind(...params) : stmt.bind()).first();
  return row.n;
}

// ---------------------------------------------------------------------------
// Fix 1 (CRIT) — descendTowardDeath: the down->finish lethal step is claimed with the
// `incapacitated = 2` sentinel (UPDATE ... WHERE incapacitated < 2; only the changes()===1
// winner calls finishOff). Two concurrent killing blows on one downed body — a /attack
// finisher interleaving the DO-alarm hostile turn, or two attackers — both read
// incapacitated=1; without the claim both cross DEATH_FLOOR and finishOff, double-recording
// the kill. Assert exactly ONE recorded kill (and one grave / one corpse).

test('adv-017: two CONCURRENT finishing blows on one downed player → one recorded kill + one grave', async () => {
  const db = await createMigratedDb();
  const { descendTowardDeath, getUserState, updatePresence } = await import('../worker/game.mjs');
  try {
    const room = findCalmRoom(getWorldDay());
    await seedUser(db, 'victim', { health: 8 });
    await updatePresence(db, 'victim', room.row, room.col);
    await getUserState(db, 'victim'); // instantiate body

    // A modest blow DOWNS the victim (overkill under the gib threshold).
    const down = await descendTowardDeath(db, 'victim', { cause: 'attack by slayer', row: room.row, col: room.col, blowDamage: 6, overkill: 2, currentTick: 1 });
    assert.equal(down.state, 'incapacitated');
    assert.equal((await db.prepare("SELECT incapacitated FROM users WHERE username = 'victim'").first()).incapacitated, 1);

    // Two lethal finishers fire AT THE SAME TIME against the one downed body. Both reads
    // see incapacitated=1; the claim lets exactly one finish. The lethal recordKill lives
    // upstream of the grave, so a missing claim doubles the kill even though the separate
    // moveUserToCemetery delete-claim would still dedupe the grave.
    const lethal = { cause: 'attack by slayer', row: room.row, col: room.col, blowDamage: 30, overkill: 30, currentTick: 2 };
    const [a, b] = await Promise.all([
      descendTowardDeath(db, 'victim', lethal),
      descendTowardDeath(db, 'victim', lethal)
    ]);
    assert.deepEqual([a.state, b.state].sort(), ['gibbed', 'gibbed'], 'both callers raced the same downed body');

    assert.equal(await countRows(db, "SELECT COUNT(*) AS n FROM killHistory WHERE defeatedUsername = 'victim'"), 1, 'exactly ONE recorded kill — recordKill fired once');
    assert.equal(await countRows(db, "SELECT COUNT(*) AS n FROM cemetery WHERE username = 'victim'"), 1, 'exactly ONE grave');
    assert.equal(await countRows(db, "SELECT COUNT(*) AS n FROM items WHERE corpseOf = 'victim'"), 1, 'exactly ONE corpse anchor');
    assert.equal(await db.prepare("SELECT username FROM users WHERE username = 'victim'").first(), null, 'the player is gone');
  } finally {
    await db.close();
  }
});

test('adv-017: two CONCURRENT gibs of a STANDING victim → one kill + one grave (standing-gib claim)', async () => {
  const db = await createMigratedDb();
  const { descendTowardDeath, getUserState, updatePresence } = await import('../worker/game.mjs');
  try {
    const room = findCalmRoom(getWorldDay());
    await seedUser(db, 'meat', { health: 30 });
    await updatePresence(db, 'meat', room.row, room.col);
    await getUserState(db, 'meat');

    // Both blows are gib-grade and both land while the victim still stands (the standing
    // branch). Both reads see incapacitated=0; the standing-gib claim (incapacitated 0 -> 2)
    // lets one finish and the other no-op.
    const lethal = { cause: 'attack by ogre', row: room.row, col: room.col, blowDamage: 40, overkill: 40, currentTick: 1 };
    const [a, b] = await Promise.all([
      descendTowardDeath(db, 'meat', lethal),
      descendTowardDeath(db, 'meat', lethal)
    ]);
    assert.deepEqual([a.state, b.state].sort(), ['gibbed', 'gibbed']);

    assert.equal(await countRows(db, "SELECT COUNT(*) AS n FROM killHistory WHERE defeatedUsername = 'meat'"), 1, 'one kill');
    assert.equal(await countRows(db, "SELECT COUNT(*) AS n FROM cemetery WHERE username = 'meat'"), 1, 'one grave');
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// Fix 2 (CRIT) — moveUserToCemetery: the user-delete is the claim point (DELETE FROM users
// FIRST; lay the grave/corpse only if changes()===1). Two concurrent reachings (e.g. a
// room-hazard death racing a combat finisher) must lay exactly one grave + one corpse.

test('adv-017: two CONCURRENT moveUserToCemetery calls → one grave + one corpse (delete is the claim)', async () => {
  const db = await createMigratedDb();
  const { moveUserToCemetery, getUserState } = await import('../worker/game.mjs');
  try {
    await seedUser(db, 'doomed');
    await getUserState(db, 'doomed'); // instantiate body

    // Both callers read the live user; the delete-claim lets exactly one entomb. Without
    // it, both INSERT a grave (two graves + two corpses).
    const [a, b] = await Promise.all([
      moveUserToCemetery(db, 'doomed', 'a fall', 5, 5),
      moveUserToCemetery(db, 'doomed', 'a fall', 5, 5)
    ]);
    assert.deepEqual([a, b].sort(), [false, true], 'exactly one entombment won; the other bailed');

    assert.equal(await countRows(db, "SELECT COUNT(*) AS n FROM cemetery WHERE username = 'doomed'"), 1, 'exactly ONE grave');
    assert.equal(await countRows(db, "SELECT COUNT(*) AS n FROM items WHERE corpseOf = 'doomed'"), 1, 'exactly ONE corpse');
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// Fix 3 (HIGH) — revivePlayer: claim the grave (DELETE ... WHERE id, changes()===1), then
// INSERT OR IGNORE the user and consume the corpse. Two concurrent revives on one corpse
// must recreate the user once and clear the grave once — no PK violation, no second delete.

test('adv-017: two CONCURRENT Cleric revives on one corpse → user recreated once, grave gone once', async () => {
  const db = await createMigratedDb();
  const { moveUserToCemetery, getUserState } = await import('../worker/game.mjs');
  const { revivePlayer } = await import('../worker/resurrection.mjs');
  try {
    await seedUser(db, 'fallen', { gold: 42 });
    await getUserState(db, 'fallen');
    await moveUserToCemetery(db, 'fallen', 'a fall', 5, 5);
    assert.equal(await db.prepare("SELECT username FROM users WHERE username = 'fallen'").first(), null, 'precondition: dead');
    assert.ok(await db.prepare("SELECT 1 FROM cemetery WHERE username = 'fallen'").first(), 'precondition: grave exists');

    // Two revives race the one corpse. The grave-claim lets one win; the loser no-ops with
    // no_grave. Without the claim the 2nd INSERT would PK-violate (or both delete the grave).
    const [a, b] = await Promise.all([
      revivePlayer(db, 'fallen', 5, 5),
      revivePlayer(db, 'fallen', 5, 5)
    ]);
    const revived = [a, b].filter(r => r.revived);
    const noops = [a, b].filter(r => !r.revived);
    assert.equal(revived.length, 1, 'exactly one revive won');
    assert.equal(noops.length, 1, 'exactly one revive no-opped');
    assert.equal(noops[0].reason, 'no_grave', 'the loser reports the grave already gone');

    assert.equal(await countRows(db, "SELECT COUNT(*) AS n FROM users WHERE username = 'fallen'"), 1, 'the user is recreated exactly once');
    assert.equal(await countRows(db, "SELECT COUNT(*) AS n FROM cemetery WHERE username = 'fallen'"), 0, 'the grave is gone (once)');
    assert.equal(await countRows(db, "SELECT COUNT(*) AS n FROM items WHERE corpseOf = 'fallen'"), 0, 'the corpse is consumed');
    // Progression survives the revive (the grave carried it).
    assert.equal((await db.prepare("SELECT gold FROM users WHERE username = 'fallen'").first()).gold, 42, 'stored gold restored');
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// Fix 4 (MED) — awardEventVictory: claim the completion FIRST (active -> completed; award
// only on changes()===1). A boss "finished" twice must pay each present player ONCE. Driven
// with a captured boss row (defeatNpc deletes the NPC mid-way but the event payout does not
// re-read it) — the faithful model of two killing blows racing through defeatNpc.

test('adv-017: a raid boss finished twice pays the room exactly once (event-complete claim)', async () => {
  const db = await createMigratedDb();
  const game = await import('../worker/game.mjs');
  try {
    const room = findCalmRoom(getWorldDay());
    const worldDay = getWorldDay();
    await seedUser(db, 'raider', { strength: 5, speed: 5 });
    await game.updatePresence(db, 'raider', room.row, room.col);

    await db.prepare(
      `INSERT INTO worldEvents (id, worldDay, eventType, roomRow, roomCol, status, title, description, rewardExperience, rewardGold, createdTick, expiresTick)
       VALUES ('evt-race', ?, 'raid', ?, ?, 'active', 'The Maw', 'desc', 100, 50, 0, 9999)`
    ).bind(worldDay, room.row, room.col).run();
    await db.prepare(
      `INSERT INTO users (username, password, job, health, maxHealth, stamina, maxStamina, speed, strength, intelligence, level, isNpc, displayName, npcKind, disposition, role, npcWorldDay, worldEventId)
       VALUES ('boss:maw', 'npc', 'Novice', 1, 1, 100, 100, 1, 1, 1, 5, 1, 'The Maw', 'raid_boss', 'hostile', 'patron', ?, 'evt-race')`
    ).bind(worldDay).run();
    await game.updatePresence(db, 'boss:maw', room.row, room.col);

    const goldBefore = (await db.prepare("SELECT gold FROM users WHERE username = 'raider'").first()).gold;

    // Two killing blows race through defeatNpc -> awardEventVictory with the same captured
    // boss row. The first claims the event (active -> completed) and pays; the second sees
    // it already completed and skips the (non-idempotent) XP/gold payout.
    const boss = await db.prepare("SELECT * FROM users WHERE username = 'boss:maw'").first();
    await game.defeatNpc(db, boss, { killer: 'raider', row: room.row, col: room.col, currentTick: 1 });
    await game.defeatNpc(db, boss, { killer: 'raider', row: room.row, col: room.col, currentTick: 1 });

    assert.equal((await db.prepare("SELECT status FROM worldEvents WHERE id = 'evt-race'").first()).status, 'completed', 'the event is completed');
    const goldAfter = (await db.prepare("SELECT gold FROM users WHERE username = 'raider'").first()).gold;
    assert.equal(goldAfter - goldBefore, 50, 'the raider is paid the reward gold EXACTLY ONCE (not doubled)');
    assert.equal(await countRows(db, "SELECT COUNT(*) AS n FROM worldEventAchievements WHERE username = 'raider' AND eventId = 'evt-race'"), 1, 'exactly one victory achievement');
    assert.equal(await countRows(db, "SELECT COUNT(*) AS n FROM messages WHERE message = 'The Maw has been cleared.'"), 1, 'the room is told the event cleared exactly once');
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// Fix 5 (MED) — defeatNpc social-respawn ordering: the npc_dead cooldown is written BEFORE
// the NPC user row is deleted, so a presence heartbeat cannot slip a respawn into the gap.

test('adv-017: defeatNpc stamps the npc_dead cooldown BEFORE deleting the slain social NPC', async () => {
  const db = await createMigratedDb();
  const game = await import('../worker/game.mjs');
  try {
    const room = findCalmRoom(getWorldDay());
    const worldDay = getWorldDay();
    await db.prepare(
      `INSERT INTO users (username, password, job, health, maxHealth, stamina, maxStamina, speed, strength, intelligence, level, isNpc, displayName, npcKind, disposition, role, npcWorldDay)
       VALUES ('soc:mark', 'npc', 'Fighter', 20, 20, 100, 100, 4, 5, 1, 2, 1, 'Mark', 'social', 'friendly', 'patron', ?)`
    ).bind(worldDay).run();
    await game.updatePresence(db, 'soc:mark', room.row, room.col);
    const npc = await db.prepare("SELECT * FROM users WHERE username = 'soc:mark'").first();

    // Spy on the prepared-statement layer to capture, AT THE MOMENT the NPC's user row is
    // deleted, whether the npc_dead cooldown already exists. The ordering invariant (Fix 5):
    // the gravestone must be stamped FIRST, so a presence heartbeat firing in the gap between
    // the two writes can never resurrect the slot. If the order were reversed (delete first),
    // cooldownPresentAtDelete would be false and this test fails — which is exactly the gap.
    let cooldownPresentAtDelete = null;
    const realPrepare = db.prepare.bind(db);
    db.prepare = (sql) => {
      const stmt = realPrepare(sql);
      if (/DELETE FROM users WHERE username = \? AND isNpc = 1/.test(sql)) {
        const realRun = stmt.run.bind(stmt);
        stmt.run = async () => {
          const cd = await realPrepare(
            "SELECT 1 AS present FROM roomEffectCooldowns WHERE username = 'soc:mark' AND effectType = 'npc_dead'"
          ).bind().first();
          cooldownPresentAtDelete = Boolean(cd);
          return realRun();
        };
      }
      return stmt;
    };

    await game.defeatNpc(db, npc, { killer: 'slayer', row: room.row, col: room.col, currentTick: 7 });
    db.prepare = realPrepare;

    assert.equal(cooldownPresentAtDelete, true, 'the npc_dead cooldown was already stamped when the NPC row was deleted (gravestone-before-delete)');

    const cooldown = await db.prepare(
      "SELECT lastAppliedTick FROM roomEffectCooldowns WHERE username = 'soc:mark' AND effectType = 'npc_dead' AND worldDay = ?"
    ).bind(worldDay).first();
    assert.ok(cooldown, 'the npc_dead cooldown persists');
    assert.equal(cooldown.lastAppliedTick, 7, 'stamped at the kill tick');
    assert.equal(await db.prepare("SELECT username FROM users WHERE username = 'soc:mark'").first(), null, 'the NPC row is removed');
  } finally {
    await db.close();
  }
});
