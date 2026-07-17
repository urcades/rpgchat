// NPC spawning & daily world events (mechanical split of world.mjs).

import {
  AMBIENT_HOSTILE_RESPAWN_INTERVAL,
  eliteDisplayName,
  generateDailyWorldEvents,
  getWorldDay,
  resolveCreatureBodyPlanId,
  rollAffixes,
  scaleNpcStats
} from './shared.mjs';
import { dbAll, dbFirst, dbRun } from '../db.mjs';
import { getCurrentTickValue } from './clock.mjs';
import { roomHasEffect } from './ecology.mjs';
import { getRoomPresence } from './presence.mjs';

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
// adv PERF-04: once every roster slot for a (worldDay, room) is accounted for
// (alive in D1, or dead-today — which must NOT respawn), later 15s heartbeats
// have nothing to do; skip their presence-JOIN + cooldown reads entirely. The
// memo is per-isolate AND per-db-handle (WeakMap): a fresh isolate re-runs the
// check once and re-converges — the pre-memo behavior, not a correctness risk —
// and independent databases (each test's in-memory D1) never see each other's
// staffed marks.
const staffedRoomsByDb = new WeakMap();

export async function ensureSocialPopulation(db, row, col) {
  const worldDay = getWorldDay();
  const staffedKey = `${worldDay}:${row}:${col}`;
  let staffedRooms = staffedRoomsByDb.get(db);
  if (!staffedRooms) {
    staffedRooms = new Set();
    staffedRoomsByDb.set(db, staffedRooms);
  }
  if (staffedRooms.has(staffedKey)) {
    return { spawned: 0, archetype: null, staffed: true };
  }
  if (staffedRooms.size > 2048) staffedRooms.clear(); // day rollover hygiene
  const tick = await getCurrentTickValue(db);
  const archetype = socialArchetypeFor(row, col, tick, worldDay);
  if (!archetype) {
    staffedRooms.add(staffedKey);
    return { spawned: 0, archetype: null };
  }
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
  const spawnedNames = new Set();
  for (let i = 0; i < roster.length; i += 1) {
    const entry = roster[i];
    const username = `soc:${worldDay}:${row}:${col}:${entry.role}:${i}`;
    if (present.has(username) || dead.has(username)) continue;
    spawnedNames.add(username);
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
  // Every slot now alive or dead-today: nothing left for this room this
  // world-day, so heartbeats can skip the reads until the daily reset.
  const accounted = roster.every((entry, i) => {
    const username = `soc:${worldDay}:${row}:${col}:${entry.role}:${i}`;
    return present.has(username) || dead.has(username) || spawnedNames.has(username);
  });
  if (accounted) {
    staffedRooms.add(staffedKey);
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
