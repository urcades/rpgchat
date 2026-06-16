// Plan 021 (BOLD): NPC anatomy parity + elite growth. Monsters are now first-class
// citizens of the body-part system players have — a bodied NPC (creatureBodyPlan set)
// routes through the IDENTICAL per-part pipeline (pickTargetPart, spill-to-torso, sever,
// vital-death, real overkill), dies through the SAME incap/gib band, and an elite carries
// scaled stats + affixes. A creatureBodyPlan=NULL NPC stays scalar (the gate intact).
//
// CommonJS + node:test, mirroring npcParity / gibbing / npcDeath. RNG is injected via
// withMockedRandom; each test documents its RNG consumption order (the 004 convention).
//
// THE INVARIANT under test: users.health == Σ bodyParts.hp must hold for a BODIED NPC
// through every mutation — including the incapacitation/gib band 013g/023 once assumed
// could never reach an NPC (because every NPC used to be bodyless). assertNpcInvariant is
// called after each mutation, exactly as plan 004 did for players.

const assert = require('node:assert/strict');
const test = require('node:test');
const { createSqliteD1, createMigratedDb } = require('./.helpers/d1');
const { getWorldDay, generateRoomFeatures } = require('../utils/roomEcology');
const { WYRM_PLAN } = require('../utils/body');

