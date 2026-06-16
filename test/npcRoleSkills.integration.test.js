// Plan 013d: NPCs use their job skills — the cleric who saves you. A DOWNED player who
// pleads, with a friendly NPC cleric present, is raised by the engine (the model only
// asks; the engine gates on disposition + ability + the target being down). CommonJS.

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

async function addHuman(db, game, username, row, col) {
  await db.prepare(
    `INSERT INTO users (username, password, job, health, maxHealth, stamina, maxStamina, speed, strength, intelligence, level)
     VALUES (?, 'pw', 'Fighter', 30, 30, 100, 100, 5, 5, 5, 1)`
  ).bind(username).run();
  await game.updatePresence(db, username, row, col);
  await game.getUserState(db, username); // instantiate body
}

async function addCleric(db, game, username, displayName, disposition, row, col) {
  await db.prepare(
    `INSERT INTO users (username, password, job, health, maxHealth, stamina, maxStamina, speed, strength, intelligence, level, isNpc, displayName, npcKind, disposition, role, npcWorldDay)
     VALUES (?, 'npc', 'Cleric', 24, 24, 100, 100, 4, 5, 5, 3, 1, ?, 'social', ?, 'healer', ?)`
  ).bind(username, displayName, disposition, getWorldDay()).run();
  await game.updatePresence(db, username, row, col);
}

async function downThePlayer(db, game, attacker, victim, room) {
  // Use a heavy enough blow to incapacitate (overkill stays under the gib threshold for low HP).
  await db.prepare(
    `INSERT INTO users (username, password, job, health, maxHealth, stamina, maxStamina, speed, strength, intelligence, level)
     VALUES (?, 'pw', 'Fighter', 30, 30, 100, 100, 20, 12, 1, 4)`
  ).bind(attacker).run();
  await game.updatePresence(db, attacker, room.row, room.col);
  await game.descendTowardDeath(db, victim, { cause: `attack by ${attacker}`, row: room.row, col: room.col, blowDamage: 6, overkill: 2, currentTick: 1 });
}

async function addWoundedHuman(db, game, username, row, col, health) {
  await db.prepare(
    `INSERT INTO users (username, password, job, health, maxHealth, stamina, maxStamina, speed, strength, intelligence, level)
     VALUES (?, 'pw', 'Fighter', ?, 30, 100, 100, 5, 5, 5, 1)`
  ).bind(username, health).run();
  await game.updatePresence(db, username, row, col);
  await game.getUserState(db, username); // body parts sum to health/maxHealth
}

async function humanSays(db, username, row, col, message) {
  await db.prepare('INSERT INTO messages (roomRow, roomCol, username, message, kind) VALUES (?, ?, ?, ?, ?)').bind(row, col, username, message, 'chat').run();
}

test('Plan 013d: a friendly NPC cleric raises a downed player who pleads', async () => {
  const db = await createMigratedDb();
  const game = await import('../worker/game.mjs');
  try {
    const room = findCalmRoom(getWorldDay());
    await addHuman(db, game, 'pilgrim', room.row, room.col);
    await addCleric(db, game, 'soc_healer_1', 'Sister Maeve', 'friendly', room.row, room.col);
    await downThePlayer(db, game, 'ogre', 'pilgrim', room);

    const downed = await db.prepare("SELECT incapacitated FROM users WHERE username = 'pilgrim'").first();
    assert.equal(downed.incapacitated, 1, 'precondition: the player is down');

    await humanSays(db, 'pilgrim', room.row, room.col, 'please... heal me... save me');
    const result = await game.runNpcReply(db, null, room.row, room.col); // no model: keyword floor + engine

    assert.ok(result.helped, 'the cleric acted');
    assert.equal(result.helped.action, 'revive');
    const after = await db.prepare("SELECT incapacitated, stance FROM users WHERE username = 'pilgrim'").first();
    assert.equal(after.incapacitated, 0, 'raised from the brink');
    assert.equal(after.stance, 'standing');
  } finally {
    await db.close();
  }
});

