// Plan 013f: NPCs die for real (no respawn on the next presence heartbeat) and die LIKE
// players — a last broken plea, and the surviving room reacts. CommonJS + node:test.

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

test('adv-019: the death-reaction line is DEFERRED behind the attack + defeat lines, not emitted immediately', async () => {
  const db = await createMigratedDb();
  const game = await import('../worker/game.mjs');
  try {
    const room = findCalmRoom(getWorldDay());
    // A heavy hitter so a single landed blow gibs the 1-HP victim (blowDamage >= GIB_OVERKILL=15
    // => true death this tick => defeatNpc => emitDeathReaction). strength 80 => 1 + floor(80/4) = 21.
    await db.prepare(
      `INSERT INTO users (username, password, job, health, maxHealth, stamina, maxStamina, speed, strength, intelligence, level)
       VALUES ('slayer', 'pw', 'Fighter', 30, 30, 100, 100, 20, 80, 5, 1)`
    ).bind().run();
    await game.updatePresence(db, 'slayer', room.row, room.col);
    await game.getUserState(db, 'slayer'); // instantiate the attacker's body

    // A scalar (bodyless) hostile victim with 1 HP — one blow ends it. Distinct, mentionable name.
    await db.prepare(
      `INSERT INTO users (username, password, job, health, maxHealth, stamina, maxStamina, speed, strength, intelligence, level, isNpc, displayName, npcKind, disposition, role, npcWorldDay)
       VALUES ('mob:goblin:0', 'npc', 'Novice', 1, 1, 100, 100, 1, 1, 1, 1, 1, 'Goblin', 'ambient_hostile', 'hostile', 'patron', ?)`
    ).bind(getWorldDay()).run();
    await game.updatePresence(db, 'mob:goblin:0', room.row, room.col);

    // A surviving SOCIAL bystander — the one who reacts. Friendly, so the reaction is horror.
    await addSocialNpc(db, game, 'soc:witness', 'Joss', 'friendly', room.row, room.col);

    // Drive the real attack path with a deferred buffer, exactly as handleAttackAction does:
    // handleAttack returns the attacker's combined line (inserted as a normal message), and
    // every system line it spins off (defeat, death-reaction) is pushed onto the buffer to be
    // flushed AFTER. Before this fix, emitDeathReaction destructured the wrong param name and
    // inserted the reaction IMMEDIATELY — landing before the attacker's own line.
    const deferredSystemMessages = [];
    const original = Math.random;
    Math.random = () => 0.001; // guarantee the speed contest lands (and a benign crit roll)
    let attackLine;
    try {
      attackLine = await game.handleAttack(db, 'slayer', '@Goblin', room.row, room.col, { deferredSystemMessages });
    } finally {
      Math.random = original;
    }

    // The victim is truly dead (gibbed -> defeatNpc), confirming we exercised the reaction path.
    assert.equal(await db.prepare("SELECT username FROM users WHERE username = 'mob:goblin:0'").first(), null, 'the goblin was truly slain');

    // (a) The reaction is in the DEFERRED buffer (it was NOT inserted immediately).
    const defeatIdx = deferredSystemMessages.findIndex(d => /Goblin is defeated by slayer/.test(d.message));
    const reactionIdx = deferredSystemMessages.findIndex(d => /^Joss:/.test(d.message));
    assert.ok(defeatIdx >= 0, 'the defeat line was deferred');
    assert.ok(reactionIdx >= 0, 'the death-reaction line was deferred (the bug dropped it from the buffer)');
    // (b) ...and it sits AFTER the defeat line within the buffer.
    assert.ok(reactionIdx > defeatIdx, 'the reaction is ordered after the defeat line in the deferred buffer');

    // (c) End-to-end order in the room log: flush the buffer after the attacker's own line,
    // mirroring handlers.mjs, and assert the reaction lands AFTER both the attack and defeat lines.
    await game.insertMessage(db, room.row, room.col, 'slayer', attackLine);
    for (const d of deferredSystemMessages) {
      await game.insertSystemMessage(db, room.row, room.col, d.message, d.kind);
    }
    const log = await db.prepare("SELECT message FROM messages WHERE roomRow = ? AND roomCol = ? ORDER BY id ASC").bind(room.row, room.col).all();
    const order = log.results.map(r => r.message);
    const attackPos = order.findIndex(m => m.includes('slayer') && m.includes('Goblin') && !/defeated/.test(m));
    const defeatPos = order.findIndex(m => /Goblin is defeated by slayer/.test(m));
    const reactionPos = order.findIndex(m => /^Joss:/.test(m));
    assert.ok(attackPos >= 0 && defeatPos >= 0 && reactionPos >= 0, 'all three lines are present in the room log');
    assert.ok(attackPos < reactionPos, 'the attacker\'s own line precedes the death reaction');
    assert.ok(defeatPos < reactionPos, 'the defeat line precedes the death reaction');
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
