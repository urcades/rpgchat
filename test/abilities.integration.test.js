// Plan 018: the ability registry. 018a moved ability DATA into utils/abilities.js
// and made dispatch registry-driven (runAbility by id); 018b gives a class a real
// multi-ability kit (a second active + a passive) and folds passive stat deltas
// into the effective layer. These tests pin the registry shape, the passive fold,
// and the usable-set gate. CommonJS + node:test to match the rest of test/.

const assert = require('node:assert/strict');
const test = require('node:test');
const { createSqliteD1, createMigratedDb } = require('./.helpers/d1');
const { getWorldDay, generateRoomFeatures } = require('../utils/roomEcology');
const abilities = require('../utils/abilities');
const { getEffectiveUser } = require('../utils/jobs');

function findCalmRoom(worldDay) {
  const hazardous = ['poison_marsh', 'moon_room', 'echo_chamber', 'pub', 'inn', 'sun_room', 'cold_room', 'guild'];
  for (let row = 1; row <= 16; row += 1) {
    for (let col = 1; col <= 16; col += 1) {
      const types = generateRoomFeatures(row, col, worldDay).map(f => f.effect?.type);
      if (!types.some(t => hazardous.includes(t))) {
        return { row, col };
      }
    }
  }
  throw new Error('No calm room for ' + worldDay);
}

async function seedLiveUser(db, username, job = 'Novice') {
  await db.prepare(
    `INSERT INTO users
      (username, password, job, health, maxHealth, stamina, maxStamina, speed, strength, intelligence, level, gold)
     VALUES (?, 'pw', ?, 30, 30, 100, 100, 1, 1, 1, 0, 0)`
  ).bind(username, job).run();
}

const ids = list => list.map(ability => ability.id);

// ---------------------------------------------------------------------------
// Registry shape (pure)

test('Plan 018: every class kit resolves to registered abilities with display data', () => {
  for (const job of Object.keys(abilities.CLASS_ABILITIES)) {
    const kit = abilities.getAbilitiesForJob(job);
    assert.ok(kit.length >= 1, `${job} has at least one ability`);
    for (const ability of kit) {
      assert.ok(ability && ability.id && ability.label, `${job} ability is well-formed`);
      assert.ok(Array.isArray(ability.effects) && ability.effects.length, `${ability.id} lists effects`);
      assert.ok(ability.kind === 'active' || ability.kind === 'passive', `${ability.id} has a kind`);
    }
  }
});

test('Plan 018b: the Fighter has a multi-ability kit split into actives and a passive', () => {
  assert.deepEqual(ids(abilities.getAbilitiesForJob('Fighter')), ['power_strike', 'brace', 'toughness']);
  assert.deepEqual(ids(abilities.getActiveAbilitiesForJob('Fighter')), ['power_strike', 'brace']);
  assert.deepEqual(ids(abilities.getPassiveAbilitiesForJob('Fighter')), ['toughness']);
  // The starter (back-compat shape) is still the first innate ability.
  assert.equal(abilities.getStarterAbility('Fighter').id, 'power_strike');
});

test('Plan 018b: a passive folds its stat delta into the effective layer like a job bonus', () => {
  // Fighter strength = base 1 + job bonus 2 + Toughness passive 1 = 4.
  const fighter = getEffectiveUser({ job: 'Fighter', strength: 1 });
  assert.equal(fighter.strength, 4);
  assert.deepEqual(abilities.getPassiveStatModifiers('Fighter'), { strength: 1 });

  // A class with no passive is unaffected.
  const novice = getEffectiveUser({ job: 'Novice', strength: 1 });
  assert.equal(novice.strength, 1);
  assert.deepEqual(abilities.getPassiveStatModifiers('Novice'), {});

  // getEffectiveUser surfaces the kit + passives for the client.
  assert.deepEqual(ids(fighter.skills), ['power_strike', 'brace']);
  assert.deepEqual(ids(fighter.passives), ['toughness']);
});

// ---------------------------------------------------------------------------
// Usable-set gate + behavior (live DB)