test('Plan 013d: a HOSTILE cleric does not heal you, no matter how nicely you ask', async () => {
  const db = await createMigratedDb();
  const game = await import('../worker/game.mjs');
  try {
    const room = findCalmRoom(getWorldDay());
    await addHuman(db, game, 'pilgrim', room.row, room.col);
    await addCleric(db, game, 'soc_healer_2', 'Brother Aldric', 'hostile', room.row, room.col);
    await downThePlayer(db, game, 'ogre', 'pilgrim', room);

    await humanSays(db, 'pilgrim', room.row, room.col, 'please heal me, save me');
    const result = await game.runNpcReply(db, null, room.row, room.col);

    assert.equal(result.helped, null, 'a hostile cleric will not lift a finger');
    const after = await db.prepare("SELECT incapacitated FROM users WHERE username = 'pilgrim'").first();
    assert.equal(after.incapacitated, 1, 'still down');
  } finally {
    await db.close();
  }
});

test('Plan 013d: a friendly NPC cleric TENDS a wounded (not downed) player who asks', async () => {
  const db = await createMigratedDb();
  const game = await import('../worker/game.mjs');
  try {
    const room = findCalmRoom(getWorldDay());
    await addWoundedHuman(db, game, 'scout', room.row, room.col, 10); // 10/30 health
    await addCleric(db, game, 'soc_healer_w', 'Sister Maeve', 'friendly', room.row, room.col);
    await humanSays(db, 'scout', room.row, room.col, 'please heal me, I am hurt');

    const before = (await db.prepare("SELECT health FROM users WHERE username = 'scout'").first()).health;
    const result = await game.runNpcReply(db, null, room.row, room.col);

    assert.ok(result.helped, 'the cleric acted');
    assert.equal(result.helped.action, 'heal');
    const after = await db.prepare("SELECT health, incapacitated FROM users WHERE username = 'scout'").first();
    assert.ok(after.health > before, `wounds tended (${before} -> ${after.health})`);
    assert.equal(after.incapacitated, 0, 'was wounded, never downed');
  } finally {
    await db.close();
  }
});

test('Plan 013d: an upright player asking for help is not revived (nothing to revive)', async () => {
  const db = await createMigratedDb();
  const game = await import('../worker/game.mjs');
  try {
    const room = findCalmRoom(getWorldDay());
    await addHuman(db, game, 'pilgrim', room.row, room.col);
    await addCleric(db, game, 'soc_healer_3', 'Sister Maeve', 'friendly', room.row, room.col);

    await humanSays(db, 'pilgrim', room.row, room.col, 'please help me find the road');
    const result = await game.runNpcReply(db, null, room.row, room.col);

    assert.equal(result.helped, null, 'a healthy asker triggers no revive');
    assert.equal(result.spoke, true, 'but the cleric still answers');
  } finally {
    await db.close();
  }
});

// --- Campaign B (013 tail): hostile NPCs use offensive JOB kits + scarier support, with
// the hard safety guard that a non-'enemy' ability can NEVER resolve onto the player. ---

// A flipped social NPC: hostile disposition, a REAL job (so getHostileKit derives from it),
// no CREATURE_ABILITIES entry (so the JOB kit — not a creature kit — is what fires).
async function addHostileNpcJob(db, game, username, displayName, job, row, col, opts = {}) {
  const { health = 24, strength = 5, speed = 4 } = opts;
  await db.prepare(
    `INSERT INTO users (username, password, job, health, maxHealth, stamina, maxStamina, speed, strength, intelligence, level, isNpc, displayName, npcKind, disposition, role, npcWorldDay)
     VALUES (?, 'npc', ?, ?, ?, 100, 100, ?, ?, 5, 3, 1, ?, 'social', 'hostile', 'guard', ?)`
  ).bind(username, job, health, health, speed, strength, displayName, getWorldDay()).run();
  await game.updatePresence(db, username, row, col);
}

// A tough, slow human so several hostile turns can resolve without killing them; body
// instantiated so applyBodyDamage/Heal and the health invariant behave.
async function addToughHuman(db, game, username, row, col) {
  await db.prepare(
    `INSERT INTO users (username, password, job, health, maxHealth, stamina, maxStamina, speed, strength, intelligence, level)
     VALUES (?, 'pw', 'Novice', 200, 200, 100, 100, 1, 1, 1, 1)`
  ).bind(username).run();
  await game.updatePresence(db, username, row, col);
  await game.getUserState(db, username);
}

