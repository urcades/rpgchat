const test = require('node:test');
const assert = require('node:assert/strict');

const {
  HUMANOID_PLAN,
  WYRM_PLAN,
  QUADRUPED_PLAN,
  BRUTE_PLAN,
  CREATURE_BODY_PLANS,
  getBodyPlan,
  resolveCreatureBodyPlanId,
  PART_PENALTIES,
  MODIFIER_KEYS,
  distributeAcrossPlan,
  partCondition,
  bodyPenaltyModifiers,
  pickTargetPart,
  emptyModifiers,
  STANCES,
  normalizeStance,
  parseCalledShot
} = require('../utils/body');
const {
  scaleNpcStats,
  rollAffixes,
  buildAffixRoll,
  baseCreatureName,
  eliteDisplayName,
  ELITE_MIN_LEVEL
} = require('../utils/npcGrowth');

test('distributeAcrossPlan sums exactly for awkward totals', () => {
  for (const total of [0, 1, 30, 31, 37, 100, 999]) {
    const parts = distributeAcrossPlan(total);
    assert.equal(parts.length, HUMANOID_PLAN.length);
    const sum = parts.reduce((acc, part) => acc + part.amount, 0);
    assert.equal(sum, total, `total ${total} should sum exactly`);
    for (const part of parts) {
      assert.ok(Number.isInteger(part.amount));
      assert.ok(part.amount >= 0);
    }
  }
});

test('distributeAcrossPlan preserves template fields and largest-remainder order', () => {
  const parts = distributeAcrossPlan(30);
  const torso = parts.find(part => part.partType === 'torso');
  const head = parts.find(part => part.partType === 'head');
  assert.equal(torso.amount, 9); // 0.30 * 30
  assert.equal(head.amount, 5); // 0.15 * 30 = 4.5 -> floors to 4, remainder .5 wins a leftover unit -> 5
  assert.equal(torso.label, 'torso');
  assert.equal(torso.vital, true);
});

test('partCondition reads thresholds from hp/maxHp without storing', () => {
  assert.equal(partCondition({ hp: 4, maxHp: 4, severed: 0 }), 'healthy');
  assert.equal(partCondition({ hp: 9, maxHp: 10, severed: 0 }), 'healthy'); // ratio 0.9 boundary -> healthy
  assert.equal(partCondition({ hp: 8, maxHp: 10, severed: 0 }), 'hurt'); // ratio 0.8 < 0.9
  assert.equal(partCondition({ hp: 1, maxHp: 4, severed: 0 }), 'mangled'); // ratio 0.25 boundary -> mangled
  assert.equal(partCondition({ hp: 2, maxHp: 4, severed: 0 }), 'hurt'); // ratio 0.5
  assert.equal(partCondition({ hp: 0, maxHp: 4, severed: 0 }), 'mangled'); // ratio 0
  assert.equal(partCondition({ hp: 0, maxHp: 4, severed: 1 }), 'missing'); // severed wins
});

test('bodyPenaltyModifiers sums penalties across mangled and missing parts', () => {
  const parts = [
    { partType: 'arm', label: 'left arm', hp: 0, maxHp: 4, severed: 1 }, // missing arm: strength -3
    { partType: 'arm', label: 'right arm', hp: 1, maxHp: 4, severed: 0 }, // mangled arm: strength -2
    { partType: 'leg', label: 'left leg', hp: 0, maxHp: 4, severed: 1 }, // missing leg: speed -2
    { partType: 'leg', label: 'right leg', hp: 4, maxHp: 4, severed: 0 }, // healthy: no penalty
    { partType: 'torso', label: 'torso', hp: 1, maxHp: 8, severed: 0 } // mangled torso: maxStamina -10
  ];
  const modifiers = bodyPenaltyModifiers(parts);
  assert.equal(modifiers.strength, -5);
  assert.equal(modifiers.speed, -2);
  assert.equal(modifiers.maxStamina, -10);
  assert.equal(modifiers.intelligence, 0);
  assert.equal(modifiers.maxHealth, 0);
});

test('bodyPenaltyModifiers returns empty modifiers for healthy bodies', () => {
  const parts = distributeAcrossPlan(30).map(part => ({
    ...part,
    hp: part.amount,
    maxHp: part.amount,
    severed: 0
  }));
  assert.deepEqual(bodyPenaltyModifiers(parts), emptyModifiers());
});

