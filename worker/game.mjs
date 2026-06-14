import jobsModule from '../utils/jobs.js';
import ecologyModule from '../utils/roomEcology.js';
import levelingModule from '../utils/leveling.js';
import worldEventsModule from '../utils/worldEvents.js';
import bodyModule from '../utils/body.js';
import itemsModule from '../utils/items.js';
import abilitiesModule from '../utils/abilities.js';
import progressionModule from '../utils/progressionGrid.js';
import { changes, dbAll, dbFirst, dbRun, lastInsertId } from './db.mjs';
import { elapsedMs, logEvent, measureAsync, nowMs } from './observability.mjs';

const {
  JOBS,
  normalizeJob,
  validateStartingAllocation,
  buildStartingStats,
  getEffectiveUser
} = jobsModule;

const {
  getAbility,
  getInnateAbilityIds,
  resolveAbilityStaminaCost
} = abilitiesModule;

const {
  getDailyBoard,
  getNode: getGridNode,
  getEntryNodeIds: getGridEntryNodeIds
} = progressionModule;

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

const {
  SIGNATURE_ITEMS_BY_JOB,
  getTemplate,
  rollNpcDrop
} = itemsModule;

const {
  HUMANOID_PLAN,
  MODIFIER_KEYS,
  distributeAcrossPlan,
  partCondition,
  bodyPenaltyModifiers,
  emptyModifiers,
  pickTargetPart,
  STANCES,
  DEFAULT_STANCE,
  normalizeStance,
  parseCalledShot,
  CALLED_SHOT_HIT_PENALTY,
  CALLED_SHOT_HEAD_BONUS
} = bodyModule;

const PRESENCE_MAX_AGE_SECONDS = 45;
const ROOM_MESSAGE_HISTORY_LIMIT = 100;
const BASE_EXPERIENCE_REQUIRED = 100;
const PLAYER_ACTION_EXPERIENCE = 1;
const INN_ACCESS_TYPE = 'inn';
const SPEED_HIT_BASE_CHANCE = 0.7;
const SPEED_HIT_STEP = 0.05;
const SPEED_HIT_MIN_CHANCE = 0.25;
const SPEED_HIT_MAX_CHANCE = 0.95;
// Regrowth (plan 006): the inn's dark miracle restores one severed part per day.
const REGROW_GOLD_COST = 25;
const REGROW_STAMINA_COST = 20;
const REGROW_EFFECT_TYPE = 'regrow';
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
  SIGNATURE_ITEMS_BY_JOB,
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

export function calculateSpeedHitChance(attacker, target, attackerMods = null, targetMods = null, { hitDelta = 0, dodgeDelta = 0 } = {}) {
  const effectiveAttacker = getEffectiveUser(attacker, attackerMods);
  const effectiveTarget = getEffectiveUser(target, targetMods);
  const speedDifference = effectiveAttacker.speed - effectiveTarget.speed;
  // hitDelta raises the attacker's chance; dodgeDelta lowers it (the defender
  // is harder to hit). Both fold in before the [0.25, 0.95] clamp. With both
  // deltas at 0 (the default — standing stance, no called shot) the result is
  // byte-identical to the original curve.
  const hitChance = clampNumber(
    SPEED_HIT_BASE_CHANCE + speedDifference * SPEED_HIT_STEP + hitDelta - dodgeDelta,
    SPEED_HIT_MIN_CHANCE,
    SPEED_HIT_MAX_CHANCE
  );

  return Math.round(hitChance * 100) / 100;
}

