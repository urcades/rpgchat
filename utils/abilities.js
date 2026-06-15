// Plan 018: the ability registry — the single source of truth for ability DATA
// (display text + metadata). Behavior lives in worker/game.mjs's ABILITY_BEHAVIORS,
// keyed by the SAME id, so dispatch is registry-driven (no per-job switch) and an
// item or NPC can borrow an ability just by referencing its id. Pure data: no DB.
//
//   kind     'active' (a hotbar button) | 'passive' (folds into effective stats)
//   target   who an active can aim at: 'none' | 'self' | 'ally' | 'enemy'
//   contest  harmful active → rolls the speed contest (faster targets dodge)
//   effects  human-readable lines for the tooltip / character sheet
//   statEffects  passive only: { stat: delta } folded into effective stats like a job bonus
//
// CommonJS to match the other utils/ modules (jobs.js, items.js, roomEcology.js).

const ABILITIES = {
  scrounge: {
    id: 'scrounge', label: 'Scrounge', kind: 'active', target: 'none', contest: false, costStamina: 1,
    description: 'Search the room for loose gold.',
    effects: [
      'Gains 1 + half your Intelligence in gold, rounded down with a minimum bonus of 1.',
      'Does not require a target.'
    ]
  },
  ward: {
    id: 'ward', label: 'Ward', kind: 'active', target: 'ally', contest: false, costStamina: 1,
    description: 'Protect yourself or another player from incoming harm.',
    effects: [
      'Adds Ward for 5 ticks.',
      'The next attack or Power Strike against the warded target is reduced by 2 damage and consumes the ward.',
      'Targets yourself if no target is selected.'
    ]
  },
  power_strike: {
    id: 'power_strike', label: 'Power Strike', kind: 'active', target: 'enemy', contest: true, costStamina: 1,
    description: 'Hit a target harder than a normal attack.',
    effects: [
      'Uses a speed contest, so faster targets can dodge it.',
      'Deals 1 + half your Strength in damage, rounded down.',
      'Consumes Mark for +2 damage and consumes Ward for -2 damage.'
    ]
  },
  dose: {
    id: 'dose', label: 'Dose', kind: 'active', target: 'ally', contest: false, costStamina: 1,
    description: 'Patch someone up by day, poison them by night.',
    effects: [
      'Day: heals the target for 2 + one quarter of your Intelligence, rounded down.',
      'Night: uses a speed contest, then poisons the target for 5 ticks.',
      'Poison deals 1 damage each tick after it starts.'
    ]
  },
  survey: {
    id: 'survey', label: 'Survey', kind: 'active', target: 'none', contest: false, costStamina: 1,
    description: 'Study the room and leave a visible survey trace.',
    effects: [
      'Leaves a survey trace in the room for 20 ticks.',
      'Gains 1 gold.',
      'Does not require a target.'
    ]
  },
  arcane_pin: {
    id: 'arcane_pin', label: 'Arcane Pin', kind: 'active', target: 'enemy', contest: true, costStamina: 1,
    description: 'Pin a target with a stamina-draining spell.',
    effects: [
      'Uses a speed contest, so faster targets can dodge it.',
      'Adds Arcane Pin for 4 ticks.',
      'Arcane Pin drains 2 stamina each tick after it starts.'
    ]
  },
  mark: {
    id: 'mark', label: 'Mark', kind: 'active', target: 'enemy', contest: true, costStamina: 1,
    description: 'Make a target vulnerable to the next strong hit.',
    effects: [
      'Uses a speed contest, so faster targets can dodge it.',
      'Adds Mark for 6 ticks.',
      'The next attack or Power Strike against the marked target gains +2 damage and consumes the mark.'
    ]
  },
  bless: {
    id: 'bless', label: 'Bless', kind: 'active', target: 'ally', contest: false, costStamina: 1,
    description: 'Bless a target with healing and protection from harmful effects.',
    effects: [
      'Clears one harmful effect from the target if one is present.',
      'Adds Bless for 5 ticks.',
      'Bless heals 1 health each tick after it starts.'
    ]
  },

  // Plan 012 — keyword rites: language AS mechanics (the moat). Cast via
  // /cast <incantation> @target. Stamina cost AND damage scale with the
  // incantation's word count (cost.linguistic + the behavior reads ctx.incantation):
  // a verbose rite hits harder but costs more; brevity is cheap but weak. (Mastery —
  // doing more with fewer words at higher level — is a future tuning lever.)
  word_bolt: {
    id: 'word_bolt', label: 'Word Bolt', kind: 'active', target: 'enemy', contest: true,
    costStamina: 1,
    cost: { stamina: 1, linguistic: { perWord: 1, max: 12 } },
    description: 'A spoken bolt — the more words you incant, the harder it strikes (and the more it costs).',
    effects: [
      'Cast via /cast <incantation> @target.',
      'Damage = 2 + the word count of your incantation.',
      'Stamina = 1 + word count (capped at 13).',
      'Uses a speed contest, so faster targets can dodge it.'
    ]
  },

  // Plan 011 — the Cleric's revival rite. Target 'corpse' skips the live-target
  // check (the ally is dead); the behavior finds their corpse in the room and
  // restores them from the grave (consuming the corpse). Ties into the 022c anchor.
  revive: {
    id: 'revive', label: 'Revive', kind: 'active', target: 'corpse', contest: false, costStamina: 3,
    description: 'Call a fallen ally back from death — if their corpse still lies here.',
    effects: [
      "Revives a dead player whose corpse is in your room, restored from their grave.",
      'Consumes the corpse. Fails if the corpse was destroyed (true death) or the grave is gone.'
    ]
  },

  // Plan 018b — a second active for the Fighter, proving multi-ability kits. Self
  // only (target 'self' skips external target validation); a weaker, shorter ward
  // than the Paladin's so the protector keeps the better version (no dominant meta).
  brace: {
    id: 'brace', label: 'Brace', kind: 'active', target: 'self', contest: false, costStamina: 1,
    description: 'Set your feet and ward yourself against the next blow.',
    effects: [
      'Wards yourself for 3 ticks.',
      'The next attack against you is reduced by 1 damage and consumes the ward.'
    ]
  },
  // Plan 018b — the first passive. statEffects fold into the effective layer like a
  // job bonus (getPassiveStatModifiers). Never a hotbar button; shown read-only.
  toughness: {
    id: 'toughness', label: 'Toughness', kind: 'passive', target: 'none', contest: false,
    description: 'Years of taking hits have hardened you.',
    effects: [
      'Always active.',
      'Increases your Strength by 1.'
    ],
    statEffects: { strength: 1 }
  },

  // Plan 019 — board-granted passives (unlocked on the progression grid, not
  // innate to any class). Their statEffects fold through the modifier channel
  // (getProgressionModifiers) the same way the Toughness job passive does.
  quickness: {
    id: 'quickness', label: 'Quickness', kind: 'passive', target: 'none', contest: false,
    description: 'Light on your feet.',
    effects: ['Always active.', 'Increases your Speed by 1.'],
    statEffects: { speed: 1 }
  },
  acuity: {
    id: 'acuity', label: 'Acuity', kind: 'passive', target: 'none', contest: false,
    description: 'A sharper, faster mind.',
    effects: ['Always active.', 'Increases your Intelligence by 1.'],
    statEffects: { intelligence: 1 }
  },
  vigor: {
    id: 'vigor', label: 'Vigor', kind: 'passive', target: 'none', contest: false,
    description: 'Deeper reserves of stamina.',
    effects: ['Always active.', 'Increases your Max Stamina by 5.'],
    statEffects: { maxStamina: 5 }
  }
};