test('emptyModifiers zeroes every modifier key', () => {
  const empty = emptyModifiers();
  assert.deepEqual(Object.keys(empty).sort(), [...MODIFIER_KEYS].sort());
  for (const key of MODIFIER_KEYS) {
    assert.equal(empty[key], 0);
  }
});

test('pickTargetPart respects weights under a seeded random and skips severed parts', () => {
  const parts = [
    { label: 'head', maxHp: 2, severed: 0 },
    { label: 'torso', maxHp: 4, severed: 0 },
    { label: 'left arm', maxHp: 1, severed: 1 }, // severed: never picked
    { label: 'right leg', maxHp: 3, severed: 0 }
  ];
  // Live weights: head 2, torso 4, right leg 3 (total 9). roll = random * 9.
  // 0.0 -> 0 lands in head (0..2)
  assert.equal(pickTargetPart(parts, () => 0.0).label, 'head');
  // 0.3 -> 2.7 lands in torso (2..6)
  assert.equal(pickTargetPart(parts, () => 0.3).label, 'torso');
  // 0.99 -> 8.91 lands in right leg (6..9)
  assert.equal(pickTargetPart(parts, () => 0.99).label, 'right leg');
  // The severed arm is never selected across the weight range.
  for (const r of [0, 0.1, 0.25, 0.5, 0.75, 0.999]) {
    assert.notEqual(pickTargetPart(parts, () => r).label, 'left arm');
  }
});

test('pickTargetPart returns null when every part is severed', () => {
  const parts = [
    { label: 'head', maxHp: 2, severed: 1 },
    { label: 'torso', maxHp: 4, severed: 1 }
  ];
  assert.equal(pickTargetPart(parts, () => 0.5), null);
  assert.equal(pickTargetPart([], () => 0.5), null);
});

test('parseCalledShot normalizes labels across case, spaces, and underscores', () => {
  assert.equal(parseCalledShot('take his RIGHT_ARM off @bob'), 'right arm');
  assert.equal(parseCalledShot('aim for the Left Leg'), 'left leg');
  assert.equal(parseCalledShot('go for the head'), 'head');
  assert.equal(parseCalledShot('strike the TORSO'), 'torso');
  assert.equal(parseCalledShot('a clean shot at his neck'), 'neck');
  // underscore form for a one-word label is a no-op (still matches)
  assert.equal(parseCalledShot('hit the left_arm'), 'left arm');
});

test('parseCalledShot returns null when no part is named', () => {
  assert.equal(parseCalledShot('I attack @bob'), null);
  assert.equal(parseCalledShot(''), null);
  assert.equal(parseCalledShot(undefined), null);
  // word-boundary anchored: a part name embedded inside another word never matches
  assert.equal(parseCalledShot('he charged headlong into battle'), null);
  assert.equal(parseCalledShot('the armageddon begins'), null); // 'arm' inside 'armageddon'
});

test('normalizeStance accepts known keys and falls back to standing', () => {
  assert.equal(normalizeStance('aggressive'), 'aggressive');
  assert.equal(normalizeStance('GUARDING'), 'guarding');
  assert.equal(normalizeStance('  crouched  '), 'crouched');
  assert.equal(normalizeStance('standing'), 'standing');
  assert.equal(normalizeStance('nonsense'), 'standing');
  assert.equal(normalizeStance(''), 'standing');
  assert.equal(normalizeStance(undefined), 'standing');
  assert.equal(normalizeStance(null), 'standing');
});

test('STANCES table has the four expected keys and a neutral standing default', () => {
  assert.deepEqual(Object.keys(STANCES).sort(), ['aggressive', 'crouched', 'guarding', 'standing']);
  // standing must be all-zero so the default is behavior-neutral in combat.
  const standing = STANCES.standing;
  assert.equal(standing.hitBonus, 0);
  assert.equal(standing.dodgeBonus, 0);
  assert.equal(standing.damageBonus, 0);
  assert.equal(standing.damageTakenDelta, 0);
  // Every stance exposes the same shape with numeric fields and a label.
  for (const key of Object.keys(STANCES)) {
    const stance = STANCES[key];
    assert.equal(typeof stance.label, 'string');
    for (const field of ['hitBonus', 'dodgeBonus', 'damageBonus', 'damageTakenDelta']) {
      assert.equal(typeof stance[field], 'number', `${key}.${field} is numeric`);
    }
  }
});

