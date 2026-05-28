const { dbGet, dbAll, dbRun } = require('./dbAsync');
const { getEffectiveUser, getSkillForJob } = require('./jobs');
const { createActionError } = require('./playerActions');
const { insertSystemMessage, moveUserToCemetery } = require('./deathUtils');
const {
  getWorldDay,
  createTrace
} = require('./roomEcology');

const HARMFUL_EFFECTS = new Set(['poison', 'arcane_pin', 'marked']);

function getSkillTarget(invoker, targetUsername) {
  return targetUsername && targetUsername.trim() ? targetUsername.trim() : invoker;
}

async function getUserOrThrow(db, username, label = 'User') {
  const user = await dbGet(db, 'SELECT * FROM users WHERE username = ?', [username]);
  if (!user) {
    throw createActionError(`${label} not found.`, 404);
  }
  return user;
}

async function addStatusEffect(db, {
  username,
  source,
  effectType,
  magnitude,
  currentTick,
  duration,
  row,
  col
}) {
  await dbRun(
    db,
    `INSERT INTO statusEffects
      (username, source, effectType, magnitude, createdTick, expiryTick, roomRow, roomCol, sourceUsername)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [username, source, effectType, magnitude, currentTick, currentTick + duration, row, col, source]
  );
}

async function removeExpiredStatusEffects(db, currentTick) {
  await dbRun(db, 'DELETE FROM statusEffects WHERE expiryTick <= ?', [currentTick]);
}

async function damageUser(db, username, amount, cause, row, col) {
  const target = await getUserOrThrow(db, username, 'Target');
  const nextHealth = Math.max(0, target.health - amount);
  await dbRun(db, 'UPDATE users SET health = ? WHERE username = ?', [nextHealth, username]);

  if (nextHealth <= 0 && target.health > 0) {
    await moveUserToCemetery(db, username, cause, row, col);
    return { killed: true, remainingHealth: 0 };
  }

  return { killed: false, remainingHealth: nextHealth };
}

async function healUser(db, username, amount) {
  const user = await getUserOrThrow(db, username, 'Target');
  const effective = getEffectiveUser(user);
  const nextHealth = Math.min(effective.maxHealth, user.health + amount);
  await dbRun(db, 'UPDATE users SET health = ? WHERE username = ?', [nextHealth, username]);
  return nextHealth;
}

async function drainStamina(db, username, amount) {
  const user = await getUserOrThrow(db, username, 'Target');
  const nextStamina = Math.max(0, user.stamina - amount);
  await dbRun(db, 'UPDATE users SET stamina = ? WHERE username = ?', [nextStamina, username]);
  return nextStamina;
}

async function createRoomTrace(db, trace) {
  await new Promise((resolve, reject) => {
    createTrace(db, trace, (err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });
}

async function clearOneHarmfulEffect(db, username) {
  const effect = await dbGet(
    db,
    `SELECT id
     FROM statusEffects
     WHERE username = ?
       AND effectType IN (${[...HARMFUL_EFFECTS].map(() => '?').join(', ')})
     ORDER BY expiryTick ASC, id ASC
     LIMIT 1`,
    [username, ...HARMFUL_EFFECTS]
  );

  if (!effect) {
    return false;
  }

  await dbRun(db, 'DELETE FROM statusEffects WHERE id = ?', [effect.id]);
  return true;
}

async function validateClassSkillUse(db, {
  username,
  skillId,
  targetUsername
}) {
  const actor = await getUserOrThrow(db, username);
  const effectiveActor = getEffectiveUser(actor);
  const actorSkill = getSkillForJob(effectiveActor.job);

  if (skillId !== actorSkill.id) {
    throw createActionError(`${effectiveActor.job} cannot use that skill.`, 400);
  }

  const target = getSkillTarget(username, targetUsername);
  if (skillId !== 'scrounge' && target) {
    await getUserOrThrow(db, target, 'Target');
  }

  return {
    actor,
    effectiveActor,
    target
  };
}

async function useClassSkill(db, {
  username,
  skillId,
  targetUsername,
  row,
  col,
  currentTick,
  phase
}) {
  const {
    effectiveActor,
    target
  } = await validateClassSkillUse(db, { username, skillId, targetUsername });

  switch (skillId) {
    case 'scrounge': {
      const gold = 1 + Math.max(1, Math.floor(effectiveActor.intelligence / 2));
      await dbRun(db, 'UPDATE users SET gold = gold + ? WHERE username = ?', [gold, username]);
      const message = `${username} scrounges up ${gold} gold.`;
      await insertSystemMessage(db, row, col, message);
      return { message };
    }
    case 'ward': {
      await getUserOrThrow(db, target, 'Target');
      await addStatusEffect(db, {
        username: target,
        source: username,
        effectType: 'ward',
        magnitude: 2,
        currentTick,
        duration: 5,
        row,
        col
      });
      const message = `${username} wards ${target} for 5 ticks.`;
      await insertSystemMessage(db, row, col, message);
      return { message };
    }
    case 'power_strike': {
      await getUserOrThrow(db, target, 'Target');
      const marked = await dbGet(
        db,
        'SELECT id, magnitude FROM statusEffects WHERE username = ? AND effectType = ? AND expiryTick > ? ORDER BY expiryTick ASC LIMIT 1',
        [target, 'marked', currentTick]
      );
      const ward = await dbGet(
        db,
        'SELECT id, magnitude FROM statusEffects WHERE username = ? AND effectType = ? AND expiryTick > ? ORDER BY expiryTick ASC LIMIT 1',
        [target, 'ward', currentTick]
      );
      let damage = 1 + Math.floor(effectiveActor.strength / 2);
      if (marked) {
        damage += marked.magnitude;
        await dbRun(db, 'DELETE FROM statusEffects WHERE id = ?', [marked.id]);
      }
      if (ward) {
        damage = Math.max(0, damage - ward.magnitude);
        await dbRun(db, 'DELETE FROM statusEffects WHERE id = ?', [ward.id]);
      }
      const result = damage > 0
        ? await damageUser(db, target, damage, 'power strike', row, col)
        : { killed: false, remainingHealth: null };
      const message = `${username} power strikes ${target} for ${damage} damage.`;
      await insertSystemMessage(db, row, col, message);
      return { message, damage, ...result };
    }
    case 'dose': {
      await getUserOrThrow(db, target, 'Target');
      if (phase === 'Night') {
        await addStatusEffect(db, {
          username: target,
          source: username,
          effectType: 'poison',
          magnitude: 1,
          currentTick,
          duration: 5,
          row,
          col
        });
        const message = `${username} doses ${target} with something bitter.`;
        await insertSystemMessage(db, row, col, message);
        return { message };
      }

      const amount = 2 + Math.floor(effectiveActor.intelligence / 4);
      await healUser(db, target, amount);
      const message = `${username} patches up ${target} for ${amount} health.`;
      await insertSystemMessage(db, row, col, message);
      return { message };
    }
    case 'survey': {
      await createRoomTrace(db, {
        row,
        col,
        traceType: 'survey',
        intensity: 1,
        attacker: username,
        target: `Room ${row}, ${col}`,
        createdTick: currentTick + 1,
        expiryTick: currentTick + 20,
        worldDay: getWorldDay()
      });
      await dbRun(db, 'UPDATE users SET gold = gold + 1 WHERE username = ?', [username]);
      const message = `${username} surveys the room and finds 1 gold.`;
      await insertSystemMessage(db, row, col, message);
      return { message };
    }
    case 'arcane_pin': {
      await getUserOrThrow(db, target, 'Target');
      await addStatusEffect(db, {
        username: target,
        source: username,
        effectType: 'arcane_pin',
        magnitude: 2,
        currentTick,
        duration: 4,
        row,
        col
      });
      const message = `${username} pins ${target} with a humming spell.`;
      await insertSystemMessage(db, row, col, message);
      return { message };
    }
    case 'mark': {
      await getUserOrThrow(db, target, 'Target');
      await addStatusEffect(db, {
        username: target,
        source: username,
        effectType: 'marked',
        magnitude: 2,
        currentTick,
        duration: 6,
        row,
        col
      });
      const message = `${username} marks ${target}.`;
      await insertSystemMessage(db, row, col, message);
      return { message };
    }
    case 'bless': {
      await getUserOrThrow(db, target, 'Target');
      const cleared = await clearOneHarmfulEffect(db, target);
      await addStatusEffect(db, {
        username: target,
        source: username,
        effectType: 'bless',
        magnitude: 1,
        currentTick,
        duration: 5,
        row,
        col
      });
      const message = cleared
        ? `${username} blesses ${target} and clears a harmful effect.`
        : `${username} blesses ${target}.`;
      await insertSystemMessage(db, row, col, message);
      return { message };
    }
    default:
      throw createActionError('Unknown skill.', 400);
  }
}

async function processStatusEffects(db, currentTick) {
  const activeEffects = await dbAll(
    db,
    `SELECT *
     FROM statusEffects
     WHERE expiryTick > ?
       AND createdTick < ?
       AND effectType IN ('poison', 'arcane_pin', 'bless')
     ORDER BY id ASC`,
    [currentTick, currentTick]
  );

  for (const effect of activeEffects) {
    const stillExists = await dbGet(db, 'SELECT username FROM users WHERE username = ?', [effect.username]);
    if (!stillExists) {
      continue;
    }

    if (effect.effectType === 'poison') {
      await damageUser(db, effect.username, effect.magnitude || 1, 'poison', effect.roomRow, effect.roomCol);
    } else if (effect.effectType === 'arcane_pin') {
      await drainStamina(db, effect.username, effect.magnitude || 1);
    } else if (effect.effectType === 'bless') {
      await healUser(db, effect.username, effect.magnitude || 1);
    }
  }

  await removeExpiredStatusEffects(db, currentTick);
}

module.exports = {
  useClassSkill,
  validateClassSkillUse,
  processStatusEffects,
  damageUser,
  healUser,
  addStatusEffect,
  clearOneHarmfulEffect
};
