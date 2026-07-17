// A body plan is a template; a player's body is rows instantiated from it.
// Every part owns a hidden HP pool; the sum of part HP IS the player's health.
// Segmented anatomy (engine-overhaul, after paperdoll-viewer's Combatant): limbs
// carry DISTAL children (`parent` names the proximal part). A sever cascades to
// everything distal — cut the arm and the hand goes with it; the spine chain
// torso -> neck -> head makes a neck sever a DECAPITATION (the head, a vital,
// detaches -> death). Proximal labels/slots are unchanged from the 7-part plan,
// so equips, called shots, and 120+ existing test sites keep working; the new
// parts are additional aim targets with small hp shares shaved off their parents.
const HUMANOID_PLAN = [
  { partType: 'head', label: 'head', slotType: 'head', share: 0.15, vital: true, parent: 'neck' },
  { partType: 'torso', label: 'torso', slotType: 'torso', share: 0.30, vital: true },
  { partType: 'neck', label: 'neck', slotType: 'trinket', share: 0.04, vital: false, parent: 'torso' },
  { partType: 'arm', label: 'left arm', slotType: 'hand', share: 0.08, vital: false, parent: 'torso' },
  { partType: 'hand', label: 'left hand', slotType: null, share: 0.04, vital: false, parent: 'left arm' },
  { partType: 'arm', label: 'right arm', slotType: 'hand', share: 0.08, vital: false, parent: 'torso' },
  { partType: 'hand', label: 'right hand', slotType: null, share: 0.04, vital: false, parent: 'right arm' },
  { partType: 'leg', label: 'left leg', slotType: 'leg', share: 0.09, vital: false, parent: 'torso' },
  { partType: 'foot', label: 'left foot', slotType: null, share: 0.045, vital: false, parent: 'left leg' },
  { partType: 'leg', label: 'right leg', slotType: 'leg', share: 0.09, vital: false, parent: 'torso' },
  { partType: 'foot', label: 'right foot', slotType: null, share: 0.045, vital: false, parent: 'right leg' }
]; // shares sum to 1.0

// Plan 021 (BOLD): creature body plans. Same {partType,label,slotType,share,vital}
// shape as HUMANOID_PLAN so the IDENTICAL per-part routing (pickTargetPart,
// spill-to-torso, sever, vital-death) in applyBodyDamage applies unchanged. Two
// invariants the engine relies on:
//   1) shares sum to EXACTLY 1.0 (asserted in tests) — distributeAcrossPlan's
//      largest-remainder pass then makes the part pools sum exactly to the total.
//   2) the central mass that absorbs spill-over damage is partType 'torso' (the
//      spill rule in applyBodyDamage keys on partType==='torso'), even when its
//      LABEL reads 'body' — so a wyrm's overflow pools into its body, not nowhere.
// slotType is null on every creature part: NPCs never wear gear, so no part is an
// equip slot (and the sever knock-off path simply finds nothing to drop).
const WYRM_PLAN = [
  { partType: 'head', label: 'head', slotType: null, share: 0.18, vital: true },
  { partType: 'torso', label: 'body', slotType: null, share: 0.34, vital: true },
  { partType: 'wing', label: 'left wing', slotType: null, share: 0.10, vital: false },
  { partType: 'wing', label: 'right wing', slotType: null, share: 0.10, vital: false },
  { partType: 'leg', label: 'left foreleg', slotType: null, share: 0.09, vital: false },
  { partType: 'leg', label: 'right foreleg', slotType: null, share: 0.09, vital: false },
  { partType: 'tail', label: 'tail', slotType: null, share: 0.10, vital: false }
]; // 0.18 + 0.34 + 0.10 + 0.10 + 0.09 + 0.09 + 0.10 = 1.0

const QUADRUPED_PLAN = [
  { partType: 'head', label: 'head', slotType: null, share: 0.16, vital: true },
  { partType: 'torso', label: 'torso', slotType: null, share: 0.34, vital: true },
  { partType: 'leg', label: 'front-left leg', slotType: null, share: 0.10, vital: false },
  { partType: 'leg', label: 'front-right leg', slotType: null, share: 0.10, vital: false },
  { partType: 'leg', label: 'hind-left leg', slotType: null, share: 0.10, vital: false },
  { partType: 'leg', label: 'hind-right leg', slotType: null, share: 0.10, vital: false },
  { partType: 'tail', label: 'tail', slotType: null, share: 0.10, vital: false }
]; // 0.16 + 0.34 + 0.10*4 + 0.10 = 1.0

// A brute is anatomically a humanoid (head/torso/neck/arms/legs) — reuse the plan
// verbatim so its part roster, labels, and shares match a player's exactly. This is
// also the DEFAULT plan for any unmapped hostile (BOLD: every hostile gets a body).
const BRUTE_PLAN = HUMANOID_PLAN.map(part => ({ ...part }));

// The registry, keyed by plan id. getBodyPlan(id) resolves a stored
// users.creatureBodyPlan back to its template; a NULL/unknown id resolves to null
// (the scalar-HP path — today's behavior for bodyless NPCs).
const CREATURE_BODY_PLANS = {
  humanoid: HUMANOID_PLAN,
  wyrm: WYRM_PLAN,
  quadruped: QUADRUPED_PLAN,
  brute: BRUTE_PLAN
};