// --- Plan 021 (BOLD): creature body-plan registry -------------------------------

test('Plan 021: every creature body plan has shares summing to 1.0 and the {partType,label,slotType,share,vital} shape', () => {
  for (const [id, plan] of Object.entries(CREATURE_BODY_PLANS)) {
    const sum = plan.reduce((acc, part) => acc + part.share, 0);
    // Float math can land a hair off 1.0 — assert within a tight epsilon; the EXACT
    // sum guarantee comes from distributeAcrossPlan's largest-remainder pass (below).
    assert.ok(Math.abs(sum - 1.0) < 1e-9, `${id} shares sum to 1.0 (got ${sum})`);
    for (const part of plan) {
      assert.equal(typeof part.partType, 'string');
      assert.equal(typeof part.label, 'string');
      assert.ok('slotType' in part);
      assert.equal(typeof part.share, 'number');
      assert.ok(typeof part.vital === 'boolean' || part.vital === 0 || part.vital === 1);
    }
    // Each plan must carry at least one vital part (else nothing can ever truly die a
    // vital death) and exactly one partType 'torso' (the spill-to-torso sink).
    assert.ok(plan.some(p => p.vital), `${id} has a vital part`);
    assert.equal(plan.filter(p => p.partType === 'torso').length, 1, `${id} has exactly one torso-type part`);
    // Labels are unique (bodyParts is UNIQUE(username,label)).
    assert.equal(new Set(plan.map(p => p.label)).size, plan.length, `${id} labels are unique`);
  }
});

test('Plan 021: distributeAcrossPlan sums EXACTLY for WYRM_PLAN on awkward totals', () => {
  for (const total of [0, 1, 20, 31, 37, 100, 999]) {
    const parts = distributeAcrossPlan(total, WYRM_PLAN);
    assert.equal(parts.length, WYRM_PLAN.length);
    const sum = parts.reduce((acc, part) => acc + part.amount, 0);
    assert.equal(sum, total, `WYRM total ${total} sums exactly`);
    for (const part of parts) {
      assert.ok(Number.isInteger(part.amount) && part.amount >= 0);
    }
  }
});

test('Plan 021: distributeAcrossPlan sums EXACTLY for QUADRUPED_PLAN too', () => {
  for (const total of [0, 1, 20, 31, 8, 14, 50]) {
    const sum = distributeAcrossPlan(total, QUADRUPED_PLAN).reduce((acc, p) => acc + p.amount, 0);
    assert.equal(sum, total, `QUADRUPED total ${total} sums exactly`);
  }
});

test('Plan 021: resolveCreatureBodyPlanId maps the known bestiary and defaults unmapped hostiles to brute', () => {
  assert.equal(resolveCreatureBodyPlanId('Frost Wyrm'), 'wyrm');
  assert.equal(resolveCreatureBodyPlanId('Ice Gnawer'), 'quadruped');
  assert.equal(resolveCreatureBodyPlanId('Frost Thrall'), 'brute');
  assert.equal(resolveCreatureBodyPlanId('Restless Brute'), 'brute');
  assert.equal(resolveCreatureBodyPlanId('Room Lurker'), 'brute');
  // BOLD: every unmapped hostile still gets a body (humanoid 'brute'), never null.
  assert.equal(resolveCreatureBodyPlanId('Goblin Raider'), 'brute');
  assert.equal(resolveCreatureBodyPlanId('Whatever McUnknown'), 'brute');
});

test('Plan 021: getBodyPlan resolves ids and returns null for absent/unknown (the scalar gate)', () => {
  assert.equal(getBodyPlan('wyrm'), WYRM_PLAN);
  assert.equal(getBodyPlan('quadruped'), QUADRUPED_PLAN);
  assert.equal(getBodyPlan('brute'), BRUTE_PLAN);
  assert.equal(getBodyPlan('humanoid'), HUMANOID_PLAN);
  // A NULL/absent/unknown id is the scalar-HP path.
  assert.equal(getBodyPlan(null), null);
  assert.equal(getBodyPlan(undefined), null);
  assert.equal(getBodyPlan(''), null);
  assert.equal(getBodyPlan('nonsense'), null);
});

