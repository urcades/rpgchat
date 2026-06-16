// Plan 021 (BOLD): elite NPC growth — a PURE module (no I/O, no DB). Two pieces:
//
//   1) scaleNpcStats(template, level): inflate a creature's STORED health/strength by
//      its level, so a level-8 spawn is meaningfully tougher than a level-3 one. This
//      scales the stored pool ensureBody distributes from (so a bigger creature simply
//      gets bigger part pools — the per-part routing is unchanged), and the stored
//      strength the damage formula reads.
//
//   2) An AFFIXES registry + rollAffixes(level, random): an elite carries 1–2 affixes
//      that prefix its displayName ("Vicious Frost Wyrm") and describe deltas the SPAWN
//      site applies — a flat stat bump, a part-maxHp fortification, an intrinsic element,
//      or extra body parts. The registry is pure DATA + pure transforms; the DB writes
//      (applyPartMaxHpDelta, appending bodyParts rows) live in world.mjs at spawn time.
//
// Everything here is deterministic given an injected `random` (Math.random by default),
// mirroring the 004 RNG-injection convention so tests can pin the roll order.

// --- stat scaling -----------------------------------------------------------

// Per-level growth multipliers. Tuned modestly: a creature gains ~12% health and ~8%
// strength per level above 1, so growth is felt across the bestiary's level spread
// (level 1 ambient → level 6 boss) without runaway scaling. Floors at level 1.
const HEALTH_GROWTH_PER_LEVEL = 0.12;
const STRENGTH_GROWTH_PER_LEVEL = 0.08;

// Inflate a template's stored health/maxHealth/strength by its level. Returns a NEW
// template (never mutates the input). A level <= 1 returns the base numbers unchanged,
// so existing level-1 spawns are byte-identical. health and maxHealth scale together
// (a fresh spawn is at full health), keeping users.health == users.maxHealth at birth —
// and so the lazy ensureBody distributes a full, consistent pool.
function scaleNpcStats(template, level) {
  const lvl = Math.max(1, Math.floor(Number(level) || 1));
  const steps = lvl - 1;
  const healthMul = 1 + HEALTH_GROWTH_PER_LEVEL * steps;
  const strengthMul = 1 + STRENGTH_GROWTH_PER_LEVEL * steps;
  const baseHealth = Math.max(1, Math.floor(Number(template.health) || 1));
  const baseMaxHealth = Math.max(baseHealth, Math.floor(Number(template.maxHealth ?? template.health) || baseHealth));
  const baseStrength = Math.max(1, Math.floor(Number(template.strength) || 1));
  const scaledMaxHealth = Math.max(1, Math.floor(baseMaxHealth * healthMul));
  return {
    ...template,
    level: lvl,
    health: Math.max(1, Math.floor(baseHealth * healthMul)),
    maxHealth: scaledMaxHealth,
    strength: Math.max(1, Math.floor(baseStrength * strengthMul))
  };
}

// --- affixes ----------------------------------------------------------------

// The affix registry. Each affix is PURE: `apply(template)` returns a new template with
// its delta folded in (a stat bump, an intrinsic element, or extra body-part templates
// queued under `_extraParts`); `partMaxHpDelta` (a number) is read by the spawn site to
// fortify EVERY instantiated part via applyPartMaxHpDelta after ensureBody. `prefix` is
// the displayName adjective. `_extraParts` rides on the template for the spawn site to
// append at ensureBody time; it is NOT a stored column.
//
//   Vicious  — +strength (a harder hitter).
//   Armored  — fortifies each body part's maxHp (tankier; via applyPartMaxHpDelta).
//   Rending  — an intrinsic element on its bite (its hits land that element's status).
//   Hulking  — appends an extra pair of limbs (more parts to hack through; also more
//              total maxHp once those parts instantiate).
const AFFIXES = {
  Vicious: {
    name: 'Vicious',
    prefix: 'Vicious',
    apply(template) {
      const strength = Math.max(1, Math.floor(Number(template.strength) || 1)) + 4;
      return { ...template, strength };
    }
  },
  Armored: {
    name: 'Armored',
    prefix: 'Armored',
    // +3 maxHp on every part the spawn instantiates (applied via applyPartMaxHpDelta,
    // which mirrors maxHealth and never destroys hp on a positive delta).
    partMaxHpDelta: 3,
    apply(template) {
      return { ...template };
    }
  },
  Rending: {
    name: 'Rending',
    prefix: 'Rending',
    // An intrinsic elemental bite. `element` is read by the combat hostile-action path
    // the same way CREATURE_ELEMENT is, so a Rending creature's hits land 'shock'.
    element: 'shock',
    apply(template) {
      return { ...template, element: template.element || 'shock' };
    }
  },
  Hulking: {
    name: 'Hulking',
    prefix: 'Hulking',
    // Extra parts to append at ensureBody time. Distinct labels (the bodyParts table is
    // UNIQUE(username,label)); non-vital so they never one-shot the beast; partType
    // 'arm' so the existing arm penalties apply. maxHp/hp are absolute (not share-based)
    // because they are appended AFTER the plan's pool is distributed.
    extraParts: [
      { partType: 'arm', label: 'extra left limb', slotType: null, vital: 0, maxHp: 4 },
      { partType: 'arm', label: 'extra right limb', slotType: null, vital: 0, maxHp: 4 }
    ],
    apply(template) {
      const existing = Array.isArray(template._extraParts) ? template._extraParts : [];
      return { ...template, _extraParts: [...existing, ...this.extraParts] };
    }
  }
};

