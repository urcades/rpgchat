const {
  getWorldDay,
  getPhaseFromTick,
  generateRoomFeatures,
  applyPhaseToFeatures,
  calculateInnFee,
  shouldApplyEffect,
  applyPassiveEffectToUser,
  resolveGamblingRound,
  createTrace
} = require('./roomEcology');
const { dbGet, dbAll, dbRun } = require('./dbAsync');
const { getEffectiveUser } = require('./jobs');
const { moveUserToCemetery: moveUserToCemeteryShared } = require('./deathUtils');

const PRESENCE_MAX_AGE_SECONDS = 45;
const INN_ACCESS_TYPE = 'inn';
const PASSIVE_EFFECT_TYPES = new Set([
  'pub',
  'inn',
  'poison_marsh',
  'sun_room',
  'moon_room',
  'cold_room',
  'guild'
]);

function getRoomFeaturesForTick(row, col, tickValue, worldDay = getWorldDay()) {
  const phase = getPhaseFromTick(tickValue);
  return applyPhaseToFeatures(generateRoomFeatures(row, col, worldDay), phase);
}

function getActiveEffectsForRoom(row, col, tickValue, worldDay = getWorldDay()) {
  return getRoomFeaturesForTick(row, col, tickValue, worldDay)
    .filter(feature => feature.active !== false && feature.effect)
    .map(feature => ({
      ...feature.effect,
      label: feature.label
    }));
}

function roomHasEffect(row, col, tickValue, effectType, worldDay = getWorldDay()) {
  return getActiveEffectsForRoom(row, col, tickValue, worldDay)
    .some(effect => effect.type === effectType);
}

async function getCurrentTickValue(db) {
  const row = await dbGet(db, 'SELECT value FROM tick WHERE rowid = 1');
  return row ? row.value : 0;
}

async function cleanupOldWorldDayData(db, worldDay = getWorldDay()) {
  await dbRun(db, 'DELETE FROM roomPresence WHERE worldDay != ?', [worldDay]);
  await dbRun(db, 'DELETE FROM roomEffectCooldowns WHERE worldDay != ?', [worldDay]);
  await dbRun(db, 'DELETE FROM roomAccess WHERE worldDay != ?', [worldDay]);
  await dbRun(db, 'DELETE FROM gamblingEntries WHERE roundId IN (SELECT id FROM gamblingRounds WHERE worldDay != ?)', [worldDay]);
  await dbRun(db, 'DELETE FROM gamblingRounds WHERE worldDay != ?', [worldDay]);
}

async function getInnAccessState(db, username, row, col, worldDay = getWorldDay()) {
  const fee = calculateInnFee(row, col, worldDay);
  const access = username
    ? await dbGet(
      db,
      `SELECT username, costPaid
       FROM roomAccess
       WHERE username = ?
         AND roomRow = ?
         AND roomCol = ?
         AND accessType = ?
         AND worldDay = ?`,
      [username, row, col, INN_ACCESS_TYPE, worldDay]
    )
    : null;
  const user = username
    ? await dbGet(db, 'SELECT gold FROM users WHERE username = ?', [username])
    : null;

  return {
    required: true,
    fee,
    paid: Boolean(access),
    costPaid: access ? access.costPaid : 0,
    gold: user ? user.gold : null,
    canPay: user ? user.gold >= fee : false
  };
}

async function getRoomAccessState(db, username, row, col, tickValue = null, worldDay = getWorldDay()) {
  const currentTick = tickValue === null ? await getCurrentTickValue(db) : tickValue;
  const requiresInn = roomHasEffect(row, col, currentTick, 'inn', worldDay);

  if (!requiresInn) {
    return {
      required: false,
      fee: 0,
      paid: true,
      costPaid: 0,
      gold: null,
      canPay: false
    };
  }

  return getInnAccessState(db, username, row, col, worldDay);
}

async function requireRoomUse(db, username, row, col) {
  const worldDay = getWorldDay();
  const tickValue = await getCurrentTickValue(db);
  const access = await getRoomAccessState(db, username, row, col, tickValue, worldDay);

  return {
    allowed: !access.required || access.paid,
    access,
    worldDay,
    tickValue
  };
}