test('Plan 021: wing and tail penalties degrade speed when mangled or missing', () => {
  assert.deepEqual(PART_PENALTIES.wing.mangled, { speed: -1 });
  assert.deepEqual(PART_PENALTIES.wing.missing, { speed: -2 });
  assert.deepEqual(PART_PENALTIES.tail.mangled, { speed: -1 });
  assert.deepEqual(PART_PENALTIES.tail.missing, { speed: -1 });
  // Folded through bodyPenaltyModifiers: a severed wing + mangled tail = speed -3.
  const parts = [
    { partType: 'wing', label: 'left wing', hp: 0, maxHp: 3, severed: 1 }, // missing wing: speed -2
    { partType: 'tail', label: 'tail', hp: 0, maxHp: 3, severed: 0 } // mangled tail: speed -1
  ];
  assert.equal(bodyPenaltyModifiers(parts).speed, -3);
});

test('Plan 021: parseCalledShot is plan-aware — wyrm/quadruped parts resolve across separators', () => {
  // Wyrm parts.
  assert.equal(parseCalledShot('aim for the left wing'), 'left wing');
  assert.equal(parseCalledShot('sever its RIGHT_WING'), 'right wing');
  assert.equal(parseCalledShot('go for the tail'), 'tail');
  assert.equal(parseCalledShot('strike the body @wyrm'), 'body');
  // Quadruped hyphenated labels accept space/underscore/hyphen between every token.
  assert.equal(parseCalledShot('cripple the hind-left leg'), 'hind-left leg');
  assert.equal(parseCalledShot('cripple the hind left leg'), 'hind-left leg');
  assert.equal(parseCalledShot('cripple the front_right_leg'), 'front-right leg');
  // Humanoid called shots are unchanged (regression guard for players).
  assert.equal(parseCalledShot('take his RIGHT_ARM off @bob'), 'right arm');
  assert.equal(parseCalledShot('go for the head'), 'head');
});

// --- Plan 021 (BOLD): elite growth (pure module) --------------------------------

test('Plan 021: scaleNpcStats inflates stored health/strength with level; level 8 > level 3 > level 1', () => {
  const base = { health: 20, maxHealth: 20, strength: 12 };
  const l1 = scaleNpcStats(base, 1);
  const l3 = scaleNpcStats(base, 3);
  const l8 = scaleNpcStats(base, 8);
  // Level 1 is byte-identical to the base (no growth).
  assert.equal(l1.health, 20);
  assert.equal(l1.strength, 12);
  // Monotonic growth in both health and strength.
  assert.ok(l3.health > l1.health, 'L3 health > L1');
  assert.ok(l8.health > l3.health, 'L8 health > L3');
  assert.ok(l8.strength > l3.strength, 'L8 strength > L3');
  // health and maxHealth scale together (a fresh spawn is at full health).
  assert.equal(l8.health, l8.maxHealth);
  // Never mutates the input.
  assert.equal(base.health, 20);
});

test('Plan 021: rollAffixes returns nothing below the elite floor, and 1–2 affixes at/above it', () => {
  // Below the floor: always empty, whatever the RNG.
  const low = rollAffixes(ELITE_MIN_LEVEL - 1, () => 0);
  assert.deepEqual(low.affixes, []);
  assert.equal(low.prefix, '');
  // At the floor: a deterministic roll yields a known count. random()<0.5 -> 1 affix;
  // then the pick draw indexes AFFIX_NAMES.
  const one = rollAffixes(ELITE_MIN_LEVEL, () => 0); // count draw 0 -> 1 affix; pick 0 -> first
  assert.equal(one.affixes.length, 1);
  assert.ok(one.prefix.length > 0);
  // A two-affix roll (count draw >= 0.5).
  let calls = 0;
  const two = rollAffixes(8, () => { calls += 1; return calls === 1 ? 0.9 : (calls === 2 ? 0.0 : 0.34); });
  assert.equal(two.affixes.length, 2);
  assert.equal(new Set(two.affixes).size, 2, 'no duplicate affixes');
});