async function beneficialEffectsOn(db, username) {
  const rows = await db.prepare(
    "SELECT effectType FROM statusEffects WHERE username = ? AND effectType IN ('bless', 'ward')"
  ).bind(username).all();
  return rows.results.map(r => r.effectType);
}

// Drive runHostileRoomAction across N ticks, with the speed contest forced to MISS
// (Math.random high) so a basic attack never deals chip damage we'd have to model — we
// only care that the player is never HEALED/BUFFED. Cast outcomes are unaffected by the
// roll. Returns the list of per-tick results.
async function driveHostileTicks(game, db, row, col, n) {
  const real = Math.random;
  Math.random = () => 0.99; // attacker loses the speed contest → basic attacks miss; crits off
  const results = [];
  try {
    for (let i = 0; i < n; i += 1) {
      results.push(await game.runHostileRoomAction(db, row, col));
    }
  } finally {
    Math.random = real;
  }
  return results;
}

test('Campaign B: THE hostile-cleric-never-heals-the-player test (no allied NPC)', async () => {
  const db = await createMigratedDb();
  const game = await import('../worker/game.mjs');
  try {
    const room = findCalmRoom(getWorldDay());
    await addToughHuman(db, game, 'victim', room.row, room.col);
    // A hostile Cleric — its job kit is bless/revive: revive is EXCLUDED (corpse), bless
    // has no allied hostile to land on, so it self-targets; it can never bless YOU.
    await addHostileNpcJob(db, game, 'soc:c:hostile:0', 'Brother Aldric', 'Cleric', room.row, room.col);

    const healthBefore = (await db.prepare("SELECT health FROM users WHERE username = 'victim'").first()).health;
    // Drive plenty of ticks so we cross many cast-ticks and basic-attack-ticks.
    const results = await driveHostileTicks(game, db, room.row, room.col, 12);

    // The player NEVER gains health and NEVER receives a beneficial effect.
    const after = (await db.prepare("SELECT health FROM users WHERE username = 'victim'").first()).health;
    assert.ok(after <= healthBefore, `player health never rose (${healthBefore} -> ${after})`);
    assert.deepEqual(await beneficialEffectsOn(db, 'victim'), [], 'player got no bless/ward');

    // Whenever it cast, it cast bless onto ITSELF (never the player); other ticks it fell
    // to a basic attack. Either way the player is never the beneficiary.
    const casts = results.filter(r => r.cast);
    assert.ok(casts.length > 0, 'the cleric reached at least one cast tick');
    assert.ok(casts.every(c => c.cast === 'bless' && c.target === 'soc:c:hostile:0'), 'every cast was a self-bless, never aimed at the player');
    // And the cleric DID bless itself (the scarier-support set lets it buff, just not you).
    assert.ok((await beneficialEffectsOn(db, 'soc:c:hostile:0')).includes('bless'), 'the cleric buffed itself');
  } finally {
    await db.close();
  }
});

test('Campaign B: scarier support — bless lands on an ALLIED hostile, never the player', async () => {
  const db = await createMigratedDb();
  const game = await import('../worker/game.mjs');
  try {
    const room = findCalmRoom(getWorldDay());
    await addToughHuman(db, game, 'victim', room.row, room.col);
    // The cleric (username sorts FIRST so it is the actor picked by runHostileRoomAction's
    // ORDER BY username), plus a wounded allied hostile for it to mend.
    await addHostileNpcJob(db, game, 'soc:a:cleric:0', 'Sister Maeve', 'Cleric', room.row, room.col);
    await addHostileNpcJob(db, game, 'soc:b:ally:1', 'Tovin', 'Fighter', room.row, room.col, { health: 6 });

    const results = await driveHostileTicks(game, db, room.row, room.col, 8);

    // The bless landed on the ALLY (most-wounded allied hostile), never on the player.
    const blessCasts = results.filter(r => r.cast === 'bless');
    assert.ok(blessCasts.length > 0, 'the cleric cast bless');
    assert.ok(blessCasts.every(c => c.target === 'soc:b:ally:1'), 'bless aimed at the allied hostile, not the player');
    assert.ok((await beneficialEffectsOn(db, 'soc:b:ally:1')).includes('bless'), 'the ally received the buff');
    assert.deepEqual(await beneficialEffectsOn(db, 'victim'), [], 'the player received NO buff');
  } finally {
    await db.close();
  }
});

