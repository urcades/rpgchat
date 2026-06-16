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
  assert.equal(head.amount, 4); // 0.15 * 30 = 4.5 -> floors to 4, gains remainder
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
