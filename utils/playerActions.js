const { dbGet, dbRun } = require('./dbAsync');

function createActionError(message, statusCode = 400) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

async function spendStamina(db, username, cost = 1) {
  const result = await dbRun(
    db,
    'UPDATE users SET stamina = stamina - ? WHERE username = ? AND stamina >= ?',
    [cost, username, cost]
  );

  if (result.changes === 0) {
    throw createActionError('Not enough stamina.', 400);
  }

  return result;
}

async function assertEnoughStamina(db, username, cost = 1) {
  const user = await dbGet(db, 'SELECT stamina FROM users WHERE username = ?', [username]);
  if (!user || user.stamina < cost) {
    throw createActionError('Not enough stamina.', 400);
  }
}

async function runPlayerAction(db, {
  username,
  staminaCost = 1,
  validate,
  perform,
  advanceTick
}) {
  await assertEnoughStamina(db, username, staminaCost);
  if (validate) {
    await validate();
  }
  await spendStamina(db, username, staminaCost);
  const result = await perform();
  const tick = advanceTick ? await advanceTick() : null;

  return {
    ...result,
    tick
  };
}

module.exports = {
  createActionError,
  assertEnoughStamina,
  spendStamina,
  runPlayerAction
};