// Innate kit per class. The FIRST id is the starter skill (jobs.getSkillForJob),
// preserved for back-compat. Plan 018b adds more ids here.
const CLASS_ABILITIES = {
  Novice: ['scrounge'],
  Paladin: ['ward'],
  Fighter: ['power_strike', 'brace', 'toughness'],
  Chemist: ['dose'],
  Dungeoneer: ['survey'],
  Mage: ['arcane_pin', 'word_bolt'],
  Assassin: ['mark'],
  Cleric: ['bless', 'revive']
};

function getAbility(id) {
  return ABILITIES[id] || null;
}

function getInnateAbilityIds(job) {
  return CLASS_ABILITIES[job] || CLASS_ABILITIES.Novice;
}

function getAbilitiesForJob(job) {
  return getInnateAbilityIds(job).map(getAbility).filter(Boolean);
}

// The starter (first innate) ability — the shape jobs.getSkillForJob returns.
function getStarterAbility(job) {
  return getAbility(getInnateAbilityIds(job)[0]);
}

function getActiveAbilitiesForJob(job) {
  return getAbilitiesForJob(job).filter(ability => ability.kind !== 'passive');
}

function getPassiveAbilitiesForJob(job) {
  return getAbilitiesForJob(job).filter(ability => ability.kind === 'passive');
}

