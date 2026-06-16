// Unit coverage for describeAttack — the weapon- & part-aware brutal attack line.
// Pure + deterministic: random is INJECTED (plan 004 convention), so every verb /
// part-noun / execution-line pick is reproducible. The sequence helper hands out
// the provided values in draw order, then repeats the last — mirroring the
// withMockedRandom helper the integration suites use.
//
// Draw order inside describeAttack:
//   - the part-noun pick (only when a known `part` is supplied) is ALWAYS first;
//   - then EITHER the verb pick (a live hit) OR the execution-line pick (downed).
// CommonJS + node:test to match the rest of test/.

const test = require('node:test');
const assert = require('node:assert/strict');

const { describeAttack, PART_NOUNS, VERBS, EXECUTION } = require('../utils/combatFlavor');

// A random() that returns each value in turn, repeating the last once exhausted.
function seq(values) {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)];
}

test('a blade hit names a blade verb and a part-noun, with the damage in parens', () => {
  // part 'torso' -> noun pick is draw 1; damage 4 -> 'solid' tier -> verb pick is draw 2.
  // noun 0.0 -> PART_NOUNS.torso[0] = 'ribs'; verb 0.0 -> VERBS.blade.solid[0] = 'hacks into'.
  const line = describeAttack(
    { attacker: 'Mara', target: 'Bandit', weaponClass: 'blade', part: 'torso', damage: 4 },
    seq([0.0, 0.0])
  );
  assert.equal(line, "Mara hacks into Bandit's ribs (4)");
  assert.match(line, /\(4\)/, 'damage rides in parens');
  assert.ok(VERBS.blade.solid.includes('hacks into'), 'verb came from the blade/solid set');
  assert.ok(PART_NOUNS.torso.includes('ribs'), 'noun came from the torso set');
});

