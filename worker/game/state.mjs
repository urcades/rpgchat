// Room/user state aggregators & leaderboard (mechanical split of world.mjs).

import {
  ActionError,
  PRESENCE_MAX_AGE_SECONDS,
  composeRoomDescription,
  getAbility,
  getEffectiveUser,
  getItemCategory,
  getItemSockets,
  getNextResetAt,
  getPhaseFromTick,
  getRoomEffectPayload,
  getWorldDay,
  partCondition,
  summarizeTraces
} from './shared.mjs';
import { dbAll, dbFirst } from '../db.mjs';
import { elapsedMs, logEvent, measureAsync, nowMs } from '../observability.mjs';
import {
  ensureBody,
  getConditionAndGearModifiers,
  parseItemModifiers
} from './body.mjs';
import { getCurrentTickValue } from './clock.mjs';
import { getRoomFeaturesForTick } from './ecology.mjs';
import { getEquippedModifiers, getFloorItems, getInventory } from './inventory.mjs';
import { getMessages } from './messages.mjs';
import { getGrantedAbilityIds } from './progression.mjs';
import { getRoomAccessState } from './access.mjs';
import { getRoomPresence } from './presence.mjs';

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

// adv-006: `access` may be a pre-resolved getRoomAccessState result threaded in
// by a caller that already computed it for THIS (user, room, tick) — requireRoomUse
// does, on the /room-state path — so the inn-access state is resolved once per
// request instead of twice (here AND in the gate). Omitted (the default) ⇒ resolve
// it inline exactly as before, so every other caller is byte-for-byte unchanged.
export async function getRoomEcology(db, username, row, col, worldDay = getWorldDay(), tickValue = null, access = null) {
  const currentTick = tickValue === null ? await getCurrentTickValue(db) : tickValue;
  const phase = getPhaseFromTick(currentTick);
  const features = getRoomFeaturesForTick(row, col, currentTick, worldDay);
  const [traces, resolvedAccess, activeRound, presence, event, groundItems] = await Promise.all([
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
    access === null ? getRoomAccessState(db, username, row, col, currentTick, worldDay) : Promise.resolve(access),
    getActiveRound(db, row, col, worldDay, currentTick),
    getRoomPresence(db, row, col, worldDay),
    getActiveRoomEvent(db, row, col, worldDay),
    getFloorItems(db, row, col)
  ]);
  const innAccess = resolvedAccess;
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

// adv-006: the room DESCRIPTION string in isolation — exactly the value
// getRoomEcology computes for its `description` field, but WITHOUT the five extra
// reads (inn access, gambling round, presence, active event, floor items) that
// the full ecology payload needs and the description does not. composeRoomDescription
// reads only { row, col, phase, features, traceSummary }; this assembles those from
// the same room-feature derivation and the same roomTraces query getRoomEcology uses,
// so the produced string is byte-identical. The NPC dialogue paths (which only ever
// read ecology.description) call this instead of building the whole payload.
export async function getRoomDescription(db, row, col, worldDay = getWorldDay(), tickValue = null) {
  const currentTick = tickValue === null ? await getCurrentTickValue(db) : tickValue;
  const phase = getPhaseFromTick(currentTick);
  const features = getRoomFeaturesForTick(row, col, currentTick, worldDay);
  const traces = await dbAll(
    db,
    `SELECT id, roomRow, roomCol, traceType, intensity, attacker, target, createdTick, expiryTick, worldDay, createdAt
     FROM roomTraces
     WHERE roomRow = ?
       AND roomCol = ?
       AND worldDay = ?
       AND (expiryTick IS NULL OR expiryTick >= ?)
     ORDER BY createdTick DESC, id DESC`,
    [row, col, worldDay, currentTick]
  );
  const traceSummary = summarizeTraces(traces);
  return composeRoomDescription({ row, col, phase, features, traceSummary });
}

// adv PERF-01: `scope: 'hud'` skips the character-sheet extras (all
// achievements, the 50-row kill log, the presence lookup) that the chat HUD
// never renders — getRoomState refetches this on every non-message broadcast,
// so combat rooms were paying 3 extra queries per event for discarded data.
// The default stays 'full' for /user-attributes and the character page.
export async function getUserState(db, username, { scope = 'full' } = {}) {
  const user = await dbFirst(
    db,
    'SELECT username, job, health, maxHealth, stamina, maxStamina, speed, strength, intelligence, level, gold, experience, attributePoints, skillPoints, displayName, stance, incapacitated, deathClock FROM users WHERE username = ? AND isNpc = 0',
    [username]
  );
  if (!user) {
    throw new ActionError('User Not Found', 404);
  }

  // ensureBody already returns the (possibly just-created) parts — don't re-read
  // them; and thread parts + gear into getConditionAndGearModifiers so the
  // modifier bundle doesn't re-run the same two sub-queries (this endpoint is the
  // hottest poll in the app).
  const bodyParts = (await ensureBody(db, user)) || [];
  const gearBonuses = await getEquippedModifiers(db, username);
  const combinedModifiers = await getConditionAndGearModifiers(db, username, { bodyParts, gear: gearBonuses });
  const effective = getEffectiveUser(user, combinedModifiers);
  const body = bodyParts.map(part => ({
    label: part.label,
    partType: part.partType,
    slotType: part.slotType,
    condition: partCondition(part),
    vital: Boolean(part.vital)
  }));
  const inventoryRows = await getInventory(db, username);
  // Carried items only — equipped show under `equipment`; socketed materia (plan
  // 020d) live inside a host, not loose in the bag.
  const inventory = inventoryRows
    .filter(row => (row.equippedPartId === null || row.equippedPartId === undefined) && !row.socketedInId)
    .map(row => ({
      name: row.name,
      slotType: row.slotType,
      rarity: row.rarity,
      category: getItemCategory(row.templateId),
      quantity: Number(row.quantity || 1),
      sockets: getItemSockets(row.templateId),
      modifiers: parseItemModifiers(row.modifiers)
    }));
  // Plan 020d: which materia sit in which host item (by host item id).
  const materiaByHost = new Map();
  for (const row of inventoryRows) {
    if (!row.socketedInId) continue;
    const list = materiaByHost.get(row.socketedInId) || [];
    list.push(row.name);
    materiaByHost.set(row.socketedInId, list);
  }
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
  // Plan 020d: socket summary for equipped gear that has sockets (read-only display).
  const socketSummary = [];
  for (const equipped of equippedByPartId.values()) {
    const sockets = getItemSockets(equipped.templateId);
    if (sockets > 0) {
      socketSummary.push({ host: equipped.name, sockets, materia: materiaByHost.get(equipped.id) || [] });
    }
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
  let achievements = [];
  let kills = [];
  let currentRoom = null;
  if (scope === 'full') {
    [achievements, kills] = await Promise.all([
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
    currentRoom = presence ? { row: presence.roomRow, col: presence.roomCol } : null;
  }

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
    socketSummary,
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

// adv-006: `access` threads the pre-resolved inn-access state requireRoomUse
// already produced (alongside tickValue) on the /room-state path into getRoomEcology,
// so getRoomAccessState runs once per request, not twice. Omitted ⇒ resolved inline
// (identical payload), so callers that don't have it pre-computed are unchanged.
export async function getRoomState(db, username, row, col, tickValue = null, access = null) {
  const stateStart = nowMs();
  const worldDay = getWorldDay();
  const tick = tickValue === null ? await getCurrentTickValue(db) : tickValue;
  const [roomResult, messagesResult, userResult] = await Promise.all([
    measureAsync(() => getRoomEcology(db, username, row, col, worldDay, tick, access)),
    measureAsync(() => getMessages(db, row, col, tick)),
    measureAsync(() => getUserState(db, username, { scope: 'hud' }))
  ]);
  const room = roomResult.value;
  const messages = messagesResult.value;
  const user = userResult.value;

  // Sampled: this fires on every poll/broadcast-driven refetch, so the steady
  // state stream is noise. Slow requests always log; the rest log at 10%.
  const durationMs = elapsedMs(stateStart);
  if (durationMs > 250 || Math.random() < 0.1) logEvent({
    event: 'room_state.complete',
    roomRow: row,
    roomCol: col,
    durationMs,
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

// One scan of the room's presence rows answers all three loop-gating questions
// the DO alarm / route tails used to ask with up to five separate probes:
// is a live hostile NPC here, is a fresh live (or downed) human here, and is a
// social NPC here. Each CASE reproduces its original probe's predicates exactly.
export async function getRoomLoopState(db, row, col) {
  const worldDay = getWorldDay();
  const state = await dbFirst(
    db,
    `SELECT
       MAX(CASE WHEN u.isNpc = 1 AND u.health > 0
                 AND (u.disposition IS NULL OR u.disposition = 'hostile')
            THEN 1 ELSE 0 END) AS hostiles,
       MAX(CASE WHEN u.isNpc = 0 AND (u.health > 0 OR u.incapacitated = 1)
                 AND rp.lastSeenAt >= datetime('now', ?)
            THEN 1 ELSE 0 END) AS humans,
       MAX(CASE WHEN u.isNpc = 1 AND u.npcKind = 'social' THEN 1 ELSE 0 END) AS social
     FROM roomPresence rp
     JOIN users u ON u.username = rp.username
     WHERE rp.roomRow = ?
       AND rp.roomCol = ?
       AND rp.worldDay = ?`,
    [`-${PRESENCE_MAX_AGE_SECONDS} seconds`, row, col, worldDay]
  );
  const hostiles = Boolean(state?.hostiles);
  const humans = Boolean(state?.humans);
  const social = Boolean(state?.social);
  return {
    hasActiveHostiles: hostiles && humans,
    needsLoop: (hostiles && humans) || (humans && social)
  };
}

export async function roomHasActiveHostiles(db, row, col) {
  return (await getRoomLoopState(db, row, col)).hasActiveHostiles;
}

// Plan 013f: the room's background loop should run when there's combat OR when a present
// human shares the room with social NPCs (so they chatter proactively). Drives the DO alarm.
export async function roomNeedsLoop(db, row, col) {
  return (await getRoomLoopState(db, row, col)).needsLoop;
}

// Plan 024: the living leaderboard. Kills DERIVE from killHistory — no kills
// column, no migration. NPCs are excluded; the ranking is kills first (the point
// of the board), then level, then gold as tie-breakers.
//
// adv-006: the per-row correlated `(SELECT COUNT(*) ...)` re-scanned killHistory
// once per user (O(users × killHistory)); a single pre-aggregated LEFT JOIN
// (idx_killHistory_killer-backed GROUP BY, one pass) yields the IDENTICAL counts
// in O(users + killHistory). COALESCE makes a killer with no rows 0 (the LEFT
// JOIN's NULL), exactly as the subquery's COUNT(*) returned 0. The sort is
// unchanged except for an added `username ASC` final tie-break so an all-equal
// tie (same kills/level/gold) is DETERMINISTIC rather than insertion-ordered.
// LIMIT 100 caps the payload (the board only renders a top slice anyway).
export async function getLeaderboard(db) {
  return dbAll(
    db,
    `SELECT u.username, u.gold, u.level,
            COALESCE(k.c, 0) AS kills
     FROM users u
     LEFT JOIN (
       SELECT killerUsername, COUNT(*) AS c
       FROM killHistory
       GROUP BY killerUsername
     ) k ON k.killerUsername = u.username
     WHERE u.isNpc = 0
       AND u.username != 'System'
     ORDER BY kills DESC, u.level DESC, u.gold DESC, u.username ASC
     LIMIT 100`
  );
}