// Sum the stat deltas contributed by a job's passive abilities. Folded into
// effective stats (getEffectiveUser) exactly like a job bonus. Empty until a
// passive with statEffects exists (plan 018b), so this is a no-op for now.
function getPassiveStatModifiers(job) {
  const modifiers = {};
  for (const ability of getPassiveAbilitiesForJob(job)) {
    for (const [stat, delta] of Object.entries(ability.statEffects || {})) {
      modifiers[stat] = (modifiers[stat] || 0) + Number(delta || 0);
    }
  }
  return modifiers;
}

// Plan 018c — the linguistic-cost evaluator: the seed of plan 012's "language as
// mechanics." An ability's cost may carry a `linguistic` spec whose fields read
// properties of the triggering text (the incantation a player types). Pure and
// total: a missing spec or empty text yields 0, so non-linguistic abilities and
// prose-less invocations are unaffected.
//   spec: any subset of { perWord, perCharacter, perCapital, max } (each a number)
function countWords(text) {
  const trimmed = String(text == null ? '' : text).trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

function countCapitals(text) {
  const matches = String(text == null ? '' : text).match(/[A-Z]/g);
  return matches ? matches.length : 0;
}

function evaluateLinguisticCost(spec, text) {
  if (!spec || typeof spec !== 'object') {
    return 0;
  }
  const trimmedLength = String(text == null ? '' : text).trim().length;
  let cost = 0;
  if (Number.isFinite(spec.perWord)) {
    cost += spec.perWord * countWords(text);
  }
  if (Number.isFinite(spec.perCharacter)) {
    cost += spec.perCharacter * trimmedLength;
  }
  if (Number.isFinite(spec.perCapital)) {
    cost += spec.perCapital * countCapitals(text);
  }
  cost = Math.round(cost);
  if (Number.isFinite(spec.max)) {
    cost = Math.min(cost, spec.max);
  }
  return Math.max(0, cost);
}

// Total stamina an ability costs to invoke given an optional triggering context
// ({ text }). Base = ability.cost.stamina ?? ability.costStamina ?? 1, plus any
// linguistic surcharge. Defaults preserve the flat 1-stamina cost every skill has
// today; plan 012 supplies abilities with a linguistic cost and a prose path.
function resolveAbilityStaminaCost(ability, context = {}) {
  if (!ability) {
    return 1;
  }
  const cost = ability.cost || {};
  const base = Number.isFinite(cost.stamina)
    ? cost.stamina
    : (Number.isFinite(ability.costStamina) ? ability.costStamina : 1);
  const surcharge = cost.linguistic ? evaluateLinguisticCost(cost.linguistic, context.text) : 0;
  return Math.max(0, base + surcharge);
}

module.exports = {
  ABILITIES,
  CLASS_ABILITIES,
  getAbility,
  getInnateAbilityIds,
  getAbilitiesForJob,
  getStarterAbility,
  getActiveAbilitiesForJob,
  getPassiveAbilitiesForJob,
  getPassiveStatModifiers,
  evaluateLinguisticCost,
  resolveAbilityStaminaCost
};