test('a fist/NPC hit (no weapon class) uses the fist verb set and names no part when part is null', () => {
  // No part -> no noun draw; damage 2 -> 'light' tier -> verb pick is the FIRST (only) draw.
  // verb 0.0 -> VERBS.fist.light[0] = 'clips'.
  const line = describeAttack(
    { attacker: 'Frost Wyrm', target: 'hunter', weaponClass: 'fist', part: null, damage: 2 },
    seq([0.0])
  );
  assert.equal(line, 'Frost Wyrm clips hunter (2)');
  assert.doesNotMatch(line, /'s /, 'no body part is named when part is null');
});

test('an unknown weapon class falls back to the fist verbs', () => {
  // weaponClass 'laser' is not in VERBS -> klass coerces to 'fist'. damage 2 -> light.
  const line = describeAttack(
    { attacker: 'A', target: 'B', weaponClass: 'laser', part: null, damage: 2 },
    seq([0.0])
  );
  assert.equal(line, 'A clips B (2)');
});

test('a downed target with a head shot yields a head EXECUTION line (the curb-stomp)', () => {
  // part 'head' -> noun pick is draw 1 (face/skull/etc), execution-line pick is draw 2.
  // noun 0.0 -> 'skull'; exec 0.0 -> EXECUTION.head[0] (the wet, final crunch).
  const line = describeAttack(
    { attacker: 'Mara', target: 'Bandit', weaponClass: 'blunt', part: 'head', damage: 5, targetDowned: true },
    seq([0.0, 0.0])
  );
  assert.equal(line, "Mara stomps down on Bandit's skull as they lie — a wet, final crunch (5)");
  assert.match(line, /stomps down on/, 'a head curb-stomp execution');
});

test('a downed target with no part falls to the default execution set and uses the weapon noun', () => {
  // part null -> no noun draw; execution-line pick is the FIRST draw. blunt -> WEAPON_NOUN 'heel'.
  // exec 0.0 -> EXECUTION.default[0] = "drives a {w} into {tgt}'s {pn} as they writhe".
  const line = describeAttack(
    { attacker: 'Ash', target: 'Goblin', weaponClass: 'blunt', part: null, damage: 4, targetDowned: true },
    seq([0.0])
  );
  assert.equal(line, "Ash drives a heel into Goblin's body as they writhe (4)");
  assert.match(line, /\bheel\b/, 'blunt resolves the {w} token to its weapon noun');
});

test('a downed neck shot drives the weapon through the throat', () => {
  // part 'neck' -> noun pick draw 1, exec pick draw 2. blade -> {w} = 'blade'.
  // noun 0.0 -> 'throat'; exec 0.0 -> EXECUTION.neck[0].
  const line = describeAttack(
    { attacker: 'Ash', target: 'Goblin', weaponClass: 'blade', part: 'neck', damage: 3, targetDowned: true },
    seq([0.0, 0.0])
  );
  assert.equal(line, "Ash drives a blade through Goblin's throat where they lie (3)");
});

test('damage tiers pick the right verb SET: light < 3, solid 3..5, brutal >= 6', () => {
  // Same blade weapon, no part (verb pick is the sole draw at 0.0 -> first of each set).
  const light = describeAttack({ attacker: 'A', target: 'B', weaponClass: 'blade', damage: 2 }, seq([0.0]));
  const solid = describeAttack({ attacker: 'A', target: 'B', weaponClass: 'blade', damage: 3 }, seq([0.0]));
  const brutal = describeAttack({ attacker: 'A', target: 'B', weaponClass: 'blade', damage: 6 }, seq([0.0]));
  assert.equal(light, 'A slashes at B (2)', 'light tier (VERBS.blade.light[0])');
  assert.equal(solid, 'A hacks into B (3)', 'solid tier (VERBS.blade.solid[0])');
  assert.equal(brutal, 'A cleaves deep into B (6)!', 'brutal tier (VERBS.blade.brutal[0]) + bang');
  assert.ok(VERBS.blade.light.includes('slashes at'));
  assert.ok(VERBS.blade.solid.includes('hacks into'));
  assert.ok(VERBS.blade.brutal.includes('cleaves deep into'));
});

test('a critical promotes any damage to the brutal tier and appends a bang', () => {
  // damage 1 (would be light) but isCritical -> brutal tier. pierce.brutal[0] = 'runs the blade through'.
  const line = describeAttack(
    { attacker: 'sniper', target: 'mark', weaponClass: 'pierce', part: null, damage: 1, isCritical: true },
    seq([0.0])
  );
  assert.equal(line, 'sniper runs the blade through mark (1)!');
  assert.match(line, /!$/, 'a crit ends with a bang');
});

test('a heavy non-crit hit (damage >= 6) also gets the bang', () => {
  const line = describeAttack({ attacker: 'A', target: 'B', weaponClass: 'fist', part: null, damage: 6 }, seq([0.0]));
  assert.match(line, /\(6\)!$/, 'damage >= 6 appends the bang even without a crit');
});

test('an unknown part label is treated as no-part (no noun drawn, no "\'s")', () => {
  // 'antenna' is not in PART_NOUNS -> nouns falsy -> no noun draw; verb pick is the sole draw.
  const line = describeAttack(
    { attacker: 'A', target: 'B', weaponClass: 'fist', part: 'antenna', damage: 2 },
    seq([0.0])
  );
  assert.equal(line, 'A clips B (2)');
});

test('default args: a bare call is fist/light and still well-formed', () => {
  // No weaponClass -> 'fist'; no damage -> 0 -> light; no part -> no noun. verb draw at 0.0.
  const line = describeAttack({ attacker: 'A', target: 'B' }, seq([0.0]));
  assert.equal(line, 'A clips B (0)');
});

test('the EXECUTION/VERBS/PART_NOUNS tables are exported for callers and tests', () => {
  assert.ok(EXECUTION.head && EXECUTION.neck && EXECUTION.default, 'execution sets present');
  assert.deepEqual(Object.keys(VERBS).sort(), ['blade', 'blunt', 'fist', 'pierce']);
});

// ---------------------------------------------------------------------------
// Self-directed (reflexive) flavor — a player who targets themselves. The grammar
// flips to "their own <part>" / "themselves" so a self-attack never reads
// "mog carves across mog's throat". Draw order in the self branch mirrors the rest:
//   - the part-noun pick (only when a known `part` is given) is ALWAYS first;
//   - then the SELF_VERBS / SELF_NO_PART / SELF_DOWNED pick.

test('self + a known part names a reflexive verb and "their own <part>" — never "name\'s name"', () => {
  // part 'neck' -> noun pick is draw 1 (0.0 -> 'throat'); SELF_VERBS.blade pick is draw 2.
  // verb 0.0 -> SELF_VERBS.blade[0] = 'drags the edge across their own'.
  const line = describeAttack(
    { attacker: 'mog', target: 'mog', weaponClass: 'blade', part: 'neck', damage: 3, self: true },
    seq([0.0, 0.0])
  );
  assert.equal(line, 'mog drags the edge across their own throat (3)');
  assert.match(line, /their own/, 'reads as self-directed');
  assert.doesNotMatch(line, /mog's mog/, "never the broken possessive 'name's name'");
});

test('self + a known part, second verb in the set (draw 1 advances the SELF_VERBS pick)', () => {
  // part 'torso' -> noun draw 1 (0.0 -> 'ribs'); SELF_VERBS.blade pick draw 2 at 0.3 -> index 1.
  // 0.3 * 4 = 1.2 -> floor 1 -> SELF_VERBS.blade[1] = 'opens their own'.
  const line = describeAttack(
    { attacker: 'mog', target: 'mog', weaponClass: 'blade', part: 'torso', damage: 5, self: true },
    seq([0.0, 0.3])
  );
  assert.equal(line, 'mog opens their own ribs (5)');
});

test('self with no part falls to the SELF_NO_PART set', () => {
  // No part -> no noun draw; SELF_NO_PART pick is the sole draw. 0.0 -> 'turns the blow on themselves'.
  const line = describeAttack(
    { attacker: 'mog', target: 'mog', weaponClass: 'fist', part: null, damage: 2, self: true },
    seq([0.0])
  );
  assert.equal(line, 'mog turns the blow on themselves (2)');
  assert.doesNotMatch(line, /'s /, 'no possessive when no part is named');
});

test('self + targetDowned yields a SELF_DOWNED line (the grim finish)', () => {
  // No part -> no noun draw; the self branch's targetDowned check returns first.
  // SELF_DOWNED pick is the sole draw. 0.0 -> 'stops struggling and lets the last blow fall'.
  const line = describeAttack(
    { attacker: 'mog', target: 'mog', weaponClass: 'blade', part: null, damage: 4, self: true, targetDowned: true },
    seq([0.0])
  );
  assert.equal(line, 'mog stops struggling and lets the last blow fall (4)');
  assert.match(line, /last blow fall/, 'a downed self-attack reads as giving up');
});

test('self respects the weapon class for the reflexive verb set (blunt vs fist)', () => {
  // part 'head' -> noun draw 1 (0.0 -> 'skull'); SELF_VERBS.blunt pick draw 2 (0.0 -> 'hammers their own').
  const blunt = describeAttack(
    { attacker: 'mog', target: 'mog', weaponClass: 'blunt', part: 'head', damage: 3, self: true },
    seq([0.0, 0.0])
  );
  assert.equal(blunt, 'mog hammers their own skull (3)');
  // fist set, with a part -> SELF_VERBS.fist[0] = 'pounds at their own'.
  const fist = describeAttack(
    { attacker: 'mog', target: 'mog', weaponClass: 'fist', part: 'head', damage: 1, self: true },
    seq([0.0, 0.0])
  );
  assert.equal(fist, 'mog pounds at their own skull (1)', 'SELF_VERBS.fist[0]');
});

test('regression: self=false (and the default) leaves the non-self path byte-identical', () => {
  // The exact assertion from the blade-hit test above, now pinned to prove the self
  // flag defaults off and does not perturb the original verb/part wording or draw order.
  const explicit = describeAttack(
    { attacker: 'Mara', target: 'Bandit', weaponClass: 'blade', part: 'torso', damage: 4, self: false },
    seq([0.0, 0.0])
  );
  const defaulted = describeAttack(
    { attacker: 'Mara', target: 'Bandit', weaponClass: 'blade', part: 'torso', damage: 4 },
    seq([0.0, 0.0])
  );
  assert.equal(explicit, "Mara hacks into Bandit's ribs (4)", 'self:false is the original line');
  assert.equal(defaulted, explicit, 'omitting self matches self:false exactly');
  assert.doesNotMatch(explicit, /their own|themselves/, 'no reflexive wording leaks into a normal hit');
});
