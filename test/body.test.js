const test = require('node:test');
const assert = require('node:assert/strict');

const {
  HUMANOID_PLAN,
  MODIFIER_KEYS,
  distributeAcrossPlan,
  partCondition,
  bodyPenaltyModifiers,
  pickTargetPart,
  emptyModifiers
} = require('../utils/body');

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
