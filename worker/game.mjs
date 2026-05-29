import jobsModule from '../utils/jobs.js';
import ecologyModule from '../utils/roomEcology.js';
import levelingModule from '../utils/leveling.js';
import worldEventsModule from '../utils/worldEvents.js';
import { changes, dbAll, dbFirst, dbRun, lastInsertId } from './db.mjs';

const {
  JOBS,
  normalizeJob,
  getSkillForJob,
  validateStartingAllocation,
  buildStartingStats,
  getEffectiveUser
} = jobsModule;

const {
  GRID_SIZE,
  getWorldDay,
  getNextResetAt,
  validateRoomCoordinates,
  generateRoomFeatures,
  generateShopStock,
  calculateInnFee,
  getRoomEffectPayload,
  shouldApplyEffect,
  applyPassiveEffectToUser,
  resolveGamblingRound,
  applyPhaseToFeatures,
  getPhaseFromTick,
  summarizeTraces,
  composeRoomDescription,
  getAttackTrace
} = ecologyModule;

const { calculateLevel } = levelingModule;
const { generateDailyWorldEvents } = worldEventsModule;

const PRESENCE_MAX_AGE_SECONDS = 45;
const BASE_EXPERIENCE_REQUIRED = 100;
const PLAYER_ACTION_EXPERIENCE = 1;
const INN_ACCESS_TYPE = 'inn';
const SPEED_HIT_BASE_CHANCE = 0.7;
const SPEED_HIT_STEP = 0.05;
const SPEED_HIT_MIN_CHANCE = 0.25;
const SPEED_HIT_MAX_CHANCE = 0.95;
const HARMFUL_EFFECTS = new Set(['poison', 'arcane_pin', 'marked']);
const AMBIENT_HOSTILE_RESPAWN_INTERVAL = 6;
const PASSIVE_EFFECT_TYPES = new Set([
  'pub',
  'inn',
  'poison_marsh',
  'sun_room',
  'moon_room',
  'cold_room',
  'guild'
]);

export {
  GRID_SIZE,
  JOBS,
  getEffectiveUser,
  normalizeJob,
  validateRoomCoordinates,
  validateStartingAllocation,
  buildStartingStats
};

export class ActionError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

function assertAction(condition, message, statusCode = 400) {
  if (!condition) {
    throw new ActionError(message, statusCode);
  }
}

