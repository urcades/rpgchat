// Plan 006 integration coverage — drives stances through the real combat path,
// covering axes the workerMigration.test.js suite does NOT already assert:
//   - a DEFENDER's stance dodgeBonus flipping a hit into a miss (existing stance
//     tests cover guarding's damageTakenDelta and an aggressive attacker's
//     hitBonus + damageBonus, but never the defender-dodge axis);
//   - /stance round-tripping through the handler into the getUserState payload's
//     `stance` field (existing tests only read users.stance straight from SQL).
//
// handleAttack is called directly (not handleAttackAction) so awardGoldMaybe's
// random draws stay out of the mocked sequence — the same convention the
// existing combat tests use. RNG order per attacked target inside handleAttack:
//   1) speed contest      (Math.random() < hitChance)
//   2) crit gate          (Math.random() < 0.01, in calculateAttackDamage)
//   3) pickTargetPart     (weighted part draw in applyBodyDamage)
//
// CommonJS + node:test to match the rest of test/.

const assert = require('node:assert/strict');
const test = require('node:test');
const { createSqliteD1, createMigratedDb } = require('./.helpers/d1');
const { getWorldDay, generateRoomFeatures } = require('../utils/roomEcology');

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

async function seedLiveUser(db, username, overrides = {}) {
  const stats = {
    job: 'Novice', health: 30, maxHealth: 30, stamina: 100, maxStamina: 100,
    speed: 1, strength: 1, intelligence: 1, level: 0, ...overrides
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

// ---------------------------------------------------------------------------

test('Plan 006: a crouched defender dodges a hit a standing defender would take', async () => {
  const db = await createMigratedDb();
  const { handleAttack, handleChatAction, getBodyParts, getUserState, updatePresence } = await import('../worker/game.mjs');

  try {
    // Equal speeds => base hit chance 0.70. Crouched stance gives the DEFENDER
    // dodgeBonus +0.1, which lowers the attacker's chance against them to 0.60.
    // A single contest roll of 0.65 HITS a standing defender (0.65 < 0.70) but
    // MISSES a crouched one (0.65 < 0.60 is false). Only the contest draw is read
    // before the miss branch returns; the hit branch then reads crit + pick.
    await seedLiveUser(db, 'striker', { health: 30, maxHealth: 30, speed: 1, strength: 1 });
    await seedLiveUser(db, 'stander', { health: 30, maxHealth: 30, speed: 1 });
    await seedLiveUser(db, 'ducker', { health: 30, maxHealth: 30, speed: 1, stamina: 100, maxStamina: 100 });

    const calm = findCalmRoom(getWorldDay());
    await updatePresence(db, 'striker', calm.row, calm.col);
    await updatePresence(db, 'stander', calm.row, calm.col);
    await updatePresence(db, 'ducker', calm.row, calm.col);

    // Instantiate the defenders' body part rows up front. The dodging defender
    // never gets hit, so applyBodyDamage (which lazily ensureBody's) wouldn't run
    // on them — without this their bodyParts would be empty and the post-dodge
    // arm assertion would have nothing to read.
    await getUserState(db, 'stander');
    await getUserState(db, 'ducker');

    // ducker crouches; the stance persists on the row.
    const stanceResult = await handleChatAction(db, 'ducker', calm.row, calm.col, '/stance crouched');
    assert.equal(stanceResult.stance, 'crouched');

    // Standing defender, roll 0.65 -> hit (chance 0.70), no crit, pick 0.5 -> left arm.
    const landed = await withMockedRandom([0.65, 0.99, 0.5], () =>
      handleAttack(db, 'striker', 'I swing at @stander', calm.row, calm.col));
    assert.match(landed, /striker .*stander.*\(1\)/, 'standing defender is struck for 1');
    const standerArm = (await getBodyParts(db, 'stander')).find(p => p.label === 'left arm');
    assert.equal(standerArm.hp, 3, 'standing defender took the 1 damage (4 -> 3)');

    // Crouched defender, SAME roll 0.65 -> miss (chance 0.60). Only one draw read.
    const dodged = await withMockedRandom([0.65], () =>
      handleAttack(db, 'striker', 'I swing at @ducker', calm.row, calm.col));
    assert.match(dodged, /ducker dodged/, 'crouched defender slips the same swing');
    const duckerArm = (await getBodyParts(db, 'ducker')).find(p => p.label === 'left arm');
    assert.equal(duckerArm.hp, 4, 'crouched defender took no damage');
  } finally {
    await db.close();
  }
});

test('Plan 024: an explicit aimed part (targeting toolbar) routes the hit to that limb, beats the prose, and never leaks into chat', async () => {
  const db = await createMigratedDb();
  const { handleAttack, getBodyParts, getUserState, updatePresence } = await import('../worker/game.mjs');

  try {
    await seedLiveUser(db, 'sniper', { health: 30, maxHealth: 30, speed: 1, strength: 1 });
    await seedLiveUser(db, 'mark', { health: 30, maxHealth: 30, speed: 1 });

    const calm = findCalmRoom(getWorldDay());
    await updatePresence(db, 'sniper', calm.row, calm.col);
    await updatePresence(db, 'mark', calm.row, calm.col);
    await getUserState(db, 'mark'); // instantiate the defender's body part rows

    // A head called shot costs CALLED_SHOT_HIT_PENALTY (0.15) accuracy: equal speeds
    // give base 0.70, so the contest threshold is 0.55. Roll 0.5 still lands; crit
    // 0.99 misses; the pick draw (0.5 -> would be left arm) is consumed but overridden
    // by the explicit aim. The prose ALSO names 'left arm' — the toolbar part must win.
    const landed = await withMockedRandom([0.5, 0.99, 0.5], () =>
      handleAttack(db, 'sniper', 'I swing at @mark left arm', calm.row, calm.col, { targetPart: 'head' }));

    assert.match(landed, /sniper .*mark.*\(2\)/, 'base 1 + aimed-head bonus 1 = 2 damage');
    assert.doesNotMatch(landed, /\bhead\b/i, 'the aimed limb never appears in the chat prose');

    const parts = await getBodyParts(db, 'mark');
    const head = parts.find(p => p.label === 'head');
    const leftArm = parts.find(p => p.label === 'left arm');
    assert.equal(head.hp, head.maxHp - 2, 'the head took the 2 damage');
    assert.equal(leftArm.hp, leftArm.maxHp, 'the prose-named left arm is untouched — the toolbar aim wins');
  } finally {
    await db.close();
  }
});

test('Plan 006: /stance round-trips through the handler into the getUserState payload', async () => {
  const db = await createMigratedDb();
  const { handleChatAction, getUserState, updatePresence } = await import('../worker/game.mjs');

  try {
    await seedLiveUser(db, 'poser', { health: 30, maxHealth: 30, stamina: 100, maxStamina: 100 });
    await updatePresence(db, 'poser', 1, 1);

    // Default stance surfaces as standing before any /stance command.
    const fresh = await getUserState(db, 'poser');
    assert.equal(fresh.stance, 'standing', 'a new player defaults to standing');

    await handleChatAction(db, 'poser', 1, 1, '/stance aggressive');
    const aggressive = await getUserState(db, 'poser');
    assert.equal(aggressive.stance, 'aggressive', 'aggressive stance surfaces in the payload');

    // Switching again overwrites, not stacks.
    await handleChatAction(db, 'poser', 1, 1, '/stance guarding');
    const guarding = await getUserState(db, 'poser');
    assert.equal(guarding.stance, 'guarding', 'the latest stance wins');

    // The stance system message lands in the room.
    const message = await db.prepare(
      "SELECT message FROM messages WHERE username = 'System' AND message LIKE 'poser takes a%' ORDER BY id DESC LIMIT 1"
    ).first();
    assert.equal(message.message, 'poser takes a Guarding stance.');
  } finally {
    await db.close();
  }
});
