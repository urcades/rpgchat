const test = require('node:test');
const assert = require('node:assert/strict');

const {
  JOBS,
  STAT_KEYS,
  validateStartingAllocation,
  buildStartingStats,
  getEffectiveUser,
  getSkillForJob
} = require('../utils/jobs');

test('defines the eight starting jobs with one active skill each', () => {
  assert.deepEqual(Object.keys(JOBS).sort(), [
    'Assassin',
    'Chemist',
    'Cleric',
    'Dungeoneer',
    'Fighter',
    'Mage',
    'Novice',
    'Paladin'
  ]);

  for (const jobName of Object.keys(JOBS)) {
    const skill = getSkillForJob(jobName);
    assert.equal(typeof skill.id, 'string');
    assert.equal(typeof skill.label, 'string');
    assert.equal(typeof skill.description, 'string');
    assert.ok(Array.isArray(skill.effects));
    assert.ok(skill.effects.length > 0);
    skill.effects.forEach(effect => assert.equal(typeof effect, 'string'));
  }
});

test('validates starting allocation budget while allowing stat dumps', () => {
  const valid = {
    health: 2,
    stamina: 3,
    speed: 2,
    strength: 3,
    intelligence: 2
  };

  assert.deepEqual(validateStartingAllocation(valid), {
    valid: true,
    allocation: valid,
    errors: []
  });

  assert.deepEqual(validateStartingAllocation({
    health: 12,
    stamina: 0,
    speed: 0,
    strength: 0,
    intelligence: 0
  }), {
    valid: true,
    allocation: {
      health: 12,
      stamina: 0,
      speed: 0,
      strength: 0,
      intelligence: 0
    },
    errors: []
  });

  assert.deepEqual(validateStartingAllocation({
    health: 1,
    stamina: 1,
    speed: 1,
    strength: 1,
    intelligence: 1
  }).errors, ['Starting stats must spend exactly 12 points.']);

  assert.deepEqual(validateStartingAllocation({
    health: 2,
    stamina: '3.5',
    speed: 2,
    strength: 2,
    intelligence: 2
  }).errors, ['Starting stats must be whole numbers.']);

  assert.deepEqual(validateStartingAllocation({
    health: 2,
    stamina: 3,
    speed: 2,
    strength: 3,
    luck: 2
  }).errors, [`Starting stats must include ${STAT_KEYS.join(', ')}.`]);
});

test('builds saved base stats separately from temporary job bonuses', () => {
  const stats = buildStartingStats({
    health: 2,
    stamina: 3,
    speed: 2,
    strength: 3,
    intelligence: 2
  });

  assert.deepEqual(stats, {
    health: 36,
    maxHealth: 36,
    stamina: 130,
    maxStamina: 130,
    speed: 3,
    strength: 4,
    intelligence: 3
  });

  const effective = getEffectiveUser({
    username: 'tank',
    job: 'Paladin',
    health: 36,
    maxHealth: 36,
    stamina: 130,
    maxStamina: 130,
    speed: 3,
    strength: 4,
    intelligence: 3
  });

  assert.equal(effective.baseStats.maxHealth, 36);
  assert.equal(effective.jobBonuses.maxHealth, 9);
  assert.equal(effective.maxHealth, 45);
  assert.equal(effective.health, 36);
  assert.equal(effective.strength, 5);
});

test('unknown or missing jobs safely behave as Novice', () => {
  assert.equal(getEffectiveUser({ job: 'Chef' }).job, 'Novice');
  assert.equal(getSkillForJob('Chef').id, 'scrounge');
});
