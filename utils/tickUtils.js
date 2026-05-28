const { dbAll, dbGet, dbRun } = require('./dbAsync');
const {
  processRoomEffects,
  resolveExpiredGamblingRounds
} = require('./roomMechanics');
const { processStatusEffects } = require('./classSkills');
const { getEffectiveUser } = require('./jobs');

async function recoverStaminaForAllUsers(db) {
  const users = await dbAll(
    db,
    'SELECT username, job, health, maxHealth, stamina, maxStamina, speed, strength, intelligence FROM users'
  );

  for (const user of users) {
    const effective = getEffectiveUser(user);
    const nextStamina = Math.min(user.stamina + 1, effective.maxStamina);
    if (nextStamina !== user.stamina) {
      await dbRun(db, 'UPDATE users SET stamina = ? WHERE username = ?', [nextStamina, user.username]);
    }
  }
}

async function advanceGlobalTickAsync(db) {
  await dbRun(db, 'UPDATE tick SET value = value + 1 WHERE rowid = 1');
  const row = await dbGet(db, 'SELECT value FROM tick WHERE rowid = 1');
  const tickValue = row ? row.value : 0;

  if (tickValue % 3 === 0) {
    await recoverStaminaForAllUsers(db);
  }

  await processRoomEffects(db, tickValue);
  await processStatusEffects(db, tickValue);
  await resolveExpiredGamblingRounds(db, tickValue);

  return {
    tick: tickValue,
    staminaUpdated: tickValue % 3 === 0
  };
}

function advanceGlobalTick(db, callback) {
  advanceGlobalTickAsync(db)
    .then(result => callback(null, result))
    .catch(callback);
}

module.exports = {
  recoverStaminaForAllUsers,
  advanceGlobalTick,
  advanceGlobalTickAsync
};