function rollSpeedContest(attacker, target, attackerMods = null, targetMods = null, options = {}) {
  const hitChance = calculateSpeedHitChance(attacker, target, attackerMods, targetMods, options);
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

// The player's position for the day — their single roomPresence row (PK is
// (username, worldDay), so there is at most one). Null before their first
// placement of the day.
export async function getCurrentPosition(db, username, worldDay = getWorldDay()) {
  return dbFirst(
    db,
    'SELECT roomRow AS row, roomCol AS col FROM roomPresence WHERE username = ? AND worldDay = ?',
    [username, worldDay]
  );
}

// Adjacency rule (plan 009): the first placement of the world day is free (spawn
// anywhere); after that you may only enter a room within Chebyshev distance 1
// (including diagonals) of where you last stood. A new world day resets position
// (presence is keyed by worldDay), so movement frees up again each day. Staleness
// is ignored on purpose — your body stays where you left it even if you go AFK.
export async function validateMovement(db, username, row, col) {
  const position = await getCurrentPosition(db, username);
  if (!position) {
    return { allowed: true, first: true };
  }
  const distance = Math.max(Math.abs(position.row - row), Math.abs(position.col - col));
  if (distance <= 1) {
    return { allowed: true, from: position };
  }
  return { allowed: false, from: position };
}

export async function requireRoomUse(db, username, row, col) {
  // Movement is the first gate and the single choke point — covers POST
  // /room-presence (the move) and every action route, so acting in a room you
  // couldn't have walked to is rejected too. The throw flows through the route
  // try/catch -> formError; the inn path below keeps returning its structured
  // object so the pay-to-enter flow still renders.
  const movement = await validateMovement(db, username, row, col);
  if (!movement.allowed) {
    throw new ActionError('Too far to walk there.', 403);
  }

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
  const goldUpdate = await dbRun(
    db,
    'UPDATE users SET gold = gold - ? WHERE username = ? AND gold >= ?',
    [currentAccess.fee, username, currentAccess.fee]
  );
  assertAction(changes(goldUpdate) > 0, 'Not enough gold', 402);

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
  await dbRun(db, 'DELETE FROM sessions WHERE expiresAt <= CURRENT_TIMESTAMP');
  await dbRun(db, "DELETE FROM messages WHERE timestamp < datetime('now', '-7 days')");
  await reconcileBodyHealthInvariant(db);
}

// Self-healing reconcile: for any live non-NPC user with body rows where
// users.health != Σ bodyParts.hp, set users.health to the sum. The invariant
// is the contract; this only catches drift, never masks a bypassed chokepoint.
async function reconcileBodyHealthInvariant(db) {
  const drifted = await dbAll(
    db,
    `SELECT u.username AS username, u.health AS health, SUM(bp.hp) AS bodySum
     FROM users u
     JOIN bodyParts bp ON bp.username = u.username
     WHERE u.isNpc = 0
       AND u.username != 'System'
     GROUP BY u.username
     HAVING u.health != SUM(bp.hp)`
  );
  for (const row of drifted) {
    const bodySum = Math.max(0, Math.floor(row.bodySum || 0));
    await dbRun(db, 'UPDATE users SET health = ? WHERE username = ?', [bodySum, row.username]);
    logEvent({
      event: 'body.reconcile',
      username: row.username,
      previousHealth: row.health,
      reconciledHealth: bodySum
    });
  }
}

export async function updatePresence(db, username, row, col) {
  const worldDay = getWorldDay();
  const tickValue = await getCurrentTickValue(db);
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

export async function getRoomEcology(db, username, row, col, worldDay = getWorldDay(), tickValue = null) {
  const currentTick = tickValue === null ? await getCurrentTickValue(db) : tickValue;
  const phase = getPhaseFromTick(currentTick);
  const features = getRoomFeaturesForTick(row, col, currentTick, worldDay);
  const [traces, innAccess, activeRound, presence, event, groundItems] = await Promise.all([
    dbAll(
      db,
      `SELECT id, roomRow, roomCol, traceType, intensity, attacker, target, createdTick, expiryTick, worldDay, createdAt
       FROM roomTraces
       WHERE roomRow = ?
         AND roomCol = ?
         AND worldDay = ?
         AND (expiryTick IS NULL OR expiryTick >= ?)
       ORDER BY createdTick DESC, id DESC`,
      [row, col, worldDay, currentTick]
    ),
    getRoomAccessState(db, username, row, col, currentTick, worldDay),
    getActiveRound(db, row, col, worldDay, currentTick),
    getRoomPresence(db, row, col, worldDay),
    getActiveRoomEvent(db, row, col, worldDay),
    getFloorItems(db, row, col)
  ]);
  const traceSummary = summarizeTraces(traces);
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
    groundItems,
    description: composeRoomDescription({ row, col, phase, features, traceSummary }),
    ...effectPayload
  };
}

export async function getUserState(db, username) {
  const user = await dbFirst(
    db,
    'SELECT username, job, health, maxHealth, stamina, maxStamina, speed, strength, intelligence, level, gold, experience, attributePoints, skillPoints, displayName, stance FROM users WHERE username = ? AND isNpc = 0',
    [username]
  );
  if (!user) {
    throw new ActionError('User Not Found', 404);
  }

  await ensureBody(db, user);
  const bodyParts = await getBodyParts(db, username);
  const gearBonuses = await getEquippedModifiers(db, username);
  const combinedModifiers = await getConditionAndGearModifiers(db, username);
  const effective = getEffectiveUser(user, combinedModifiers);
  const body = bodyParts.map(part => ({
    label: part.label,
    partType: part.partType,
    slotType: part.slotType,
    condition: partCondition(part),
    vital: Boolean(part.vital)
  }));
  const inventoryRows = await getInventory(db, username);
  // Carried items only (equipped items show up under `equipment`).
  const inventory = inventoryRows
    .filter(row => row.equippedPartId === null || row.equippedPartId === undefined)
    .map(row => ({
      name: row.name,
      slotType: row.slotType,
      rarity: row.rarity,
      modifiers: parseItemModifiers(row.modifiers)
    }));
  // Equipment keyed by part label: one entry per non-severed part, empty or filled.
  const equippedByPartId = new Map(
    inventoryRows
      .filter(row => row.equippedPartId !== null && row.equippedPartId !== undefined)
      .map(row => [row.equippedPartId, row])
  );
  const equipment = {};
  for (const part of bodyParts) {
    if (part.severed) {
      continue;
    }
    const equipped = equippedByPartId.get(part.id);
    equipment[part.label] = equipped ? equipped.name : null;
  }
  // Structural HP from worn armor (plan 015): the on-part maxHealth bonus is
  // folded into maxHealth, never into the effective modifier layer, so surface
  // it separately for the character sheet to annotate Health with "(+N armor)".
  let gearHealthBonus = 0;
  for (const equipped of equippedByPartId.values()) {
    gearHealthBonus += Number(parseItemModifiers(equipped.modifiers).maxHealth || 0);
  }
  // Plan 018c: merge item-granted active abilities into the innate kit for the
  // hotbar, deduped by id (a class may already own a granted ability).
  const grantedActives = (await getGrantedAbilityIds(db, username))
    .map(getAbility)
    .filter(ability => ability && ability.kind === 'active');
  const hotbarSkills = [...(effective.skills || [])];
  for (const ability of grantedActives) {
    if (!hotbarSkills.some(skill => skill.id === ability.id)) {
      hotbarSkills.push(ability);
    }
  }
  const [achievements, kills] = await Promise.all([
    dbAll(
      db,
      `SELECT achievementType, eventId, worldDay, earnedTick, rewardExperience, rewardGold
       FROM worldEventAchievements
       WHERE username = ?
       ORDER BY earnedTick DESC, id DESC`,
      [username]
    ),
    dbAll(
      db,
      `SELECT defeatedUsername, defeatedName, defeatedKind, defeatedLevel, experienceGained, goldGained, roomRow, roomCol, worldDay, tick, createdAt
       FROM killHistory
       WHERE killerUsername = ?
       ORDER BY id DESC
       LIMIT 50`,
      [username]
    )
  ]);

  // The player's current room (latest presence this world-day). The character
  // page uses it to route /equip, /unequip, /drop — which are tick-advancing,
  // stamina-costing chat commands, not silent endpoints — to the room the player
  // is in. Null when they aren't in a room (e.g. viewing from the world map).
  const presence = await dbFirst(
    db,
    `SELECT roomRow, roomCol FROM roomPresence
     WHERE username = ? AND worldDay = ?
     ORDER BY lastSeenAt DESC LIMIT 1`,
    [username, getWorldDay()]
  );
  const currentRoom = presence ? { row: presence.roomRow, col: presence.roomCol } : null;

  return {
    ...user,
    job: effective.job,
    baseStats: effective.baseStats,
    jobBonuses: effective.jobBonuses,
    bonusModifiers: effective.bonusModifiers,
    effectiveStats: {
      health: effective.health,
      maxHealth: effective.maxHealth,
      stamina: effective.stamina,
      maxStamina: effective.maxStamina,
      speed: effective.speed,
      strength: effective.strength,
      intelligence: effective.intelligence
    },
    body,
    inventory,
    equipment,
    gearBonuses,
    gearHealthBonus,
    currentRoom,
    skill: effective.skill,
    skills: hotbarSkills,
    passives: effective.passives,
    achievements,
    kills
  };
}

export async function getRoomState(db, username, row, col, tickValue = null) {
  const stateStart = nowMs();
  const worldDay = getWorldDay();
  const tick = tickValue === null ? await getCurrentTickValue(db) : tickValue;
  const [roomResult, messagesResult, userResult] = await Promise.all([
    measureAsync(() => getRoomEcology(db, username, row, col, worldDay, tick)),
    measureAsync(() => getMessages(db, row, col, tick)),
    measureAsync(() => getUserState(db, username))
  ]);
  const room = roomResult.value;
  const messages = messagesResult.value;
  const user = userResult.value;

  logEvent({
    event: 'room_state.complete',
    roomRow: row,
    roomCol: col,
    durationMs: elapsedMs(stateStart),
    roomMs: roomResult.durationMs,
    messagesMs: messagesResult.durationMs,
    userMs: userResult.durationMs,
    messageCount: messages.length,
    presenceCount: room.presence.length,
    tick
  });

  return {
    room,
    messages,
    user,
    tick
  };
}

export async function insertMessage(db, row, col, username, message, kind = 'chat') {
  await dbRun(
    db,
    'INSERT INTO messages (roomRow, roomCol, username, message, kind) VALUES (?, ?, ?, ?, ?)',
    [row, col, username, message, kind]
  );
}

export async function insertSystemMessage(db, row, col, message, kind = 'system') {
  await insertMessage(db, row, col, 'System', message, kind);
}

// kind tags a system message for client styling (combat/skill/support/death/
// dice/ambient/system — see migration 0008). When deferring for flush ordering
// (the attack path), the kind rides along as { message, kind } so the flush loop
// can preserve it instead of collapsing back to a bare string.
async function emitSystemMessage(db, row, col, message, deferredSystemMessages = null, kind = 'system') {
  if (deferredSystemMessages) {
    deferredSystemMessages.push({ message, kind });
    return;
  }
  await insertSystemMessage(db, row, col, message, kind);
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

export async function getMessages(db, row, col, tickValue = null) {
  const recent = await dbAll(
    db,
    `SELECT id, username, message, timestamp, kind
     FROM messages
     WHERE roomRow = ?
       AND roomCol = ?
     ORDER BY id DESC
     LIMIT ?`,
    [row, col, ROOM_MESSAGE_HISTORY_LIMIT]
  );
  const rows = recent.reverse();
  const usernames = [...new Set(rows.map(row => row.username).filter(username => username && username !== 'System'))];

  if (usernames.length === 0) {
    return rows.map(row => ({ ...row, job: null, statusEffects: [] }));
  }

  const placeholders = usernames.map(() => '?').join(', ');
  const currentTick = tickValue === null ? await getCurrentTickValue(db) : tickValue;
  const [users, effects] = await Promise.all([
    dbAll(db, `SELECT username, job FROM users WHERE username IN (${placeholders})`, usernames),
    dbAll(
      db,
      `SELECT username, effectType
       FROM statusEffects
       WHERE username IN (${placeholders})
         AND expiryTick > ?
       ORDER BY username ASC, expiryTick ASC, id ASC`,
      [...usernames, currentTick]
    )
  ]);
  const usersByName = new Map(users.map(user => [user.username, user]));
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

// Plan 016: spend one attributePoint (granted 10/level by awardExperience) to
// raise a base stat. The map is the allowlist — only these stat names ever reach
// the SQL, which is why the `${stat}` interpolation below is safe. maxStamina
// gives a bigger step so a point is worth spending; maxHealth is deliberately
// NOT here yet (it's body-bound: maxHealth == Σ part maxHp — see the plan).
const ALLOCATABLE_STATS = { strength: 1, speed: 1, intelligence: 1, maxStamina: 5 };

export function getAllocatableStats() {
  return { ...ALLOCATABLE_STATS };
}

export async function allocateAttributePoint(db, username, stat) {
  const step = ALLOCATABLE_STATS[stat];
  assertAction(step, 'You cannot raise that attribute.');
  // Atomic: spends exactly one point, and only if one is available.
  const result = await dbRun(
    db,
    `UPDATE users SET ${stat} = ${stat} + ?, attributePoints = attributePoints - 1
     WHERE username = ? AND attributePoints >= 1 AND isNpc = 0`,
    [step, username]
  );
  assertAction(changes(result) > 0, 'No attribute points to spend.', 400);
  return { stat, step };
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

// Effective max stamina = stored maxStamina + the job's maxStamina bonus.
// Build that bonus as a CASE expression straight from JOBS so it stays in sync
// with utils/jobs.js instead of hardcoding per-job numbers in SQL. Job names are
// our own config keys (never user input), so inlining them carries no injection risk.
function effectiveMaxStaminaSql() {
  const clauses = Object.entries(JOBS)
    .map(([job, definition]) => [job, definition.bonuses?.maxStamina || 0])
    .filter(([, bonus]) => bonus > 0)
    .map(([job, bonus]) => `WHEN '${job}' THEN maxStamina + ${bonus}`);
  return clauses.length > 0 ? `CASE job ${clauses.join(' ')} ELSE maxStamina END` : 'maxStamina';
}

async function recoverStaminaForAllUsers(db) {
  // Regenerate 1 stamina for every eligible user (and clamp any over-cap values
  // back down) in a single statement instead of one round-trip per row. The
  // WHERE clause writes exactly the rows the per-user loop used to write.
  const effectiveMax = effectiveMaxStaminaSql();
  await dbRun(
    db,
    `UPDATE users
     SET stamina = MIN(stamina + 1, ${effectiveMax})
     WHERE stamina <> (${effectiveMax})`
  );
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
  const droppedCount = await dropPlayerItemsOnDeath(db, username, row, col);
  if (droppedCount > 0) {
    await emitSystemMessage(db, row, col, `${username}'s belongings scatter across the floor.`, options.deferredSystemMessages);
  }
  await dbRun(db, 'DELETE FROM bodyParts WHERE username = ?', [username]);
  await emitSystemMessage(db, row, col, `${username} has died from ${cause}.`, options.deferredSystemMessages, 'death');
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

  const healthDelta = after.health - before.health;
  if (healthDelta < 0) {
    await applyBodyDamage(db, presence, -healthDelta, {
      cause: effect.type,
      row: presence.roomRow,
      col: presence.roomCol
    });
  } else if (healthDelta > 0) {
    await applyBodyHeal(db, presence, healthDelta, {
      row: presence.roomRow,
      col: presence.roomCol
    });
  }

  if (after.stamina !== before.stamina) {
    await dbRun(
      db,
      'UPDATE users SET stamina = ? WHERE username = ?',
      [after.stamina, presence.username]
    );
  }

  if (healthDelta !== 0 || after.stamina !== before.stamina) {
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
  await insertSystemMessage(db, row, col, `An echo repeats: ${fragment}`, 'ambient');
}

export async function processRoomEffects(db, currentTick) {
  const worldDay = getWorldDay();

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
  await emitSystemMessage(db, row, col, `${npc.displayName || npc.username} is defeated by ${killer}.`, deferredSystemMessages, 'combat');

  const drop = rollNpcDrop(npc.npcKind);
  if (drop) {
    await dropItemOnFloor(db, drop.templateId, row, col);
    await emitSystemMessage(db, row, col, `${npc.displayName || npc.username} drops ${drop.name}.`, deferredSystemMessages);
  }

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

function isBodylessUser(user) {
  return Boolean(user && (user.isNpc || user.username === 'System'));
}

export async function getBodyParts(db, username) {
  return dbAll(
    db,
    `SELECT id, username, partType, label, slotType, vital, hp, maxHp, baseMaxHp, severed
     FROM bodyParts
     WHERE username = ?
     ORDER BY CASE partType WHEN 'torso' THEN 0 ELSE 1 END, id ASC`,
    [username]
  );
}

export async function ensureBody(db, user) {
  if (isBodylessUser(user)) {
    return null;
  }
  const existing = await getBodyParts(db, user.username);
  if (existing.length > 0) {
    return existing;
  }

  // Part pools mirror the STORED pool so the invariant is exact; job bonuses
  // live in the effective layer only.
  const storedMax = Math.max(0, Math.floor(user.maxHealth || 0));
  const storedHealth = Math.max(0, Math.min(Math.floor(user.health || 0), storedMax));
  const maxDistribution = distributeAcrossPlan(storedMax, HUMANOID_PLAN);

  // Distribute current hp, clamped per-part to its maxHp; push any clamp
  // overflow to parts with headroom, torso first.
  const hpDistribution = distributeAcrossPlan(storedHealth, HUMANOID_PLAN);
  const parts = HUMANOID_PLAN.map((template, index) => ({
    ...template,
    maxHp: maxDistribution[index].amount,
    hp: Math.min(hpDistribution[index].amount, maxDistribution[index].amount)
  }));
  let overflow = parts.reduce(
    (sum, part, index) => sum + Math.max(0, hpDistribution[index].amount - part.maxHp),
    0
  );
  if (overflow > 0) {
    const order = parts
      .map((part, index) => ({ part, index, isTorso: part.partType === 'torso' }))
      .sort((a, b) => (b.isTorso ? 1 : 0) - (a.isTorso ? 1 : 0) || a.index - b.index);
    for (const entry of order) {
      if (overflow <= 0) {
        break;
      }
      const headroom = entry.part.maxHp - entry.part.hp;
      const add = Math.min(headroom, overflow);
      entry.part.hp += add;
      overflow -= add;
    }
  }

  for (const part of parts) {
    // baseMaxHp mirrors the distributed base maxHp at creation (plan 006). Armor
    // bonuses (plan 015's applyPartMaxHpDelta) move maxHp transiently but never
    // touch baseMaxHp, so /regrow can restore the permanent, un-fortified base.
    await dbRun(
      db,
      `INSERT OR IGNORE INTO bodyParts
        (username, partType, label, slotType, vital, hp, maxHp, baseMaxHp, severed)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      [user.username, part.partType, part.label, part.slotType, part.vital ? 1 : 0, part.hp, part.maxHp, part.maxHp]
    );
  }

  return getBodyParts(db, user.username);
}

export async function getBodyConditionModifiers(db, username) {
  const parts = await getBodyParts(db, username);
  return bodyPenaltyModifiers(parts);
}

// Defensive parse of an item's stored modifiers JSON into a plain object.
function parseItemModifiers(raw) {
  if (!raw) {
    return {};
  }
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (error) {
    return {};
  }
}

// The integer maxHealth an item contributes to the body part it's worn on.
// Single source of truth for plan 015's structural HP gear: 0 when absent/NaN.
// May be negative (e.g. Mage's Humming Focus -3), which lowers the part's cap.
function itemMaxHealthBonus(item) {
  const parsed = parseItemModifiers(item && item.modifiers);
  const value = Math.trunc(Number(parsed.maxHealth));
  return Number.isFinite(value) ? value : 0;
}

// Move an item's maxHealth bonus into (delta > 0) or out of (delta < 0) the
// part it's worn on, mirroring users.maxHealth and the EXACT hp the part loses
// onto users.health. The bonus lives in exactly one place at a time — this is
// the only write path for it, so equip and unequip can't drift. Floors caps at
// 0. Critically, users.health drops by precisely the per-part hp destroyed (a
// negative delta can clamp the part's hp), never by a coarse MIN-to-maxHealth,
// so users.health == Σ hp stays exact even when other parts hold the surplus.
async function applyPartMaxHpDelta(db, username, partId, delta) {
  if (!delta) {
    return;
  }
  const before = await dbFirst(db, 'SELECT hp FROM bodyParts WHERE id = ?', [partId]);
  const hpBefore = before ? Math.max(0, Math.floor(before.hp || 0)) : 0;

  await dbRun(
    db,
    'UPDATE bodyParts SET maxHp = MAX(maxHp + ?, 0) WHERE id = ?',
    [delta, partId]
  );
  // A negative delta can push hp above the lowered cap; clamp it down.
  await dbRun(
    db,
    'UPDATE bodyParts SET hp = MIN(hp, maxHp) WHERE id = ?',
    [partId]
  );

  const after = await dbFirst(db, 'SELECT hp FROM bodyParts WHERE id = ?', [partId]);
  const hpAfter = after ? Math.max(0, Math.floor(after.hp || 0)) : 0;
  const hpLost = hpBefore - hpAfter; // >= 0; only a negative delta destroys hp.

  await dbRun(
    db,
    'UPDATE users SET maxHealth = MAX(maxHealth + ?, 0) WHERE username = ?',
    [delta, username]
  );
  // Mirror the exact hp the part shed onto users.health (floor 0). Equip with a
  // positive bonus destroys nothing (hpLost 0), so health is untouched.
  if (hpLost > 0) {
    await dbRun(
      db,
      'UPDATE users SET health = MAX(health - ?, 0) WHERE username = ?',
      [hpLost, username]
    );
  }
}

// Owned items joined to the equipped part's label; equipped rows first.
export async function getInventory(db, username) {
  return dbAll(
    db,
    `SELECT i.id, i.templateId, i.name, i.slotType, i.rarity, i.modifiers,
            i.equippedPartId, bp.label AS partLabel
     FROM items i
     LEFT JOIN bodyParts bp ON bp.id = i.equippedPartId
     WHERE i.ownerUsername = ?
     ORDER BY CASE WHEN i.equippedPartId IS NULL THEN 1 ELSE 0 END,
              bp.label ASC, i.name ASC, i.id ASC`,
    [username]
  );
}

// Sum the modifiers of every equipped item into a modifier object over
// MODIFIER_KEYS EXCEPT maxHealth, which is intentionally excluded: plan 015
// owns HP gear via part maxHp, and applying maxHealth to the effective layer
// now would be an unfillable dead stat (applyBodyHeal caps fill at part maxHp).
export async function getEquippedModifiers(db, username) {
  const rows = await dbAll(
    db,
    'SELECT modifiers FROM items WHERE ownerUsername = ? AND equippedPartId IS NOT NULL',
    [username]
  );
  const modifiers = emptyModifiers();
  delete modifiers.maxHealth; // dead-stat guard: never surface gear maxHealth.
  for (const row of rows) {
    const parsed = parseItemModifiers(row.modifiers);
    for (const key of MODIFIER_KEYS) {
      if (key === 'maxHealth') {
        continue;
      }
      const value = Number(parsed[key]);
      if (Number.isFinite(value)) {
        modifiers[key] = (modifiers[key] || 0) + value;
      }
    }
  }
  return modifiers;
}

// Element-wise sum of wound penalties and equipped-gear bonuses. Swapped in at
// every site that previously fed getBodyConditionModifiers / bodyPenaltyModifiers
// into getEffectiveUser, so wounds and gear ride one modifier channel.
export async function getConditionAndGearModifiers(db, username) {
  const [condition, gear, progression] = await Promise.all([
    getBodyConditionModifiers(db, username),
    getEquippedModifiers(db, username),
    getProgressionModifiers(db, username)
  ]);
  const combined = {};
  for (const key of MODIFIER_KEYS) {
    combined[key] = (Number(condition[key]) || 0) + (Number(gear[key]) || 0) + (Number(progression[key]) || 0);
  }
  return combined;
}

// --- Plan 019b: the daily progression grid --------------------------------
// ONE shared board generated per worldDay from a Penrose tiling (utils/progression
// Grid.js). Daily builds: your point budget is your LEVEL, re-spent each day;
// available = budget − cost of TODAY's unlocked nodes. Node IDs are namespaced
// `${worldDay}:${vid}`, so yesterday's rows stop counting and the reset is free and
// automatic — stale rows are swept lazily. Node effects are DERIVED from the
// unlocked set (respec is just deleting today's rows).

// Today's unlocked node IDs only (a prior day's rows belong to a board that no
// longer exists). Sweep those stale rows opportunistically.
async function getStoredUnlockedNodeIds(db, username, worldDay) {
  const rows = await dbAll(db, 'SELECT nodeId FROM playerProgressionNodes WHERE username = ? AND nodeId LIKE ?', [username, `${worldDay}:%`]);
  return rows.map(row => row.nodeId);
}

async function sweepStaleUnlocks(db, username, worldDay) {
  await dbRun(db, 'DELETE FROM playerProgressionNodes WHERE username = ? AND nodeId NOT LIKE ?', [username, `${worldDay}:%`]);
}

// The full unlocked set (the class's entry node + today's unlocks) — for adjacency.
async function getUnlockedNodeIds(db, username, job, worldDay) {
  const stored = await getStoredUnlockedNodeIds(db, username, worldDay);
  return new Set([...getGridEntryNodeIds(worldDay, normalizeJob(job)), ...stored]);
}

// Stat deltas from today's unlocked `stat` / `passive` nodes, folded into the
// effective layer via getConditionAndGearModifiers so they reach combat AND
// display. Passives are binary: one the class already has innately is skipped.
async function getProgressionModifiers(db, username) {
  const worldDay = getWorldDay();
  const stored = await getStoredUnlockedNodeIds(db, username, worldDay);
  if (!stored.length) {
    return {};
  }
  const user = await getUser(db, username);
  const innatePassives = new Set(
    getInnateAbilityIds(normalizeJob(user.job)).filter(id => {
      const ability = getAbility(id);
      return ability && ability.kind === 'passive';
    })
  );
  const modifiers = {};
  for (const nodeId of stored) {
    const node = getGridNode(worldDay, nodeId);
    if (!node || !node.effect) continue;
    if (node.effect.kind === 'stat') {
      modifiers[node.effect.stat] = (modifiers[node.effect.stat] || 0) + Number(node.effect.amount || 0);
    } else if (node.effect.kind === 'passive') {
      if (innatePassives.has(node.effect.abilityId)) continue; // already folded by getEffectiveUser
      const ability = getAbility(node.effect.abilityId);
      for (const [stat, delta] of Object.entries((ability && ability.statEffects) || {})) {
        modifiers[stat] = (modifiers[stat] || 0) + Number(delta || 0);
      }
    }
  }
  return modifiers;
}

// Active abilities granted by today's unlocked `grant_ability` nodes — unioned with
// item-granted abilities in getGrantedAbilityIds.
async function getProgressionGrantedAbilityIds(db, username) {
  const worldDay = getWorldDay();
  const stored = await getStoredUnlockedNodeIds(db, username, worldDay);
  const granted = [];
  for (const nodeId of stored) {
    const node = getGridNode(worldDay, nodeId);
    if (node && node.effect && node.effect.kind === 'grant_ability') {
      const abilityId = node.effect.abilityId;
      if (getAbility(abilityId) && !granted.includes(abilityId)) granted.push(abilityId);
    }
  }
  return granted;
}

function spentOnNodes(board, nodeIds) {
  let spent = 0;
  for (const id of nodeIds) {
    const node = board.byId.get(id);
    if (node) spent += node.cost || 0;
  }
  return spent;
}

// The board state for the UI: today's board with every node tagged unlocked /
// unlockable / locked, plus the daily point budget.
export async function getProgressionGrid(db, username) {
  const worldDay = getWorldDay();
  await sweepStaleUnlocks(db, username, worldDay);
  const board = getDailyBoard(worldDay);
  const user = await getUser(db, username);
  const job = normalizeJob(user.job);
  const budget = Number(user.level || 0);
  const stored = await getStoredUnlockedNodeIds(db, username, worldDay);
  const unlocked = new Set([...getGridEntryNodeIds(worldDay, job), ...stored]);
  const spent = spentOnNodes(board, stored);
  const available = Math.max(0, budget - spent);

  const nodes = board.nodes.map(node => {
    const isUnlocked = unlocked.has(node.id);
    const onFrontier = node.neighbors.some(neighborId => unlocked.has(neighborId));
    const cost = node.cost || 0;
    return {
      id: node.id,
      label: node.label,
      x: node.x,
      y: node.y,
      cost,
      effect: node.effect,
      entryFor: node.entryFor || null,
      neighbors: node.neighbors,
      state: isUnlocked ? 'unlocked' : (onFrontier && available >= cost ? 'unlockable' : 'locked')
    };
  });
  return { worldDay, job, budget, spent, available, canvas: board.canvas, nodes };
}

// Unlock a node on TODAY's board: claim-first (the PK guards double-unlock races),
// then verify the daily budget still holds — rolling the claim back if it doesn't.
export async function unlockProgressionNode(db, username, nodeId) {
  const worldDay = getWorldDay();
  const board = getDailyBoard(worldDay);
  const node = board.byId.get(nodeId);
  assertAction(node, 'That node is not on today\'s board.', 404);
  await sweepStaleUnlocks(db, username, worldDay);

  const user = await getUser(db, username);
  const job = normalizeJob(user.job);
  const budget = Number(user.level || 0);
  const stored = await getStoredUnlockedNodeIds(db, username, worldDay);
  const unlocked = new Set([...getGridEntryNodeIds(worldDay, job), ...stored]);
  assertAction(!unlocked.has(nodeId), 'That node is already unlocked.', 400);
  assertAction(node.neighbors.some(neighborId => unlocked.has(neighborId)), 'That node is not reachable yet.', 400);

  const cost = node.cost || 0;
  assertAction(budget - spentOnNodes(board, stored) >= cost, 'Not enough skill points today.', 400);

  const claim = await dbRun(
    db,
    'INSERT OR IGNORE INTO playerProgressionNodes (username, nodeId, unlockedTick) VALUES (?, ?, ?)',
    [username, nodeId, await getCurrentTickValue(db)]
  );
  assertAction(changes(claim) > 0, 'That node is already unlocked.', 400);

  // Re-check the budget against the now-committed set; roll back on overspend.
  const after = await getStoredUnlockedNodeIds(db, username, worldDay);
  if (spentOnNodes(board, after) > budget) {
    await dbRun(db, 'DELETE FROM playerProgressionNodes WHERE username = ? AND nodeId = ?', [username, nodeId]);
    throw new ActionError('Not enough skill points today.', 400);
  }
  return getProgressionGrid(db, username);
}

const RESPEC_GOLD_COST = 50;

// Respec at a guild (where class reselection lives): pay gold to clear TODAY's
// unlocks so the day's budget can be re-spent. (The board itself resets free at
// the daily rollover; this is for re-planning mid-day.)
export async function respecProgression(db, username, row, col) {
  const worldDay = getWorldDay();
  const tickValue = await getCurrentTickValue(db);
  assertAction(roomHasEffect(row, col, tickValue, 'guild', worldDay), 'You can only respec at a guild.', 400);

  const stored = await getStoredUnlockedNodeIds(db, username, worldDay);
  assertAction(stored.length > 0, 'You have no unlocked nodes to respec today.', 400);

  const paid = await dbRun(
    db,
    'UPDATE users SET gold = gold - ? WHERE username = ? AND gold >= ? AND isNpc = 0',
    [RESPEC_GOLD_COST, username, RESPEC_GOLD_COST]
  );
  assertAction(changes(paid) > 0, `Respec costs ${RESPEC_GOLD_COST} gold.`, 400);

  await dbRun(db, 'DELETE FROM playerProgressionNodes WHERE username = ? AND nodeId LIKE ?', [username, `${worldDay}:%`]);
  return getProgressionGrid(db, username);
}

async function findOwnedUnequippedItem(db, username, itemName) {
  return dbFirst(
    db,
    `SELECT id, name, slotType, modifiers FROM items
     WHERE ownerUsername = ? AND equippedPartId IS NULL
       AND roomRow IS NULL AND roomCol IS NULL
       AND LOWER(name) = LOWER(?)
     ORDER BY id ASC
     LIMIT 1`,
    [username, itemName]
  );
}

// Shared equip core: attach an ALREADY-OWNED item row to a matching body part
// and fold its HP gear (plan 015). The single write path for both /equip (which
// adds a system message afterward) and createItemForOwner's silent grant — so
// the candidate-part selection, swap-off-occupant HP accounting, attach, and
// applyPartMaxHpDelta(+bonus) can't drift between the two callers. `item` must
// have id, slotType, and modifiers. Returns { partId, partLabel }.
async function attachItemToBody(db, user, item) {
  await ensureBody(db, user);
  const candidates = await dbAll(
    db,
    `SELECT id, label FROM bodyParts
     WHERE username = ? AND slotType = ? AND severed = 0
     ORDER BY id ASC`,
    [user.username, item.slotType]
  );
  if (candidates.length === 0) {
    throw new ActionError('You have nowhere to put that.');
  }

  // Which candidate parts already hold an item?
  const occupied = await dbAll(
    db,
    `SELECT equippedPartId FROM items
     WHERE ownerUsername = ? AND equippedPartId IS NOT NULL`,
    [user.username]
  );
  const occupiedIds = new Set(occupied.map(o => o.equippedPartId));

  // Prefer an EMPTY candidate part; if all are occupied, swap on the first one.
  let target = candidates.find(part => !occupiedIds.has(part.id));
  if (!target) {
    target = candidates[0];
    // Swap = unequip-then-equip for HP accounting: the swapped-off item's
    // bonus must leave the part BEFORE the new item's bonus enters, or the
    // part would keep the old armor's HP. Remove every occupant's bonus first.
    const occupants = await dbAll(
      db,
      'SELECT modifiers FROM items WHERE equippedPartId = ?',
      [target.id]
    );
    for (const occupant of occupants) {
      await applyPartMaxHpDelta(db, user.username, target.id, -itemMaxHealthBonus(occupant));
    }
    await dbRun(
      db,
      'UPDATE items SET equippedPartId = NULL WHERE equippedPartId = ?',
      [target.id]
    );
  }

  await dbRun(
    db,
    `UPDATE items SET equippedPartId = ?, roomRow = NULL, roomCol = NULL
     WHERE id = ?`,
    [target.id, item.id]
  );

  // Fold this item's HP gear into the worn part (structural, plan 015): raise
  // the part's maxHp and users.maxHealth by the bonus. A positive bonus opens
  // headroom but does NOT heal; a negative bonus clamps hp/health down.
  await applyPartMaxHpDelta(db, user.username, target.id, itemMaxHealthBonus(item));

  return { partId: target.id, partLabel: target.label };
}

export async function equipItem(db, user, itemName, row, col) {
  const item = await findOwnedUnequippedItem(db, user.username, itemName);
  if (!item) {
    throw new ActionError("You aren't carrying that.");
  }

  const { partId, partLabel } = await attachItemToBody(db, user, item);

  await insertSystemMessage(db, row, col, `${user.username} equips ${item.name} on their ${partLabel}.`);
  return { item, partId, partLabel };
}

export async function unequipItem(db, user, ref, row, col) {
  await ensureBody(db, user);
  // ref may name the item OR the body part (case-insensitive). Pull the part's
  // id/severed and the item's modifiers too, so we can reverse the HP gear
  // (plan 015) BEFORE clearing equippedPartId.
  const equipped = await dbFirst(
    db,
    `SELECT i.id, i.name, i.modifiers, bp.id AS partId, bp.label AS partLabel, bp.severed
     FROM items i
     JOIN bodyParts bp ON bp.id = i.equippedPartId
     WHERE i.ownerUsername = ? AND i.equippedPartId IS NOT NULL
       AND (LOWER(i.name) = LOWER(?) OR LOWER(bp.label) = LOWER(?))
     ORDER BY i.id ASC
     LIMIT 1`,
    [user.username, ref, ref]
  );
  if (!equipped) {
    throw new ActionError('Nothing equipped there.');
  }

  // Remove this item's HP gear from the part it's leaving — inverse of equip's
  // applyPartMaxHpDelta. A severed part already shed its maxHp (including the
  // gear) on sever, so skip it there to avoid double-subtracting.
  if (!equipped.severed) {
    await applyPartMaxHpDelta(db, user.username, equipped.partId, -itemMaxHealthBonus(equipped));
  }

  await dbRun(db, 'UPDATE items SET equippedPartId = NULL WHERE id = ?', [equipped.id]);
  await insertSystemMessage(db, row, col, `${user.username} stows ${equipped.name}.`);
  return { item: { id: equipped.id, name: equipped.name }, partLabel: equipped.partLabel };
}

// Mint an item from a template and give it to a player. With { equip: true }
// the end state is IDENTICAL to the player carrying it and running /equip —
// including plan 015's HP fold via the shared attachItemToBody — but SILENT (no
// system message) and with NO room needed (signup grants gear off-grid).
// Returns the inserted item id.
export async function createItemForOwner(db, templateId, username, { equip = false } = {}) {
  const template = getTemplate(templateId);
  if (!template) {
    throw new ActionError(`Unknown item template: ${templateId}`);
  }
  const result = await dbRun(
    db,
    `INSERT INTO items (templateId, name, slotType, rarity, modifiers, ownerUsername)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [template.templateId, template.name, template.slotType, template.rarity, JSON.stringify(template.modifiers || {}), username]
  );
  const itemId = lastInsertId(result);

  if (equip) {
    const user = await getUser(db, username);
    // attachItemToBody needs id/slotType/modifiers; reuse the template values.
    await attachItemToBody(db, user, {
      id: itemId,
      slotType: template.slotType,
      modifiers: JSON.stringify(template.modifiers || {})
    });
  }

  return itemId;
}

// Drop a fresh template-minted item onto a room floor (ownerUsername NULL).
// Used for NPC defeat loot.
export async function dropItemOnFloor(db, templateId, row, col) {
  const template = getTemplate(templateId);
  if (!template) {
    return null;
  }
  await dbRun(
    db,
    `INSERT INTO items (templateId, name, slotType, rarity, modifiers, ownerUsername, roomRow, roomCol)
     VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`,
    [template.templateId, template.name, template.slotType, template.rarity, JSON.stringify(template.modifiers || {}), row, col]
  );
}

// Drop a CARRIED item (owned, unequipped) onto the current room floor, where
// any player can /take it. Equipped items must be /unequip'd first (that returns
// them to the pack), so this only ever moves carried items. Race-safe: the
// conditional WHERE means a second drop of an item already gone is a no-op.
export async function dropOwnedItem(db, username, itemName, row, col) {
  const item = await findOwnedUnequippedItem(db, username, itemName);
  if (!item) {
    throw new ActionError("You aren't carrying that.");
  }
  const result = await dbRun(
    db,
    `UPDATE items SET ownerUsername = NULL, equippedPartId = NULL, roomRow = ?, roomCol = ?
     WHERE id = ? AND ownerUsername = ? AND equippedPartId IS NULL`,
    [row, col, item.id, username]
  );
  if (changes(result) === 0) {
    throw new ActionError("You aren't carrying that.");
  }
  await insertSystemMessage(db, row, col, `${username} drops ${item.name}.`);
  return { item: { id: item.id, name: item.name } };
}

// Full-loot on death: every item the player owns (carried OR equipped) scatters
// to the room floor where they fell. No HP accounting — the body is deleted on
// death, and a taker re-applies any bonus fresh via /equip. Returns how many
// item rows were scattered.
export async function dropPlayerItemsOnDeath(db, username, row, col) {
  const result = await dbRun(
    db,
    `UPDATE items SET ownerUsername = NULL, equippedPartId = NULL, roomRow = ?, roomCol = ?
     WHERE ownerUsername = ?`,
    [row, col, username]
  );
  return changes(result);
}

// Items lying on a room floor (ownerUsername NULL), for the room payload.
export async function getFloorItems(db, row, col) {
  return dbAll(
    db,
    `SELECT id, name, slotType, rarity, modifiers FROM items
     WHERE ownerUsername IS NULL AND roomRow = ? AND roomCol = ?
     ORDER BY id DESC LIMIT 20`,
    [row, col]
  );
}

// Pick a floor item up by name into the player's pack (carried, NOT equipped —
// no HP fold here). The claim is a conditional update so two players racing for
// the same item can't both win: only the one whose UPDATE still saw
// ownerUsername NULL takes it.
export async function takeItem(db, username, itemName, row, col) {
  const item = await dbFirst(
    db,
    `SELECT * FROM items
     WHERE ownerUsername IS NULL AND roomRow = ? AND roomCol = ? AND LOWER(name) = LOWER(?)
     ORDER BY id ASC
     LIMIT 1`,
    [row, col, itemName]
  );
  if (!item) {
    throw new ActionError('There is no such thing here.');
  }
  const result = await dbRun(
    db,
    `UPDATE items SET ownerUsername = ?, roomRow = NULL, roomCol = NULL
     WHERE id = ? AND ownerUsername IS NULL`,
    [username, item.id]
  );
  if (changes(result) === 0) {
    throw new ActionError('Someone snatched it first.');
  }
  await insertSystemMessage(db, row, col, `${username} takes ${item.name}.`);
  return { item: { id: item.id, name: item.name } };
}

async function emitConditionTransitions(db, username, beforeParts, afterParts, row, col) {
  if (row === undefined || row === null || col === undefined || col === null) {
    return;
  }
  const beforeByLabel = new Map(beforeParts.map(part => [part.label, part]));
  for (const after of afterParts) {
    const before = beforeByLabel.get(after.label);
    if (!before) {
      continue;
    }
    const beforeCondition = partCondition(before);
    const afterCondition = partCondition(after);
    if (beforeCondition === afterCondition) {
      continue;
    }
    if (after.severed) {
      // Severance gets its own "destroyed" line from the caller; skip here.
      continue;
    }
    const phrase = afterCondition === 'healthy'
      ? `${username}'s ${after.label} looks healthy again.`
      : `${username}'s ${after.label} is ${afterCondition}.`;
    await insertSystemMessage(db, row, col, phrase);
  }
}

export async function applyBodyDamage(db, user, amount, options = {}) {
  const { cause, row, col, random = Math.random, targetLabel = null } = options;
  const damage = Math.max(0, Math.floor(amount || 0));

  if (isBodylessUser(user)) {
    const nextHealth = Math.max(0, (user.health || 0) - damage);
    await dbRun(db, 'UPDATE users SET health = MAX(health - ?, 0) WHERE username = ?', [damage, user.username]);
    return { died: nextHealth <= 0, npc: true, healthAfter: nextHealth, severedLabels: [] };
  }

  const partsBefore = await ensureBody(db, user);
  const liveParts = partsBefore.filter(part => !part.severed);

  // Snapshot for condition-transition messaging.
  const working = partsBefore.map(part => ({ ...part }));
  const workingByLabel = new Map(working.map(part => [part.label, part]));
  const torso = working.find(part => part.partType === 'torso');

  let remaining = damage;
  // A called shot (targetLabel) routes damage to the named, non-severed part
  // instead of the weighted-random pick. Spill-to-torso and every other rule
  // below is unchanged. When targetLabel is absent this is byte-identical to the
  // original random routing (the `random` draw is still consumed, preserving the
  // RNG order callers rely on).
  let target = pickTargetPart(liveParts, random);
  if (targetLabel) {
    const aimed = liveParts.find(part => part.label === targetLabel);
    if (aimed) {
      target = aimed;
    }
  }
  const targetWorking = target ? workingByLabel.get(target.label) : null;

  let totalDealt = 0;
  if (targetWorking && remaining > 0) {
    const dealt = Math.min(remaining, targetWorking.hp);
    targetWorking.hp -= dealt;
    totalDealt += dealt;
    remaining -= dealt;
  }

  // Spill remainder into the torso (if the target wasn't the torso); anything
  // beyond torso hp is dropped (total is already 0 by then).
  if (remaining > 0 && torso && (!targetWorking || targetWorking.label !== torso.label) && !torso.severed) {
    const dealt = Math.min(remaining, torso.hp);
    torso.hp -= dealt;
    totalDealt += dealt;
    remaining -= dealt;
  }

  // Determine transitions: severance for non-vital parts driven >0 -> 0,
  // and death for any vital part driven >0 -> 0.
  const severedLabels = [];
  const severedParts = []; // { id, label } — id resolves the knock-off UPDATE.
  let vitalDestroyed = false;
  let maxHealthReduction = 0;
  for (const part of working) {
    const before = workingByLabel.get(part.label);
    const wasAlive = partsBefore.find(p => p.label === part.label).hp > 0;
    if (part.hp <= 0 && wasAlive) {
      if (part.vital) {
        vitalDestroyed = true;
      } else if (!part.severed) {
        part.severed = 1;
        severedLabels.push(part.label);
        severedParts.push({ id: part.id, label: part.label });
        maxHealthReduction += part.maxHp;
      }
    }
  }

  // Persist part rows.
  for (const part of working) {
    await dbRun(
      db,
      'UPDATE bodyParts SET hp = ?, severed = ? WHERE username = ? AND label = ?',
      [Math.max(0, part.hp), part.severed ? 1 : 0, user.username, part.label]
    );
  }

  // Mirror the same total deduction on users.health in a single UPDATE.
  const healthAfter = Math.max(0, (user.health || 0) - totalDealt);
  if (maxHealthReduction > 0) {
    await dbRun(
      db,
      'UPDATE users SET health = ?, maxHealth = MAX(maxHealth - ?, 0) WHERE username = ?',
      [healthAfter, maxHealthReduction, user.username]
    );
  } else {
    await dbRun(db, 'UPDATE users SET health = ? WHERE username = ?', [healthAfter, user.username]);
  }

  // Loud states: condition-transition messages (non-severance), then severance.
  await emitConditionTransitions(db, user.username, partsBefore, working, row, col);
  if (row !== undefined && row !== null && col !== undefined && col !== null) {
    for (const part of severedParts) {
      await insertSystemMessage(db, row, col, `${user.username}'s ${part.label} is destroyed.`, 'combat');
      // Sever knock-off: whatever was equipped on this part clatters to the
      // floor for anyone to /take (plan 005). Fetch the name BEFORE the UPDATE.
      const equipped = await dbFirst(
        db,
        'SELECT id, name FROM items WHERE equippedPartId = ?',
        [part.id]
      );
      if (equipped) {
        await dbRun(
          db,
          `UPDATE items SET ownerUsername = NULL, equippedPartId = NULL, roomRow = ?, roomCol = ?
           WHERE equippedPartId = ?`,
          [row, col, part.id]
        );
        await insertSystemMessage(
          db,
          row,
          col,
          `${equipped.name} falls to the floor with ${user.username}'s ${part.label}.`
        );
      }
    }
  }

  const died = vitalDestroyed || healthAfter <= 0;
  return { died, npc: false, healthAfter, severedLabels };
}

export async function applyBodyHeal(db, user, amount, options = {}) {
  const { row, col } = options;
  const heal = Math.max(0, Math.floor(amount || 0));

  if (isBodylessUser(user)) {
    const effective = getEffectiveUser(user);
    const nextHealth = Math.min(effective.maxHealth, (user.health || 0) + heal);
    await dbRun(db, 'UPDATE users SET health = ? WHERE username = ?', [nextHealth, user.username]);
    return nextHealth;
  }

  const partsBefore = await ensureBody(db, user);
  // Combine wound penalties (from the just-read parts) with equipped-gear
  // bonuses so the heal cap rides the same modifier channel as combat. Gear
  // maxHealth is intentionally excluded (getEquippedModifiers), so the cap is
  // unchanged for HP until plan 015 makes it real via part maxHp.
  const conditionModifiers = bodyPenaltyModifiers(partsBefore);
  const gearModifiers = await getEquippedModifiers(db, user.username);
  const combinedModifiers = {};
  for (const key of MODIFIER_KEYS) {
    combinedModifiers[key] = (Number(conditionModifiers[key]) || 0) + (Number(gearModifiers[key]) || 0);
  }
  const effective = getEffectiveUser(user, combinedModifiers);

  const working = partsBefore.map(part => ({ ...part }));
  // Fill non-severed parts worst-ratio-first up to maxHp until the pool or the
  // effective max is exhausted. Severed parts are never restored (plan 006).
  const currentTotal = working.reduce((sum, part) => sum + (part.severed ? 0 : part.hp), 0);
  let budget = Math.max(0, Math.min(heal, effective.maxHealth - currentTotal));

  while (budget > 0) {
    const candidates = working
      .filter(part => !part.severed && part.hp < part.maxHp)
      .sort((a, b) => (a.hp / a.maxHp) - (b.hp / b.maxHp));
    if (candidates.length === 0) {
      break;
    }
    const target = candidates[0];
    target.hp += 1;
    budget -= 1;
  }

  const totalHealed = working.reduce((sum, part) => sum + (part.severed ? 0 : part.hp), 0)
    - currentTotal;
  for (const part of working) {
    await dbRun(
      db,
      'UPDATE bodyParts SET hp = ? WHERE username = ? AND label = ?',
      [part.hp, user.username, part.label]
    );
  }

  const healthAfter = Math.max(0, (user.health || 0) + totalHealed);
  await dbRun(db, 'UPDATE users SET health = ? WHERE username = ?', [healthAfter, user.username]);
  await emitConditionTransitions(db, user.username, partsBefore, working, row, col);
  return healthAfter;
}

async function damageUser(db, username, amount, cause, row, col) {
  const target = await getUser(db, username, 'Target');
  const result = await applyBodyDamage(db, target, amount, { cause, row, col });
  const nextHealth = result.healthAfter;

  if (result.died && target.health > 0) {
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

async function healUser(db, username, amount, row, col) {
  const user = await getUser(db, username, 'Target');
  return applyBodyHeal(db, user, amount, { row, col });
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
      await healUser(db, effect.username, effect.magnitude || 1, effect.roomRow, effect.roomCol);
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

  return {
    tick: tickValue,
    staminaUpdated: tickValue % 3 === 0
  };
}

export async function runScheduledWorldPulse(db) {
  const worldDay = getWorldDay();
  await cleanupOldWorldDayData(db, worldDay);
  const tick = await advanceGlobalTick(db);
  await ensureDailyWorldEvents(db, worldDay, tick.tick);
  const activeRooms = await getActivePlayerRooms(db);

  return {
    tick,
    environmental: tick.tick % 5 === 0,
    activeRooms
  };
}

export async function getActivePlayerRooms(db, worldDay = getWorldDay()) {
  const rooms = await dbAll(
    db,
    `SELECT DISTINCT rp.roomRow AS row, rp.roomCol AS col
     FROM roomPresence rp
     JOIN users u ON u.username = rp.username
     WHERE rp.worldDay = ?
       AND u.isNpc = 0
       AND u.health > 0
       AND rp.lastSeenAt >= datetime('now', ?)
     ORDER BY rp.roomRow ASC, rp.roomCol ASC`,
    [worldDay, `-${PRESENCE_MAX_AGE_SECONDS} seconds`]
  );

  return rooms.map(room => ({ row: room.row, col: room.col }));
}

export async function getActiveWorldEvents(db, worldDay = getWorldDay()) {
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

  const playerMods = await getConditionAndGearModifiers(db, player.username);
  // Only the defending PLAYER's stance applies against an NPC: dodgeBonus makes
  // them harder to hit, damageTakenDelta adjusts the blow. The NPC has no stance.
  const playerStance = STANCES[normalizeStance(player.stance)];
  const contest = rollSpeedContest(npc, player, null, playerMods, { dodgeDelta: playerStance.dodgeBonus });
  if (!contest.hit) {
    await insertSystemMessage(db, row, col, `${player.username} dodged ${npc.displayName || npc.username}.`, 'combat');
    return { tick, acted: true, missed: true };
  }

  const { damage: baseDamage, isCriticalAttack } = await calculateAttackDamage(db, npc, player.username, tick.tick, null);
  const damage = Math.max(0, baseDamage + playerStance.damageTakenDelta);
  const damageResult = await applyBodyDamage(db, player, damage, {
    cause: `attack by ${npc.username}`,
    row,
    col
  });
  const hitText = isCriticalAttack ? 'critically hits' : 'attacks';
  await insertSystemMessage(db, row, col, `${npc.displayName || npc.username} ${hitText} ${player.username} for ${damage} damage.`, 'combat');

  if (damageResult.died) {
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
      // Plan 016 grants 10 attribute points/level; plan 019 grants 1 skill point/
      // level (a SEPARATE currency for the progression grid).
      'UPDATE users SET experience = ?, level = ?, attributePoints = attributePoints + ?, skillPoints = skillPoints + ? WHERE username = ?',
      [nextExperience, nextLevel, levelDelta * 10, levelDelta, username]
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
  await insertSystemMessage(db, row, col, systemMessage, 'dice');

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

async function calculateAttackDamage(db, attacker, targetUsername, currentTick, attackerMods = null) {
  const effectiveAttacker = getEffectiveUser(attacker, attackerMods);
  const isCriticalAttack = Math.random() < 0.01;
  const markedBonus = await consumeStatusModifier(db, targetUsername, 'marked', currentTick);
  const wardReduction = await consumeStatusModifier(db, targetUsername, 'ward', currentTick);
  const baseDamage = 1 + Math.floor(effectiveAttacker.strength / 4);
  const criticalDamage = isCriticalAttack ? baseDamage + 1 : baseDamage;
  const damage = Math.max(0, criticalDamage + markedBonus - wardReduction);

  return { damage, isCriticalAttack };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export async function validateAttackTargets(db, message, row, col, attackerUsername) {
  const worldDay = getWorldDay();
  const occupants = await dbAll(
    db,
    `SELECT u.username
     FROM roomPresence rp
     JOIN users u ON u.username = rp.username
     WHERE rp.roomRow = ?
       AND rp.roomCol = ?
       AND rp.worldDay = ?
       AND rp.username != 'System'
       AND u.username != ?
       AND (u.isNpc = 1 OR rp.lastSeenAt >= datetime('now', ?))`,
    [row, col, worldDay, attackerUsername, `-${PRESENCE_MAX_AGE_SECONDS} seconds`]
  );

  const mentioned = [...message.matchAll(/@([A-Za-z0-9_-]+)/g)].map(m => m[1]);
  if (mentioned.length > 0) {
    const byName = new Map(occupants.map(user => [user.username, user]));
    const targets = [...new Set(mentioned)]
      .map(name => byName.get(name))
      .filter(Boolean);
    if (targets.length === 0) {
      throw new ActionError('No such target here.');
    }
    return targets;
  }

  const targets = occupants.filter(user => {
    const pattern = new RegExp(`(^|[^A-Za-z0-9_-])${escapeRegExp(user.username)}([^A-Za-z0-9_-]|$)`);
    return pattern.test(message);
  });
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
  const targets = await validateAttackTargets(db, message, row, col, username);
  const attackMessages = [];

  const attackerMods = attacker.isNpc ? null : await getConditionAndGearModifiers(db, username);

  // Stance and called shot are attacker-message-level (apply to every target in
  // this attack). NPCs have no parts, so a called shot only routes at player
  // targets; against NPCs it's ignored. standing/no-aim => deltas are all zero,
  // so every existing combat number is unchanged.
  const attackerStance = STANCES[normalizeStance(attacker.stance)];

  for (const user of targets) {
    const target = await getUser(db, user.username, 'Target');
    const targetMods = target.isNpc ? null : await getConditionAndGearModifiers(db, target.username);
    const calledShot = target.isNpc ? null : parseCalledShot(message);
    const targetStance = target.isNpc ? STANCES[DEFAULT_STANCE] : STANCES[normalizeStance(target.stance)];

    // Contest deltas: attacker stance hitBonus and (when aiming) the called-shot
    // accuracy penalty raise/lower the attacker; defender stance dodgeBonus
    // makes the defender harder to hit. Folded in before the [0.25, 0.95] clamp.
    let hitDelta = attackerStance.hitBonus;
    if (calledShot) {
      hitDelta -= CALLED_SHOT_HIT_PENALTY;
    }
    const dodgeDelta = targetStance.dodgeBonus;

    const speedContest = rollSpeedContest(attacker, target, attackerMods, targetMods, { hitDelta, dodgeDelta });
    if (!speedContest.hit) {
      attackMessages.push(`${user.username} dodged ${username}'s attack`);
      continue;
    }

    const { damage: baseDamage, isCriticalAttack } = await calculateAttackDamage(db, attacker, user.username, createdTick, attackerMods);
    // Damage modifiers: aimed head bonus, attacker stance damageBonus, and the
    // defender's stance damageTakenDelta. Floor at 0. standing => all zero.
    const headBonus = calledShot === 'head' ? CALLED_SHOT_HEAD_BONUS : 0;
    const damage = Math.max(0, baseDamage + headBonus + attackerStance.damageBonus + targetStance.damageTakenDelta);
    const damageResult = await applyBodyDamage(db, target, damage, {
      cause: `attack by ${username}`,
      row,
      col,
      targetLabel: calledShot
    });

    const attackedUser = await dbFirst(db, 'SELECT * FROM users WHERE username = ?', [user.username]);
    const remainingHealth = attackedUser ? attackedUser.health : 0;
    const wasKilled = damageResult.died;
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

// Plan 018c: abilities granted by a player's EQUIPPED items (an item template's
// grantsAbility), deduped to ids that resolve to a registered ability. Unioned
// into the usable set and the hotbar so gear can hand a class a verb.
export async function getGrantedAbilityIds(db, username) {
  const rows = await dbAll(
    db,
    'SELECT templateId FROM items WHERE ownerUsername = ? AND equippedPartId IS NOT NULL',
    [username]
  );
  const granted = [];
  for (const row of rows) {
    const template = getTemplate(row.templateId);
    const abilityId = template && template.grantsAbility;
    if (abilityId && getAbility(abilityId) && !granted.includes(abilityId)) {
      granted.push(abilityId);
    }
  }
  // Plan 019: abilities granted by unlocked progression-grid nodes ride the same
  // usable-set + hotbar channel as item-granted abilities.
  for (const abilityId of await getProgressionGrantedAbilityIds(db, username)) {
    if (!granted.includes(abilityId)) {
      granted.push(abilityId);
    }
  }
  return granted;
}

// The abilities a player may invoke right now: their innate class kit plus any
// abilities granted by equipped items (plan 018c) — actives only (passives are
// never activated). Async so the granted source can hit the DB.
async function getUsableAbilityIds(db, username, effectiveActor) {
  const candidateIds = [
    ...getInnateAbilityIds(effectiveActor.job),
    ...(await getGrantedAbilityIds(db, username))
  ];
  const usable = [];
  for (const id of candidateIds) {
    const ability = getAbility(id);
    if (ability && ability.kind !== 'passive' && !usable.includes(id)) {
      usable.push(id);
    }
  }
  return usable;
}

export async function validateClassSkillUse(db, { username, skillId, targetUsername }) {
  const actor = await getUser(db, username);
  const effectiveActor = getEffectiveUser(actor);
  const ability = getAbility(skillId);
  const usableIds = await getUsableAbilityIds(db, username, effectiveActor);

  if (!ability || !usableIds.includes(skillId)) {
    throw new ActionError(`${effectiveActor.job} cannot use that skill.`);
  }

  // Only abilities that aim at someone else validate a target. 'none' (room/no
  // target) and 'self' resolve to the actor and need no lookup.
  const target = getSkillTarget(username, targetUsername);
  if ((ability.target === 'ally' || ability.target === 'enemy') && target) {
    await getUser(db, target, 'Target');
  }

  return { actor, effectiveActor, target, ability };
}

async function tryHarmfulSkillHit(db, { effectiveActor, target, skillLabel, row, col }) {
  const targetUser = await getUser(db, target, 'Target');
  const speedContest = rollSpeedContest(effectiveActor, targetUser);
  if (speedContest.hit) {
    return true;
  }

  const message = `${target} dodged ${effectiveActor.username}'s ${skillLabel}.`;
  await insertSystemMessage(db, row, col, message, 'combat');
  return false;
}

export async function useClassSkill(db, { username, skillId, targetUsername, row, col, currentTick, phase }) {
  const { effectiveActor, target } = await validateClassSkillUse(db, { username, skillId, targetUsername });
  return runAbility(db, skillId, { username, effectiveActor, target, row, col, currentTick, phase });
}

// The ability resolver: behavior keyed by ability id, callable by any invoker (a
// player class skill today; an equipped item or an NPC tomorrow — plans 018c/021).
// Behavior parity with the per-class switch it replaced: identical formulas,
// messages, and message kinds. Validation and targeting happen in the caller.
export async function runAbility(db, abilityId, { username, effectiveActor, target, row, col, currentTick, phase }) {
  switch (abilityId) {
    case 'scrounge': {
      const gold = 1 + Math.max(1, Math.floor(effectiveActor.intelligence / 2));
      await dbRun(db, 'UPDATE users SET gold = gold + ? WHERE username = ?', [gold, username]);
      const message = `${username} scrounges up ${gold} gold.`;
      await insertSystemMessage(db, row, col, message, 'skill');
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
      await insertSystemMessage(db, row, col, message, 'support');
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
      await insertSystemMessage(db, row, col, message, 'skill');
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
        await insertSystemMessage(db, row, col, message, 'skill');
        return { message };
      }

      const amount = 2 + Math.floor(effectiveActor.intelligence / 4);
      await healUser(db, target, amount, row, col);
      const message = `${username} patches up ${target} for ${amount} health.`;
      await insertSystemMessage(db, row, col, message, 'support');
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
      await insertSystemMessage(db, row, col, message, 'skill');
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
      await insertSystemMessage(db, row, col, message, 'skill');
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
      await insertSystemMessage(db, row, col, message, 'skill');
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
      await insertSystemMessage(db, row, col, message, 'support');
      return { message };
    }
    case 'brace': {
      // Self only — ward the actor regardless of any selected target.
      await addStatusEffect(db, {
        username,
        source: username,
        effectType: 'ward',
        magnitude: 1,
        currentTick,
        duration: 3,
        row,
        col
      });
      const message = `${username} braces, warding themselves for 3 ticks.`;
      await insertSystemMessage(db, row, col, message, 'support');
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
  const nextStamina = Math.min(user.stamina, nextEffective.maxStamina);

  // Job and stamina update directly; the downward health clamp routes through
  // the body chokepoint so part HP and the invariant stay consistent.
  await dbRun(
    db,
    'UPDATE users SET job = ?, stamina = ? WHERE username = ?',
    [nextJob, nextStamina, username]
  );

  if (user.health > nextEffective.maxHealth) {
    const difference = user.health - nextEffective.maxHealth;
    await applyBodyDamage(db, { ...user, job: nextJob }, difference, {
      cause: 'the change of vocation',
      row,
      col
    });
  }

  const message = `${username} changes job to ${nextJob}.`;
  await insertSystemMessage(db, row, col, message);
  return { message, job: nextJob };
}

// Original-case argument text after a leading "/command" word, or '' if absent.
function commandRest(message, command) {
  const trimmed = message.trim();
  const rest = trimmed.slice(command.length);
  return rest.replace(/^\s+/, '');
}

export async function handleEquipCommand(db, username, row, col, message) {
  const rest = commandRest(message, '/equip');
  if (!rest) {
    throw new ActionError('Use /equip <item name>.');
  }
  const user = await getUser(db, username);
  const { item } = await equipItem(db, user, rest, row, col);
  return { equipped: item.name };
}

export async function handleUnequipCommand(db, username, row, col, message) {
  const rest = commandRest(message, '/unequip');
  if (!rest) {
    throw new ActionError('Use /unequip <item name or part>.');
  }
  const user = await getUser(db, username);
  const { item } = await unequipItem(db, user, rest, row, col);
  return { unequipped: item.name };
}

export async function handleTakeCommand(db, username, row, col, message) {
  const rest = commandRest(message, '/take');
  if (!rest) {
    throw new ActionError('Use /take <item name>.');
  }
  const { item } = await takeItem(db, username, rest, row, col);
  return { taken: item.name };
}

export async function handleDropCommand(db, username, row, col, message) {
  const rest = commandRest(message, '/drop');
  if (!rest) {
    throw new ActionError('Use /drop <item name>.');
  }
  const { item } = await dropOwnedItem(db, username, rest, row, col);
  return { dropped: item.name };
}

// Space-separated stance keys for usage/error messages, e.g. "standing,
// aggressive, guarding, crouched".
function stanceOptionList() {
  return Object.keys(STANCES).join(', ');
}

// Resolve the severed part the player named in /regrow, normalizing label
// spelling (underscores/case) the same way called shots do. Returns the live
// part row (the named, currently-severed part) plus context, or throws the
// appropriate validation ActionError. Shared by validate and perform so the
// two can't drift.
async function resolveRegrow(db, username, row, col, message) {
  const rest = commandRest(message, '/regrow').trim();
  if (!rest) {
    throw new ActionError('Use /regrow <part label>.');
  }
  // Map 'left_arm'/'RIGHT ARM' to the canonical label via parseCalledShot,
  // which matches any humanoid part label. Fall back to the raw text so the
  // not-a-part error path stays informative.
  const label = parseCalledShot(rest) || rest.toLowerCase();

  const worldDay = getWorldDay();
  const tickValue = await getCurrentTickValue(db);

  // Inn gate: room must be an inn today AND the player must have paid access.
  const access = await getRoomAccessState(db, username, row, col, tickValue, worldDay);
  assertAction(access.required, 'Regrowth rites require an inn.', 403);
  assertAction(access.paid, 'You must pay for inn access first.', 402);

  // One regrowth per player per worldDay (pseudo-room 0,0 — global per day).
  const cooldown = await dbFirst(
    db,
    `SELECT lastAppliedTick FROM roomEffectCooldowns
     WHERE username = ? AND roomRow = 0 AND roomCol = 0 AND effectType = ? AND worldDay = ?`,
    [username, REGROW_EFFECT_TYPE, worldDay]
  );
  assertAction(!cooldown, 'You can only regrow once per day.');

  const user = await getUser(db, username);
  assertAction((user.gold || 0) >= REGROW_GOLD_COST, 'Not enough gold for the rite.', 402);

  const parts = (await ensureBody(db, user)) || [];
  const part = parts.find(p => p.label === label);
  assertAction(part, 'No such body part.');
  assertAction(part.severed, 'That part is not severed.');

  return { user, part, worldDay, tickValue, label: part.label };
}

export async function validateRegrowCommand(db, username, row, col, message) {
  // All failure paths fire here (before spendStamina): bad part, not an inn,
  // unpaid, short on gold, already regrown today.
  await resolveRegrow(db, username, row, col, message);
}

// Dedicated regrow restorer — NOT applyBodyHeal (which skips severed parts).
// Restores the part to its BASE (un-fortified) maxHp, hp 1, un-severs it, and
// folds baseMaxHp back into users.maxHealth and 1 into users.health, keeping
// the invariant `users.maxHealth == Σ non-severed maxHp` exact. The limb
// regrows bare; re-equipping armor re-applies its bonus via plan 015.
async function restoreSeveredPart(db, username, part) {
  const base = Math.max(0, Math.floor(part.baseMaxHp || 0));
  await dbRun(
    db,
    'UPDATE bodyParts SET severed = 0, maxHp = ?, hp = 1 WHERE id = ?',
    [base, part.id]
  );
  await dbRun(
    db,
    'UPDATE users SET maxHealth = maxHealth + ?, health = health + 1 WHERE username = ?',
    [base, username]
  );
}

export async function handleRegrowCommand(db, username, row, col, message) {
  const { part, worldDay, tickValue, label } = await resolveRegrow(db, username, row, col, message);

  // Conditional gold decrement (plan 003 pattern) — only fires once and never
  // overdraws below zero.
  const goldUpdate = await dbRun(
    db,
    'UPDATE users SET gold = gold - ? WHERE username = ? AND gold >= ?',
    [REGROW_GOLD_COST, username, REGROW_GOLD_COST]
  );
  assertAction(changes(goldUpdate) > 0, 'Not enough gold for the rite.', 402);

  await restoreSeveredPart(db, username, part);
  // Stamp the per-day cooldown (pseudo-room 0,0).
  await upsertCooldown(db, username, 0, 0, REGROW_EFFECT_TYPE, tickValue, worldDay);

  const message_ = `${username}'s ${label} regrows, pale and new.`;
  await insertSystemMessage(db, row, col, message_);
  return { regrew: label };
}

export async function handleStanceCommand(db, username, row, col, message) {
  const rest = commandRest(message, '/stance').trim();
  if (!rest) {
    throw new ActionError(`Use /stance <${stanceOptionList()}>.`);
  }
  const requested = rest.split(/\s+/)[0].toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(STANCES, requested)) {
    throw new ActionError(`Unknown stance. Choose one of: ${stanceOptionList()}.`);
  }
  await getUser(db, username); // 404 if the user vanished
  await dbRun(db, 'UPDATE users SET stance = ? WHERE username = ?', [requested, username]);
  const message_ = `${username} takes a ${STANCES[requested].label} stance.`;
  await insertSystemMessage(db, row, col, message_);
  return { stance: requested };
}

// Resolve the shop stock line a /buy names, or throw the right ActionError.
// Shared by the /buy validate (so a bad buy spends no stamina) and the perform
// below, so the two can't drift. Returns the matched stock line + the per-day
// cooldown key.
async function resolveShopPurchase(db, username, row, col, itemName) {
  const worldDay = getWorldDay();
  const tickValue = await getCurrentTickValue(db);
  assertAction(roomHasEffect(row, col, tickValue, 'shop', worldDay), '/buy only works in a shop.');

  const stockItem = generateShopStock(row, col, worldDay).find(
    item => item.name.toLowerCase() === itemName.toLowerCase()
  );
  assertAction(stockItem, 'Not stocked here today.');

  // One of each stock line per player per room per day. effectType is namespaced
  // (`buy:<templateId>`) so it never collides with passive room effects.
  const effectType = `buy:${stockItem.templateId}`;
  const already = await dbFirst(
    db,
    `SELECT 1 AS hit FROM roomEffectCooldowns
     WHERE username = ? AND roomRow = ? AND roomCol = ? AND effectType = ? AND worldDay = ?`,
    [username, row, col, effectType, worldDay]
  );
  assertAction(!already, 'Sold out for you today.');

  return { stockItem, effectType, worldDay, tickValue };
}

export async function validateBuyCommand(db, username, row, col, message) {
  const rest = commandRest(message, '/buy').trim();
  assertAction(rest, 'Usage: /buy <item name>');
  const { stockItem } = await resolveShopPurchase(db, username, row, col, rest);
  const user = await getUser(db, username);
  assertAction((user.gold || 0) >= stockItem.price, 'Not enough gold.', 402);
}

export async function buyShopItem(db, username, row, col, itemName) {
  const { stockItem, effectType, worldDay, tickValue } = await resolveShopPurchase(db, username, row, col, itemName);

  // Atomic spend (plan 003): the conditional WHERE re-validates gold under
  // concurrency. The cooldown is written only AFTER a successful spend, so a
  // failed payment never burns the player's once-per-day slot for this item.
  const spend = await dbRun(
    db,
    'UPDATE users SET gold = gold - ? WHERE username = ? AND gold >= ?',
    [stockItem.price, username, stockItem.price]
  );
  assertAction(changes(spend) > 0, 'Not enough gold.', 402);

  await upsertCooldown(db, username, row, col, effectType, tickValue, worldDay);
  await createItemForOwner(db, stockItem.templateId, username);
  await insertSystemMessage(db, row, col, `${username} buys ${stockItem.name} for ${stockItem.price} gold.`);
  return { bought: stockItem.name, price: stockItem.price };
}

export async function handleBuyCommand(db, username, row, col, message) {
  const rest = commandRest(message, '/buy').trim();
  assertAction(rest, 'Usage: /buy <item name>');
  return buyShopItem(db, username, row, col, rest);
}

export async function handleChatAction(db, username, row, col, message) {
  if (message.trim().toLowerCase().startsWith('/stance')) {
    return runPlayerAction(db, {
      username,
      staminaCost: 1,
      perform: async () => handleStanceCommand(db, username, row, col, message),
      advanceTick: () => advanceGlobalTick(db)
    });
  }

  if (message.trim().toLowerCase().startsWith('/regrow')) {
    return runPlayerAction(db, {
      username,
      staminaCost: 20,
      validate: async () => validateRegrowCommand(db, username, row, col, message),
      perform: async () => handleRegrowCommand(db, username, row, col, message),
      advanceTick: () => advanceGlobalTick(db)
    });
  }

  if (message.trim().toLowerCase().startsWith('/roll')) {
    return runPlayerAction(db, {
      username,
      staminaCost: 1,
      validate: async () => validateRollCommand(db, username, row, col, message),
      perform: async () => handleRollCommand(db, username, row, col, message),
      advanceTick: () => advanceGlobalTick(db)
    });
  }

  if (message.trim().toLowerCase().startsWith('/equip')) {
    return runPlayerAction(db, {
      username,
      staminaCost: 1,
      perform: async () => handleEquipCommand(db, username, row, col, message),
      advanceTick: () => advanceGlobalTick(db)
    });
  }

  if (message.trim().toLowerCase().startsWith('/unequip')) {
    return runPlayerAction(db, {
      username,
      staminaCost: 1,
      perform: async () => handleUnequipCommand(db, username, row, col, message),
      advanceTick: () => advanceGlobalTick(db)
    });
  }

  if (message.trim().toLowerCase().startsWith('/take')) {
    return runPlayerAction(db, {
      username,
      staminaCost: 1,
      perform: async () => handleTakeCommand(db, username, row, col, message),
      advanceTick: () => advanceGlobalTick(db)
    });
  }

  if (message.trim().toLowerCase().startsWith('/drop')) {
    return runPlayerAction(db, {
      username,
      staminaCost: 1,
      perform: async () => handleDropCommand(db, username, row, col, message),
      advanceTick: () => advanceGlobalTick(db)
    });
  }

  if (message.trim().toLowerCase().startsWith('/buy')) {
    return runPlayerAction(db, {
      username,
      staminaCost: 1,
      validate: async () => validateBuyCommand(db, username, row, col, message),
      perform: async () => handleBuyCommand(db, username, row, col, message),
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

// Called-shot pre-flight: if the attacker named a part, at least one player
// target must have that part non-severed, else the aim is rejected BEFORE any
// stamina is spent. NPC targets have no parts and never satisfy the aim. This
// runs inside handleAttackAction's `validate`, so the throw happens before
// spendStamina in runPlayerAction.
async function validateCalledShot(db, message, targets) {
  const calledShot = parseCalledShot(message);
  if (!calledShot) {
    return;
  }
  let aimable = false;
  for (const target of targets) {
    const full = await getUser(db, target.username, 'Target');
    if (full.isNpc) {
      continue;
    }
    // ensureBody instantiates the part rows if the target has never been read,
    // so a fresh target's intact limb is aimable.
    const parts = (await ensureBody(db, full)) || [];
    const part = parts.find(p => p.label === calledShot);
    if (part && !part.severed) {
      aimable = true;
      break;
    }
  }
  assertAction(aimable, 'There is nothing left to aim at.');
}

export async function handleAttackAction(db, username, row, col, message) {
  return runPlayerAction(db, {
    username,
    staminaCost: 1,
    validate: async () => {
      const targets = await validateAttackTargets(db, message, row, col, username);
      await validateCalledShot(db, message, targets);
      return targets;
    },
    perform: async () => {
      const deferredSystemMessages = [];
      const updatedMessage = await handleAttack(db, username, message, row, col, { deferredSystemMessages });
      await insertMessage(db, row, col, username, updatedMessage);
      for (const deferred of deferredSystemMessages) {
        await insertSystemMessage(db, row, col, deferred.message, deferred.kind);
      }
      await awardGoldMaybe(db, username);
      await updateLevel(db, username, row, col);
      return { updatedMessage };
    },
    advanceTick: () => advanceGlobalTick(db)
  });
}

export async function handleSkillAction(db, username, row, col, skillId, targetUsername, actionTick, incantation = '') {
  // Plan 018c: cost is data-driven — base plus any linguistic surcharge from the
  // typed incantation. Every ability defaults to 1 stamina with no prose, so this
  // is parity today; plan 012 supplies linguistic abilities and the prose path.
  const staminaCost = resolveAbilityStaminaCost(getAbility(skillId), { text: incantation });
  return runPlayerAction(db, {
    username,
    staminaCost,
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
