// A body plan is a template; a player's body is rows instantiated from it.
// Every part owns a hidden HP pool; the sum of part HP IS the player's health.
const HUMANOID_PLAN = [
  { partType: 'head', label: 'head', slotType: 'head', share: 0.15, vital: true },
  { partType: 'torso', label: 'torso', slotType: 'torso', share: 0.30, vital: true },
  { partType: 'neck', label: 'neck', slotType: 'trinket', share: 0.04, vital: false },
  { partType: 'arm', label: 'left arm', slotType: 'hand', share: 0.12, vital: false },
  { partType: 'arm', label: 'right arm', slotType: 'hand', share: 0.12, vital: false },
  { partType: 'leg', label: 'left leg', slotType: 'leg', share: 0.135, vital: false },
  { partType: 'leg', label: 'right leg', slotType: 'leg', share: 0.135, vital: false }
]; // shares sum to 1.0

const MODIFIER_KEYS = ['maxHealth', 'maxStamina', 'speed', 'strength', 'intelligence'];

// Mechanical penalties: mangled or missing parts degrade stats.
const PART_PENALTIES = {
  arm: { mangled: { strength: -2 }, missing: { strength: -3 } },
  leg: { mangled: { speed: -1 }, missing: { speed: -2 } },
  head: { mangled: { intelligence: -2 } }, // missing head = you are dead
  neck: { mangled: { intelligence: -1 }, missing: { intelligence: -1 } },
  torso: { mangled: { maxStamina: -10 } }
};

function emptyModifiers() {
  const modifiers = {};
  for (const key of MODIFIER_KEYS) {
    modifiers[key] = 0;
  }
  return modifiers;
}

// Largest-remainder distribution so part pools sum EXACTLY to the total.
function distributeAcrossPlan(total, plan = HUMANOID_PLAN) {
  const safeTotal = Math.max(0, Math.floor(Number.isFinite(total) ? total : 0));
  const provisional = plan.map(part => {
    const exact = safeTotal * part.share;
    const floor = Math.floor(exact);
    return {
      part,
      amount: floor,
      remainder: exact - floor
    };
  });

  const distributed = provisional.reduce((sum, entry) => sum + entry.amount, 0);
  let leftover = safeTotal - distributed;

  // Hand out remaining units to the largest fractional remainders first.
  const order = provisional
    .map((entry, index) => ({ index, remainder: entry.remainder }))
    .sort((a, b) => b.remainder - a.remainder || a.index - b.index);

  for (let i = 0; i < order.length && leftover > 0; i += 1) {
    provisional[order[i].index].amount += 1;
    leftover -= 1;
  }

  return provisional.map(entry => ({ ...entry.part, amount: entry.amount }));
}

// Condition is READ from hp/maxHp — never stored.
// missing: severed; mangled: ratio <= 0.25; hurt: ratio < 0.9; healthy otherwise.
function partCondition(part) {
  if (part.severed) {
    return 'missing';
  }
  const maxHp = part.maxHp || 0;
  if (maxHp <= 0) {
    return 'mangled';
  }
  const ratio = part.hp / maxHp;
  if (ratio <= 0.25) {
    return 'mangled';
  }
  if (ratio < 0.9) {
    return 'hurt';
  }
  return 'healthy';
}

function bodyPenaltyModifiers(parts) {
  const modifiers = emptyModifiers();
  for (const part of parts || []) {
    const penaltyTable = PART_PENALTIES[part.partType];
    if (!penaltyTable) {
      continue;
    }
    const condition = partCondition(part);
    const penalty = penaltyTable[condition];
    if (!penalty) {
      continue;
    }
    for (const key of Object.keys(penalty)) {
      modifiers[key] = (modifiers[key] || 0) + penalty[key];
    }
  }
  return modifiers;
}

// Stances trade hit/dodge/damage. `standing` is all-zero so the default is
// behavior-neutral: with no stance change every combat number is unchanged.
// All tuning lives here; the engine references the symbols, never the numbers.
const STANCES = {
  standing:   { label: 'Standing',   hitBonus: 0,     dodgeBonus: 0,    damageBonus: 0,  damageTakenDelta: 0 },
  aggressive: { label: 'Aggressive', hitBonus: 0.05,  dodgeBonus: -0.1, damageBonus: 1,  damageTakenDelta: 1 },
  guarding:   { label: 'Guarding',   hitBonus: -0.05, dodgeBonus: 0.05, damageBonus: -1, damageTakenDelta: -1 },
  crouched:   { label: 'Crouched',   hitBonus: -0.1,  dodgeBonus: 0.1,  damageBonus: 0,  damageTakenDelta: 0 }
};

const DEFAULT_STANCE = 'standing';

// A known stance key, or 'standing' for anything unrecognized.
function normalizeStance(value) {
  if (typeof value === 'string') {
    const key = value.trim().toLowerCase();
    if (Object.prototype.hasOwnProperty.call(STANCES, key)) {
      return key;
    }
  }
  return DEFAULT_STANCE;
}

// Called shots trade accuracy for placement. Numbers live here only.
const CALLED_SHOT_HIT_PENALTY = 0.15;
const CALLED_SHOT_HEAD_BONUS = 1; // aimed head hits land +1 damage

// Part labels a player can name in an attack message (the humanoid plan).
// Matched case-insensitively; space or underscore between words is accepted.
const CALLED_SHOT_LABELS = HUMANOID_PLAN.map(part => part.label);

// Find a part LABEL named in the message and return its normalized label, or
// null when no part is aimed at. Two-word labels accept an underscore in place
// of the space ('RIGHT_ARM' -> 'right arm'). Word-boundary anchored so 'head'
// inside 'headlong' never matches.
function parseCalledShot(message) {
  if (typeof message !== 'string') {
    return null;
  }
  // Strip @mention target tokens first: a called shot names a body part in the
  // prose, never inside the @target handle. Without this, attacking '@left_arm'
  // (a username) would be misread as aiming at the left arm.
  const haystack = message.toLowerCase().replace(/@[a-z0-9_-]+/g, ' ');
  for (const label of CALLED_SHOT_LABELS) {
    const pattern = new RegExp(
      `(^|[^a-z])${label.replace(/ /g, '[ _]')}([^a-z]|$)`,
      'i'
    );
    if (pattern.test(haystack)) {
      return label;
    }
  }
  return null;
}

// Weighted-random target selection among non-severed parts, by maxHp.
function pickTargetPart(parts, random = Math.random) {
  const live = (parts || []).filter(part => !part.severed);
  if (live.length === 0) {
    return null;
  }
  const totalWeight = live.reduce((sum, part) => sum + Math.max(0, part.maxHp || 0), 0);
  if (totalWeight <= 0) {
    return live[0];
  }
  let roll = random() * totalWeight;
  for (const part of live) {
    roll -= Math.max(0, part.maxHp || 0);
    if (roll < 0) {
      return part;
    }
  }
  return live[live.length - 1];
}

module.exports = {
  HUMANOID_PLAN,
  MODIFIER_KEYS,
  distributeAcrossPlan,
  partCondition,
  PART_PENALTIES,
  bodyPenaltyModifiers,
  pickTargetPart,
  emptyModifiers,
  STANCES,
  DEFAULT_STANCE,
  normalizeStance,
  parseCalledShot,
  CALLED_SHOT_HIT_PENALTY,
  CALLED_SHOT_HEAD_BONUS
};