test('Campaign B: a hostile Mage throws an OFFENSIVE ability at the player', async () => {
  const db = await createMigratedDb();
  const game = await import('../worker/game.mjs');
  try {
    const room = findCalmRoom(getWorldDay());
    await addToughHuman(db, game, 'victim', room.row, room.col);
    // Mage kit: arcane_pin (enemy) + word_bolt (enemy) — both must aim AT the player.
    await addHostileNpcJob(db, game, 'soc:m:mage:0', 'Vex', 'Mage', room.row, room.col, { speed: 50 });

    // Force the speed contest to LAND (low roll) so the contested offensive cast connects;
    // the player's 200 HP absorbs the basic-attack ticks across the run.
    const real = Math.random;
    Math.random = () => 0;
    const results = [];
    try {
      for (let i = 0; i < 8; i += 1) results.push(await game.runHostileRoomAction(db, room.row, room.col));
    } finally {
      Math.random = real;
    }
    const offensiveCasts = results.filter(r => r.cast === 'arcane_pin' || r.cast === 'word_bolt');
    assert.ok(offensiveCasts.length > 0, 'the mage cast an offensive ability');
    assert.ok(offensiveCasts.every(c => c.target === 'victim'), 'every offensive cast aimed at the player');

    // arcane_pin lands its status ON THE PLAYER (word_bolt deals damage) — the offense
    // reaches the player, exactly as a hostile should.
    const pinned = await db.prepare("SELECT effectType FROM statusEffects WHERE username = 'victim' AND effectType = 'arcane_pin'").first();
    assert.ok(pinned, 'an offensive status (arcane_pin) landed on the player');
    // And the player is never the beneficiary of anything.
    assert.deepEqual(await beneficialEffectsOn(db, 'victim'), [], 'no beneficial effect ever lands on the player');
  } finally {
    await db.close();
  }
});

test('Campaign B: a hostile self-buff (brace/ward) lands on the NPC, never the player', async () => {
  const db = await createMigratedDb();
  const game = await import('../worker/game.mjs');
  try {
    const room = findCalmRoom(getWorldDay());
    await addToughHuman(db, game, 'victim', room.row, room.col);
    // Fighter kit: power_strike (enemy) + brace (self). brace must ward the NPC itself.
    await addHostileNpcJob(db, game, 'soc:f:fighter:0', 'Bren', 'Fighter', room.row, room.col);

    const results = await driveHostileTicks(game, db, room.row, room.col, 8);
    const braceCasts = results.filter(r => r.cast === 'brace');
    assert.ok(braceCasts.length > 0, 'the fighter braced');
    assert.ok(braceCasts.every(c => c.target === 'soc:f:fighter:0'), 'brace targeted the NPC itself, never the player');
    assert.ok((await beneficialEffectsOn(db, 'soc:f:fighter:0')).includes('ward'), 'the NPC warded ITSELF');
    assert.deepEqual(await beneficialEffectsOn(db, 'victim'), [], 'the player never receives the ward');
  } finally {
    await db.close();
  }
});

