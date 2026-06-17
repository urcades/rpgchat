// World, rooms, ecology, presence, world-events & NPC spawning (plan adv-005).
//
// Extracted verbatim from the original worker/game.mjs — a pure mechanical move.
// Cross-seam dependencies are now explicit imports; cycles between seams resolve
// through ESM live bindings (every cross-seam reference is call-time, never
// dereferenced at module load).

import {
  AMBIENT_HOSTILE_RESPAWN_INTERVAL,
  ActionError,
  CORPSE_CULL_TICKS,
  CORPSE_FRESH_TICKS,
  CORPSE_ROTTEN_TICKS,
  HUMANOID_PLAN,
  INN_ACCESS_TYPE,
  PASSIVE_EFFECT_TYPES,
  PRESENCE_MAX_AGE_SECONDS,
  applyPassiveEffectToUser,
  applyPhaseToFeatures,
  assertAction,
  buildAffixRoll,
  calculateInnFee,
  composeRoomDescription,
  eliteDisplayName,
  generateDailyWorldEvents,
  generateRoomFeatures,
  getAbility,
  getBodyPlan,
  getEffectiveUser,
  getItemCategory,
  getItemSockets,
  getNextResetAt,
  getPhaseFromTick,
  getRoomEffectPayload,
  getWorldDay,
  partCondition,
  resolveCreatureBodyPlanId,
  resolveGamblingRound,
  rollAffixes,
  scaleNpcStats,
  shouldApplyEffect,
  summarizeTraces
} from './shared.mjs';
import { changes, dbAll, dbFirst, dbRun } from '../db.mjs';
import { elapsedMs, logEvent, measureAsync, nowMs } from '../observability.mjs';
import {
  applyBodyDamage,
  applyBodyHeal,
  ensureBody,
  getBodyParts,
  getConditionAndGearModifiers,
  parseItemModifiers,
  processStatusEffects
} from './body.mjs';
import { descendTowardDeath, isIncapacitated, processIncapacitationBleed } from './death.mjs';
import { getEquippedModifiers, getFloorItems, getInventory } from './inventory.mjs';
import { getMessages, insertSystemMessage } from './messages.mjs';
import { getGrantedAbilityIds, recoverStaminaForAllUsers, upsertCooldown } from './progression.mjs';


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
  // Plan 023b: the incapacitated can't crawl to another room. Staying put
  // (distance 0 — the presence heartbeat) is allowed, so the prone body stays
  // visible to the room and keeps bleeding where it fell.
  if (distance >= 1 && await isIncapacitated(db, username)) {
    return { allowed: false, from: position, incapacitated: true };
  }
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
    throw new ActionError(movement.incapacitated ? 'You are incapacitated — you cannot move.' : 'Too far to walk there.', 403);
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
  // Plan 013b: social NPCs are anchored to their spawn day; clear yesterday's cast.
  await dbRun(
    db,
    "DELETE FROM users WHERE isNpc = 1 AND npcKind = 'social' AND (npcWorldDay IS NULL OR npcWorldDay != ?)",
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

// Plan 024-fix: the aimable body-part labels for one occupant, derived from its
// body PLAN (the single source of truth), not from instantiated bodyParts rows —
// an NPC body is lazy, so a freshly-spawned hostile has no rows yet, but its plan
// is always knowable. A player (isNpc falsy) is humanoid; a bodied NPC resolves
// its creatureBodyPlan to a plan and lists its labels; a bodyless NPC (NULL plan)
// returns [] (no parts to aim at — matching the server's own called-shot gate in
// combat.mjs, which only accepts a targetPart for a bodied target).
function aimPartsForOccupant(occupant) {
  const plan = occupant.isNpc ? getBodyPlan(occupant.creatureBodyPlan) : HUMANOID_PLAN;
  if (!plan) {
    return [];
  }
  return plan.map(part => part.label);
}

export async function getRoomPresence(db, row, col, worldDay) {
  const occupants = await dbAll(
    db,
    `SELECT rp.username,
            COALESCE(u.displayName, rp.username) AS displayName,
            u.job,
            u.level,
            u.isNpc,
            u.npcKind,
            u.worldEventId,
            u.incapacitated,
            u.deathClock,
            u.disposition,
            u.role,
            u.health,
            u.creatureBodyPlan,
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
  // Attach the aimable parts purely additively — every existing field is kept, so
  // the combat loop / ally resolver that read these rows are unaffected. dbAll
  // already unwraps to a plain array, so the shape callers depend on is preserved.
  for (const occupant of occupants) {
    occupant.aimParts = aimPartsForOccupant(occupant);
  }
  return occupants;
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

// Plan 021 (BOLD): turn a base hostile template into a spawn-ready one. Three layers,
// all derived from the BASE displayName (so the body plan + the combat trait maps keyed
// by base name still resolve — the affix prefix is applied to displayName LAST):
//   1) creatureBodyPlan — resolveCreatureBodyPlanId gives EVERY hostile a body (known
//      creatures get a tailored plan; unmapped hostiles default to 'brute').
//   2) scaled stats — scaleNpcStats inflates stored health/strength by level.
//   3) affixes — rollAffixes (deterministic via `random`) picks an elite's 1–2 affixes;
//      their stat/element deltas fold into the template, their names become a stored JSON
//      column + a displayName prefix ("Vicious Frost Wyrm"), and their spawn-time body
//      riders (extra parts, part-maxHp fortification) ride the stored affixes column —
//      ensureBody reads it back and shapes the body to match.
// `random` is injectable so spawn tests can pin the affix roll (the 004 RNG convention).
function decorateNpcTemplate(template, random = Math.random) {
  const baseName = template.displayName;
  const creatureBodyPlan = resolveCreatureBodyPlanId(baseName);
  const scaled = scaleNpcStats(template, template.level);
  const roll = rollAffixes(scaled.level, random);
  const withAffixes = roll.applyTemplate(scaled);
  const displayName = eliteDisplayName(baseName, roll.prefix);
  return {
    ...withAffixes,
    displayName,
    creatureBodyPlan,
    // Stored as a JSON array of affix names; null when not an elite (no column noise). The
    // intrinsic element a Rending affix grants is NOT stored separately — the combat seam
    // re-derives it from this affixes column (creatureElementFor), keeping one source.
    affixes: roll.affixes.length ? JSON.stringify(roll.affixes) : null
  };
}

function npcTemplateFor(event, suffix) {
  if (event.eventType === 'raid' && suffix === 'boss') {
    return {
      username: npcUsername(event.id, 'boss'),
      displayName: 'Frost Wyrm',
      npcKind: 'raid_boss',
      level: 6,
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
      level: 2,
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
      level: 3,
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
    level: 1,
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
  // Plan 021 (BOLD): persist the body plan + affixes. A caller that passes neither (e.g.
  // a direct-construction test, or any legacy path) writes NULL/NULL — the lazy/no-backfill
  // contract: such an NPC stays scalar (NULL plan) and the body gate skips it, EXACTLY
  // today's behavior. maxHealth mirrors the (possibly level-scaled) health at birth.
  await dbRun(
    db,
    `INSERT OR IGNORE INTO users
      (username, password, job, health, maxHealth, stamina, maxStamina, speed, strength, intelligence, level, gold,
       experience, isNpc, displayName, npcKind, worldEventId, disposition, creatureBodyPlan, affixes)
     VALUES (?, 'npc', 'Novice', ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 1, ?, ?, ?, 'hostile', ?, ?)`,
    [
      npc.username,
      npc.health,
      npc.maxHealth ?? npc.health,
      npc.stamina ?? 100,
      npc.stamina ?? 100,
      npc.speed,
      npc.strength,
      npc.intelligence,
      npc.level ?? 0,
      npc.displayName,
      npc.npcKind,
      npc.worldEventId,
      npc.creatureBodyPlan ?? null,
      npc.affixes ?? null
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

// Plan 013b: the living social cast. Friendly/neutral NPCs that inhabit a room by its
// daily archetype — a pub gets a bartender, a barmaid, a patron, a guard. Each carries a
// REAL job (so 013d reuses the player skill path), a disposition (so they sit out combat
// until provoked — 013c), and a role (dialogue demeanor + fallback lines). They are
// anchored to the worldDay and culled on the daily reset, exactly like rooms.
const SOCIAL_NAME_POOLS = {
  bartender: ['Hask', 'Bryn', 'Old Pell'],
  barmaid: ['Sil', 'Mara', 'Joss'],
  patron: ['a sodden regular', 'a hooded drinker', 'a quiet dicer'],
  guard: ['Bren', 'Tovin', 'the house guard'],
  clerk: ['Auria', 'the guild clerk'],
  healer: ['Sister Maeve', 'Brother Aldric', 'a robed acolyte']
};
const SOCIAL_ROSTERS = {
  tavern: [
    { role: 'bartender', job: 'Fighter', disposition: 'neutral', level: 3 },
    { role: 'barmaid', job: 'Novice', disposition: 'friendly', level: 1 },
    { role: 'patron', job: 'Novice', disposition: 'friendly', level: 1 },
    { role: 'guard', job: 'Fighter', disposition: 'neutral', level: 4 },
    // Plan 013d: a kindly cleric nursing an ale — can raise you if asked (and able).
    { role: 'healer', job: 'Cleric', disposition: 'friendly', level: 3 }
  ],
  guild: [
    { role: 'clerk', job: 'Novice', disposition: 'friendly', level: 1 },
    { role: 'guard', job: 'Fighter', disposition: 'neutral', level: 4 },
    { role: 'healer', job: 'Cleric', disposition: 'friendly', level: 3 }
  ]
};

function socialArchetypeFor(row, col, tickValue, worldDay) {
  if (roomHasEffect(row, col, tickValue, 'pub', worldDay) || roomHasEffect(row, col, tickValue, 'inn', worldDay)) return 'tavern';
  if (roomHasEffect(row, col, tickValue, 'guild', worldDay)) return 'guild';
  return null;
}

function socialNpcName(role, row, col, index) {
  const pool = SOCIAL_NAME_POOLS[role] || [role];
  return pool[(row + col + index) % pool.length];
}

async function createSocialNpc(db, { username, displayName, role, job, disposition, level, row, col, worldDay, tick }) {
  // Plan 021/social-bodies: social NPCs get a body plan too, so a provoked-into-hostility
  // barmaid/guard/patron is aimable for called shots (matching the hostile spawn path).
  // They are humanoid — resolveCreatureBodyPlanId on their human-ish names yields the
  // default 'brute' (= the humanoid plan). affixes stays NULL (social NPCs aren't elites).
  await dbRun(
    db,
    `INSERT OR IGNORE INTO users
      (username, password, job, health, maxHealth, stamina, maxStamina, speed, strength, intelligence, level, gold,
       experience, isNpc, displayName, npcKind, disposition, role, npcWorldDay, creatureBodyPlan)
     VALUES (?, 'npc', ?, 24, 24, 100, 100, 4, 5, 3, ?, 0, 0, 1, ?, 'social', ?, ?, ?, ?)`,
    [username, job, level, displayName, disposition, role, worldDay, resolveCreatureBodyPlanId(displayName)]
  );
  await dbRun(
    db,
    `INSERT INTO roomPresence (username, roomRow, roomCol, lastSeenTick, worldDay, lastSeenAt)
     VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(username, worldDay) DO UPDATE SET
       roomRow = excluded.roomRow, roomCol = excluded.roomCol,
       lastSeenTick = excluded.lastSeenTick, lastSeenAt = CURRENT_TIMESTAMP`,
    [username, row, col, tick, worldDay]
  );
}

// Lazily populate a social room when a human is present and it is under-staffed. Idempotent
// (deterministic per-day usernames + INSERT OR IGNORE), cheap (runs only when a human enters
// a social room), and self-clearing on the daily reset. Returns { spawned, archetype }.
export async function ensureSocialPopulation(db, row, col) {
  const worldDay = getWorldDay();
  const tick = await getCurrentTickValue(db);
  const archetype = socialArchetypeFor(row, col, tick, worldDay);
  if (!archetype) return { spawned: 0, archetype: null };
  const roster = SOCIAL_ROSTERS[archetype] || [];

  // Alive only when observed — never populate an empty room.
  const presence = await getRoomPresence(db, row, col, worldDay);
  if (!presence.some(p => !p.isNpc)) return { spawned: 0, archetype };

  const present = new Set(presence.filter(p => p.isNpc && p.npcKind === 'social').map(p => p.username));
  // Plan 013f: a slot whose NPC was killed today stays dead until the daily reset — don't
  // resurrect it on the next presence heartbeat (the bug where slain NPCs popped back).
  const deadRows = await dbAll(
    db,
    "SELECT username FROM roomEffectCooldowns WHERE effectType = 'npc_dead' AND roomRow = ? AND roomCol = ? AND worldDay = ?",
    [row, col, worldDay]
  );
  const dead = new Set(deadRows.map(r => r.username));

  let spawned = 0;
  for (let i = 0; i < roster.length; i += 1) {
    const entry = roster[i];
    const username = `soc:${worldDay}:${row}:${col}:${entry.role}:${i}`;
    if (present.has(username) || dead.has(username)) continue;
    await createSocialNpc(db, {
      username,
      displayName: socialNpcName(entry.role, row, col, i),
      role: entry.role,
      job: entry.job,
      disposition: entry.disposition,
      level: entry.level,
      row,
      col,
      worldDay,
      tick
    });
    spawned += 1;
  }
  return { spawned, archetype };
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
    // Plan 021 (BOLD): decorate every spawned hostile — a body plan, level-scaled stats,
    // and (for elites) affixes — BEFORE persisting. canSpawnEventNpc keys on the stable
    // username (untouched by decoration), so respawn gating is unchanged.
    const decorated = decorateNpcTemplate(template);
    const npc = {
      ...decorated,
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
    'SELECT username, job, health, maxHealth, stamina, maxStamina, speed, strength, intelligence, level, gold, experience, attributePoints, skillPoints, displayName, stance, incapacitated, deathClock FROM users WHERE username = ? AND isNpc = 0',
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
    // Plan 023b: a hazard downs rather than entombs — the passive bleed finishes them.
    await descendTowardDeath(db, presence.username, {
      cause: effect.type.replace(/_/g, ' '),
      row: presence.roomRow,
      col: presence.roomCol,
      blowDamage: 0,
      currentTick
    });
    presence.health = 0;
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

// Plan 022 (tail): age corpses and remains by their decayTick each world pulse.
// Two populations share the decayTick clock but decay VERY differently:
//
//   MONSTER remains (monster_remains → rotten_remains → bones): rewritten in place
//   (templateId + name) at each stage, then CULLED (DELETE) at the bones-age cap so
//   floors don't fill with bones. The rotten stage stays edible — a raw /eat poisons.
//
//   PLAYER corpses (player_corpse): COSMETIC ONLY (owner decision). Renamed to
//   "<player>'s Skeletal Remains" once aged, but NEVER deleted and corpseOf is ALWAYS
//   kept — the resurrection anchor must persist indefinitely. Decay must NOT
//   permadeath; only a deliberate /eat or destroy (unchanged) severs the tether.
export async function processCorpseDecay(db, tickValue = null) {
  const tick = tickValue === null ? await getCurrentTickValue(db) : tickValue;
  const decaying = await dbAll(
    db,
    `SELECT id, templateId, name, corpseOf, decayTick
     FROM items
     WHERE decayTick IS NOT NULL
       AND templateId IN ('monster_remains', 'rotten_remains', 'bones', 'player_corpse')`
  );

  for (const item of decaying) {
    const age = tick - item.decayTick;
    if (age < CORPSE_FRESH_TICKS) {
      continue; // still fresh — nothing to do
    }

    if (item.templateId === 'player_corpse') {
      // Cosmetic-only: once aged, rename to skeletal remains. NEVER delete; NEVER
      // touch corpseOf or templateId — the resurrection anchor is sacrosanct. Only
      // rename once (idempotent) so we don't rewrite every pulse.
      if (item.corpseOf) {
        const skeletalName = `${item.corpseOf}'s Skeletal Remains`;
        if (item.name !== skeletalName) {
          await dbRun(db, 'UPDATE items SET name = ? WHERE id = ?', [skeletalName, item.id]);
        }
      }
      continue;
    }

    // Monster remains: cull at the bones-age cap, else advance the stage in place.
    if (age >= CORPSE_CULL_TICKS) {
      await dbRun(db, 'DELETE FROM items WHERE id = ?', [item.id]);
      continue;
    }
    if (age >= CORPSE_FRESH_TICKS + CORPSE_ROTTEN_TICKS) {
      if (item.templateId !== 'bones') {
        await dbRun(db, "UPDATE items SET templateId = 'bones', name = 'Bones' WHERE id = ?", [item.id]);
      }
      continue;
    }
    // FRESH..(FRESH+ROTTEN): rotten.
    if (item.templateId !== 'rotten_remains') {
      await dbRun(db, "UPDATE items SET templateId = 'rotten_remains', name = 'Rotten Remains' WHERE id = ?", [item.id]);
    }
  }
}