test('Plan 021: buildAffixRoll folds deltas — Vicious bumps strength, Armored exposes partMaxHpDelta, Hulking adds parts, Rending sets element', () => {
  const vicious = buildAffixRoll(['Vicious']);
  assert.equal(vicious.applyTemplate({ strength: 12 }).strength, 16, 'Vicious +4 strength');
  assert.equal(vicious.prefix, 'Vicious');

  const armored = buildAffixRoll(['Armored']);
  assert.ok(armored.partMaxHpDelta > 0, 'Armored fortifies part maxHp');

  const hulking = buildAffixRoll(['Hulking']);
  assert.ok(hulking.extraParts.length >= 1, 'Hulking appends extra parts');
  for (const p of hulking.extraParts) {
    assert.ok(p.label && Number.isFinite(p.maxHp) && !p.vital, 'extra parts are non-vital with a label + maxHp');
  }

  const rending = buildAffixRoll(['Rending']);
  assert.ok(typeof rending.element === 'string' && rending.element.length > 0, 'Rending grants an element');

  // Combined prefix joins in order.
  assert.equal(buildAffixRoll(['Vicious', 'Armored']).prefix, 'Vicious Armored');
});

test('Plan 021: eliteDisplayName / baseCreatureName round-trip the affix prefix', () => {
  assert.equal(eliteDisplayName('Frost Wyrm', 'Vicious'), 'Vicious Frost Wyrm');
  assert.equal(eliteDisplayName('Frost Wyrm', ''), 'Frost Wyrm');
  assert.equal(baseCreatureName('Vicious Frost Wyrm'), 'Frost Wyrm');
  assert.equal(baseCreatureName('Vicious Armored Frost Wyrm'), 'Frost Wyrm');
  assert.equal(baseCreatureName('Frost Wyrm'), 'Frost Wyrm');
  // Never strips the whole name away even if every word looks like an affix.
  assert.equal(baseCreatureName('Vicious'), 'Vicious');
});

// --- adv-018: BODY delta-writes — concurrent damage/heal compose, no lost update ---
//
// These exercise body.mjs against the real D1 shim. applyBodyDamage/applyBodyHeal now
// persist RELATIVE deltas (`hp = MAX(hp - dealt, 0)` / `hp = MIN(hp + healed, maxHp)`,
// and the same on users.health) instead of writing JS-computed ABSOLUTES. The root-cause
// race: two handlers each read the row, compute a new hp, and write it back; with absolute
// writes the second writer clobbers the first (a heal or a hit is silently lost). The
// deltas commute, so both land. The `users.health == Σ bodyParts.hp` invariant, the
// sever-at-0 and vital-death transitions, and the damage/heal amounts are all unchanged.

const { createMigratedDb } = require('./.helpers/d1');

async function assertBodyInvariant(db, username, where) {
  const u = await db.prepare('SELECT health FROM users WHERE username = ?').bind(username).first();
  const sum = await db.prepare('SELECT COALESCE(SUM(hp), 0) AS s FROM bodyParts WHERE username = ?').bind(username).first();
  assert.equal(u.health, sum.s, `health == Σ bodyParts.hp ${where} (health=${u.health}, Σhp=${sum.s})`);
}

async function seedBodiedPlayer(db, username, { health, maxHealth }) {
  await db.prepare(
    `INSERT INTO users (username, password, job, health, maxHealth, stamina, maxStamina, speed, strength, intelligence, level, gold)
     VALUES (?, 'pw', 'Fighter', ?, ?, 100, 100, 5, 10, 5, 4, 0)`
  ).bind(username, health, maxHealth).run();
  const row = await db.prepare('SELECT * FROM users WHERE username = ?').bind(username).first();
  const game = await import('../worker/game.mjs');
  await game.ensureBody(db, row);
  return row;
}