test('Plan 018b: a Fighter fires the second active (Brace) and wards themselves', async () => {
  const db = await createMigratedDb();
  const { handleSkillAction, getCurrentTickValue, getUserState, updatePresence } = await import('../worker/game.mjs');
  try {
    const calm = findCalmRoom(getWorldDay());
    await seedLiveUser(db, 'fighter', 'Fighter');
    await updatePresence(db, 'fighter', calm.row, calm.col);
    await getUserState(db, 'fighter'); // instantiate body
    const tick = await getCurrentTickValue(db);

    await handleSkillAction(db, 'fighter', calm.row, calm.col, 'brace', '', tick);

    const line = await db.prepare("SELECT message, kind FROM messages WHERE message LIKE 'fighter braces%' ORDER BY id DESC LIMIT 1").bind().first();
    assert.ok(line, 'Brace posts a system line');
    assert.equal(line.kind, 'support', 'Brace is a support-kind message');

    const ward = await db.prepare("SELECT magnitude FROM statusEffects WHERE username = 'fighter' AND effectType = 'ward' ORDER BY id DESC LIMIT 1").bind().first();
    assert.ok(ward, 'Brace adds a ward to the Fighter themselves');
    assert.equal(ward.magnitude, 1, 'the self-ward is weaker than a Paladin ward');

    const state = await getUserState(db, 'fighter');
    assert.deepEqual(ids(state.skills), ['power_strike', 'brace'], 'the hotbar payload carries both actives');
    assert.deepEqual(ids(state.passives), ['toughness'], 'passives are surfaced read-only');
  } finally {
    await db.close();
  }
});

test('Plan 018b: passives are not activatable and kits are class-gated', async () => {
  const db = await createMigratedDb();
  const { validateClassSkillUse, getUserState, updatePresence } = await import('../worker/game.mjs');
  try {
    const calm = findCalmRoom(getWorldDay());
    await seedLiveUser(db, 'fighter', 'Fighter');
    await seedLiveUser(db, 'novice', 'Novice');
    for (const name of ['fighter', 'novice']) {
      await updatePresence(db, name, calm.row, calm.col);
      await getUserState(db, name);
    }

    // A passive cannot be invoked as a skill, even though it is in the kit.
    await assert.rejects(
      () => validateClassSkillUse(db, { username: 'fighter', skillId: 'toughness', targetUsername: '' }),
      /cannot use that skill/
    );
    // A class cannot borrow another class's active.
    await assert.rejects(
      () => validateClassSkillUse(db, { username: 'novice', skillId: 'brace', targetUsername: '' }),
      /cannot use that skill/
    );
    // The Fighter's own second active validates fine.
    const ok = await validateClassSkillUse(db, { username: 'fighter', skillId: 'brace', targetUsername: '' });
    assert.equal(ok.ability.id, 'brace');
  } finally {
    await db.close();
  }
});