// adv-013 (the COST split): advancing the tick and running the world sweeps are now
// two separable steps. The increment is the cheap, always-synchronous part (it carries
// the combat cadence — every action and every 5s hostile alarm bumps it, and NPC turn
// logic reads its parity); the five global sweeps are the EXPENSIVE part that scans the
// whole world and must NOT fan out K× per 5s window.

// The cheap part: bump the global tick by one and report the new value. Runs NO sweeps,
// so it is safe in the synchronous request-latency path (the per-action advanceTick
// callback) and is the first thing every tick driver does. `staminaUpdated` mirrors the
// every-3rd-tick stamina cadence the sweep applies, so a caller can still report it.
export async function advanceTickOnly(db) {
  await dbRun(db, 'UPDATE tick SET value = value + 1 WHERE id = 1');
  const tickValue = await getCurrentTickValue(db);
  return {
    tick: tickValue,
    staminaUpdated: tickValue % 3 === 0
  };
}

// The expensive part: the five GLOBAL sweeps (+ the every-3rd-tick stamina recovery),
// extracted verbatim from the original advanceGlobalTick. Pure cadence-preservers — every
// per-tick effect (room hazards, the incap bleed, corpse decay, status ticks, gambling
// resolution, stamina recovery) keeps the EXACT schedule it had inside advanceGlobalTick;
// only WHERE/HOW-OFTEN this block runs changes (see claimWorldSweep). `tickValue` is passed
// in (never re-read) so the sweep operates on the same tick the increment produced, even
// when the claim runs slightly later (e.g. deferred after the response).
export async function runWorldSweeps(db, tickValue) {
  if (tickValue % 3 === 0) {
    await recoverStaminaForAllUsers(db);
  }

  await processRoomEffects(db, tickValue);
  await processIncapacitationBleed(db, tickValue);
  await processCorpseDecay(db, tickValue);
  await processStatusEffects(db, tickValue);
  await resolveExpiredGamblingRounds(db, tickValue);
}