// BOLD (owner-locked): EVERY hostile gets a body. Known creatures map to a tailored
// plan; every UNMAPPED hostile defaults to 'brute' (humanoid anatomy) via
// resolveCreatureBodyPlanId, so no hostile stays scalar once it spawns fresh.
const CREATURE_BODY_PLAN_BY_NAME = {
  'Frost Wyrm': 'wyrm',
  'Ice Gnawer': 'quadruped',
  'Frost Thrall': 'brute',
  'Restless Brute': 'brute',
  'Room Lurker': 'brute'
};

// Resolve a creature's displayName to a plan id. Default-to-brute is the BOLD
// decision: an unmapped hostile still gets full anatomy (humanoid). Returns a plan
// id string (never null) — callers that want NULL (scalar) must opt out explicitly.
function resolveCreatureBodyPlanId(displayName) {
  return CREATURE_BODY_PLAN_BY_NAME[displayName] || 'brute';
}

// Resolve a plan id to its template array, or null when the id is absent/unknown.
// A null result is the scalar-HP path (the body gate treats it as "no body").
function getBodyPlan(id) {
  if (!id) {
    return null;
  }
  return CREATURE_BODY_PLANS[id] || null;
}

const MODIFIER_KEYS = ['maxHealth', 'maxStamina', 'speed', 'strength', 'intelligence'];

// Mechanical penalties: mangled or missing parts degrade stats. Plan 021 adds
// wing/tail (creature parts): a mauled wing or tail saps speed (a grounded,
// off-balance beast), scaling worse when the part is gone entirely.
const PART_PENALTIES = {
  arm: { mangled: { strength: -2 }, missing: { strength: -3 } },
  hand: { mangled: { strength: -1 }, missing: { strength: -2 } },
  leg: { mangled: { speed: -1 }, missing: { speed: -2 } },
  foot: { mangled: { speed: -1 }, missing: { speed: -1 } },
  head: { mangled: { intelligence: -2 } }, // missing head = you are dead
  neck: { mangled: { intelligence: -1 }, missing: { intelligence: -1 } },
  torso: { mangled: { maxStamina: -10 } },
  wing: { mangled: { speed: -1 }, missing: { speed: -2 } },
  tail: { mangled: { speed: -1 }, missing: { speed: -1 } }
};


// The joint a part separates at, for sever narration ("severed at the elbow").
const SEVER_JOINT_BY_TYPE = {
  arm: 'shoulder', hand: 'wrist', leg: 'hip', foot: 'ankle',
  neck: 'spine', head: 'neck', wing: 'wing root', tail: 'tail base'
};
function severJointFor(partType) {
  return SEVER_JOINT_BY_TYPE[partType] || 'joint';
}

// Every part distal to `label` in the plan (children, recursively). The sever
// cascade uses this: destroying a proximal segment scatters the whole chain.
function distalPartLabels(plan, label) {
  const out = [];
  const walk = parentLabel => {
    for (const part of plan) {
      if (part.parent === parentLabel) {
        out.push(part.label);
        walk(part.label);
      }
    }
  };
  walk(label);
  return out;
}

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

// Part labels that can be named in an attack message. Plan 021 makes this
// plan-aware: the UNION of every body plan's labels (deduped, longest-first so a
// two-word label like 'left wing' is tried before a substring could shadow it),
// so a player can call a shot on a wyrm's wing or a quadruped's hind leg, not just
// the humanoid set. Longest-first also keeps 'left foreleg' from being pre-empted
// by 'left ...'. Players are unaffected: every humanoid label is still present.
const CALLED_SHOT_LABELS = Array.from(
  new Set(
    Object.values(CREATURE_BODY_PLANS).flatMap(plan => plan.map(part => part.label))
  )
).sort((a, b) => b.length - a.length || a.localeCompare(b));

// Find a part LABEL named in the message and return its normalized label, or
// null when no part is aimed at. Two-word labels accept an underscore in place
// of the space ('RIGHT_ARM' -> 'right arm'). Word-boundary anchored so 'head'
// inside 'headlong' never matches. Plan 021: hyphenated labels (e.g.
// 'front-left leg') accept a space, underscore, OR hyphen between every token, so
// 'front left leg' / 'front_left_leg' / 'front-left-leg' all resolve.
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
      `(^|[^a-z])${label.replace(/[ _-]/g, '[ _-]')}([^a-z]|$)`,
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
  distalPartLabels,
  severJointFor,
  HUMANOID_PLAN,
  WYRM_PLAN,
  QUADRUPED_PLAN,
  BRUTE_PLAN,
  CREATURE_BODY_PLANS,
  CREATURE_BODY_PLAN_BY_NAME,
  getBodyPlan,
  resolveCreatureBodyPlanId,
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
  CALLED_SHOT_LABELS,
  CALLED_SHOT_HIT_PENALTY,
  CALLED_SHOT_HEAD_BONUS
};
