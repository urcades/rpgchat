// Plan 018: ability DATA now lives in utils/abilities.js (the registry). Jobs keep
// their stat identity (bonuses) and reference abilities by class; getSkillForJob
// returns the starter ability so its shape and callers stay unchanged.
const abilitiesModule = require('./abilities');

const STAT_KEYS = ['health', 'stamina', 'speed', 'strength', 'intelligence'];
const STARTING_STAT_POINTS = 12;

const BASE_STATS = {
  health: 30,
  maxHealth: 30,
  stamina: 100,
  maxStamina: 100,
  speed: 1,
  strength: 1,
  intelligence: 1
};

const JOBS = {
  Novice: {
    label: 'Novice',
    description: 'Flexible, poor, and unusually good at finding loose change.',
    bonuses: {}
  },
  Paladin: {
    label: 'Paladin',
    description: 'A stubborn protector whose holiness mostly looks like interference.',
    bonuses: { maxHealth: 9, strength: 1 }
  },
  Fighter: {
    label: 'Fighter',
    description: 'A blunt instrument with legs and a grievance.',
    bonuses: { maxHealth: 3, strength: 2 }
  },
  Chemist: {
    label: 'Chemist',
    description: 'Helpful in daylight, concerning after dark.',
    bonuses: { intelligence: 2, maxStamina: 10 }
  },
  Dungeoneer: {
    label: 'Dungeoneer',
    description: 'Reads rooms like arguments and leaves marks on both.',
    bonuses: { speed: 1, strength: 1, intelligence: 1 }
  },
  Mage: {
    label: 'Mage',
    description: 'Turns attention into pressure.',
    bonuses: { intelligence: 3 }
  },
  Assassin: {
    label: 'Assassin',
    description: 'Makes future violence easier for everyone, unfortunately.',
    bonuses: { speed: 2, strength: 1 }
  },
  Cleric: {
    label: 'Cleric',
    description: 'Keeps people alive in ways that create obligations.',
    bonuses: { maxHealth: 6, intelligence: 2 }
  }
};

function normalizeJob(job) {
  return Object.prototype.hasOwnProperty.call(JOBS, job) ? job : 'Novice';
}

function getJob(job) {
  return JOBS[normalizeJob(job)];
}

function getSkillForJob(job) {
  return abilitiesModule.getStarterAbility(normalizeJob(job));
}

function parseAllocationValue(value) {
  if (typeof value === 'number') {
    return Number.isInteger(value) ? value : null;
  }

  if (typeof value !== 'string' || value.trim() === '') {
    return null;
  }

  if (!/^\d+$/.test(value.trim())) {
    return null;
  }

  return Number.parseInt(value, 10);
}

function validateStartingAllocation(input = {}) {
  const keys = Object.keys(input).sort();
  const expectedKeys = [...STAT_KEYS].sort();

  if (keys.length !== expectedKeys.length || !expectedKeys.every((key, index) => key === keys[index])) {
    return {
      valid: false,
      allocation: null,
      errors: [`Starting stats must include ${STAT_KEYS.join(', ')}.`]
    };
  }

  const allocation = {};
  for (const key of STAT_KEYS) {
    const parsed = parseAllocationValue(input[key]);
    if (parsed === null) {
      return {
        valid: false,
        allocation: null,
        errors: ['Starting stats must be whole numbers.']
      };
    }
    if (parsed < 0) {
      return {
        valid: false,
        allocation: null,
        errors: ['Starting stats cannot be negative.']
      };
    }
    allocation[key] = parsed;
  }

  const total = STAT_KEYS.reduce((sum, key) => sum + allocation[key], 0);
  if (total !== STARTING_STAT_POINTS) {
    return {
      valid: false,
      allocation: null,
      errors: [`Starting stats must spend exactly ${STARTING_STAT_POINTS} points.`]
    };
  }

  return {
    valid: true,
    allocation,
    errors: []
  };
}

function buildStartingStats(allocation) {
  return {
    health: BASE_STATS.health + allocation.health * 3,
    maxHealth: BASE_STATS.maxHealth + allocation.health * 3,
    stamina: BASE_STATS.stamina + allocation.stamina * 10,
    maxStamina: BASE_STATS.maxStamina + allocation.stamina * 10,
    speed: BASE_STATS.speed + allocation.speed,
    strength: BASE_STATS.strength + allocation.strength,
    intelligence: BASE_STATS.intelligence + allocation.intelligence
  };
}

function numberOrDefault(value, defaultValue) {
  return Number.isFinite(value) ? value : defaultValue;
}

function getBaseStats(user = {}) {
  return {
    health: numberOrDefault(user.health, BASE_STATS.health),
    maxHealth: numberOrDefault(user.maxHealth, BASE_STATS.maxHealth),
    stamina: numberOrDefault(user.stamina, BASE_STATS.stamina),
    maxStamina: numberOrDefault(user.maxStamina, BASE_STATS.maxStamina),
    speed: numberOrDefault(user.speed, BASE_STATS.speed),
    strength: numberOrDefault(user.strength, BASE_STATS.strength),
    intelligence: numberOrDefault(user.intelligence, BASE_STATS.intelligence)
  };
}

function getEffectiveUser(user = {}, bonusModifiers = null) {
  const job = normalizeJob(user.job);
  const baseStats = getBaseStats(user);
  const jobBonuses = {
    maxHealth: 0,
    maxStamina: 0,
    speed: 0,
    strength: 0,
    intelligence: 0,
    ...JOBS[job].bonuses
  };
  const mods = {
    maxHealth: 0,
    maxStamina: 0,
    speed: 0,
    strength: 0,
    intelligence: 0,
    ...(bonusModifiers || {})
  };
  // Plan 018: passive abilities fold their stat deltas into the effective layer,
  // exactly like a job bonus. Empty until a passive with statEffects exists, so
  // this changes nothing for the eight starter classes.
  const passiveMods = abilitiesModule.getPassiveStatModifiers(job);
  const passiveOf = key => Number(passiveMods[key] || 0);
  const maxHealth = baseStats.maxHealth + jobBonuses.maxHealth + mods.maxHealth + passiveOf('maxHealth');
  const maxStamina = baseStats.maxStamina + jobBonuses.maxStamina + mods.maxStamina + passiveOf('maxStamina');

  return {
    ...user,
    job,
    baseStats,
    jobBonuses,
    bonusModifiers: mods,
    health: Math.min(baseStats.health, maxHealth),
    maxHealth,
    stamina: Math.min(baseStats.stamina, maxStamina),
    maxStamina,
    speed: baseStats.speed + jobBonuses.speed + mods.speed + passiveOf('speed'),
    strength: baseStats.strength + jobBonuses.strength + mods.strength + passiveOf('strength'),
    intelligence: baseStats.intelligence + jobBonuses.intelligence + mods.intelligence + passiveOf('intelligence'),
    skill: getSkillForJob(job),
    skills: abilitiesModule.getActiveAbilitiesForJob(job),
    passives: abilitiesModule.getPassiveAbilitiesForJob(job)
  };
}

module.exports = {
  JOBS,
  STAT_KEYS,
  STARTING_STAT_POINTS,
  BASE_STATS,
  normalizeJob,
  getJob,
  getSkillForJob,
  validateStartingAllocation,
  buildStartingStats,
  getEffectiveUser
};