async function payInnAccess(db, username, row, col) {
  const worldDay = getWorldDay();
  const tickValue = await getCurrentTickValue(db);

  if (!roomHasEffect(row, col, tickValue, 'inn', worldDay)) {
    const err = new Error('This room is not an inn today');
    err.statusCode = 400;
    throw err;
  }

  const currentAccess = await getInnAccessState(db, username, row, col, worldDay);
  if (currentAccess.paid) {
    return currentAccess;
  }

  const user = await dbGet(db, 'SELECT gold FROM users WHERE username = ?', [username]);
  if (!user) {
    const err = new Error('User not found');
    err.statusCode = 404;
    throw err;
  }

  if (user.gold < currentAccess.fee) {
    const err = new Error('Not enough gold');
    err.statusCode = 402;
    err.access = currentAccess;
    throw err;
  }

  await dbRun(db, 'UPDATE users SET gold = gold - ? WHERE username = ?', [currentAccess.fee, username]);
  await dbRun(
    db,
    `INSERT OR REPLACE INTO roomAccess
      (username, roomRow, roomCol, accessType, costPaid, worldDay)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [username, row, col, INN_ACCESS_TYPE, currentAccess.fee, worldDay]
  );

  return {
    ...currentAccess,
    paid: true,
    costPaid: currentAccess.fee,
    gold: user.gold - currentAccess.fee,
    canPay: true
  };
}

async function updatePresence(db, username, row, col) {
  const worldDay = getWorldDay();
  const tickValue = await getCurrentTickValue(db);
  await cleanupOldWorldDayData(db, worldDay);
  await dbRun(
    db,
    `INSERT INTO roomPresence
      (username, roomRow, roomCol, lastSeenTick, worldDay, lastSeenAt)
     VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(username, worldDay) DO UPDATE SET
      roomRow = excluded.roomRow,
      roomCol = excluded.roomCol,
      lastSeenTick = excluded.lastSeenTick,
      lastSeenAt = CURRENT_TIMESTAMP`,
    [username, row, col, tickValue, worldDay]
  );

  return {
    username,
    row,
    col,
    tickValue,
    worldDay
  };
}

async function getActiveRound(db, row, col, worldDay, tickValue) {
  const round = await dbGet(
    db,
    `SELECT *
     FROM gamblingRounds
     WHERE roomRow = ?
       AND roomCol = ?
       AND worldDay = ?
       AND status = 'open'
     ORDER BY startTick DESC
     LIMIT 1`,
    [row, col, worldDay]
  );

  if (!round) {
    return null;
  }

  const entries = await dbAll(
    db,
    `SELECT username, wager, roll, enteredTick
     FROM gamblingEntries
     WHERE roundId = ?
     ORDER BY enteredTick ASC, id ASC`,
    [round.id]
  );

  return {
    id: round.id,
    startTick: round.startTick,
    endTick: round.endTick,
    remainingTicks: Math.max(0, round.endTick - tickValue),
    pool: round.pool,
    entries
  };
}

function parseRollCommand(message) {
  const match = message.trim().match(/^\/roll\s+(\d+)$/i);
  if (!match) {
    return null;
  }
  return Number.parseInt(match[1], 10);
}

async function insertSystemMessage(db, row, col, message) {
  await dbRun(db, `INSERT INTO messages_${row}_${col} (username, message) VALUES ('System', ?)`, [message]);
}

async function handleRollCommand(db, username, row, col, message) {
  const { wager, tickValue, worldDay } = await validateRollCommand(db, username, row, col, message);
  await resolveExpiredGamblingRounds(db, tickValue);
  let round = await dbGet(
    db,
    `SELECT *
     FROM gamblingRounds
     WHERE roomRow = ?
       AND roomCol = ?
       AND worldDay = ?
       AND status = 'open'
       AND endTick >= ?
     ORDER BY startTick ASC
     LIMIT 1`,
    [row, col, worldDay, tickValue]
  );

  if (!round) {
    const created = await dbRun(
      db,
      `INSERT INTO gamblingRounds
        (roomRow, roomCol, worldDay, startTick, endTick, status, pool)
       VALUES (?, ?, ?, ?, ?, 'open', 0)`,
      [row, col, worldDay, tickValue, tickValue + 10]
    );
    round = {
      id: created.lastID,
      roomRow: row,
      roomCol: col,
      worldDay,
      startTick: tickValue,
      endTick: tickValue + 10,
      status: 'open',
      pool: 0
    };
  }

  const roll = Math.floor(Math.random() * 20) + 1;
  const goldUpdate = await dbRun(
    db,
    'UPDATE users SET gold = gold - ? WHERE username = ? AND gold >= ?',
    [wager, username, wager]
  );

  if (goldUpdate.changes === 0) {
    const err = new Error('Not enough gold for that wager.');
    err.statusCode = 400;
    throw err;
  }

  try {
    await dbRun(
      db,
      `INSERT INTO gamblingEntries
        (roundId, username, wager, roll, enteredTick)
       VALUES (?, ?, ?, ?, ?)`,
      [round.id, username, wager, roll, tickValue]
    );
  } catch (err) {
    await dbRun(db, 'UPDATE users SET gold = gold + ? WHERE username = ?', [wager, username]);
    throw err;
  }

  await dbRun(db, 'UPDATE gamblingRounds SET pool = pool + ? WHERE id = ?', [wager, round.id]);

  const systemMessage = `${username} enters the dice round with ${wager} gold and rolls ${roll}. The round closes at tick ${round.endTick}.`;
  await insertSystemMessage(db, row, col, systemMessage);

  return {
    wager,
    roll,
    roundId: round.id,
    endTick: round.endTick,
    systemMessage
  };
}

async function validateRollCommand(db, username, row, col, message) {
  const wager = parseRollCommand(message);
  if (!wager || wager < 1) {
    const err = new Error('Use /roll <gold> with a positive wager.');
    err.statusCode = 400;
    throw err;
  }

  const worldDay = getWorldDay();
  const tickValue = await getCurrentTickValue(db);

  if (!roomHasEffect(row, col, tickValue, 'gambling_den', worldDay)) {
    const err = new Error('/roll can only be used in a gambling den.');
    err.statusCode = 400;
    throw err;
  }

  const user = await dbGet(db, 'SELECT gold FROM users WHERE username = ?', [username]);
  if (!user || user.gold < wager) {
    const err = new Error('Not enough gold for that wager.');
    err.statusCode = 400;
    throw err;
  }

  const existingRound = await dbGet(
    db,
    `SELECT *
     FROM gamblingRounds
     WHERE roomRow = ?
       AND roomCol = ?
       AND worldDay = ?
       AND status = 'open'
       AND endTick >= ?
     ORDER BY startTick ASC
     LIMIT 1`,
    [row, col, worldDay, tickValue]
  );

  const existingEntry = existingRound
    ? await dbGet(
      db,
      'SELECT id FROM gamblingEntries WHERE roundId = ? AND username = ?',
      [existingRound.id, username]
    )
    : null;

  if (existingEntry) {
    const err = new Error('You have already entered this dice round.');
    err.statusCode = 400;
    throw err;
  }

  return {
    wager,
    tickValue,
    worldDay
  };
}

async function upsertCooldown(db, username, row, col, effectType, currentTick, worldDay) {
  await dbRun(
    db,
    `INSERT INTO roomEffectCooldowns
      (username, roomRow, roomCol, effectType, lastAppliedTick, worldDay)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(username, roomRow, roomCol, effectType, worldDay) DO UPDATE SET
      lastAppliedTick = excluded.lastAppliedTick`,
    [username, row, col, effectType, currentTick, worldDay]
  );
}

async function moveUserToCemetery(db, user, row, col, effectType, currentTick, worldDay) {
  const cause = effectType.replace(/_/g, ' ');

  await moveUserToCemeteryShared(db, user.username, cause, row, col);
  await new Promise((resolve, reject) => {
    createTrace(db, {
      row,
      col,
      traceType: 'body',
      intensity: 3,
      attacker: cause,
      target: user.username,
      createdTick: currentTick,
      expiryTick: null,
      worldDay
    }, (err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });
}

async function processUserEffect(db, presence, effect, currentTick, worldDay) {
  if (!PASSIVE_EFFECT_TYPES.has(effect.type)) {
    return false;
  }

  if (effect.type === 'inn') {
    const access = await getInnAccessState(db, presence.username, presence.roomRow, presence.roomCol, worldDay);
    if (!access.paid) {
      return false;
    }
  }

  const cooldown = await dbGet(
    db,
    `SELECT lastAppliedTick
     FROM roomEffectCooldowns
     WHERE username = ?
       AND roomRow = ?
       AND roomCol = ?
       AND effectType = ?
       AND worldDay = ?`,
    [presence.username, presence.roomRow, presence.roomCol, effect.type, worldDay]
  );

  const interval = effect.interval || 5;
  if (!shouldApplyEffect({
    currentTick,
    lastAppliedTick: cooldown ? cooldown.lastAppliedTick : null,
    interval
  })) {
    return false;
  }

  await upsertCooldown(db, presence.username, presence.roomRow, presence.roomCol, effect.type, currentTick, worldDay);

  const phase = getPhaseFromTick(currentTick);
  const before = {
    username: presence.username,
    health: presence.health,
    maxHealth: getEffectiveUser(presence).maxHealth,
    stamina: presence.stamina,
    maxStamina: getEffectiveUser(presence).maxStamina
  };
  const after = applyPassiveEffectToUser(before, effect.type, phase);

  if (after.health <= 0 && before.health > 0) {
    await moveUserToCemetery(db, presence, presence.roomRow, presence.roomCol, effect.type, currentTick, worldDay);
    return true;
  }

  if (after.health !== before.health || after.stamina !== before.stamina) {
    await dbRun(
      db,
      'UPDATE users SET health = ?, stamina = ? WHERE username = ?',
      [after.health, after.stamina, presence.username]
    );
    presence.health = after.health;
    presence.stamina = after.stamina;
  }

  return false;
}

async function processEchoChamber(db, row, col, currentTick, worldDay) {
  const cooldownUsername = `__room_${row}_${col}`;
  const cooldown = await dbGet(
    db,
    `SELECT lastAppliedTick
     FROM roomEffectCooldowns
     WHERE username = ?
       AND roomRow = ?
       AND roomCol = ?
       AND effectType = ?
       AND worldDay = ?`,
    [cooldownUsername, row, col, 'echo_chamber', worldDay]
  );

  if (!shouldApplyEffect({
    currentTick,
    lastAppliedTick: cooldown ? cooldown.lastAppliedTick : null,
    interval: 5
  })) {
    return;
  }

  await upsertCooldown(db, cooldownUsername, row, col, 'echo_chamber', currentTick, worldDay);
  if (Math.random() >= 0.35) {
    return;
  }

  const recent = await dbGet(
    db,
    `SELECT username, message
     FROM messages_${row}_${col}
     WHERE username != 'System'
     ORDER BY timestamp DESC
     LIMIT 1`
  );

  if (!recent) {
    return;
  }

  const fragment = recent.message.length > 120
    ? `${recent.message.slice(0, 117)}...`
    : recent.message;
  await insertSystemMessage(db, row, col, `An echo repeats: ${fragment}`);
}

async function processRoomEffects(db, currentTick) {
  const worldDay = getWorldDay();
  await cleanupOldWorldDayData(db, worldDay);

  const presences = await dbAll(
    db,
    `SELECT rp.username, rp.roomRow, rp.roomCol, rp.lastSeenTick,
            u.job, u.health, u.maxHealth, u.stamina, u.maxStamina, u.speed, u.strength, u.intelligence, u.level, u.gold
     FROM roomPresence rp
     JOIN users u ON u.username = rp.username
     WHERE rp.worldDay = ?
       AND rp.lastSeenAt >= datetime('now', ?)`,
    [worldDay, `-${PRESENCE_MAX_AGE_SECONDS} seconds`]
  );
  const echoRooms = new Map();

  for (const presence of presences) {
    const effects = getActiveEffectsForRoom(presence.roomRow, presence.roomCol, currentTick, worldDay);

    for (const effect of effects) {
      if (effect.type === 'echo_chamber') {
        echoRooms.set(`${presence.roomRow}:${presence.roomCol}`, {
          row: presence.roomRow,
          col: presence.roomCol
        });
        continue;
      }

      const died = await processUserEffect(db, presence, effect, currentTick, worldDay);
      if (died) {
        break;
      }
    }
  }

  for (const room of echoRooms.values()) {
    await processEchoChamber(db, room.row, room.col, currentTick, worldDay);
  }
}

async function resolveExpiredGamblingRounds(db, currentTick) {
  const worldDay = getWorldDay();
  const rounds = await dbAll(
    db,
    `SELECT *
     FROM gamblingRounds
     WHERE status = 'open'
       AND worldDay = ?
       AND endTick <= ?`,
    [worldDay, currentTick]
  );

  for (const round of rounds) {
    const entries = await dbAll(
      db,
      `SELECT id, username, wager, roll, enteredTick
       FROM gamblingEntries
       WHERE roundId = ?
       ORDER BY enteredTick ASC, id ASC`,
      [round.id]
    );

    if (entries.length === 0) {
      await dbRun(db, "UPDATE gamblingRounds SET status = 'closed' WHERE id = ?", [round.id]);
      continue;
    }

    const result = resolveGamblingRound(entries);
    await dbRun(db, 'UPDATE users SET gold = gold + ? WHERE username = ?', [result.pool, result.winner]);
    await dbRun(
      db,
      `UPDATE gamblingRounds
       SET status = 'resolved',
           pool = ?,
           winner = ?,
           winningRoll = ?
       WHERE id = ?`,
      [result.pool, result.winner, result.winningRoll, round.id]
    );
    await insertSystemMessage(
      db,
      round.roomRow,
      round.roomCol,
      `The dice round closes. ${result.winner} wins ${result.pool} gold with a roll of ${result.winningRoll}.`
    );
  }
}

module.exports = {
  PRESENCE_MAX_AGE_SECONDS,
  getRoomFeaturesForTick,
  getActiveEffectsForRoom,
  roomHasEffect,
  getCurrentTickValue,
  cleanupOldWorldDayData,
  getRoomAccessState,
  requireRoomUse,
  payInnAccess,
  updatePresence,
  getActiveRound,
  parseRollCommand,
  validateRollCommand,
  handleRollCommand,
  insertSystemMessage,
  processRoomEffects,
  resolveExpiredGamblingRounds
};