// adv-013 (the DEDUP claim): only the FIRST caller in a given tick-window runs the global
// sweeps; the rest skip. With K hostile rooms the tick advances K+1×/5s and EACH advance
// used to run all five world-scanning sweeps — ~5K scans/window. The claim collapses that
// to ONE sweep per window. The marker reuses roomEffectCooldowns (NO migration): a sentinel
// row (pseudo-user '__world_sweep', pseudo-room 0,0, keyed by worldDay so the daily reset
// sweeps it like every other cooldown). The conditional UPDATE ... WHERE lastAppliedTick <
// tickValue is atomic per statement, so exactly one concurrent caller flips it and sees
// changes()==1; a later caller in the SAME tick is a no-op (changes()==0 → skip). A higher
// tick always wins, so a fresh window always re-claims. Returns true iff THIS caller won.
const WORLD_SWEEP_SENTINEL_USER = '__world_sweep';
const WORLD_SWEEP_EFFECT_TYPE = 'world_sweep';

export async function claimWorldSweep(db, tickValue, worldDay = getWorldDay()) {
  // Seed the row once (cheap, idempotent) with a sentinel below any real tick so the very
  // first claim's conditional UPDATE matches. INSERT OR IGNORE never clobbers an existing
  // marker, so a concurrent seed can't reset a claim already won this window.
  await dbRun(
    db,
    `INSERT OR IGNORE INTO roomEffectCooldowns
      (username, roomRow, roomCol, effectType, lastAppliedTick, worldDay)
     VALUES (?, 0, 0, ?, -1, ?)`,
    [WORLD_SWEEP_SENTINEL_USER, WORLD_SWEEP_EFFECT_TYPE, worldDay]
  );
  const claim = await dbRun(
    db,
    `UPDATE roomEffectCooldowns
     SET lastAppliedTick = ?
     WHERE username = ?
       AND roomRow = 0
       AND roomCol = 0
       AND effectType = ?
       AND worldDay = ?
       AND lastAppliedTick < ?`,
    [tickValue, WORLD_SWEEP_SENTINEL_USER, WORLD_SWEEP_EFFECT_TYPE, worldDay, tickValue]
  );
  return changes(claim) > 0;
}