function clampNumber(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

export function calculateSpeedHitChance(attacker, target) {
  const effectiveAttacker = getEffectiveUser(attacker);
  const effectiveTarget = getEffectiveUser(target);
  const speedDifference = effectiveAttacker.speed - effectiveTarget.speed;
  const hitChance = clampNumber(
    SPEED_HIT_BASE_CHANCE + speedDifference * SPEED_HIT_STEP,
    SPEED_HIT_MIN_CHANCE,
    SPEED_HIT_MAX_CHANCE
  );

  return Math.round(hitChance * 100) / 100;
}

function rollSpeedContest(attacker, target) {
  const hitChance = calculateSpeedHitChance(attacker, target);
  return {
    hit: Math.random() < hitChance,
    hitChance
  };
}

export async function getCurrentTickValue(db) {
  const row = await dbFirst(db, 'SELECT value FROM tick WHERE id = 1');
  return row ? row.value : 0;
}

export function getRoomFeaturesForTick(row, col, tickValue, worldDay = getWorldDay()) {
  const phase = getPhaseFromTick(tickValue);
  return applyPhaseToFeatures(generateRoomFeatures(row, col, worldDay), phase);
}

export function getActiveEffectsForRoom(row, col, tickValue, worldDay = getWorldDay()) {
  return getRoomFeaturesForTick(row, col, tickValue, worldDay)
    .filter(feature => feature.active !== false && feature.effect)
    .map(feature => ({
      ...feature.effect,
      label: feature.label
    }));
}

export function roomHasEffect(row, col, tickValue, effectType, worldDay = getWorldDay()) {
  return getActiveEffectsForRoom(row, col, tickValue, worldDay)
    .some(effect => effect.type === effectType);
}

export async function getUser(db, username, label = 'User') {
  const user = await dbFirst(db, 'SELECT * FROM users WHERE username = ?', [username]);
  if (!user) {
    throw new ActionError(`${label} not found.`, 404);
  }
  return user;
}

export async function getRoomAccessState(db, username, row, col, tickValue = null, worldDay = getWorldDay()) {
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

  const fee = calculateInnFee(row, col, worldDay);
  const access = username
    ? await dbFirst(
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
    ? await dbFirst(db, 'SELECT gold FROM users WHERE username = ?', [username])
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

export async function requireRoomUse(db, username, row, col) {
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

export async function payInnAccess(db, username, row, col) {
  const worldDay = getWorldDay();
  const tickValue = await getCurrentTickValue(db);
  assertAction(roomHasEffect(row, col, tickValue, 'inn', worldDay), 'This room is not an inn today');

  const currentAccess = await getRoomAccessState(db, username, row, col, tickValue, worldDay);
  if (currentAccess.paid) {
    return currentAccess;
  }

  const user = await getUser(db, username);
  assertAction(user.gold >= currentAccess.fee, 'Not enough gold', 402);

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

export async function cleanupOldWorldDayData(db, worldDay = getWorldDay()) {
  await dbRun(
    db,
    `DELETE FROM users
     WHERE isNpc = 1
       AND worldEventId IN (SELECT id FROM worldEvents WHERE worldDay != ?)`,
    [worldDay]
  );
  await dbRun(
    db,
    `DELETE FROM worldEventEntities
     WHERE eventId IN (SELECT id FROM worldEvents WHERE worldDay != ?)`,
    [worldDay]
  );
  await dbRun(db, 'DELETE FROM worldEvents WHERE worldDay != ? AND status != ?', [worldDay, 'completed']);
  await dbRun(db, 'DELETE FROM roomPresence WHERE worldDay != ?', [worldDay]);
  await dbRun(db, 'DELETE FROM roomEffectCooldowns WHERE worldDay != ?', [worldDay]);
  await dbRun(db, 'DELETE FROM roomAccess WHERE worldDay != ?', [worldDay]);
  await dbRun(db, 'DELETE FROM gamblingEntries WHERE roundId IN (SELECT id FROM gamblingRounds WHERE worldDay != ?)', [worldDay]);
  await dbRun(db, 'DELETE FROM gamblingRounds WHERE worldDay != ?', [worldDay]);
  await dbRun(db, 'DELETE FROM roomTraces WHERE worldDay != ?', [worldDay]);
}

export async function updatePresence(db, username, row, col) {
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

  return { username, row, col, tickValue, worldDay };
}

async function getRoomPresence(db, row, col, worldDay) {
  return dbAll(
    db,
    `SELECT rp.username,
            COALESCE(u.displayName, rp.username) AS displayName,
            u.job,
            u.level,
            u.isNpc,
            u.npcKind,
            u.worldEventId,
            rp.lastSeenTick
     FROM roomPresence rp
     JOIN users u ON u.username = rp.username
     WHERE rp.roomRow = ?
       AND rp.roomCol = ?
       AND rp.worldDay = ?
       AND (u.isNpc = 1 OR rp.lastSeenAt >= datetime('now', ?))
       AND rp.username != 'System'
     ORDER BY lower(rp.username) ASC`,
    [row, col, worldDay, `-${PRESENCE_MAX_AGE_SECONDS} seconds`]
  );
}

async function getActiveRoomEvent(db, row, col, worldDay) {
  return dbFirst(
    db,
    `SELECT id, worldDay, eventType, roomRow, roomCol, status, title, description, rewardExperience, rewardGold
     FROM worldEvents
     WHERE roomRow = ?
       AND roomCol = ?
       AND worldDay = ?
       AND status = 'active'
       AND eventType IN ('raid', 'lesser')
     ORDER BY CASE eventType WHEN 'raid' THEN 0 ELSE 1 END
     LIMIT 1`,
    [row, col, worldDay]
  );
}

function npcUsername(eventId, suffix) {
  return `${eventId}_${suffix}`.replace(/[^A-Za-z0-9_-]/g, '_');
}

function npcTemplateFor(event, suffix) {
  if (event.eventType === 'raid' && suffix === 'boss') {
    return {
      username: npcUsername(event.id, 'boss'),
      displayName: 'Frost Wyrm',
      npcKind: 'raid_boss',
      health: 20,
      stamina: 100,
      speed: 7,
      strength: 12,
      intelligence: 3,
      rewardExperience: event.rewardExperience,
      rewardGold: event.rewardGold
    };
  }

  if (event.eventType === 'raid') {
    return {
      username: npcUsername(event.id, suffix),
      displayName: suffix === 'add_1' ? 'Frost Thrall' : 'Ice Gnawer',
      npcKind: 'raid_add',
      health: 10,
      stamina: 80,
      speed: 5,
      strength: 6,
      intelligence: 1,
      rewardExperience: 12,
      rewardGold: 3
    };
  }

  if (event.eventType === 'lesser') {
    return {
      username: npcUsername(event.id, 'brute'),
      displayName: 'Restless Brute',
      npcKind: 'lesser_hostile',
      health: 14,
      stamina: 80,
      speed: 4,
      strength: 8,
      intelligence: 1,
      rewardExperience: event.rewardExperience,
      rewardGold: event.rewardGold
    };
  }

  return {
    username: npcUsername(event.id, 'lurker'),
    displayName: 'Room Lurker',
    npcKind: 'ambient_hostile',
    health: 8,
    stamina: 60,
    speed: 3,
    strength: 4,
    intelligence: 1,
    rewardExperience: event.rewardExperience,
    rewardGold: event.rewardGold,
    respawnInterval: AMBIENT_HOSTILE_RESPAWN_INTERVAL
  };
}

function npcTemplatesForEvent(event) {
  if (event.eventType === 'raid') {
    return [
      npcTemplateFor(event, 'boss'),
      npcTemplateFor(event, 'add_1'),
      npcTemplateFor(event, 'add_2')
    ];
  }
  return [npcTemplateFor(event, 'hostile')];
}

export async function createNpcForEvent(db, npc) {
  await dbRun(
    db,
    `INSERT OR IGNORE INTO users
      (username, password, job, health, maxHealth, stamina, maxStamina, speed, strength, intelligence, level, gold,
       experience, isNpc, displayName, npcKind, worldEventId)
     VALUES (?, 'npc', 'Novice', ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 1, ?, ?, ?)`,
    [
      npc.username,
      npc.health,
      npc.health,
      npc.stamina ?? 100,
      npc.stamina ?? 100,
      npc.speed,
      npc.strength,
      npc.intelligence,
      npc.displayName,
      npc.npcKind,
      npc.worldEventId
    ]
  );
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
    [npc.username, npc.row, npc.col, await getCurrentTickValue(db), npc.worldDay ?? getWorldDay()]
  );
  await dbRun(
    db,
    `INSERT INTO worldEventEntities
      (eventId, username, entityKind, maxPopulation, respawnInterval, rewardExperience, rewardGold)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(username) DO UPDATE SET
      eventId = excluded.eventId,
      entityKind = excluded.entityKind,
      maxPopulation = excluded.maxPopulation,
      respawnInterval = excluded.respawnInterval,
      rewardExperience = excluded.rewardExperience,
      rewardGold = excluded.rewardGold`,
    [
      npc.worldEventId,
      npc.username,
      npc.npcKind,
      npc.maxPopulation ?? 1,
      npc.respawnInterval ?? 20,
      npc.rewardExperience ?? 0,
      npc.rewardGold ?? 0
    ]
  );
  return npc;
}

async function canSpawnEventNpc(db, npc, currentTick) {
  const liveNpc = await dbFirst(db, 'SELECT username FROM users WHERE username = ? AND isNpc = 1 AND health > 0', [npc.username]);
  if (liveNpc) {
    return false;
  }

  const entity = await dbFirst(db, 'SELECT lastDefeatedTick, respawnInterval FROM worldEventEntities WHERE username = ?', [npc.username]);
  if (!entity || entity.lastDefeatedTick === null || entity.lastDefeatedTick === undefined) {
    return true;
  }

  const respawnInterval = npc.respawnInterval ?? entity.respawnInterval ?? 20;
  return currentTick - entity.lastDefeatedTick >= respawnInterval;
}

async function spawnEventNpcs(db, event, currentTick) {
  const templates = npcTemplatesForEvent(event);
  for (const template of templates) {
    const npc = {
      ...template,
      worldEventId: event.id,
      worldDay: event.worldDay,
      row: event.roomRow,
      col: event.roomCol
    };
    if (await canSpawnEventNpc(db, npc, currentTick)) {
      await createNpcForEvent(db, npc);
    }
  }
}

async function expireStaleHostileEvents(db, worldDay, activeIds) {
  const activeIdSet = new Set(activeIds);
  const existingHostiles = await dbAll(
    db,
    `SELECT id
     FROM worldEvents
     WHERE worldDay = ?
       AND status = 'active'
       AND eventType = 'hostile'`,
    [worldDay]
  );
  const staleEvents = existingHostiles.filter(event => !activeIdSet.has(event.id));

  for (const event of staleEvents) {
    await dbRun(db, 'DELETE FROM roomPresence WHERE username IN (SELECT username FROM users WHERE isNpc = 1 AND worldEventId = ?)', [event.id]);
    await dbRun(db, 'DELETE FROM users WHERE isNpc = 1 AND worldEventId = ?', [event.id]);
    await dbRun(db, 'DELETE FROM worldEventEntities WHERE eventId = ?', [event.id]);
    await dbRun(db, 'UPDATE worldEvents SET status = ? WHERE id = ?', ['expired', event.id]);
  }
}

export async function ensureDailyWorldEvents(db, worldDay = getWorldDay(), createdTick = null) {
  const tickValue = createdTick ?? await getCurrentTickValue(db);
  const generatedEvents = generateDailyWorldEvents(worldDay);

  for (const event of generatedEvents) {
    await dbRun(
      db,
      `INSERT OR IGNORE INTO worldEvents
        (id, worldDay, eventType, roomRow, roomCol, status, title, description, rewardExperience, rewardGold, createdTick, expiresTick)
       VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)`,
      [
        event.id,
        worldDay,
        event.eventType,
        event.row,
        event.col,
        event.title,
        event.description,
        event.rewardExperience,
        event.rewardGold,
        tickValue,
        tickValue + 1440
      ]
    );
  }

  await expireStaleHostileEvents(db, worldDay, generatedEvents.map(event => event.id));

  const events = await dbAll(
    db,
    `SELECT *
     FROM worldEvents
     WHERE worldDay = ?
       AND status = 'active'
     ORDER BY eventType ASC, id ASC`,
    [worldDay]
  );

  for (const event of events) {
    await spawnEventNpcs(db, event, tickValue);
  }

  return {
    raid: events.find(event => event.eventType === 'raid'),
    lesser: events.find(event => event.eventType === 'lesser'),
    hostiles: events.filter(event => event.eventType === 'hostile'),
    events
  };
}

export async function getActiveRound(db, row, col, worldDay, tickValue) {
  const round = await dbFirst(
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

export async function getRoomEcology(db, username, row, col) {
  const worldDay = getWorldDay();
  const tickValue = await getCurrentTickValue(db);
  await cleanupOldWorldDayData(db, worldDay);
  await ensureDailyWorldEvents(db, worldDay, tickValue);
  const traces = await dbAll(
    db,
    `SELECT id, roomRow, roomCol, traceType, intensity, attacker, target, createdTick, expiryTick, worldDay, createdAt
     FROM roomTraces
     WHERE roomRow = ?
       AND roomCol = ?
       AND worldDay = ?
       AND (expiryTick IS NULL OR expiryTick >= ?)
     ORDER BY createdTick DESC, id DESC`,
    [row, col, worldDay, tickValue]
  );
  const phase = getPhaseFromTick(tickValue);
  const features = getRoomFeaturesForTick(row, col, tickValue, worldDay);
  const traceSummary = summarizeTraces(traces);
  const innAccess = await getRoomAccessState(db, username, row, col, tickValue, worldDay);
  const activeRound = await getActiveRound(db, row, col, worldDay, tickValue);
  const presence = await getRoomPresence(db, row, col, worldDay);
  const event = await getActiveRoomEvent(db, row, col, worldDay);
  const effectPayload = getRoomEffectPayload({ row, col, worldDay, features, innAccess, activeRound });

  return {
    room: { row, col },
    worldDay,
    nextResetAt: getNextResetAt().toISOString(),
    phase,
    features,
    traces,
    traceSummary,
    presence,
    event,
    description: composeRoomDescription({ row, col, phase, features, traceSummary }),
    ...effectPayload
  };
}

export async function insertMessage(db, row, col, username, message) {
  await dbRun(
    db,
    'INSERT INTO messages (roomRow, roomCol, username, message) VALUES (?, ?, ?, ?)',
    [row, col, username, message]
  );
}

export async function insertSystemMessage(db, row, col, message) {
  await insertMessage(db, row, col, 'System', message);
}

async function emitSystemMessage(db, row, col, message, deferredSystemMessages = null) {
  if (deferredSystemMessages) {
    deferredSystemMessages.push(message);
    return;
  }
  await insertSystemMessage(db, row, col, message);
}

export async function createTrace(db, trace) {
  await dbRun(
    db,
    `INSERT INTO roomTraces
      (roomRow, roomCol, traceType, intensity, attacker, target, createdTick, expiryTick, worldDay)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      trace.row,
      trace.col,
      trace.traceType,
      trace.intensity,
      trace.attacker,
      trace.target,
      trace.createdTick,
      trace.expiryTick,
      trace.worldDay
    ]
  );
}

export async function getMessages(db, row, col) {
  const rows = await dbAll(
    db,
    `SELECT id, username, message, timestamp
     FROM messages
     WHERE roomRow = ?
       AND roomCol = ?
     ORDER BY id ASC`,
    [row, col]
  );
  const usernames = [...new Set(rows.map(row => row.username).filter(username => username && username !== 'System'))];

  if (usernames.length === 0) {
    return rows.map(row => ({ ...row, job: null, statusEffects: [] }));
  }

  const placeholders = usernames.map(() => '?').join(', ');
  const users = await dbAll(db, `SELECT username, job FROM users WHERE username IN (${placeholders})`, usernames);
  const usersByName = new Map(users.map(user => [user.username, user]));
  const tickValue = await getCurrentTickValue(db);
  const effects = await dbAll(
    db,
    `SELECT username, effectType
     FROM statusEffects
     WHERE username IN (${placeholders})
       AND expiryTick > ?
     ORDER BY username ASC, expiryTick ASC, id ASC`,
    [...usernames, tickValue]
  );
  const effectsByName = effects.reduce((map, effect) => {
    if (!map.has(effect.username)) {
      map.set(effect.username, []);
    }
    if (!map.get(effect.username).includes(effect.effectType)) {
      map.get(effect.username).push(effect.effectType);
    }
    return map;
  }, new Map());

  return rows.map(row => ({
    ...row,
    job: usersByName.get(row.username)?.job || null,
    statusEffects: effectsByName.get(row.username) || []
  }));
}

export async function assertEnoughStamina(db, username, cost = 1) {
  const user = await dbFirst(db, 'SELECT stamina FROM users WHERE username = ?', [username]);
  if (!user || user.stamina < cost) {
    throw new ActionError('Not enough stamina.', 400);
  }
}

export async function spendStamina(db, username, cost = 1) {
  const result = await dbRun(
    db,
    'UPDATE users SET stamina = stamina - ? WHERE username = ? AND stamina >= ?',
    [cost, username, cost]
  );
  if (changes(result) === 0) {
    throw new ActionError('Not enough stamina.', 400);
  }
}

export async function runPlayerAction(db, { username, staminaCost = 1, validate, perform, advanceTick }) {
  await assertEnoughStamina(db, username, staminaCost);
  if (validate) {
    await validate();
  }
  await spendStamina(db, username, staminaCost);
  const result = await perform();
  const tick = advanceTick ? await advanceTick() : null;
  return { ...result, tick };
}

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

export async function moveUserToCemetery(db, username, cause, row, col, options = {}) {
  const user = await dbFirst(db, 'SELECT username, password, level, gold, job FROM users WHERE username = ?', [username]);
  if (!user) {
    return false;
  }

  await dbRun(
    db,
    `INSERT INTO cemetery
      (username, password, level, gold, job, cause, roomRow, roomCol, diedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
    [user.username, user.password || '', user.level || 0, user.gold || 0, user.job || 'Novice', cause, row, col]
  );
  await dbRun(db, 'DELETE FROM users WHERE username = ?', [username]);
  await dbRun(db, 'DELETE FROM roomPresence WHERE username = ?', [username]);
  await dbRun(db, 'DELETE FROM statusEffects WHERE username = ?', [username]);
  await emitSystemMessage(db, row, col, `${username} has died from ${cause}.`, options.deferredSystemMessages);
  return true;
}

function getKillerFromCause(cause) {
  const match = String(cause || '').match(/\bby\s+(.+)$/);
  return match ? match[1].trim() : null;
}

async function recordKill(db, {
  killer,
  defeatedUsername,
  defeatedName,
  defeatedKind,
  defeatedLevel,
  experienceGained = 0,
  goldGained = 0,
  row,
  col,
  currentTick
}) {
  if (!killer || !defeatedUsername || killer === defeatedUsername) {
    return;
  }

  const killerUser = await dbFirst(db, 'SELECT username, isNpc FROM users WHERE username = ?', [killer]);
  if (!killerUser || killerUser.isNpc) {
    return;
  }

  await dbRun(
    db,
    `INSERT INTO killHistory
      (killerUsername, defeatedUsername, defeatedName, defeatedKind, defeatedLevel, experienceGained, goldGained, roomRow, roomCol, worldDay, tick)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      killer,
      defeatedUsername,
      defeatedName || defeatedUsername,
      defeatedKind || 'player',
      defeatedLevel || 0,
      experienceGained || 0,
      goldGained || 0,
      row,
      col,
      getWorldDay(),
      currentTick ?? null
    ]
  );
}

async function moveUserToCemeteryFromRoomEffect(db, user, row, col, effectType, currentTick, worldDay) {
  const cause = effectType.replace(/_/g, ' ');
  await moveUserToCemetery(db, user.username, cause, row, col);
  await createTrace(db, {
    row,
    col,
    traceType: 'body',
    intensity: 3,
    attacker: cause,
    target: user.username,
    createdTick: currentTick,
    expiryTick: null,
    worldDay
  });
}

async function processUserEffect(db, presence, effect, currentTick, worldDay) {
  if (!PASSIVE_EFFECT_TYPES.has(effect.type)) {
    return false;
  }

  if (effect.type === 'inn') {
    const access = await getRoomAccessState(db, presence.username, presence.roomRow, presence.roomCol, currentTick, worldDay);
    if (!access.paid) {
      return false;
    }
  }

  const cooldown = await dbFirst(
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

  if (!shouldApplyEffect({
    currentTick,
    lastAppliedTick: cooldown ? cooldown.lastAppliedTick : null,
    interval: effect.interval || 5
  })) {
    return false;
  }

  await upsertCooldown(db, presence.username, presence.roomRow, presence.roomCol, effect.type, currentTick, worldDay);
  const phase = getPhaseFromTick(currentTick);
  const effective = getEffectiveUser(presence);
  const before = {
    username: presence.username,
    health: presence.health,
    maxHealth: effective.maxHealth,
    stamina: presence.stamina,
    maxStamina: effective.maxStamina
  };
  const after = applyPassiveEffectToUser(before, effect.type, phase);

  if (after.health <= 0 && before.health > 0) {
    await moveUserToCemeteryFromRoomEffect(db, presence, presence.roomRow, presence.roomCol, effect.type, currentTick, worldDay);
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
  const cooldown = await dbFirst(
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

  const recent = await dbFirst(
    db,
    `SELECT username, message
     FROM messages
     WHERE roomRow = ?
       AND roomCol = ?
       AND username != 'System'
     ORDER BY id DESC
     LIMIT 1`,
    [row, col]
  );

  if (!recent) {
    return;
  }

  const fragment = recent.message.length > 120
    ? `${recent.message.slice(0, 117)}...`
    : recent.message;
  await insertSystemMessage(db, row, col, `An echo repeats: ${fragment}`);
}

export async function processRoomEffects(db, currentTick) {
  const worldDay = getWorldDay();
  await cleanupOldWorldDayData(db, worldDay);

  const presences = await dbAll(
    db,
    `SELECT rp.username, rp.roomRow, rp.roomCol, rp.lastSeenTick,
            u.job, u.health, u.maxHealth, u.stamina, u.maxStamina, u.speed, u.strength, u.intelligence, u.level, u.gold
     FROM roomPresence rp
     JOIN users u ON u.username = rp.username
     WHERE rp.worldDay = ?
       AND u.isNpc = 0
       AND rp.lastSeenAt >= datetime('now', ?)`,
    [worldDay, `-${PRESENCE_MAX_AGE_SECONDS} seconds`]
  );
  const echoRooms = new Map();

  for (const presence of presences) {
    const effects = getActiveEffectsForRoom(presence.roomRow, presence.roomCol, currentTick, worldDay);

    for (const effect of effects) {
      if (effect.type === 'echo_chamber') {
        echoRooms.set(`${presence.roomRow}:${presence.roomCol}`, { row: presence.roomRow, col: presence.roomCol });
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

export async function resolveExpiredGamblingRounds(db, currentTick) {
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

async function awardEventVictory(db, event, row, col, currentTick, options = {}) {
  const presentPlayers = await dbAll(
    db,
    `SELECT rp.username
     FROM roomPresence rp
     JOIN users u ON u.username = rp.username
     WHERE rp.roomRow = ?
       AND rp.roomCol = ?
       AND rp.worldDay = ?
       AND rp.lastSeenAt >= datetime('now', ?)
       AND u.isNpc = 0`,
    [row, col, event.worldDay, `-${PRESENCE_MAX_AGE_SECONDS} seconds`]
  );

  for (const player of presentPlayers) {
    await awardExperience(db, player.username, event.rewardExperience || 0);
    await dbRun(db, 'UPDATE users SET gold = gold + ? WHERE username = ?', [event.rewardGold || 0, player.username]);
    await dbRun(
      db,
      `INSERT OR IGNORE INTO worldEventAchievements
        (username, eventId, achievementType, worldDay, earnedTick, rewardExperience, rewardGold)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        player.username,
        event.id,
        event.eventType === 'raid' ? 'raid_victory' : 'event_victory',
        event.worldDay,
        currentTick,
        event.rewardExperience || 0,
        event.rewardGold || 0
      ]
    );
  }

  await dbRun(
    db,
    'UPDATE worldEvents SET status = ?, completedTick = ? WHERE id = ?',
    ['completed', currentTick, event.id]
  );
  await emitSystemMessage(db, row, col, `${event.title} has been cleared.`, options.deferredSystemMessages);
}

async function defeatNpc(db, npc, { killer, row, col, currentTick, deferredSystemMessages = null }) {
  const entity = await dbFirst(db, 'SELECT rewardExperience, rewardGold FROM worldEventEntities WHERE username = ?', [npc.username]);
  const event = npc.worldEventId
    ? await dbFirst(db, 'SELECT * FROM worldEvents WHERE id = ?', [npc.worldEventId])
    : null;
  const eventVictoryExperience = event && (event.eventType === 'lesser' || (event.eventType === 'raid' && npc.npcKind === 'raid_boss'))
    ? event.rewardExperience || 0
    : 0;
  const eventVictoryGold = event && (event.eventType === 'lesser' || (event.eventType === 'raid' && npc.npcKind === 'raid_boss'))
    ? event.rewardGold || 0
    : 0;
  await recordKill(db, {
    killer,
    defeatedUsername: npc.username,
    defeatedName: npc.displayName || npc.username,
    defeatedKind: npc.npcKind || 'npc',
    defeatedLevel: npc.level || 0,
    experienceGained: eventVictoryExperience || (entity ? entity.rewardExperience : 0),
    goldGained: eventVictoryGold || (entity ? entity.rewardGold : 0),
    row,
    col,
    currentTick
  });

  await dbRun(db, 'DELETE FROM users WHERE username = ? AND isNpc = 1', [npc.username]);
  await dbRun(db, 'DELETE FROM roomPresence WHERE username = ?', [npc.username]);
  await dbRun(db, 'DELETE FROM statusEffects WHERE username = ?', [npc.username]);
  await dbRun(db, 'UPDATE worldEventEntities SET lastDefeatedTick = ? WHERE username = ?', [currentTick, npc.username]);
  await emitSystemMessage(db, row, col, `${npc.displayName || npc.username} is defeated by ${killer}.`, deferredSystemMessages);

  if (event && ['raid', 'lesser'].includes(event.eventType) && npc.npcKind === 'raid_boss') {
    await awardEventVictory(db, event, row, col, currentTick, { deferredSystemMessages });
    return;
  }

  if (event && event.eventType === 'lesser') {
    await awardEventVictory(db, event, row, col, currentTick, { deferredSystemMessages });
    return;
  }

  if (killer && entity) {
    await awardExperience(db, killer, entity.rewardExperience || 0);
    await dbRun(db, 'UPDATE users SET gold = gold + ? WHERE username = ?', [entity.rewardGold || 0, killer]);
  }
}

async function damageUser(db, username, amount, cause, row, col) {
  const target = await getUser(db, username, 'Target');
  const nextHealth = Math.max(0, target.health - amount);
  await dbRun(db, 'UPDATE users SET health = ? WHERE username = ?', [nextHealth, username]);

  if (nextHealth <= 0 && target.health > 0) {
    if (target.isNpc) {
      await defeatNpc(db, target, { killer: cause.replace(/.* by /, ''), row, col, currentTick: await getCurrentTickValue(db) });
      return { killed: true, remainingHealth: 0 };
    }
    await recordKill(db, {
      killer: getKillerFromCause(cause),
      defeatedUsername: target.username,
      defeatedName: target.username,
      defeatedKind: 'player',
      defeatedLevel: target.level || 0,
      row,
      col,
      currentTick: await getCurrentTickValue(db)
    });
    await moveUserToCemetery(db, username, cause, row, col);
    return { killed: true, remainingHealth: 0 };
  }

  return { killed: false, remainingHealth: nextHealth };
}

async function healUser(db, username, amount) {
  const user = await getUser(db, username, 'Target');
  const effective = getEffectiveUser(user);
  const nextHealth = Math.min(effective.maxHealth, user.health + amount);
  await dbRun(db, 'UPDATE users SET health = ? WHERE username = ?', [nextHealth, username]);
  return nextHealth;
}

async function drainStamina(db, username, amount) {
  const user = await getUser(db, username, 'Target');
  const nextStamina = Math.max(0, user.stamina - amount);
  await dbRun(db, 'UPDATE users SET stamina = ? WHERE username = ?', [nextStamina, username]);
  return nextStamina;
}

export async function addStatusEffect(db, {
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

async function clearOneHarmfulEffect(db, username) {
  const placeholders = [...HARMFUL_EFFECTS].map(() => '?').join(', ');
  const effect = await dbFirst(
    db,
    `SELECT id
     FROM statusEffects
     WHERE username = ?
       AND effectType IN (${placeholders})
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

export async function processStatusEffects(db, currentTick) {
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
    const stillExists = await dbFirst(db, 'SELECT username FROM users WHERE username = ?', [effect.username]);
    if (!stillExists) {
      continue;
    }

    if (effect.effectType === 'poison') {
      const cause = effect.sourceUsername ? `dose by ${effect.sourceUsername}` : 'poison';
      await damageUser(db, effect.username, effect.magnitude || 1, cause, effect.roomRow, effect.roomCol);
    } else if (effect.effectType === 'arcane_pin') {
      await drainStamina(db, effect.username, effect.magnitude || 1);
    } else if (effect.effectType === 'bless') {
      await healUser(db, effect.username, effect.magnitude || 1);
    }
  }

  await dbRun(db, 'DELETE FROM statusEffects WHERE expiryTick <= ?', [currentTick]);
}

export async function advanceGlobalTick(db) {
  await dbRun(db, 'UPDATE tick SET value = value + 1 WHERE id = 1');
  const tickValue = await getCurrentTickValue(db);

  if (tickValue % 3 === 0) {
    await recoverStaminaForAllUsers(db);
  }

  await processRoomEffects(db, tickValue);
  await processStatusEffects(db, tickValue);
  await resolveExpiredGamblingRounds(db, tickValue);
  await ensureDailyWorldEvents(db, getWorldDay(), tickValue);

  return {
    tick: tickValue,
    staminaUpdated: tickValue % 3 === 0
  };
}

export async function runScheduledWorldPulse(db) {
  const tick = await advanceGlobalTick(db);

  return {
    tick,
    environmental: tick.tick % 5 === 0
  };
}

export async function getActiveWorldEvents(db, worldDay = getWorldDay()) {
  await ensureDailyWorldEvents(db, worldDay);
  return dbAll(
    db,
    `SELECT id, eventType, roomRow AS row, roomCol AS col, status, title, description, rewardExperience, rewardGold
     FROM worldEvents
     WHERE worldDay = ?
       AND status = 'active'
       AND eventType IN ('raid', 'lesser')
     ORDER BY CASE eventType WHEN 'raid' THEN 0 ELSE 1 END, id ASC`,
    [worldDay]
  );
}

export async function roomHasActiveHostiles(db, row, col) {
  const worldDay = getWorldDay();
  const hostiles = await dbFirst(
    db,
    `SELECT u.username
     FROM users u
     JOIN roomPresence rp ON rp.username = u.username
     WHERE u.isNpc = 1
       AND u.health > 0
       AND rp.roomRow = ?
       AND rp.roomCol = ?
       AND rp.worldDay = ?
     LIMIT 1`,
    [row, col, worldDay]
  );
  const players = await dbFirst(
    db,
    `SELECT u.username
     FROM users u
     JOIN roomPresence rp ON rp.username = u.username
     WHERE u.isNpc = 0
       AND u.health > 0
       AND rp.roomRow = ?
       AND rp.roomCol = ?
       AND rp.worldDay = ?
       AND rp.lastSeenAt >= datetime('now', ?)
     LIMIT 1`,
    [row, col, worldDay, `-${PRESENCE_MAX_AGE_SECONDS} seconds`]
  );
  return Boolean(hostiles && players);
}

export async function runHostileRoomAction(db, row, col) {
  const tick = await advanceGlobalTick(db);
  const worldDay = getWorldDay();
  const npc = await dbFirst(
    db,
    `SELECT u.*
     FROM users u
     JOIN roomPresence rp ON rp.username = u.username
     WHERE u.isNpc = 1
       AND u.health > 0
       AND rp.roomRow = ?
       AND rp.roomCol = ?
       AND rp.worldDay = ?
     ORDER BY CASE u.npcKind WHEN 'raid_boss' THEN 0 ELSE 1 END, u.username ASC
     LIMIT 1`,
    [row, col, worldDay]
  );
  const player = await dbFirst(
    db,
    `SELECT u.*
     FROM users u
     JOIN roomPresence rp ON rp.username = u.username
     WHERE u.isNpc = 0
       AND u.health > 0
       AND rp.roomRow = ?
       AND rp.roomCol = ?
       AND rp.worldDay = ?
       AND rp.lastSeenAt >= datetime('now', ?)
     ORDER BY rp.lastSeenAt DESC, u.username ASC
     LIMIT 1`,
    [row, col, worldDay, `-${PRESENCE_MAX_AGE_SECONDS} seconds`]
  );

  if (!npc || !player) {
    return { tick, acted: false };
  }

  const contest = rollSpeedContest(npc, player);
  if (!contest.hit) {
    await insertSystemMessage(db, row, col, `${player.username} dodged ${npc.displayName || npc.username}.`);
    return { tick, acted: true, missed: true };
  }

  const { damage, isCriticalAttack } = await calculateAttackDamage(db, npc, player.username, tick.tick);
  await dbRun(
    db,
    'UPDATE users SET health = MAX(health - ?, 0) WHERE username = ? AND health > 0',
    [damage, player.username]
  );
  const after = await dbFirst(db, 'SELECT * FROM users WHERE username = ?', [player.username]);
  const hitText = isCriticalAttack ? 'critically hits' : 'attacks';
  await insertSystemMessage(db, row, col, `${npc.displayName || npc.username} ${hitText} ${player.username} for ${damage} damage.`);

  if (after && after.health <= 0) {
    await moveUserToCemetery(db, player.username, `attack by ${npc.username}`, row, col);
  }

  return { tick, acted: true, target: player.username, damage };
}

async function awardGoldMaybe(db, username) {
  if (Math.random() < 0.1) {
    const goldAmount = Math.floor(Math.random() * 3) + 1;
    await dbRun(db, 'UPDATE users SET gold = gold + ? WHERE username = ?', [goldAmount, username]);
    return goldAmount;
  }
  return 0;
}

async function updateLevel(db, username, row, col) {
  const result = await awardExperience(db, username, PLAYER_ACTION_EXPERIENCE);

  if (result.leveled) {
    await insertSystemMessage(db, row, col, `${username} reached level ${result.level} and gained 10 attribute points.`);
  }
}

async function awardExperience(db, username, amount) {
  const user = await dbFirst(db, 'SELECT experience, level, isNpc FROM users WHERE username = ?', [username]);
  if (!user || user.isNpc) {
    return { experience: 0, level: 0, leveled: false };
  }

  const nextExperience = (user.experience || 0) + amount;
  const nextLevel = calculateLevel(nextExperience, BASE_EXPERIENCE_REQUIRED);
  const levelDelta = Math.max(0, nextLevel - user.level);
  if (levelDelta > 0) {
    await dbRun(
      db,
      'UPDATE users SET experience = ?, level = ?, attributePoints = attributePoints + ? WHERE username = ?',
      [nextExperience, nextLevel, levelDelta * 10, username]
    );
  } else {
    await dbRun(db, 'UPDATE users SET experience = ? WHERE username = ?', [nextExperience, username]);
  }

  return { experience: nextExperience, level: nextLevel, leveled: levelDelta > 0 };
}

function parseRollCommand(message) {
  const match = message.trim().match(/^\/roll\s+(\d+)$/i);
  return match ? Number.parseInt(match[1], 10) : null;
}

export async function validateRollCommand(db, username, row, col, message) {
  const wager = parseRollCommand(message);
  if (!wager || wager < 1) {
    throw new ActionError('Use /roll <gold> with a positive wager.');
  }

  const worldDay = getWorldDay();
  const tickValue = await getCurrentTickValue(db);
  assertAction(roomHasEffect(row, col, tickValue, 'gambling_den', worldDay), '/roll can only be used in a gambling den.');

  const user = await getUser(db, username);
  assertAction(user.gold >= wager, 'Not enough gold for that wager.');

  const existingRound = await dbFirst(
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
    ? await dbFirst(db, 'SELECT id FROM gamblingEntries WHERE roundId = ? AND username = ?', [existingRound.id, username])
    : null;

  assertAction(!existingEntry, 'You have already entered this dice round.');
  return { wager, tickValue, worldDay };
}

export async function handleRollCommand(db, username, row, col, message) {
  const { wager, tickValue, worldDay } = await validateRollCommand(db, username, row, col, message);
  await resolveExpiredGamblingRounds(db, tickValue);
  let round = await dbFirst(
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
      id: lastInsertId(created),
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
  assertAction(changes(goldUpdate) > 0, 'Not enough gold for that wager.');

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

async function consumeStatusModifier(db, targetUsername, effectType, currentTick) {
  const effect = await dbFirst(
    db,
    `SELECT id, magnitude
     FROM statusEffects
     WHERE username = ?
       AND effectType = ?
       AND expiryTick > ?
     ORDER BY expiryTick ASC, id ASC
     LIMIT 1`,
    [targetUsername, effectType, currentTick]
  );

  if (!effect) {
    return 0;
  }

  await dbRun(db, 'DELETE FROM statusEffects WHERE id = ?', [effect.id]);
  return effect.magnitude || 0;
}

async function calculateAttackDamage(db, attacker, targetUsername, currentTick) {
  const effectiveAttacker = getEffectiveUser(attacker);
  const isCriticalAttack = Math.random() < 0.01;
  const markedBonus = await consumeStatusModifier(db, targetUsername, 'marked', currentTick);
  const wardReduction = await consumeStatusModifier(db, targetUsername, 'ward', currentTick);
  const baseDamage = 1 + Math.floor(effectiveAttacker.strength / 4);
  const criticalDamage = isCriticalAttack ? baseDamage + 1 : baseDamage;
  const damage = Math.max(0, criticalDamage + markedBonus - wardReduction);

  return { damage, isCriticalAttack };
}

export async function validateAttackTargets(db, message) {
  const users = await dbAll(db, 'SELECT username FROM users');
  const targets = users.filter(user => message.includes(user.username));
  if (targets.length === 0) {
    throw new ActionError('Attack needs a target name.');
  }
  return targets;
}

export async function handleAttack(db, username, message, row, col, options = {}) {
  const currentTick = await getCurrentTickValue(db);
  const createdTick = currentTick + 1;
  const worldDay = getWorldDay();
  const attacker = await getUser(db, username);
  const targets = await validateAttackTargets(db, message);
  const attackMessages = [];

  await cleanupOldWorldDayData(db, worldDay);

  for (const user of targets) {
    const target = await getUser(db, user.username, 'Target');
    const speedContest = rollSpeedContest(attacker, target);
    if (!speedContest.hit) {
      attackMessages.push(`${user.username} dodged ${username}'s attack`);
      continue;
    }

    const { damage, isCriticalAttack } = await calculateAttackDamage(db, attacker, user.username, createdTick);
    await dbRun(
      db,
      'UPDATE users SET health = MAX(health - ?, 0) WHERE username = ? AND health > 0',
      [damage, user.username]
    );

    const attackedUser = await dbFirst(db, 'SELECT * FROM users WHERE username = ?', [user.username]);
    const remainingHealth = attackedUser ? attackedUser.health : 0;
    const wasKilled = Boolean(attackedUser && attackedUser.health <= 0);
    const attackMessage = isCriticalAttack
      ? `${username} landed a critical hit on ${user.username} for ${damage} damage!`
      : `${username} attacked ${user.username} for ${damage} damage`;

    attackMessages.push(attackMessage);

    const trace = getAttackTrace({
      row,
      col,
      attacker: username,
      target: user.username,
      damage,
      isCritical: isCriticalAttack,
      remainingHealth,
      wasKilled,
      createdTick,
      worldDay
    });

    if (wasKilled && attackedUser.isNpc) {
      await defeatNpc(db, attackedUser, {
        killer: username,
        row,
        col,
        currentTick: createdTick,
        deferredSystemMessages: options.deferredSystemMessages
      });
    } else if (wasKilled) {
      await recordKill(db, {
        killer: username,
        defeatedUsername: attackedUser.username,
        defeatedName: attackedUser.username,
        defeatedKind: 'player',
        defeatedLevel: attackedUser.level || 0,
        row,
        col,
        currentTick: createdTick
      });
      await moveUserToCemetery(db, user.username, `attack by ${username}`, row, col, {
        deferredSystemMessages: options.deferredSystemMessages
      });
    }

    await createTrace(db, trace);
  }

  return `${message} (${attackMessages.join(', ')})`;
}

function getSkillTarget(invoker, targetUsername) {
  return targetUsername && targetUsername.trim() ? targetUsername.trim() : invoker;
}

export async function validateClassSkillUse(db, { username, skillId, targetUsername }) {
  const actor = await getUser(db, username);
  const effectiveActor = getEffectiveUser(actor);
  const actorSkill = getSkillForJob(effectiveActor.job);

  if (skillId !== actorSkill.id) {
    throw new ActionError(`${effectiveActor.job} cannot use that skill.`);
  }

  const target = getSkillTarget(username, targetUsername);
  if (skillId !== 'scrounge' && target) {
    await getUser(db, target, 'Target');
  }

  return { actor, effectiveActor, target };
}

async function tryHarmfulSkillHit(db, { effectiveActor, target, skillLabel, row, col }) {
  const targetUser = await getUser(db, target, 'Target');
  const speedContest = rollSpeedContest(effectiveActor, targetUser);
  if (speedContest.hit) {
    return true;
  }

  const message = `${target} dodged ${effectiveActor.username}'s ${skillLabel}.`;
  await insertSystemMessage(db, row, col, message);
  return false;
}

export async function useClassSkill(db, { username, skillId, targetUsername, row, col, currentTick, phase }) {
  const { effectiveActor, target } = await validateClassSkillUse(db, { username, skillId, targetUsername });

  switch (skillId) {
    case 'scrounge': {
      const gold = 1 + Math.max(1, Math.floor(effectiveActor.intelligence / 2));
      await dbRun(db, 'UPDATE users SET gold = gold + ? WHERE username = ?', [gold, username]);
      const message = `${username} scrounges up ${gold} gold.`;
      await insertSystemMessage(db, row, col, message);
      return { message };
    }
    case 'ward': {
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
      const hit = await tryHarmfulSkillHit(db, {
        effectiveActor,
        target,
        skillLabel: 'Power Strike',
        row,
        col
      });
      if (!hit) {
        return { message: `${target} dodged ${username}'s Power Strike.`, missed: true };
      }

      const marked = await dbFirst(
        db,
        'SELECT id, magnitude FROM statusEffects WHERE username = ? AND effectType = ? AND expiryTick > ? ORDER BY expiryTick ASC LIMIT 1',
        [target, 'marked', currentTick]
      );
      const ward = await dbFirst(
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
        ? await damageUser(db, target, damage, `power strike by ${username}`, row, col)
        : { killed: false, remainingHealth: null };
      const message = `${username} power strikes ${target} for ${damage} damage.`;
      await insertSystemMessage(db, row, col, message);
      return { message, damage, ...result };
    }
    case 'dose': {
      if (phase === 'Night') {
        const hit = await tryHarmfulSkillHit(db, {
          effectiveActor,
          target,
          skillLabel: 'Dose',
          row,
          col
        });
        if (!hit) {
          return { message: `${target} dodged ${username}'s Dose.`, missed: true };
        }

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
      await createTrace(db, {
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
      const hit = await tryHarmfulSkillHit(db, {
        effectiveActor,
        target,
        skillLabel: 'Arcane Pin',
        row,
        col
      });
      if (!hit) {
        return { message: `${target} dodged ${username}'s Arcane Pin.`, missed: true };
      }

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
      const hit = await tryHarmfulSkillHit(db, {
        effectiveActor,
        target,
        skillLabel: 'Mark',
        row,
        col
      });
      if (!hit) {
        return { message: `${target} dodged ${username}'s Mark.`, missed: true };
      }

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
      throw new ActionError('Unknown skill.');
  }
}

export async function switchJob(db, { username, nextJob, row, col }) {
  if (!Object.prototype.hasOwnProperty.call(JOBS, nextJob)) {
    throw new ActionError('Invalid job.');
  }

  const user = await getUser(db, username);
  const nextEffective = getEffectiveUser({ ...user, job: nextJob });
  const nextHealth = Math.min(user.health, nextEffective.maxHealth);
  const nextStamina = Math.min(user.stamina, nextEffective.maxStamina);

  await dbRun(
    db,
    'UPDATE users SET job = ?, health = ?, stamina = ? WHERE username = ?',
    [nextJob, nextHealth, nextStamina, username]
  );

  const message = `${username} changes job to ${nextJob}.`;
  await insertSystemMessage(db, row, col, message);
  return { message, job: nextJob };
}

export async function handleChatAction(db, username, row, col, message) {
  if (message.trim().toLowerCase().startsWith('/roll')) {
    return runPlayerAction(db, {
      username,
      staminaCost: 1,
      validate: async () => validateRollCommand(db, username, row, col, message),
      perform: async () => handleRollCommand(db, username, row, col, message),
      advanceTick: () => advanceGlobalTick(db)
    });
  }

  return runPlayerAction(db, {
    username,
    staminaCost: 1,
    perform: async () => {
      await insertMessage(db, row, col, username, message);
      await awardGoldMaybe(db, username);
      await updateLevel(db, username, row, col);
      return { message };
    },
    advanceTick: () => advanceGlobalTick(db)
  });
}

export async function handleAttackAction(db, username, row, col, message) {
  return runPlayerAction(db, {
    username,
    staminaCost: 1,
    validate: async () => validateAttackTargets(db, message),
    perform: async () => {
      const deferredSystemMessages = [];
      const updatedMessage = await handleAttack(db, username, message, row, col, { deferredSystemMessages });
      await insertMessage(db, row, col, username, updatedMessage);
      for (const systemMessage of deferredSystemMessages) {
        await insertSystemMessage(db, row, col, systemMessage);
      }
      await awardGoldMaybe(db, username);
      await updateLevel(db, username, row, col);
      return { updatedMessage };
    },
    advanceTick: () => advanceGlobalTick(db)
  });
}

export async function handleSkillAction(db, username, row, col, skillId, targetUsername, actionTick) {
  return runPlayerAction(db, {
    username,
    staminaCost: 1,
    validate: async () => validateClassSkillUse(db, { username, skillId, targetUsername }),
    perform: async () => useClassSkill(db, {
      username,
      skillId,
      targetUsername,
      row,
      col,
      currentTick: actionTick,
      phase: getPhaseFromTick(actionTick)
    }),
    advanceTick: () => advanceGlobalTick(db)
  });
}

export async function handleJobChangeAction(db, username, row, col, nextJob, roomUse) {
  return runPlayerAction(db, {
    username,
    staminaCost: 1,
    validate: async () => {
      if (!roomHasEffect(row, col, roomUse.tickValue, 'guild', roomUse.worldDay)) {
        throw new ActionError('Job changes require a Guild room.', 403);
      }
      if (!Object.prototype.hasOwnProperty.call(JOBS, nextJob)) {
        throw new ActionError('Invalid job.');
      }
    },
    perform: async () => switchJob(db, { username, nextJob, row, col }),
    advanceTick: () => advanceGlobalTick(db)
  });
}
