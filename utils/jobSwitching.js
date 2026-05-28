const { dbGet, dbRun } = require('./dbAsync');
const { JOBS, getEffectiveUser } = require('./jobs');
const { createActionError } = require('./playerActions');
const { insertSystemMessage } = require('./deathUtils');

async function switchJob(db, {
  username,
  nextJob,
  row,
  col
}) {
  if (!Object.prototype.hasOwnProperty.call(JOBS, nextJob)) {
    throw createActionError('Invalid job.', 400);
  }

  const user = await dbGet(db, 'SELECT * FROM users WHERE username = ?', [username]);
  if (!user) {
    throw createActionError('User not found.', 404);
  }

  const nextEffective = getEffectiveUser({
    ...user,
    job: nextJob
  });
  const nextHealth = Math.min(user.health, nextEffective.maxHealth);
  const nextStamina = Math.min(user.stamina, nextEffective.maxStamina);

  await dbRun(
    db,
    'UPDATE users SET job = ?, health = ?, stamina = ? WHERE username = ?',
    [nextJob, nextHealth, nextStamina, username]
  );

  const message = `${username} changes job to ${nextJob}.`;
  await insertSystemMessage(db, row, col, message);

  return {
    message,
    job: nextJob
  };
}

module.exports = {
  switchJob
};
