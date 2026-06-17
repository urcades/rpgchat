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

const { describeAttack, describeSelfMiss, PART_NOUNS, VERBS, EXECUTION } = require('../utils/combatFlavor');

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

// ---------------------------------------------------------------------------
// Per-weapon SIGNATURE verbs — a recognized wielded weapon (by templateId) speaks in
// its own voice, layered OVER the weapon-CLASS pool. On a LIVE hit a matching weaponId
// draws from the signature pool INSTEAD of VERBS[klass][tier]; the pool is part- and
// tier-agnostic, but the part-noun-then-verb draw order is unchanged (noun is still
// draw 1, the signature verb is draw 2). An absent/unknown weaponId falls straight back
// to the class verbs, and the self / downed-execution / NPC-fist paths never consult it.

test('a signature weapon (iron_cleaver) speaks its own verb and still names the part', () => {
  // weaponId iron_cleaver -> SIGNATURE pool, NOT VERBS.blade. part 'torso' -> noun draw 1
  // (0.0 -> 'ribs'); signature verb draw 2 (0.0 -> SIGNATURE.iron_cleaver[0] = 'chops into').
  const line = describeAttack(
    { attacker: 'Mara', target: 'Bandit', weaponClass: 'blade', weaponId: 'iron_cleaver', part: 'torso', damage: 4 },
    seq([0.0, 0.0])
  );
  assert.equal(line, "Mara chops into Bandit's ribs (4)");
  assert.match(line, /\bchops into\b/, 'the cleaver CHOPS — its signature verb, not the class verb');
  assert.doesNotMatch(line, /hacks into/, 'the class/tier verb is bypassed when a signature matches');
  assert.match(line, /Bandit's ribs/, 'the part clause is preserved under a signature');
});

test('a signature pool is part-agnostic: a hooked_knife HOOKS the head, not a pierce verb', () => {
  // weaponId hooked_knife -> SIGNATURE pool regardless of the pierce class or the head part.
  // part 'head' -> noun draw 1 (0.0 -> 'skull'); signature verb draw 2 (0.0 -> 'hooks into').
  const line = describeAttack(
    { attacker: 'Vesh', target: 'Guard', weaponClass: 'pierce', weaponId: 'hooked_knife', part: 'head', damage: 5 },
    seq([0.0, 0.0])
  );
  assert.equal(line, "Vesh hooks into Guard's skull (5)");
  assert.doesNotMatch(line, /drives a blade into|stabs into/, 'no pierce-class verb leaks through');
});

test('a signature pool is tier-agnostic but keeps the (N) and the bang on a heavy hit', () => {
  // damage 7 would be the brutal tier, but the signature pool ignores tiers. No part ->
  // no noun draw; signature verb is the sole draw (0.0 -> 'sinks the fang into'). damage>=6 -> bang.
  const line = describeAttack(
    { attacker: 'Wolf', target: 'Ranger', weaponClass: 'pierce', weaponId: 'frostbitten_fang', part: null, damage: 7 },
    seq([0.0])
  );
  assert.equal(line, 'Wolf sinks the fang into Ranger (7)!');
  assert.match(line, /\(7\)!$/, 'damage in parens and the bang still ride a signature hit');
});

test('an unknown/absent weaponId falls back to the class verb (regression: the cleaver-less blade)', () => {
  // weaponId 'mystery_blade' is not in SIGNATURE -> straight back to VERBS.blade.solid.
  // This is the original blade-hit line, proving the fallback is byte-identical.
  const unknown = describeAttack(
    { attacker: 'Mara', target: 'Bandit', weaponClass: 'blade', weaponId: 'mystery_blade', part: 'torso', damage: 4 },
    seq([0.0, 0.0])
  );
  assert.equal(unknown, "Mara hacks into Bandit's ribs (4)", 'unknown weaponId == the class verb line');
  // And weaponId omitted entirely is identical — the existing assertion still holds.
  const absent = describeAttack(
    { attacker: 'Mara', target: 'Bandit', weaponClass: 'blade', part: 'torso', damage: 4 },
    seq([0.0, 0.0])
  );
  assert.equal(absent, "Mara hacks into Bandit's ribs (4)", 'omitted weaponId == the class verb line');
});

test('a SELF hit ignores the signature pool (reflexive verbs still win)', () => {
  // Even with a signature weaponId, self routes to SELF_VERBS. part 'neck' -> noun draw 1
  // (0.0 -> 'throat'); SELF_VERBS.blade draw 2 (0.0 -> 'drags the edge across their own').
  const line = describeAttack(
    { attacker: 'mog', target: 'mog', weaponClass: 'blade', weaponId: 'iron_cleaver', part: 'neck', damage: 4, self: true },
    seq([0.0, 0.0])
  );
  assert.equal(line, 'mog drags the edge across their own throat (4)');
  assert.doesNotMatch(line, /chops into/, 'a self-attack never reaches the signature pool');
});

test('a DOWNED target ignores the signature pool (execution lines still win)', () => {
  // targetDowned routes to EXECUTION even with a signature weaponId. part 'head' -> noun draw 1
  // (0.0 -> 'skull'); execution-line draw 2 (0.0 -> EXECUTION.head[0], the wet final crunch).
  const line = describeAttack(
    { attacker: 'Mara', target: 'Bandit', weaponClass: 'blade', weaponId: 'iron_cleaver', part: 'head', damage: 6, targetDowned: true },
    seq([0.0, 0.0])
  );
  assert.equal(line, "Mara stomps down on Bandit's skull as they lie — a wet, final crunch (6)");
  assert.doesNotMatch(line, /chops into/, 'a downed execution never reaches the signature pool');
});

test('the NPC/fist path (no weaponId) is untouched by signatures', () => {
  // The NPC call passes weaponClass:'fist' and no weaponId -> defaults to null -> class verbs.
  // No part -> verb is the sole draw (0.0 -> VERBS.fist.light[0] = 'clips').
  const line = describeAttack(
    { attacker: 'Frost Wyrm', target: 'hunter', weaponClass: 'fist', part: null, damage: 2 },
    seq([0.0])
  );
  assert.equal(line, 'Frost Wyrm clips hunter (2)', 'the fist path is byte-identical (no signature)');
});

test('a self-targeted miss reads reflexively (describeSelfMiss), never "name … name"', () => {
  // SELF_MISS[0] = 'swings at themselves and misses' (pick draw 0.0).
  const line = describeSelfMiss('mog', seq([0.0]));
  assert.equal(line, 'mog swings at themselves and misses');
  assert.match(line, /\bthemselves\b/, 'reads reflexively');
  assert.doesNotMatch(line, /\bmog\b.*\bmog\b/, 'never repeats the actor name');
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