test('adv-018 (lost-update race): a heal and a hit applied from the SAME stale snapshot BOTH land — neither is clobbered', async () => {
  const db = await createMigratedDb();
  const game = await import('../worker/game.mjs');
  try {
    // A full-health player, then wound the torso so there is real headroom to heal into AND
    // hp to take off — and so the heal's worst-ratio fill and the called-shot hit both touch
    // the torso (the part we reason about precisely).
    await seedBodiedPlayer(db, 'racer', { health: 30, maxHealth: 30 });
    // Wound the torso by 6 (called shot). After this, torso has 6 of headroom.
    const woundSnap = await db.prepare('SELECT * FROM users WHERE username = ?').bind('racer').first();
    await applyDamageNoMsg(game, db, woundSnap, 6, 'torso');
    await assertBodyInvariant(db, 'racer', 'after the setup wound');

    const torsoMid = (await game.getBodyParts(db, 'racer')).find(p => p.label === 'torso');
    const healthMid = (await db.prepare("SELECT health FROM users WHERE username = 'racer'").first()).health;
    assert.equal(healthMid, 24, 'health fell 30 -> 24 after the 6-damage setup wound');

    // THE RACE. Two handlers each read the row HERE, at health 24, then both write back.
    // Handler A reads `stale`, heals 4. Handler B ALSO acts on `stale` (a snapshot from
    // before A committed), hitting the torso for 5. With the OLD absolute writes, B would
    // write health = 24 - 5 = 19 and clobber A's heal (A wrote 28); the heal would vanish.
    // With deltas, A does health += 4 and B does health -= 5, so the net is 24 + 4 - 5 = 23.
    const stale = await db.prepare('SELECT * FROM users WHERE username = ?').bind('racer').first();

    // Handler A: heal 4 (fills the torso worst-ratio-first; torso is the only wounded part).
    await game.applyBodyHeal(db, stale, 4, {});
    // Handler B: hit the torso for 5, acting on the SAME pre-heal snapshot `stale`.
    await applyDamageNoMsg(game, db, stale, 5, 'torso');

    const healthAfter = (await db.prepare("SELECT health FROM users WHERE username = 'racer'").first()).health;
    assert.equal(healthAfter, 23, 'BOTH composed: 24 + 4 (heal) - 5 (hit) = 23 — neither operation lost');
    const torsoAfter = (await game.getBodyParts(db, 'racer')).find(p => p.label === 'torso');
    assert.equal(torsoAfter.hp, torsoMid.hp + 4 - 5, 'the torso part itself reflects BOTH the heal and the hit');
    // The whole point of the fix: the invariant re-converges immediately, not on the daily sweep.
    await assertBodyInvariant(db, 'racer', 'after the interleaved heal + hit');
  } finally {
    await db.close();
  }
});

test('adv-018: two hits from the SAME stale snapshot both subtract (no lost second hit)', async () => {
  const db = await createMigratedDb();
  const game = await import('../worker/game.mjs');
  try {
    // maxHealth 100 → torso pool 30, so both blows land fully on the torso with no overkill.
    await seedBodiedPlayer(db, 'twohit', { health: 100, maxHealth: 100 });
    // Both blows read the SAME health-100 snapshot. Old absolutes: the second writer wins and
    // only 7 total comes off (the hp it computed from the stale 100); deltas take 4 then 7 = 11.
    const stale = await db.prepare('SELECT * FROM users WHERE username = ?').bind('twohit').first();
    await applyDamageNoMsg(game, db, stale, 4, 'torso');
    await applyDamageNoMsg(game, db, stale, 7, 'torso');
    const health = (await db.prepare("SELECT health FROM users WHERE username = 'twohit'").first()).health;
    assert.equal(health, 89, '100 - 4 - 7 = 89 — the second hit was not overwritten by a stale absolute');
    await assertBodyInvariant(db, 'twohit', 'after two interleaved hits');
  } finally {
    await db.close();
  }
});

