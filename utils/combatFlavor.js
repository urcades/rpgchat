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
const EXECUTION = {
  head: ["stomps down on {tgt}'s {pn} as they lie — a wet, final crunch", "brings a heel down on {tgt}'s {pn}", "caves in {tgt}'s {pn} where they lie"],
  neck: ["drives a {w} through {tgt}'s throat where they lie", "opens {tgt}'s throat as they bleed out"],
  default: ["drives a {w} into {tgt}'s {pn} as they writhe", "strikes the prone {tgt} without mercy", "stamps {tgt} back into the dirt"]
};
const WEAPON_NOUN = { blade: 'blade', pierce: 'point', blunt: 'heel', fist: 'heel' };
function pick(arr, random) { return arr[Math.floor(random() * arr.length)] || arr[0]; }
function tierOf(damage, isCritical) { if (isCritical || damage >= 6) return 'brutal'; if (damage >= 3) return 'solid'; return 'light'; }
function describeAttack({ attacker, target, weaponClass = 'fist', part = null, damage = 0, isCritical = false, targetDowned = false } = {}, random = Math.random) {
  const klass = VERBS[weaponClass] ? weaponClass : 'fist';
  const nouns = part && PART_NOUNS[part];
  const pn = nouns ? pick(nouns, random) : null;
  const dmg = `(${damage})`;
  if (targetDowned) {
    const set = EXECUTION[part] || EXECUTION.default;
    const line = pick(set, random).split('{tgt}').join(target).split('{pn}').join(pn || 'body').split('{w}').join(WEAPON_NOUN[klass]);
    return `${attacker} ${line} ${dmg}`;
  }
  const verb = pick(VERBS[klass][tierOf(damage, isCritical)], random);
  const where = pn ? ` ${target}'s ${pn}` : ` ${target}`;
  const bang = (isCritical || damage >= 6) ? '!' : '';
  return `${attacker} ${verb}${where} ${dmg}${bang}`;
}
module.exports = { describeAttack, PART_NOUNS, VERBS, EXECUTION };
