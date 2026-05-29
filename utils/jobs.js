const STAT_KEYS = ['health', 'stamina', 'speed', 'strength', 'intelligence'];
const STARTING_STAT_POINTS = 12;

const BASE_STATS = {
  health: 10,
  maxHealth: 10,
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
    bonuses: {},
    skill: {
      id: 'scrounge',
      label: 'Scrounge',
      description: 'Search the room for loose gold.',
      effects: [
        'Gains 1 + half your Intelligence in gold, rounded down with a minimum bonus of 1.',
        'Does not require a target.'
      ]
    }
  },
  Paladin: {
    label: 'Paladin',
    description: 'A stubborn protector whose holiness mostly looks like interference.',
    bonuses: { maxHealth: 3, strength: 1 },
    skill: {
      id: 'ward',
      label: 'Ward',
      description: 'Protect yourself or another player from incoming harm.',
      effects: [
        'Adds Ward for 5 ticks.',
        'The next attack or Power Strike against the warded target is reduced by 2 damage and consumes the ward.',
        'Targets yourself if no target is selected.'
      ]
    }
  },
  Fighter: {
    label: 'Fighter',
    description: 'A blunt instrument with legs and a grievance.',
    bonuses: { maxHealth: 1, strength: 2 },
    skill: {
      id: 'power_strike',
      label: 'Power Strike',
      description: 'Hit a target harder than a normal attack.',
      effects: [
        'Uses a speed contest, so faster targets can dodge it.',
        'Deals 1 + half your Strength in damage, rounded down.',
        'Consumes Mark for +2 damage and consumes Ward for -2 damage.'
      ]
    }
  },
  Chemist: {
    label: 'Chemist',
    description: 'Helpful in daylight, concerning after dark.',
    bonuses: { intelligence: 2, maxStamina: 10 },
    skill: {
      id: 'dose',
      label: 'Dose',
      description: 'Patch someone up by day, poison them by night.',
      effects: [
        'Day: heals the target for 2 + one quarter of your Intelligence, rounded down.',
        'Night: uses a speed contest, then poisons the target for 5 ticks.',
        'Poison deals 1 damage each tick after it starts.'
      ]
    }
  },
  Dungeoneer: {
    label: 'Dungeoneer',
    description: 'Reads rooms like arguments and leaves marks on both.',
    bonuses: { speed: 1, strength: 1, intelligence: 1 },
    skill: {
      id: 'survey',
      label: 'Survey',
      description: 'Study the room and leave a visible survey trace.',
      effects: [
        'Leaves a survey trace in the room for 20 ticks.',
        'Gains 1 gold.',
        'Does not require a target.'
      ]
    }
  },
  Mage: {
    label: 'Mage',
    description: 'Turns attention into pressure.',
    bonuses: { intelligence: 3 },
    skill: {
      id: 'arcane_pin',
      label: 'Arcane Pin',
      description: 'Pin a target with a stamina-draining spell.',
      effects: [
        'Uses a speed contest, so faster targets can dodge it.',
        'Adds Arcane Pin for 4 ticks.',
        'Arcane Pin drains 2 stamina each tick after it starts.'
      ]
    }
  },
  Assassin: {
    label: 'Assassin',
    description: 'Makes future violence easier for everyone, unfortunately.',
    bonuses: { speed: 2, strength: 1 },
    skill: {
      id: 'mark',
      label: 'Mark',
      description: 'Make a target vulnerable to the next strong hit.',
      effects: [
        'Uses a speed contest, so faster targets can dodge it.',
        'Adds Mark for 6 ticks.',
        'The next attack or Power Strike against the marked target gains +2 damage and consumes the mark.'
      ]
    }
  },
  Cleric: {
    label: 'Cleric',
    description: 'Keeps people alive in ways that create obligations.',
    bonuses: { maxHealth: 2, intelligence: 2 },
    skill: {
      id: 'bless',
      label: 'Bless',
      description: 'Bless a target with healing and protection from harmful effects.',
      effects: [
        'Clears one harmful effect from the target if one is present.',
        'Adds Bless for 5 ticks.',
        'Bless heals 1 health each tick after it starts.'
      ]
    }
  }
};

function normalizeJob(job) {
  return Object.prototype.hasOwnProperty.call(JOBS, job) ? job : 'Novice';
}

function getJob(job) {
  return JOBS[normalizeJob(job)];
}

function getSkillForJob(job) {
  return getJob(job).skill;
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
    health: BASE_STATS.health + allocation.health,
    maxHealth: BASE_STATS.maxHealth + allocation.health,
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

function getEffectiveUser(user = {}) {
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
  const maxHealth = baseStats.maxHealth + jobBonuses.maxHealth;
  const maxStamina = baseStats.maxStamina + jobBonuses.maxStamina;

  return {
    ...user,
    job,
    baseStats,
    jobBonuses,
    health: Math.min(baseStats.health, maxHealth),
    maxHealth,
    stamina: Math.min(baseStats.stamina, maxStamina),
    maxStamina,
    speed: baseStats.speed + jobBonuses.speed,
    strength: baseStats.strength + jobBonuses.strength,
    intelligence: baseStats.intelligence + jobBonuses.intelligence,
    skill: getSkillForJob(job)
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
