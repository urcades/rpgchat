const db = require('../db/setup');
const {
  getWorldDay,
  cleanupOldTraces,
  createTrace,
  getAttackTrace
} = require('./roomEcology');
const { dbGet, dbAll, dbRun } = require('./dbAsync');
const { getEffectiveUser } = require('./jobs');
const { moveUserToCemetery } = require('./deathUtils');
const { createActionError } = require('./playerActions');

function cleanupOldTracesAsync(worldDay) {
  return new Promise((resolve, reject) => {
    cleanupOldTraces(db, worldDay, (err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });
}

function createTraceAsync(trace) {
  return new Promise((resolve, reject) => {
    createTrace(db, trace, (err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });
}

async function consumeStatusModifier(targetUsername, effectType, currentTick) {
  const effect = await dbGet(
    db,
    `SELECT id, magnitude
     FROM statusEffects
     WHERE username = ?
       AND effectType = ?
       AND expiryTick > ?
     ORDER BY expiryTick ASC, id ASC
     LIMIT 1`,
    [targetUsername, effectType, currentTick]
  ).catch(() => null);

  if (!effect) {
    return 0;
  }

  await dbRun(db, 'DELETE FROM statusEffects WHERE id = ?', [effect.id]);
  return effect.magnitude || 0;
}

async function calculateAttackDamage(attacker, targetUsername, currentTick) {
  const effectiveAttacker = getEffectiveUser(attacker);
  const isCriticalAttack = Math.random() < 0.01;
  const markedBonus = await consumeStatusModifier(targetUsername, 'marked', currentTick);
  const wardReduction = await consumeStatusModifier(targetUsername, 'ward', currentTick);
  const baseDamage = 1 + Math.floor(effectiveAttacker.strength / 4);
  const criticalDamage = isCriticalAttack ? baseDamage + 1 : baseDamage;
  const damage = Math.max(0, criticalDamage + markedBonus - wardReduction);

  return {
    damage,
    isCriticalAttack
  };
}

async function validateAttackTargets(database, username, message) {
  const users = await dbAll(database, 'SELECT username FROM users');
  const targets = users.filter(user => message.includes(user.username));

  if (targets.length === 0) {
    throw createActionError('Attack needs a target name.', 400);
  }

  return targets;
}

async function handleAttackCore(username, message, row, col) {
  const tickRow = await dbGet(db, 'SELECT value FROM tick WHERE rowid = 1');
  const currentTick = tickRow ? tickRow.value : 0;
  const worldDay = getWorldDay();
  const createdTick = currentTick + 1;
  const roomRow = Number.parseInt(row, 10);
  const roomCol = Number.parseInt(col, 10);
  const attacker = await dbGet(db, 'SELECT * FROM users WHERE username = ?', [username]);
  const targets = await validateAttackTargets(db, username, message);

  await cleanupOldTracesAsync(worldDay);

  const attackMessages = [];

  for (const user of targets) {
    const { damage, isCriticalAttack } = await calculateAttackDamage(attacker, user.username, createdTick);
    await dbRun(
      db,
      'UPDATE users SET health = MAX(health - ?, 0) WHERE username = ? AND health > 0',
      [damage, user.username]
    );

    const attackedUser = await dbGet(db, 'SELECT * FROM users WHERE username = ?', [user.username]);
    const remainingHealth = attackedUser ? attackedUser.health : 0;
    const wasKilled = attackedUser && attackedUser.health <= 0;
    const attackMessage = isCriticalAttack
      ? `${username} landed a critical hit on ${user.username} for ${damage} damage!`
      : `${username} attacked ${user.username} for ${damage} damage`;

    attackMessages.push(attackMessage);

    const trace = getAttackTrace({
      row: roomRow,
      col: roomCol,
      attacker: username,
      target: user.username,
      damage,
      isCritical: isCriticalAttack,
      remainingHealth,
      wasKilled,
      createdTick,
      worldDay
    });

    if (wasKilled) {
      await moveUserToCemetery(db, user.username, `attack by ${username}`, roomRow, roomCol);
    }

    await createTraceAsync(trace);
  }

  return `${message} (${attackMessages.join(', ')})`;
}

function handleAttack(username, message, row, col, callback) {
  handleAttackCore(username, message, row, col)
    .then(updatedMessage => callback(null, updatedMessage))
    .catch(callback);
}

module.exports = {
  handleAttack,
  handleAttackCore,
  validateAttackTargets
};