// adv-013: the deduped tick driver for the high-fan-out paths (the per-5s hostile-room
// alarm; the cron pulse). Advances the tick cheaply, then runs the world sweeps ONLY if
// this caller is the first in the window — so K alarms fire the sweeps once, not K×. Keeps
// advanceGlobalTick's return shape so its callers are byte-identical.
export async function advanceTickAndMaybeSweep(db) {
  const tick = await advanceTickOnly(db);
  if (await claimWorldSweep(db, tick.tick)) {
    await runWorldSweeps(db, tick.tick);
  }
  return tick;
}

// adv-013: the deferred-sweep entry for the per-ACTION path. The action's advanceTick
// callback now only bumps the tick (advanceTickOnly) so the five world scans leave the
// synchronous request-latency path; the route then calls this from its existing
// runAfterResponse/waitUntil tail. It claims-then-sweeps on the tick the action produced,
// so a player acting in a calm room (no alarm) still gets the per-tick effects on their
// action cadence — but deduped against the alarm and other concurrent actions, never K×.
// `tickValue` may be null/undefined (a path that didn't advance) → no-op.
export async function runDeferredWorldSweeps(db, tickValue) {
  if (tickValue === null || tickValue === undefined) {
    return false;
  }
  if (!(await claimWorldSweep(db, tickValue))) {
    return false;
  }
  await runWorldSweeps(db, tickValue);
  return true;
}