test('adv-018: applyBodyDamage still SEVERS a non-vital part driven to 0 (delta write floors at 0)', async () => {
  const db = await createMigratedDb();
  const game = await import('../worker/game.mjs');
  try {
    // health 100 → the 11-part humanoid arm pool is 0.08 * 100 = 8. A full-pool called
    // shot to the left arm drives it -> 0 with no spill, severing it; the distal cascade
    // takes the left hand with it. The player survives (arm and hand are non-vital).
    await seedBodiedPlayer(db, 'severee', { health: 100, maxHealth: 100 });
    const armBefore = (await game.getBodyParts(db, 'severee')).find(p => p.label === 'left arm');
    const handBefore = (await game.getBodyParts(db, 'severee')).find(p => p.label === 'left hand');
    const maxBefore = (await db.prepare("SELECT maxHealth FROM users WHERE username = 'severee'").first()).maxHealth;
    const target = await db.prepare('SELECT * FROM users WHERE username = ?').bind('severee').first();
    const result = await game.applyBodyDamage(db, target, armBefore.maxHp, {
      cause: 'test', targetLabel: 'left arm', random: () => 0
    });

    assert.equal(result.died, false, 'severing a non-vital arm does not kill');
    assert.deepEqual(result.severedLabels, ['left arm', 'left hand'], 'the arm is severed and the hand cascades with it');
    const armAfter = (await game.getBodyParts(db, 'severee')).find(p => p.label === 'left arm');
    assert.equal(armAfter.hp, 0, 'the delta write floored the part hp at 0');
    assert.equal(armAfter.severed, 1, 'the part is severed at 0 — sever logic intact under delta writes');
    const handAfter = (await game.getBodyParts(db, 'severee')).find(p => p.label === 'left hand');
    assert.equal(handAfter.severed, 1, 'the distal hand is severed by the cascade');
    const maxAfter = (await db.prepare("SELECT maxHealth FROM users WHERE username = 'severee'").first()).maxHealth;
    assert.equal(maxBefore - maxAfter, armBefore.maxHp + handBefore.maxHp, 'maxHealth dropped by the severed arm + cascaded hand pools');
    await assertBodyInvariant(db, 'severee', 'after a sever via delta write');
  } finally {
    await db.close();
  }
});

test('adv-018: applyBodyDamage still KILLS when a vital part is driven to 0', async () => {
  const db = await createMigratedDb();
  const game = await import('../worker/game.mjs');
  try {
    // The torso is vital. A called shot for the full torso pool drives it 0 -> vital death.
    await seedBodiedPlayer(db, 'doomed', { health: 100, maxHealth: 100 });
    const torso = (await game.getBodyParts(db, 'doomed')).find(p => p.label === 'torso');
    assert.equal(torso.vital, 1, 'the torso is vital');
    const target = await db.prepare('SELECT * FROM users WHERE username = ?').bind('doomed').first();
    const result = await game.applyBodyDamage(db, target, torso.maxHp, {
      cause: 'test', targetLabel: 'torso', random: () => 0
    });
    assert.equal(result.died, true, 'destroying the vital torso kills (vital-death logic intact under deltas)');
    const torsoAfter = (await game.getBodyParts(db, 'doomed')).find(p => p.label === 'torso');
    assert.equal(torsoAfter.hp, 0, 'the vital part is at 0');
    await assertBodyInvariant(db, 'doomed', 'after a vital-part kill');
  } finally {
    await db.close();
  }
});

test('adv-018: applyBodyHeal never lifts health above maxHealth even when applied from a stale low snapshot', async () => {
  const db = await createMigratedDb();
  const game = await import('../worker/game.mjs');
  try {
    // Wound by 4, then heal 100 from a stale snapshot: the MIN(..., maxHealth) clamp must
    // hold health at the cap (30), exactly as the old absolute clamp did — no overshoot.
    await seedBodiedPlayer(db, 'capped', { health: 30, maxHealth: 30 });
    const woundSnap = await db.prepare('SELECT * FROM users WHERE username = ?').bind('capped').first();
    await applyDamageNoMsg(game, db, woundSnap, 4, 'torso');
    const stale = await db.prepare('SELECT * FROM users WHERE username = ?').bind('capped').first();
    await game.applyBodyHeal(db, stale, 100, {});
    const health = (await db.prepare("SELECT health FROM users WHERE username = 'capped'").first()).health;
    assert.equal(health, 30, 'a massive heal clamps at maxHealth (30), never overshoots');
    await assertBodyInvariant(db, 'capped', 'after an over-heal');
  } finally {
    await db.close();
  }
});

// A called-shot damage helper that injects the RNG via options.random (NOT the global
// Math.random) so it can't leak into other test files that node:test runs concurrently in
// the same process. The called shot overrides the draw anyway; `() => 0` just pins it. No
// row/col → no room messages.
async function applyDamageNoMsg(game, db, userRow, amount, label) {
  return game.applyBodyDamage(db, userRow, amount, { cause: 'test', targetLabel: label, random: () => 0 });
}