test('Campaign B: 021 monsters are UNCHANGED — a Frost Wyrm still casts from CREATURE_ABILITIES', async () => {
  const db = await createMigratedDb();
  const game = await import('../worker/game.mjs');
  try {
    const room = findCalmRoom(getWorldDay());
    await db.prepare(
      `INSERT INTO users (username, password, job, health, maxHealth, stamina, maxStamina, speed, strength, intelligence, level, gold)
       VALUES ('hero', 'pw', 'Novice', 500, 500, 100, 100, 1, 1, 1, 1, 0)`
    ).bind().run();
    await game.updatePresence(db, 'hero', room.row, room.col);
    await game.createNpcForEvent(db, {
      username: 'wyrm', displayName: 'Frost Wyrm', npcKind: 'raid_boss', level: 6,
      health: 200, stamina: 100, speed: 7, strength: 12, intelligence: 3,
      worldEventId: 'evt1', row: room.row, col: room.col, worldDay: getWorldDay()
    });

    // The creature kit is ['arcane_pin','power_strike'] and takes precedence over any job
    // derivation (the Wyrm's job is the default 'Novice'); it casts on the even cast-tick.
    await db.prepare('UPDATE tick SET value = 5 WHERE id = 1').bind().run();
    const cast = await game.runHostileRoomAction(db, room.row, room.col);
    assert.ok(cast.cast === 'arcane_pin' || cast.cast === 'power_strike', `cast from the creature kit (${cast.cast})`);
    assert.equal(cast.target, 'hero', 'the creature aims at the player, exactly as before');
  } finally {
    await db.close();
  }
});

test('Campaign B (pure unit): isHostileUsable + resolveHostileTarget enforce the safety guard', async () => {
  const game = await import('../worker/game.mjs');
  const abilities = require('../utils/abilities');
  const { isHostileUsable, resolveHostileTarget, getHostileKit } = game;

  // isHostileUsable: enemy/self/none/ally accepted, corpse REJECTED, passive rejected.
  assert.equal(isHostileUsable(abilities.getAbility('power_strike')), true, 'enemy accepted');
  assert.equal(isHostileUsable(abilities.getAbility('brace')), true, 'self accepted');
  assert.equal(isHostileUsable(abilities.getAbility('scrounge')), true, 'none accepted');
  assert.equal(isHostileUsable(abilities.getAbility('bless')), true, 'ally accepted (scarier support)');
  assert.equal(isHostileUsable(abilities.getAbility('revive')), false, 'corpse REJECTED — a hostile never revives');
  assert.equal(isHostileUsable(abilities.getAbility('toughness')), false, 'passive rejected');
  assert.equal(isHostileUsable(null), false, 'null rejected');

  // getHostileKit: a Cleric never carries revive into combat; creature kit takes precedence.
  assert.deepEqual(getHostileKit({ job: 'Cleric' }), ['bless'], 'Cleric job kit excludes revive');
  assert.deepEqual(getHostileKit({ displayName: 'Frost Wyrm', job: 'Cleric' }), ['arcane_pin', 'power_strike'], 'creature kit wins');

  // resolveHostileTarget: the player is returned ONLY for 'enemy', NEVER for ally/self/none/corpse.
  const npc = { username: 'npc1' };
  const player = { username: 'hero' };
  const allies = [{ username: 'npc2', health: 9 }, { username: 'npc3', health: 2 }];
  assert.equal(resolveHostileTarget(abilities.getAbility('power_strike'), npc, player, allies), 'hero', 'enemy -> player');
  assert.equal(resolveHostileTarget(abilities.getAbility('brace'), npc, player, allies), 'npc1', 'self -> NPC');
  assert.equal(resolveHostileTarget(abilities.getAbility('scrounge'), npc, player, allies), 'npc1', 'none -> NPC');
  assert.equal(resolveHostileTarget(abilities.getAbility('bless'), npc, player, allies), 'npc3', 'ally -> most-wounded allied hostile');
  assert.equal(resolveHostileTarget(abilities.getAbility('bless'), npc, player, []), 'npc1', 'ally with no allies -> self, NEVER the player');
  assert.equal(resolveHostileTarget(abilities.getAbility('revive'), npc, player, allies), null, 'corpse -> null (default-deny skip)');

  // The invariant, asserted directly: no non-'enemy' ability EVER resolves onto the player.
  for (const id of ['brace', 'scrounge', 'bless', 'revive', 'ward', 'dose', 'survey']) {
    const ability = abilities.getAbility(id);
    if (!ability || ability.target === 'enemy') continue;
    const resolved = resolveHostileTarget(ability, npc, player, [{ username: 'npc2', health: 1 }]);
    assert.notEqual(resolved, player.username, `${id} (target=${ability.target}) must never resolve onto the player`);
  }
});