const AFFIX_NAMES = Object.keys(AFFIXES);

// The minimum level at which a spawn is eligible to roll affixes. Below this, growth is
// stat-scaling only (rollAffixes returns an empty result), so low-level ambient mobs stay
// plain and the "elite" feel is reserved for tougher spawns.
const ELITE_MIN_LEVEL = 4;

// Roll an elite's affixes. Deterministic given `random`. Returns:
//   { affixes: string[], prefix: string, applyTemplate(t), partMaxHpDelta, extraParts, element }
// where applyTemplate folds every rolled affix's stat/element delta into a template, and
// the other fields are the spawn-site-applied parts (partMaxHpDelta, extraParts) and the
// intrinsic element. A sub-elite level (or count 0) yields an empty, no-op result — so a
// non-elite spawn is byte-identical to today.
//
// RNG CONSUMPTION ORDER (document for tests, per the 004 convention):
//   draw 1 → affix COUNT: random() < 0.5 ? 1 : 2 affixes
//   draws 2.. → affix PICKS: one random() per affix, indexing AFFIX_NAMES, skipping dupes
function rollAffixes(level, random = Math.random) {
  const lvl = Math.max(1, Math.floor(Number(level) || 1));
  if (lvl < ELITE_MIN_LEVEL) {
    return emptyAffixRoll();
  }
  const count = random() < 0.5 ? 1 : 2;
  const chosen = [];
  let guard = 0;
  while (chosen.length < count && guard < 16) {
    guard += 1;
    const idx = Math.floor(random() * AFFIX_NAMES.length) % AFFIX_NAMES.length;
    const name = AFFIX_NAMES[idx];
    if (!chosen.includes(name)) {
      chosen.push(name);
    }
  }
  if (chosen.length === 0) {
    return emptyAffixRoll();
  }
  return buildAffixRoll(chosen);
}

// Build the applied roll from a fixed list of affix names (also the seam tests use to
// construct a known elite without rolling).
function buildAffixRoll(names) {
  const affixes = names.filter(name => AFFIXES[name]);
  let partMaxHpDelta = 0;
  let element = null;
  const extraParts = [];
  const apply = (template) => {
    let t = template;
    for (const name of affixes) {
      t = AFFIXES[name].apply.call(AFFIXES[name], t);
    }
    return t;
  };
  for (const name of affixes) {
    const affix = AFFIXES[name];
    if (affix.partMaxHpDelta) {
      partMaxHpDelta += affix.partMaxHpDelta;
    }
    if (affix.element && !element) {
      element = affix.element;
    }
    if (Array.isArray(affix.extraParts)) {
      extraParts.push(...affix.extraParts);
    }
  }
  // The displayName prefix is the affixes joined in roll order ("Vicious Armored").
  const prefix = affixes.join(' ');
  return { affixes, prefix, applyTemplate: apply, partMaxHpDelta, extraParts, element };
}

function emptyAffixRoll() {
  return { affixes: [], prefix: '', applyTemplate: (t) => t, partMaxHpDelta: 0, extraParts: [], element: null };
}

// Compose an elite displayName: the affix prefix + the base name ("Vicious Frost Wyrm").
// No affixes → the base name unchanged.
function eliteDisplayName(baseName, prefix) {
  const p = String(prefix || '').trim();
  return p ? `${p} ${baseName}` : baseName;
}

// The inverse of eliteDisplayName: strip leading affix adjectives to recover the base
// creature name ("Vicious Frost Wyrm" → "Frost Wyrm"). The combat seam's creature-trait
// maps (affinity / element / ability kit) are keyed by BASE name, so they must look up by
// this — otherwise an elite would lose its intrinsic traits. Only strips KNOWN affix words
// from the FRONT (so a creature legitimately named with such a word is safe past the
// prefix), and never strips the whole string away.
function baseCreatureName(displayName) {
  const words = String(displayName || '').trim().split(/\s+/).filter(Boolean);
  let i = 0;
  while (i < words.length - 1 && AFFIXES[words[i]]) {
    i += 1;
  }
  return words.slice(i).join(' ');
}

module.exports = {
  scaleNpcStats,
  rollAffixes,
  buildAffixRoll,
  eliteDisplayName,
  baseCreatureName,
  AFFIXES,
  AFFIX_NAMES,
  ELITE_MIN_LEVEL,
  HEALTH_GROWTH_PER_LEVEL,
  STRENGTH_GROWTH_PER_LEVEL
};