function findCalmRoom(worldDay) {
  const hazardous = ['poison_marsh', 'moon_room', 'echo_chamber', 'pub', 'inn', 'sun_room', 'cold_room', 'guild'];
  for (let row = 1; row <= 16; row += 1) {
    for (let col = 1; col <= 16; col += 1) {
      if (!generateRoomFeatures(row, col, worldDay).map(f => f.effect?.type).some(t => hazardous.includes(t))) return { row, col };
    }
  }
  throw new Error('No calm room');
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

// The contract for a BODIED NPC: users.health == Σ bodyParts.hp. (A scalar NPC has no
// bodyParts rows, so this is checked separately.)
async function assertNpcInvariant(db, username, where) {
  const u = await db.prepare('SELECT health FROM users WHERE username = ?').bind(username).first();
  const sum = await db.prepare('SELECT COALESCE(SUM(hp), 0) AS s FROM bodyParts WHERE username = ?').bind(username).first();
  assert.equal(u.health, sum.s, `health == Σ bodyParts.hp ${where} (health=${u.health}, Σhp=${sum.s})`);
}

// Spawn a bodied NPC directly (the production decorate path is exercised separately).
async function seedBodiedNpc(db, game, { username, displayName, plan, health, room, strength = 6, affixes = null }) {
  await game.createNpcForEvent(db, {
    username,
    displayName,
    npcKind: 'raid_boss',
    level: 6,
    health,
    maxHealth: health,
    stamina: 100,
    speed: 5,
    strength,
    intelligence: 1,
    worldEventId: 'evt-anat',
    row: room.row,
    col: room.col,
    worldDay: getWorldDay(),
    creatureBodyPlan: plan,
    affixes
  });
  // Materialize the body now (it would otherwise instantiate lazily on first hit).
  const row = await db.prepare('SELECT * FROM users WHERE username = ?').bind(username).first();
  await game.ensureBody(db, row);
  return row;
}

// ---------------------------------------------------------------------------

test('Plan 021 (1): a called shot SEVERS a wyrm wing — maxHealth drops by the wing pool, the message reads by display name, the wyrm survives (non-vital)', async () => {
  const db = await createMigratedDb();
  const game = await import('../worker/game.mjs');
  try {
    const room = findCalmRoom(getWorldDay());
    // health 100 → wing pool = 0.10 * 100 = 10. A 10-damage called shot to the left wing
    // drives it 10 -> 0 (severed) with NO spill (remaining 0), so no vital part is touched.
    await seedBodiedNpc(db, game, { username: 'wyrm', displayName: 'Frost Wyrm', plan: 'wyrm', health: 100, room });
    await assertNpcInvariant(db, 'wyrm', 'before any hit');

    const wingBefore = (await game.getBodyParts(db, 'wyrm')).find(p => p.label === 'left wing');
    assert.equal(wingBefore.maxHp, 10, 'wing pool is 10');
    const maxBefore = (await db.prepare("SELECT maxHealth FROM users WHERE username = 'wyrm'").first()).maxHealth;

    const target = await db.prepare('SELECT * FROM users WHERE username = ?').bind('wyrm').first();
    // RNG order inside applyBodyDamage: ONE pickTargetPart draw (consumed even on a called
    // shot, then overridden by targetLabel). 0.0 would pick the body, but the called shot
    // wins — we still pass 0.0 to pin the consumed draw.
    const result = await withMockedRandom([0.0], () => game.applyBodyDamage(db, target, 10, {
      cause: 'attack by hunter', row: room.row, col: room.col, targetLabel: 'left wing', displayLabel: 'Frost Wyrm'
    }));

    assert.equal(result.died, false, 'a severed wing is non-vital — the wyrm lives');
    assert.deepEqual(result.severedLabels, ['left wing']);
    const wingAfter = (await game.getBodyParts(db, 'wyrm')).find(p => p.label === 'left wing');
    assert.equal(wingAfter.severed, 1, 'the wing is severed');
    assert.equal(wingAfter.hp, 0);
    const maxAfter = (await db.prepare("SELECT maxHealth FROM users WHERE username = 'wyrm'").first()).maxHealth;
    assert.equal(maxBefore - maxAfter, 10, 'maxHealth drops by exactly the wing pool');
    const msg = await db.prepare("SELECT message FROM messages WHERE message = ?").bind("Frost Wyrm's left wing is destroyed.").first();
    assert.ok(msg, 'the sever message reads by the display name');
    const alive = await db.prepare("SELECT username FROM users WHERE username = 'wyrm'").first();
    assert.ok(alive, 'the wyrm is still alive');
    await assertNpcInvariant(db, 'wyrm', 'after wing sever');
  } finally {
    await db.close();
  }
});

test('Plan 021 (1b): handleAttack honors a called shot vs a BODIED NPC end-to-end (combat seam) — wing severed by name', async () => {
  const db = await createMigratedDb();
  const game = await import('../worker/game.mjs');
  try {
    const room = findCalmRoom(getWorldDay());
    // strength 40 → base damage 1 + floor(40/4) = 11, enough to sever a 10-HP wing.
    await db.prepare(
      `INSERT INTO users (username, password, job, health, maxHealth, stamina, maxStamina, speed, strength, intelligence, level)
       VALUES ('hunter', 'pw', 'Fighter', 30, 30, 100, 100, 1, 40, 5, 4)`
    ).run();
    await game.updatePresence(db, 'hunter', room.row, room.col);
    await seedBodiedNpc(db, game, { username: 'wyrm', displayName: 'Frost Wyrm', plan: 'wyrm', health: 100, room, strength: 6 });

    // RNG order in handleAttack per target: speed contest (0.0 → hit), crit gate (0.99 →
    // no crit), pickTargetPart (0.5 → consumed, then OVERRIDDEN by the called shot).
    const out = await withMockedRandom([0.0, 0.99, 0.5], () =>
      game.handleAttack(db, 'hunter', 'aim for the left wing @wyrm', room.row, room.col));
    assert.match(out, /hunter .*Frost Wyrm.*\(\d+\)/, 'the wyrm was struck');
    const wing = (await game.getBodyParts(db, 'wyrm')).find(p => p.label === 'left wing');
    assert.equal(wing.severed, 1, 'the called shot severed the named wing on the bodied NPC');
    const msg = await db.prepare("SELECT message FROM messages WHERE message = ?").bind("Frost Wyrm's left wing is destroyed.").first();
    assert.ok(msg, 'the sever message reads by the NPC display name');
    await assertNpcInvariant(db, 'wyrm', 'after a called-shot sever via handleAttack');
  } finally {
    await db.close();
  }
});

test('Plan 021 fix: handleAttackAction (the /attack ROUTE gate) accepts a toolbar called shot at a BODIED NPC — no "nothing left to aim at"', async () => {
  const db = await createMigratedDb();
  const game = await import('../worker/game.mjs');
  try {
    const room = findCalmRoom(getWorldDay());
    // Regression: validateCalledShot (only on handleAttackAction, the real /attack route — NOT
    // the lower-level handleAttack the other 021 tests drive) used to `continue` past every NPC,
    // so a toolbar called shot at ANY bodied NPC threw "There is nothing left to aim at." A brute
    // Room Lurker with a roomy HP pool survives one head shot, so we can assert the hit LANDED.
    await db.prepare(
      `INSERT INTO users (username, password, job, health, maxHealth, stamina, maxStamina, speed, strength, intelligence, level)
       VALUES ('hunter', 'pw', 'Fighter', 30, 30, 100, 100, 1, 8, 5, 4)`
    ).run();
    await game.updatePresence(db, 'hunter', room.row, room.col);
    await seedBodiedNpc(db, game, { username: 'lurker', displayName: 'Room Lurker', plan: 'brute', health: 100, room, strength: 4 });

    const headBefore = (await game.getBodyParts(db, 'lurker')).find(p => p.label === 'head');
    // The toolbar passes the aimed limb as the 6th arg (targetPart) — the path the player hits.
    // RNG (handleAttack per target): speed contest (0.0 hit), crit gate (0.99 none), pickTargetPart
    // (0.5, consumed then overridden by the called shot).
    await withMockedRandom([0.0, 0.99, 0.5, 0.5], () =>
      game.handleAttackAction(db, 'hunter', room.row, room.col, '@lurker', 'head'));

    const headAfter = (await game.getBodyParts(db, 'lurker')).find(p => p.label === 'head');
    assert.ok(headAfter.hp < headBefore.hp, 'the route accepted the called shot and it landed on the head (no rejection)');
    assert.ok(await db.prepare("SELECT username FROM users WHERE username = 'lurker'").first(), 'a modest head shot did not kill the high-HP lurker');
    await assertNpcInvariant(db, 'lurker', 'after a route-level called shot on a bodied NPC');
  } finally {
    await db.close();
  }
});

test('Aim never blocks (route): aiming at a SEVERED part on a bodied NPC RESOLVES — the NPC takes damage somewhere AND the clean-shot note is emitted (no "nothing left to aim at")', async () => {
  const db = await createMigratedDb();
  const game = await import('../worker/game.mjs');
  try {
    const room = findCalmRoom(getWorldDay());
    // strength 1 keeps the fallback blow tiny so the high-HP lurker survives — we only need
    // to prove the attack RESOLVED (no throw) and landed somewhere after the aim was dropped.
    await db.prepare(
      `INSERT INTO users (username, password, job, health, maxHealth, stamina, maxStamina, speed, strength, intelligence, level)
       VALUES ('hunter', 'pw', 'Fighter', 30, 30, 100, 100, 5, 1, 5, 4)`
    ).run();
    await game.updatePresence(db, 'hunter', room.row, room.col);
    await seedBodiedNpc(db, game, { username: 'lurker', displayName: 'Room Lurker', plan: 'brute', health: 100, room, strength: 4 });

    // Sever the lurker's left arm up front (a brute's arm pool is ~12 HP; 20 damage severs
    // it with no spill reaching a vital part on a 100-HP body). pick draw 0.5 is consumed
    // then overridden by the called shot.
    const armPool = (await game.getBodyParts(db, 'lurker')).find(p => p.label === 'left arm').maxHp;
    const lurkerRow = await db.prepare('SELECT * FROM users WHERE username = ?').bind('lurker').first();
    await withMockedRandom([0.5], () => game.applyBodyDamage(db, lurkerRow, armPool, {
      cause: 'a prior wound', row: room.row, col: room.col, targetLabel: 'left arm', displayLabel: 'Room Lurker'
    }));
    const armBefore = (await game.getBodyParts(db, 'lurker')).find(p => p.label === 'left arm');
    assert.equal(armBefore.severed, 1, 'the left arm is severed before the aimed attack');
    const healthBefore = (await db.prepare("SELECT health FROM users WHERE username = 'lurker'").first()).health;

    // Now aim at the GONE left arm via the route (toolbar 6th arg). The aim is best-effort:
    // it drops to a weighted-random hit and resolves. RNG: speed (0.0 hit), crit (0.99 none),
    // pickTargetPart (0.0 -> torso/body, the ordered-first live part), then a trailing >=0.1
    // so awardGoldMaybe's draw doesn't branch into a second roll.
    let result;
    await withMockedRandom([0.0, 0.99, 0.0, 0.5], async () => {
      result = await game.handleAttackAction(db, 'hunter', room.row, room.col, '@lurker', 'left_arm');
    });

    assert.match(result.updatedMessage, /can't get a clean shot at the left arm — strikes where they can\./, 'the clean-shot flavor note is emitted');
    assert.doesNotMatch(result.updatedMessage, /There is nothing left to aim at/, 'the route did NOT reject the aim');
    assert.ok(await db.prepare("SELECT username FROM users WHERE username = 'lurker'").first(), 'the lurker survived the tiny fallback blow');
    const healthAfter = (await db.prepare("SELECT health FROM users WHERE username = 'lurker'").first()).health;
    assert.ok(healthAfter < healthBefore, 'the NPC took damage somewhere (the random fallback landed)');
    await assertNpcInvariant(db, 'lurker', 'after a route-level aim at a severed part');
  } finally {
    await db.close();
  }
});

test('Aim never blocks (route regression): aiming at a VALID part on a bodied NPC still lands on that EXACT part — no fallback, no note', async () => {
  const db = await createMigratedDb();
  const game = await import('../worker/game.mjs');
  try {
    const room = findCalmRoom(getWorldDay());
    await db.prepare(
      `INSERT INTO users (username, password, job, health, maxHealth, stamina, maxStamina, speed, strength, intelligence, level)
       VALUES ('hunter', 'pw', 'Fighter', 30, 30, 100, 100, 1, 8, 5, 4)`
    ).run();
    await game.updatePresence(db, 'hunter', room.row, room.col);
    await seedBodiedNpc(db, game, { username: 'lurker', displayName: 'Room Lurker', plan: 'brute', health: 100, room, strength: 4 });

    const armBefore = (await game.getBodyParts(db, 'lurker')).find(p => p.label === 'left arm');
    assert.equal(armBefore.severed, 0, 'the left arm is intact going in');
    // Aim at the intact left arm via the route. The aim STANDS (the part is live), so the
    // blow lands on exactly that part and NO clean-shot note is emitted. RNG: speed (0.0 hit),
    // crit (0.99 none), pickTargetPart (0.5, consumed then OVERRIDDEN by the called shot),
    // trailing >=0.1 so awardGoldMaybe doesn't roll twice.
    let result;
    await withMockedRandom([0.0, 0.99, 0.5, 0.5], async () => {
      result = await game.handleAttackAction(db, 'hunter', room.row, room.col, '@lurker', 'left_arm');
    });

    const armAfter = (await game.getBodyParts(db, 'lurker')).find(p => p.label === 'left arm');
    assert.ok(armAfter.hp < armBefore.hp, 'the called shot landed on the EXACT aimed part (left arm)');
    assert.doesNotMatch(result.updatedMessage, /can't get a clean shot/, 'a valid aim emits NO fallback note');
    await assertNpcInvariant(db, 'lurker', 'after a valid route-level called shot');
  } finally {
    await db.close();
  }
});

test('Plan 021 (2): the health == Σ hp invariant holds for a bodied NPC across several attacks', async () => {
  const db = await createMigratedDb();
  const game = await import('../worker/game.mjs');
  try {
    const room = findCalmRoom(getWorldDay());
    await seedBodiedNpc(db, game, { username: 'brute', displayName: 'Restless Brute', plan: 'brute', health: 60, room });
    await assertNpcInvariant(db, 'brute', 'fresh');

    // Several uneven blows; re-load the row each time (health changes) and vary the pick.
    for (const [amount, pick] of [[5, 0.1], [7, 0.6], [3, 0.95], [9, 0.0], [4, 0.5]]) {
      const target = await db.prepare('SELECT * FROM users WHERE username = ?').bind('brute').first();
      if (!target || target.health <= 0) break;
      await withMockedRandom([pick], () => game.applyBodyDamage(db, target, amount, {
        cause: 'attack by hunter', row: room.row, col: room.col, displayLabel: 'Restless Brute'
      }));
      await assertNpcInvariant(db, 'brute', `after a ${amount}-damage blow`);
    }
  } finally {
    await db.close();
  }
});

test('Plan 021 (3): a vital-part death routes a bodied NPC to defeatNpc — user row AND bodyParts rows gone, remains + reaction', async () => {
  const db = await createMigratedDb();
  const game = await import('../worker/game.mjs');
  try {
    const room = findCalmRoom(getWorldDay());
    // A witness so the room can react to the death.
    await db.prepare(
      `INSERT INTO users (username, password, job, health, maxHealth, stamina, maxStamina, speed, strength, intelligence, level)
       VALUES ('hunter', 'pw', 'Fighter', 30, 30, 100, 100, 5, 20, 5, 4)`
    ).run();
    await game.updatePresence(db, 'hunter', room.row, room.col);

    await seedBodiedNpc(db, game, { username: 'wyrm', displayName: 'Frost Wyrm', plan: 'wyrm', health: 20, room, strength: 6 });
    await assertNpcInvariant(db, 'wyrm', 'fresh');
    assert.ok((await game.getBodyParts(db, 'wyrm')).length > 0, 'the wyrm has body rows');

    // A called shot to the HEAD (vital) for the full head pool drives it 0 -> vital death.
    const headPool = (await game.getBodyParts(db, 'wyrm')).find(p => p.label === 'head').maxHp;
    const target = await db.prepare('SELECT * FROM users WHERE username = ?').bind('wyrm').first();
    // RNG: pickTargetPart draw (consumed; called shot overrides). A modest blow on a vital
    // part kills WITHOUT enough overkill to gib (so it routes via incapacitate->true death
    // here only if downed; from standing a vital-destroy yields died=true -> descend).
    const result = await withMockedRandom([0.0], () => game.applyBodyDamage(db, target, headPool, {
      cause: 'attack by hunter', row: room.row, col: room.col, targetLabel: 'head', displayLabel: 'Frost Wyrm'
    }));
    assert.equal(result.died, true, 'destroying the vital head kills');

    // Route the death through the band (as combat does). Vital death from standing with low
    // overkill downs first; a second call finishes. To assert the DELETE cleanly, drive it
    // to true death via descendTowardDeath with a finishing blow.
    await game.descendTowardDeath(db, 'wyrm', { cause: 'attack by hunter', row: room.row, col: room.col, blowDamage: headPool, overkill: result.overkill || 0, currentTick: 1 });
    // If only downed, finish it.
    const stillThere = await db.prepare("SELECT incapacitated FROM users WHERE username = 'wyrm'").first();
    if (stillThere) {
      await game.descendTowardDeath(db, 'wyrm', { cause: 'attack by hunter', row: room.row, col: room.col, blowDamage: 99, overkill: 99, currentTick: 2 });
    }

    const userGone = await db.prepare("SELECT username FROM users WHERE username = 'wyrm'").first();
    assert.equal(userGone, null, 'the NPC user row is deleted');
    const partsGone = await db.prepare("SELECT COUNT(*) AS c FROM bodyParts WHERE username = 'wyrm'").first();
    assert.equal(partsGone.c, 0, 'the NEW defeatNpc DELETE removed the bodyParts rows (no leak)');
    const remains = await db.prepare("SELECT COUNT(*) AS c FROM items WHERE templateId IN ('monster_remains','rotten_remains','bones') AND roomRow = ? AND roomCol = ?").bind(room.row, room.col).first();
    assert.ok(remains.c >= 1, 'remains dropped on true death');
    const reaction = await db.prepare("SELECT message FROM messages WHERE message LIKE '%is defeated by hunter.%'").first();
    assert.ok(reaction, 'the room saw the defeat');
  } finally {
    await db.close();
  }
});

test('Plan 021 (4): a downed bodied NPC keeps the invariant — all parts 0, health 0', async () => {
  const db = await createMigratedDb();
  const game = await import('../worker/game.mjs');
  try {
    const room = findCalmRoom(getWorldDay());
    await seedBodiedNpc(db, game, { username: 'gnawer', displayName: 'Ice Gnawer', plan: 'quadruped', health: 30, room });
    await assertNpcInvariant(db, 'gnawer', 'fresh');

    // A modest lethal blow (overkill under GIB_OVERKILL=15) DOWNS rather than gibs.
    const down = await game.descendTowardDeath(db, 'gnawer', { cause: 'attack by hunter', row: room.row, col: room.col, blowDamage: 6, overkill: 3, currentTick: 1 });
    assert.equal(down.state, 'incapacitated', 'a modest lethal blow downs the bodied NPC');

    const u = await db.prepare("SELECT health, incapacitated FROM users WHERE username = 'gnawer'").first();
    assert.equal(u.incapacitated, 1);
    assert.equal(u.health, 0, 'health zeroed while downed');
    const anyAlivePart = await db.prepare("SELECT COUNT(*) AS c FROM bodyParts WHERE username = 'gnawer' AND hp > 0").first();
    assert.equal(anyAlivePart.c, 0, 'every part is zeroed in the downed band');
    // The whole point: 0 == Σ 0 — the invariant the band 013g/023 once couldn't reach.
    await assertNpcInvariant(db, 'gnawer', 'while downed');
  } finally {
    await db.close();
  }
});

test('Plan 021 (5): a creatureBodyPlan=NULL NPC still takes SCALAR damage with zero bodyParts rows (the gate intact)', async () => {
  const db = await createMigratedDb();
  const game = await import('../worker/game.mjs');
  try {
    const room = findCalmRoom(getWorldDay());
    // No creatureBodyPlan → NULL → scalar HP, today's behavior (the lazy/no-backfill gate).
    await game.createNpcForEvent(db, {
      username: 'scalar', displayName: 'Legacy Mob', npcKind: 'ambient_hostile', level: 1,
      health: 12, stamina: 60, speed: 3, strength: 4, intelligence: 1,
      worldEventId: 'evt-scalar', row: room.row, col: room.col, worldDay: getWorldDay()
      // creatureBodyPlan intentionally omitted
    });
    const planCol = await db.prepare("SELECT creatureBodyPlan FROM users WHERE username = 'scalar'").first();
    assert.equal(planCol.creatureBodyPlan, null, 'NULL plan column');

    // ensureBody must NOT create rows for a scalar NPC.
    const npc = await db.prepare('SELECT * FROM users WHERE username = ?').bind('scalar').first();
    const ensured = await game.ensureBody(db, npc);
    assert.equal(ensured, null, 'ensureBody returns null for the scalar gate');

    const result = await game.applyBodyDamage(db, npc, 5, { cause: 'attack by hunter', row: room.row, col: room.col });
    assert.equal(result.npc, true, 'routed through the scalar path');
    const after = await db.prepare("SELECT health FROM users WHERE username = 'scalar'").first();
    assert.equal(after.health, 7, 'scalar HP fell 12 -> 7 with no per-part routing');
    const parts = await db.prepare("SELECT COUNT(*) AS c FROM bodyParts WHERE username = 'scalar'").first();
    assert.equal(parts.c, 0, 'a scalar NPC has ZERO bodyParts rows');
  } finally {
    await db.close();
  }
});

test('Plan 021 (6): scaleNpcStats grows with level; a spawned "Vicious …" carries the affix delta, prefixed name, and affixes JSON', async () => {
  const db = await createMigratedDb();
  const game = await import('../worker/game.mjs');
  try {
    const room = findCalmRoom(getWorldDay());
    // scaleNpcStats(level 8) > level 3 (the pure helper, surfaced via the facade).
    const base = { health: 14, maxHealth: 14, strength: 8 };
    assert.ok(game.scaleNpcStats(base, 8).health > game.scaleNpcStats(base, 3).health, 'L8 health > L3');
    assert.ok(game.scaleNpcStats(base, 8).strength > game.scaleNpcStats(base, 3).strength, 'L8 strength > L3');

    // Build a known "Vicious" elite from the pure helpers (deterministic — no live roll),
    // spawn it, and assert the persisted row.
    const roll = game.buildAffixRoll(['Vicious']);
    const baseStrength = 8;
    const scaled = game.scaleNpcStats({ health: 30, maxHealth: 30, strength: baseStrength }, 6);
    const withAffix = roll.applyTemplate(scaled);
    await game.createNpcForEvent(db, {
      username: 'elite', displayName: game.eliteDisplayName('Frost Wyrm', roll.prefix),
      npcKind: 'raid_boss', level: 6, health: withAffix.health, maxHealth: withAffix.maxHealth,
      stamina: 100, speed: 5, strength: withAffix.strength, intelligence: 1,
      worldEventId: 'evt-elite', row: room.row, col: room.col, worldDay: getWorldDay(),
      creatureBodyPlan: 'wyrm', affixes: JSON.stringify(roll.affixes)
    });

    const elite = await db.prepare("SELECT displayName, strength, affixes, creatureBodyPlan FROM users WHERE username = 'elite'").first();
    assert.equal(elite.displayName, 'Vicious Frost Wyrm', 'the affix prefixes the display name');
    assert.equal(elite.affixes, '["Vicious"]', 'the affixes JSON row is stored');
    assert.equal(elite.creatureBodyPlan, 'wyrm');
    assert.ok(elite.strength > scaled.strength, 'Vicious added the strength delta on top of level scaling');
    assert.equal(elite.strength, scaled.strength + 4, 'Vicious is exactly +4 strength');
  } finally {
    await db.close();
  }
});

test('Plan 021 (7): a >= GIB_OVERKILL blow on a bodied creature flings a severed_part + drops monster_remains, then defeatNpc', async () => {
  const db = await createMigratedDb();
  const game = await import('../worker/game.mjs');
  try {
    const room = findCalmRoom(getWorldDay());
    await db.prepare(
      `INSERT INTO users (username, password, job, health, maxHealth, stamina, maxStamina, speed, strength, intelligence, level)
       VALUES ('butcher', 'pw', 'Fighter', 30, 30, 100, 100, 5, 20, 5, 4)`
    ).run();
    await game.updatePresence(db, 'butcher', room.row, room.col);
    await seedBodiedNpc(db, game, { username: 'wyrm', displayName: 'Frost Wyrm', plan: 'wyrm', health: 16, room });
    await assertNpcInvariant(db, 'wyrm', 'fresh');

    // A massive blow from standing: GIB_OVERKILL is 15, so a blowDamage of 30 gibs outright.
    const outcome = await game.descendTowardDeath(db, 'wyrm', {
      cause: 'attack by butcher', row: room.row, col: room.col, blowDamage: 30, overkill: 30, currentTick: 1
    });
    assert.equal(outcome.state, 'gibbed', 'a heavy enough blow gibs the bodied creature');

    const gone = await db.prepare("SELECT username FROM users WHERE username = 'wyrm'").first();
    assert.equal(gone, null, 'gibbed === truly dead');
    const limbs = await db.prepare("SELECT name FROM items WHERE templateId = 'severed_part' AND name LIKE \"Frost Wyrm's severed %\"").all();
    assert.ok(limbs.results.length >= 1, 'at least one wyrm limb is flung as a severed_part (Fork 5)');
    const remains = await db.prepare("SELECT COUNT(*) AS c FROM items WHERE templateId IN ('monster_remains','rotten_remains','bones')").first();
    assert.ok(remains.c >= 1, 'defeatNpc still drops monster_remains');
    const torn = await db.prepare("SELECT message FROM messages WHERE message = 'Frost Wyrm is torn apart.'").first();
    assert.ok(torn, 'the room sees the dismemberment, by display name');
    const partsGone = await db.prepare("SELECT COUNT(*) AS c FROM bodyParts WHERE username = 'wyrm'").first();
    assert.equal(partsGone.c, 0, 'bodyParts rows are gone after the gib');
  } finally {
    await db.close();
  }
});

test('Plan 021 (7b): a >= GIB_OVERKILL blow on a SCALAR NPC keeps today behavior — monster_remains, NO severed_part', async () => {
  const db = await createMigratedDb();
  const game = await import('../worker/game.mjs');
  try {
    const room = findCalmRoom(getWorldDay());
    await db.prepare(
      `INSERT INTO users (username, password, job, health, maxHealth, stamina, maxStamina, speed, strength, intelligence, level)
       VALUES ('reaper', 'pw', 'Fighter', 30, 30, 100, 100, 5, 20, 5, 4)`
    ).run();
    await game.updatePresence(db, 'reaper', room.row, room.col);
    // Scalar NPC: NULL plan, no body.
    await game.createNpcForEvent(db, {
      username: 'mob', displayName: 'Legacy Mob', npcKind: 'ambient_hostile', level: 1,
      health: 8, stamina: 60, speed: 3, strength: 4, intelligence: 1,
      worldEventId: 'evt-legacy', row: room.row, col: room.col, worldDay: getWorldDay()
    });
    const outcome = await game.descendTowardDeath(db, 'mob', { cause: 'attack by reaper', row: room.row, col: room.col, blowDamage: 30, overkill: 30, currentTick: 1 });
    assert.equal(outcome.state, 'gibbed');
    const limbs = await db.prepare("SELECT COUNT(*) AS c FROM items WHERE templateId = 'severed_part'").first();
    assert.equal(limbs.c, 0, 'a scalar NPC flings NO limbs (no body to dismember)');
    const remains = await db.prepare("SELECT COUNT(*) AS c FROM items WHERE templateId IN ('monster_remains','rotten_remains','bones')").first();
    assert.ok(remains.c >= 1, 'but it still drops monster_remains');
  } finally {
    await db.close();
  }
});

test('Plan 021 (8): post-migration users.creatureBodyPlan and users.affixes exist and default NULL', async () => {
  const db = await createMigratedDb();
  try {
    const cols = await db.prepare('PRAGMA table_info(users)').all();
    const names = cols.results.map(c => c.name);
    assert.ok(names.includes('creatureBodyPlan'), 'creatureBodyPlan column exists');
    assert.ok(names.includes('affixes'), 'affixes column exists');

    // A plain user row leaves both NULL (no backfill).
    await db.prepare(
      `INSERT INTO users (username, password, job, health, maxHealth, stamina, maxStamina, speed, strength, intelligence)
       VALUES ('plain', 'pw', 'Novice', 10, 10, 100, 100, 5, 5, 5)`
    ).run();
    const row = await db.prepare("SELECT creatureBodyPlan, affixes FROM users WHERE username = 'plain'").first();
    assert.equal(row.creatureBodyPlan, null);
    assert.equal(row.affixes, null);
  } finally {
    await db.close();
  }
});

test('Plan 021 (Hulking): an elite with the Hulking affix grows extra limbs at body materialization, invariant intact', async () => {
  const db = await createMigratedDb();
  const game = await import('../worker/game.mjs');
  try {
    const room = findCalmRoom(getWorldDay());
    await seedBodiedNpc(db, game, {
      username: 'hulk', displayName: 'Hulking Frost Wyrm', plan: 'wyrm', health: 40, room,
      affixes: JSON.stringify(['Hulking'])
    });
    const parts = await game.getBodyParts(db, 'hulk');
    const labels = parts.map(p => p.label);
    assert.ok(parts.length > WYRM_PLAN.length, 'Hulking added parts beyond the base wyrm plan');
    assert.ok(labels.includes('extra left limb') && labels.includes('extra right limb'), 'the extra limbs are present');
    // The extra parts carry HP, so the invariant (health == Σ hp) still holds at birth.
    await assertNpcInvariant(db, 'hulk', 'a freshly-materialized Hulking body');
  } finally {
    await db.close();
  }
});

test('Plan 021 (Armored): the Armored affix fortifies part maxHp (maxHealth rises), invariant intact', async () => {
  const db = await createMigratedDb();
  const game = await import('../worker/game.mjs');
  try {
    const room = findCalmRoom(getWorldDay());
    // A plain brute vs an Armored one at the same base health — the Armored one ends with a
    // higher maxHealth (every part fortified via applyPartMaxHpDelta).
    await seedBodiedNpc(db, game, { username: 'plainBrute', displayName: 'Restless Brute', plan: 'brute', health: 40, room });
    const plainMax = (await db.prepare("SELECT maxHealth FROM users WHERE username = 'plainBrute'").first()).maxHealth;

    await seedBodiedNpc(db, game, {
      username: 'armoredBrute', displayName: 'Armored Restless Brute', plan: 'brute', health: 40, room,
      affixes: JSON.stringify(['Armored'])
    });
    const armoredMax = (await db.prepare("SELECT maxHealth FROM users WHERE username = 'armoredBrute'").first()).maxHealth;
    assert.ok(armoredMax > plainMax, `Armored raises maxHealth (${armoredMax} > ${plainMax})`);
    // health == Σ hp must STILL hold after the per-part fortification (a positive maxHp
    // delta never destroys hp, so both sides moved together / stayed put).
    await assertNpcInvariant(db, 'armoredBrute', 'after Armored fortification');
  } finally {
    await db.close();
  }
});

test('Plan 021 (Rending): an elite whose displayName is affix-prefixed keeps its base traits AND a Rending bite lands shock', async () => {
  const db = await createMigratedDb();
  const game = await import('../worker/game.mjs');
  try {
    const room = findCalmRoom(getWorldDay());
    // A high-HP hero so the monster survives a basic-attack turn.
    await db.prepare(
      `INSERT INTO users (username, password, job, health, maxHealth, stamina, maxStamina, speed, strength, intelligence, level, gold)
       VALUES ('hero', 'pw', 'Novice', 500, 500, 100, 100, 1, 1, 1, 1, 0)`
    ).run();
    await game.updatePresence(db, 'hero', room.row, room.col);
    // A Rending elite BRUTE (a brute has no base element) whose name is prefixed.
    await game.createNpcForEvent(db, {
      username: 'rend', displayName: 'Rending Restless Brute', npcKind: 'raid_boss', level: 6,
      health: 200, maxHealth: 200, stamina: 100, speed: 7, strength: 12, intelligence: 1,
      worldEventId: 'evt-rend', row: room.row, col: room.col, worldDay: getWorldDay(),
      creatureBodyPlan: 'brute', affixes: JSON.stringify(['Rending'])
    });

    // Seed an even tick → advanceGlobalTick makes it odd → a BASIC attack (not a cast).
    await db.prepare('UPDATE tick SET value = 8 WHERE id = 1').run();
    // RNG order in the basic-attack branch: speed contest, crit gate, pickTargetPart.
    await withMockedRandom([0.0, 0.99, 0.5], () => game.runHostileRoomAction(db, room.row, room.col));

    const shock = await db.prepare("SELECT magnitude FROM statusEffects WHERE username = 'hero' AND effectType = 'shock'").first();
    assert.ok(shock, 'the Rending affix bite landed a shock status, resolved from the affixes JSON despite the prefixed name');
  } finally {
    await db.close();
  }
});

test('Plan 021 (production): a hostile event spawns a BODIED creature with a plan + scaled stats via the decorate path', async () => {
  const db = await createMigratedDb();
  const game = await import('../worker/game.mjs');
  try {
    // Drive the real spawn path. Every spawned hostile must now carry a creatureBodyPlan
    // (BOLD: every hostile gets a body) and level-scaled stats.
    await game.ensureDailyWorldEvents(db, getWorldDay(), 1);
    const hostiles = await db.prepare("SELECT username, displayName, creatureBodyPlan, level, health FROM users WHERE isNpc = 1").all();
    assert.ok(hostiles.results.length >= 1, 'hostiles spawned');
    for (const h of hostiles.results) {
      assert.ok(h.creatureBodyPlan, `${h.displayName} carries a body plan (BOLD: every hostile is bodied)`);
      assert.ok(['wyrm', 'quadruped', 'brute', 'humanoid'].includes(h.creatureBodyPlan), `${h.displayName} -> a known plan`);
    }
    // The raid boss (level 6) scaled past its base health of 20.
    const boss = hostiles.results.find(h => h.creatureBodyPlan === 'wyrm');
    if (boss) {
      assert.ok(boss.health > 20, 'the level-6 boss scaled past its base 20 HP');
    }
  } finally {
    await db.close();
  }
});

test('Plan 024-fix (presence): getRoomEcology presence carries plan-derived aimParts — bodied NPC, player, and bodyless NPC', async () => {
  const db = await createMigratedDb();
  const game = await import('../worker/game.mjs');
  try {
    const room = findCalmRoom(getWorldDay());
    const worldDay = getWorldDay();

    // A real player (humanoid) in the room.
    await db.prepare(
      `INSERT INTO users (username, password, job, health, maxHealth, stamina, maxStamina, speed, strength, intelligence, level)
       VALUES ('aimer', 'pw', 'Fighter', 30, 30, 100, 100, 5, 10, 5, 4)`
    ).run();
    await game.updatePresence(db, 'aimer', room.row, room.col);

    // A BODIED NPC (wyrm) — creatureBodyPlan='wyrm'.
    await game.createNpcForEvent(db, {
      username: 'wyrm', displayName: 'Frost Wyrm', npcKind: 'raid_boss', level: 6,
      health: 100, maxHealth: 100, stamina: 100, speed: 5, strength: 6, intelligence: 1,
      worldEventId: 'evt-presence', row: room.row, col: room.col, worldDay,
      creatureBodyPlan: 'wyrm'
    });

    // A BODYLESS NPC (creatureBodyPlan omitted → NULL → scalar).
    await game.createNpcForEvent(db, {
      username: 'mob', displayName: 'Legacy Mob', npcKind: 'ambient_hostile', level: 1,
      health: 12, stamina: 60, speed: 3, strength: 4, intelligence: 1,
      worldEventId: 'evt-presence', row: room.row, col: room.col, worldDay
    });

    // The CLIENT path: getRoomEcology carries the presence the chat toolbar reads.
    const ecology = await game.getRoomEcology(db, 'aimer', room.row, room.col, worldDay);
    const byName = Object.fromEntries(ecology.presence.map(p => [p.displayName, p]));

    // A bodied wyrm exposes its OWN plan's labels — a wing and a tail, not the humanoid set.
    assert.ok(byName['Frost Wyrm'], 'the wyrm is present');
    assert.deepEqual(
      byName['Frost Wyrm'].aimParts,
      ['head', 'body', 'left wing', 'right wing', 'left foreleg', 'right foreleg', 'tail'],
      'a bodied NPC lists its creature-plan labels (wing + tail present)'
    );
    assert.ok(byName['Frost Wyrm'].aimParts.includes('left wing'), 'a wing label is offered');
    assert.ok(byName['Frost Wyrm'].aimParts.includes('tail'), 'a tail label is offered');

    // A player/humanoid exposes the humanoid labels.
    assert.deepEqual(
      byName['aimer'].aimParts,
      ['head', 'torso', 'neck', 'left arm', 'right arm', 'left leg', 'right leg'],
      'a player lists the humanoid labels'
    );

    // A bodyless NPC exposes NO aimable parts.
    assert.deepEqual(byName['Legacy Mob'].aimParts, [], 'a bodyless (scalar) NPC has empty aimParts');

    // aimParts is purely ADDITIVE — every pre-existing field the combat loop / ally
    // resolver depend on is still present on each occupant row.
    for (const occ of ecology.presence) {
      for (const field of ['username', 'displayName', 'isNpc', 'health', 'incapacitated', 'lastSeenTick']) {
        assert.ok(Object.prototype.hasOwnProperty.call(occ, field), `${occ.username} keeps the ${field} field`);
      }
    }
  } finally {
    await db.close();
  }
});

test('Plan 024-fix (server accepts the structured aim): handleAttack honors options.targetPart vs a bodied NPC (the toolbar field path, no part named in prose)', async () => {
  const db = await createMigratedDb();
  const game = await import('../worker/game.mjs');
  try {
    const room = findCalmRoom(getWorldDay());
    // strength 40 → base damage 11, enough to sever a 10-HP wing.
    await db.prepare(
      `INSERT INTO users (username, password, job, health, maxHealth, stamina, maxStamina, speed, strength, intelligence, level)
       VALUES ('hunter', 'pw', 'Fighter', 30, 30, 100, 100, 1, 40, 5, 4)`
    ).run();
    await game.updatePresence(db, 'hunter', room.row, room.col);
    await seedBodiedNpc(db, game, { username: 'wyrm', displayName: 'Frost Wyrm', plan: 'wyrm', health: 100, room, strength: 6 });

    // The prose names NO body part — the aim rides ONLY in options.targetPart, exactly
    // as the (now-fixed) toolbar sends it for an NPC. RNG: speed (hit), crit (no), pick (consumed).
    const out = await withMockedRandom([0.0, 0.99, 0.5], () =>
      game.handleAttack(db, 'hunter', 'strike @wyrm', room.row, room.col, { targetPart: 'left wing' }));
    assert.match(out, /hunter .*Frost Wyrm.*\(\d+\)/, 'the wyrm was struck');
    const wing = (await game.getBodyParts(db, 'wyrm')).find(p => p.label === 'left wing');
    assert.equal(wing.severed, 1, 'the structured targetPart severed the named wing on the bodied NPC');
  } finally {
    await db.close();
  }
});
