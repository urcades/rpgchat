// Room presence rows & occupant listing (mechanical split of world.mjs).

import {
  HUMANOID_PLAN,
  PRESENCE_MAX_AGE_SECONDS,
  getBodyPlan,
  getWorldDay
} from './shared.mjs';
import { dbAll, dbRun } from '../db.mjs';
import { getCurrentTickValue } from './clock.mjs';

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