test('adv-014: a skill aimed at another player requires co-location (the cross-room exploit)', async () => {
  const db = await createMigratedDb();
  const {
    validateClassSkillUse, useClassSkill, runAbility,
    getCurrentTickValue, getUserState, updatePresence
  } = await import('../worker/game.mjs');
  try {
    const worldDay = getWorldDay();
    // Two DIFFERENT calm rooms so a cast can be co-located in one and cross-room to the other.
    const here = findCalmRoom(worldDay);
    let there = null;
    for (let row = here.row; row <= 16 && !there; row += 1) {
      for (let col = 1; col <= 16; col += 1) {
        if (row === here.row && col <= here.col) continue;
        const types = generateRoomFeatures(row, col, worldDay).map(f => f.effect?.type);
        const hazardous = ['poison_marsh', 'moon_room', 'echo_chamber', 'pub', 'inn', 'sun_room', 'cold_room', 'guild'];
        if (!types.some(t => hazardous.includes(t))) { there = { row, col }; break; }
      }
    }
    assert.ok(there, 'found a second distinct calm room');

    await seedLiveUser(db, 'fighter', 'Fighter');
    await seedLiveUser(db, 'victim', 'Novice');
    await getUserState(db, 'fighter');
    await getUserState(db, 'victim');

    // fighter stands HERE; victim stands THERE.
    await updatePresence(db, 'fighter', here.row, here.col);
    await updatePresence(db, 'victim', there.row, there.col);

    // (1) Cross-room offensive cast is rejected — power_strike (target: 'enemy') on a
    // player in another room can no longer resolve by mere existence.
    await assert.rejects(
      () => validateClassSkillUse(db, { username: 'fighter', skillId: 'power_strike', targetUsername: 'victim', row: here.row, col: here.col }),
      /aren't here/,
      'a player cannot power_strike someone in a different room'
    );
    // The full handler path (handleSkillAction wires row/col into validate) rejects too.
    const tick = await getCurrentTickValue(db);
    await assert.rejects(
      () => useClassSkill(db, { username: 'fighter', skillId: 'power_strike', targetUsername: 'victim', row: here.row, col: here.col, currentTick: tick, phase: 'day' }),
      /aren't here/
    );
    const noEffect = await db.prepare("SELECT id FROM statusEffects WHERE username = 'victim'").all();
    assert.equal(noEffect.results.length, 0, 'a rejected cross-room cast lands nothing on the victim');

    // (2) Co-located: move the victim into the fighter's room and the same cast validates.
    await updatePresence(db, 'victim', here.row, here.col);
    const ok = await validateClassSkillUse(db, { username: 'fighter', skillId: 'power_strike', targetUsername: 'victim', row: here.row, col: here.col });
    assert.equal(ok.ability.id, 'power_strike', 'a co-located target resolves');
    assert.equal(ok.target, 'victim');

    // (3) A self-targeted ability (Brace, target: 'self') is unaffected even when alone —
    // it never consults the co-location gate.
    await seedLiveUser(db, 'loner', 'Fighter');
    await updatePresence(db, 'loner', there.row, there.col); // alone in the far room
    const selfOk = await validateClassSkillUse(db, { username: 'loner', skillId: 'brace', targetUsername: '', row: there.row, col: there.col });
    assert.equal(selfOk.ability.id, 'brace');
    assert.equal(selfOk.target, 'loner', 'self-cast resolves to the caster, no presence lookup');

    // (4) A room / no-target ability (Survey, target: 'none') is likewise unaffected.
    await seedLiveUser(db, 'scout', 'Dungeoneer');
    await updatePresence(db, 'scout', there.row, there.col);
    const roomOk = await validateClassSkillUse(db, { username: 'scout', skillId: 'survey', targetUsername: '', row: there.row, col: there.col });
    assert.equal(roomOk.ability.id, 'survey');

    // (5) An NPC offensive cast still works: the hostile loop drives runAbility directly
    // (bypassing validateClassSkillUse), so a co-located beast's offensive ability lands
    // on the player exactly as before — the new gate never touches the NPC path. Mirrors
    // worker/game/combat.mjs (the kit cast inside the hostile turn).
    await db.prepare(
      `INSERT INTO users
        (username, password, job, health, maxHealth, stamina, maxStamina, speed, strength, intelligence, level, isNpc, displayName, disposition, npcKind)
       VALUES ('mob:restless:0', 'pw', 'Novice', 30, 30, 100, 100, 5, 8, 1, 1, 1, 'Restless Brute', 'hostile', 'ambient_hostile')`
    ).run();
    const original = Math.random;
    Math.random = () => 0.1; // ensure the harmful-skill speed contest lands
    try {
      await runAbility(db, 'mark', {
        username: 'Restless Brute',
        effectiveActor: { username: 'Restless Brute', job: 'Novice', strength: 8, speed: 5, intelligence: 1 },
        target: 'victim',
        row: here.row,
        col: here.col,
        currentTick: tick
      });
    } finally {
      Math.random = original;
    }
    const marked = await db.prepare("SELECT magnitude FROM statusEffects WHERE username = 'victim' AND effectType = 'marked' ORDER BY id DESC LIMIT 1").first();
    assert.ok(marked, 'an NPC offensive cast (via runAbility) still lands its effect on the co-located player');
    assert.equal(marked.magnitude, 2);
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// Plan 018c: grant-ability hook (item → usable ability + hotbar)

test('Plan 018c: equipping an item that grants an ability makes it usable and adds it to the hotbar', async () => {
  const db = await createMigratedDb();
  const { handleSkillAction, validateClassSkillUse, getCurrentTickValue, getUserState, updatePresence } = await import('../worker/game.mjs');
  try {
    const calm = findCalmRoom(getWorldDay());
    await seedLiveUser(db, 'novice', 'Novice');
    await updatePresence(db, 'novice', calm.row, calm.col);
    await getUserState(db, 'novice'); // instantiate body

    // Survey is the Dungeoneer's skill — a Novice cannot use it bare-handed.
    await assert.rejects(
      () => validateClassSkillUse(db, { username: 'novice', skillId: 'survey', targetUsername: '' }),
      /cannot use that skill/
    );

    // Equip the Old Map Scrap (grantsAbility: 'survey') onto the Novice's hand.
    const hand = await db.prepare("SELECT id FROM bodyParts WHERE username = 'novice' AND slotType = 'hand' AND severed = 0 ORDER BY id ASC LIMIT 1").bind().first();
    assert.ok(hand, 'the Novice has a hand to equip onto');
    await db.prepare(
      `INSERT INTO items (templateId, name, slotType, rarity, modifiers, ownerUsername, equippedPartId)
       VALUES ('old_map_scrap', 'Old Map Scrap', 'hand', 'shop', '{"speed":1}', 'novice', ?)`
    ).bind(hand.id).run();

    // Now the granted ability is in the hotbar payload and usable.
    const state = await getUserState(db, 'novice');
    assert.ok(ids(state.skills).includes('survey'), 'the granted ability shows on the hotbar');
    const tick = await getCurrentTickValue(db);
    await handleSkillAction(db, 'novice', calm.row, calm.col, 'survey', '', tick);
    const line = await db.prepare("SELECT message FROM messages WHERE message LIKE 'novice surveys%' ORDER BY id DESC LIMIT 1").bind().first();
    assert.ok(line, 'the Novice can now Survey because of the equipped item');
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// Plan 018c: linguistic-cost evaluator (the plan 012 on-ramp)

test('Plan 018c: evaluateLinguisticCost reads text properties, rounds, clamps, and floors at 0', () => {
  assert.equal(abilities.evaluateLinguisticCost({ perWord: 2 }, 'hello world'), 4);
  assert.equal(abilities.evaluateLinguisticCost({ perCapital: 1 }, 'HELLO there'), 5);
  assert.equal(abilities.evaluateLinguisticCost({ perCharacter: 1 }, '  ab  '), 2, 'length is trimmed');
  assert.equal(abilities.evaluateLinguisticCost({ perWord: 10, max: 3 }, 'a b c'), 3, 'max clamps the surcharge');
  assert.equal(abilities.evaluateLinguisticCost(null, 'anything'), 0, 'no spec means no cost');
  assert.equal(abilities.evaluateLinguisticCost({ perWord: 1 }, ''), 0, 'empty text means no cost');
});

test('Plan 018c: resolveAbilityStaminaCost defaults to 1 and adds the linguistic surcharge', () => {
  // Every shipped ability still costs a flat 1 (parity).
  assert.equal(abilities.resolveAbilityStaminaCost(abilities.getAbility('scrounge')), 1);
  assert.equal(abilities.resolveAbilityStaminaCost(abilities.getAbility('brace')), 1);
  assert.equal(abilities.resolveAbilityStaminaCost(null), 1, 'an unknown ability defaults to 1');

  // A hypothetical linguistic spell (plan 012 content) is charged base + surcharge.
  const spell = { id: 'incant', cost: { stamina: 1, linguistic: { perWord: 1, max: 5 } } };
  assert.equal(abilities.resolveAbilityStaminaCost(spell, { text: 'one two three' }), 4);
  assert.equal(abilities.resolveAbilityStaminaCost(spell, { text: '' }), 1, 'no incantation means base cost');
  assert.equal(abilities.resolveAbilityStaminaCost(spell, {}), 1, 'missing context means base cost');
});