// Compatibility wrapper (kept for the existing callers/tests that drive the tick AND its
// sweeps in one synchronous call — the cron pulse and the combat hostile alarm via
// runHostileRoomAction, plus the suite's direct advanceGlobalTick callers). The increment
// happens FIRST exactly as before (NPC parity tests read the bumped tick), then the sweeps
// run UNCONDITIONALLY here — this wrapper is the un-deduped, run-everything path, so its
// behavior is identical to the original. The dedup lives in the variants above.
export async function advanceGlobalTick(db) {
  const tick = await advanceTickOnly(db);
  await runWorldSweeps(db, tick.tick);
  return tick;
}

export async function runScheduledWorldPulse(db) {
  const worldDay = getWorldDay();
  await cleanupOldWorldDayData(db, worldDay);
  // adv-013: the cron (every ~1 min) advances the tick and runs the global sweeps via the
  // SAME deduped claim as the hostile alarm. As the dominant low-frequency driver it
  // normally wins its own window; if a 5s alarm already swept this exact tick, the claim is
  // a no-op and the cron skips a redundant world scan (the tick still advanced). The cron
  // remains the safety net that drives the sweeps for rooms with no active alarm at all.
  const tick = await advanceTickAndMaybeSweep(db);
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
       AND (u.disposition IS NULL OR u.disposition = 'hostile')
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
       AND (u.health > 0 OR u.incapacitated = 1)
       AND rp.roomRow = ?
       AND rp.roomCol = ?
       AND rp.worldDay = ?
       AND rp.lastSeenAt >= datetime('now', ?)
     LIMIT 1`,
    [row, col, worldDay, `-${PRESENCE_MAX_AGE_SECONDS} seconds`]
  );
  return Boolean(hostiles && players);
}

// Plan 013f: the room's background loop should run when there's combat OR when a present
// human shares the room with social NPCs (so they chatter proactively). Drives the DO alarm.
export async function roomNeedsLoop(db, row, col) {
  if (await roomHasActiveHostiles(db, row, col)) {
    return true;
  }
  const worldDay = getWorldDay();
  const human = await dbFirst(
    db,
    `SELECT 1 FROM users u JOIN roomPresence rp ON rp.username = u.username
     WHERE u.isNpc = 0 AND (u.health > 0 OR u.incapacitated = 1)
       AND rp.roomRow = ? AND rp.roomCol = ? AND rp.worldDay = ?
       AND rp.lastSeenAt >= datetime('now', ?) LIMIT 1`,
    [row, col, worldDay, `-${PRESENCE_MAX_AGE_SECONDS} seconds`]
  );
  if (!human) {
    return false;
  }
  const social = await dbFirst(
    db,
    `SELECT 1 FROM users u JOIN roomPresence rp ON rp.username = u.username
     WHERE u.isNpc = 1 AND u.npcKind = 'social'
       AND rp.roomRow = ? AND rp.roomCol = ? AND rp.worldDay = ? LIMIT 1`,
    [row, col, worldDay]
  );
  return Boolean(social);
}

// Plan 024: the living leaderboard. Kills DERIVE from killHistory (the same
// correlated COUNT(*) the cemetery/death pages use) — no kills column, no
// migration. NPCs are excluded; the ranking is kills first (the point of the
// board), then level, then gold as tie-breakers.
export async function getLeaderboard(db) {
  return dbAll(
    db,
    `SELECT u.username, u.gold, u.level,
            (SELECT COUNT(*) FROM killHistory kh WHERE kh.killerUsername = u.username) AS kills
     FROM users u
     WHERE u.isNpc = 0
       AND u.username != 'System'
     ORDER BY kills DESC, u.level DESC, u.gold DESC`
  );
}
