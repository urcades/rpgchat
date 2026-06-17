// Brutal, weapon- & part-aware attack lines. Pure + deterministic (random injected for tests).
const PART_NOUNS = {
  head: ['skull', 'jaw', 'temple', 'face'], neck: ['throat', 'neck'],
  torso: ['ribs', 'gut', 'chest', 'sternum'],
  'left arm': ['left arm', 'left shoulder'], 'right arm': ['right arm', 'right shoulder'],
  'left leg': ['left knee', 'left thigh'], 'right leg': ['right knee', 'right thigh'],
  'left wing': ['left wing'], 'right wing': ['right wing'],
  'left foreleg': ['left foreleg'], 'right foreleg': ['right foreleg'], tail: ['tail']
};
const VERBS = {
  blade: { light: ['slashes at', 'cuts at', 'scores'], solid: ['hacks into', 'carves across', 'opens a gash across'], brutal: ['cleaves deep into', 'lays open', 'splits'] },
  pierce: { light: ['jabs at', 'nicks', 'pricks'], solid: ['drives a blade into', 'stabs into', 'punches a point through'], brutal: ['runs the blade through', 'buries the point in', 'skewers'] },
  blunt: { light: ['raps', 'knocks against', 'clips'], solid: ['cracks', 'smashes into', 'bludgeons'], brutal: ['caves in', 'shatters', 'crushes'] },
  fist: { light: ['clips', 'jabs at', 'glances off'], solid: ['cracks a fist into', 'drives an elbow into', 'hammers'], brutal: ['slams a savage blow into', 'pounds', 'batters'] }
};
// Per-weapon SIGNATURE verbs — a specific wielded weapon reads distinctly (an Iron
// Cleaver CHOPS, a Hooked Knife HOOKS/RIPS, a fang BITES), layered OVER the weapon-class
// pool. Keyed by item templateId. Part-agnostic and tier-agnostic: on a LIVE hit, a
// matching weaponId draws from here INSTEAD of VERBS[klass][tier]. Self, downed-execution,
// and NPC-fist paths never consult this map, so they stay byte-identical.
const SIGNATURE = {
  iron_cleaver: ['chops into', 'hacks a wedge from', 'cleaves through'],
  flametongue: ['sears across', 'burns a line through'],
  frostbrand: ['shears through', 'leaves a frostbitten gash in'],
  hooked_knife: ['hooks into', 'tears a ragged hole in', 'rips open'],
  rusty_knife: ['saws into', 'works the rusty edge into'],
  chipped_knife: ['jabs the chipped point into', 'picks at'],
  frostbitten_fang: ['sinks the fang into', 'bites deep into'],
  venom_fang: ['sinks the dripping fang into', 'punctures'],
  cracked_buckler: ['bashes', 'shield-rams', 'cracks the rim into']
};
const EXECUTION = {
  head: ["stomps down on {tgt}'s {pn} as they lie — a wet, final crunch", "brings a heel down on {tgt}'s {pn}", "caves in {tgt}'s {pn} where they lie"],
  neck: ["drives a {w} through {tgt}'s throat where they lie", "opens {tgt}'s throat as they bleed out"],
  default: ["drives a {w} into {tgt}'s {pn} as they writhe", "strikes the prone {tgt} without mercy", "stamps {tgt} back into the dirt"]
};
const WEAPON_NOUN = { blade: 'blade', pierce: 'point', blunt: 'heel', fist: 'heel' };
const SELF_VERBS = {
  blade:  ['drags the edge across their own', 'opens their own', 'carves into their own', 'lays open their own'],
  pierce: ['drives the point into their own', 'sinks the blade into their own', 'works the blade into their own'],
  blunt:  ['hammers their own', 'cracks their own', 'batters their own'],
  fist:   ['pounds at their own', 'claws at their own', 'beats their own']
};
const SELF_NO_PART = ['turns the blow on themselves', 'lashes out at themselves', 'savages themselves'];
const SELF_DOWNED = ['stops struggling and lets the last blow fall', 'gives up and finishes the job'];
const SELF_MISS = ['swings at themselves and misses', 'flails and misses their own mark', "can't quite land a blow on themselves", 'pulls the strike at the last instant'];
function pick(arr, random) { return arr[Math.floor(random() * arr.length)] || arr[0]; }
function tierOf(damage, isCritical) { if (isCritical || damage >= 6) return 'brutal'; if (damage >= 3) return 'solid'; return 'light'; }
function describeAttack({ attacker, target, weaponClass = 'fist', weaponId = null, part = null, damage = 0, isCritical = false, targetDowned = false, self = false } = {}, random = Math.random) {
  const klass = VERBS[weaponClass] ? weaponClass : 'fist';
  const nouns = part && PART_NOUNS[part];
  const pn = nouns ? pick(nouns, random) : null;
  const dmg = `(${damage})`;
  if (self) {
    if (targetDowned) return `${attacker} ${pick(SELF_DOWNED, random)} ${dmg}`;
    if (pn) return `${attacker} ${pick(SELF_VERBS[klass], random)} ${pn} ${dmg}`;
    return `${attacker} ${pick(SELF_NO_PART, random)} ${dmg}`;
  }
  if (targetDowned) {
    const set = EXECUTION[part] || EXECUTION.default;
    const line = pick(set, random).split('{tgt}').join(target).split('{pn}').join(pn || 'body').split('{w}').join(WEAPON_NOUN[klass]);
    return `${attacker} ${line} ${dmg}`;
  }
  // A matching wielded weapon speaks in its own signature voice (part-/tier-agnostic);
  // otherwise the class+tier pool. The verb pick is a single draw either way, so the
  // part-noun-then-verb draw order — and every non-signature line — is byte-identical.
  const verbPool = (weaponId && SIGNATURE[weaponId]) ? SIGNATURE[weaponId] : VERBS[klass][tierOf(damage, isCritical)];
  const verb = pick(verbPool, random);
  const where = pn ? ` ${target}'s ${pn}` : ` ${target}`;
  const bang = (isCritical || damage >= 6) ? '!' : '';
  return `${attacker} ${verb}${where} ${dmg}${bang}`;
}
// A self-targeted attack that misses — deadpan, reflexive. (The non-self dodge line
// stays "X dodged Y's attack"; only the self case routes here.)
function describeSelfMiss(attacker, random = Math.random) {
  return `${attacker} ${pick(SELF_MISS, random)}`;
}
module.exports = { describeAttack, describeSelfMiss, PART_NOUNS, VERBS, EXECUTION };
