// Tick machinery, world sweeps & daily cleanup (mechanical split of world.mjs).

import {
  CORPSE_CULL_TICKS,
  CORPSE_FRESH_TICKS,
  CORPSE_ROTTEN_TICKS,
  PASSIVE_EFFECT_TYPES,
  PRESENCE_MAX_AGE_SECONDS,
  applyPassiveEffectToUser,
  getEffectiveUser,
  getPhaseFromTick,
  getWorldDay,
  resolveGamblingRound,
  shouldApplyEffect
} from './shared.mjs';
import { batchRows, changes, dbAll, dbBatch, dbFirst, dbRun } from '../db.mjs';
import { logEvent } from '../observability.mjs';
import { applyBodyDamage, applyBodyHeal, processStatusEffects, reconcileBodyHealthInvariant } from './body.mjs';
import { getCurrentTickValue } from './clock.mjs';
import { getActiveEffectsForRoom } from './ecology.mjs';
import { descendTowardDeath, processIncapacitationBleed } from './death.mjs';
import { insertSystemMessage } from './messages.mjs';
import { recoverStaminaForAllUsers, upsertCooldown } from './progression.mjs';
import { getRoomAccessState } from './access.mjs';
import { ensureDailyWorldEvents } from './population.mjs';

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
    // Payout, round close, and announcement land atomically in one round trip.
    await dbBatch(db, [
      ['UPDATE users SET gold = gold + ? WHERE username = ?', [result.pool, result.winner]],
      [`UPDATE gamblingRounds
        SET status = 'resolved',
            pool = ?,
            winner = ?,
            winningRoll = ?
        WHERE id = ?`, [result.pool, result.winner, result.winningRoll, round.id]],
      [`INSERT INTO messages (roomRow, roomCol, username, message, kind)
        VALUES (?, ?, 'System', ?, 'system')`,
        [round.roomRow, round.roomCol,
         `The dice round closes. ${result.winner} wins ${result.pool} gold with a roll of ${result.winningRoll}.`]]
    ]);
  }
}

// Plan 022 (tail): age corpses and remains by their decayTick each world pulse.
// Two populations share the decayTick clock but decay VERY differently:
// adv engine-overhaul Phase A: processCorpseDecay moved to inventory.mjs (it is
// pure items-table work); re-exported here so the world barrel + callers are unchanged.
import { processCorpseDecay } from './inventory.mjs';
export { processCorpseDecay };

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
  // Bump + read back in ONE batched round trip — this runs on every action.
  const [, tickResult] = await dbBatch(db, [
    ['UPDATE tick SET value = value + 1 WHERE id = 1'],
    ['SELECT value FROM tick WHERE id = 1']
  ]);
  const tickValue = batchRows(tickResult)[0]?.value ?? 0;
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
// `fromTick` (adv DUR-03): the low edge of the claimed window — sweeps that key
// on an exact tick modulo make up any hits inside (fromTick, tickValue] instead
// of dropping them when a later tick claimed first. The default (tick-1) is the
// single-tick window and reproduces the old `tickValue % 3 === 0` behavior
// exactly. Catch-up is capped so a huge idle gap can't turn into a regen burst.
export async function runWorldSweeps(db, tickValue, fromTick = tickValue - 1) {
  // Clamp the low edge to 0: the sentinel seeds at -1 and tick 0 never carried
  // a live pulse (ticks advance before any sweep runs), so the seed window must
  // not back-fill one. Multiples of 3 in (from, to] = floor(to/3) - floor(from/3).
  const staminaPulses = Math.min(
    3,
    Math.floor(tickValue / 3) - Math.floor(Math.max(fromTick, 0) / 3)
  );
  for (let i = 0; i < staminaPulses; i += 1) {
    await recoverStaminaForAllUsers(db);
  }

  await processRoomEffects(db, tickValue);
  await processIncapacitationBleed(db, tickValue);
  await processCorpseDecay(db, tickValue);
  await processStatusEffects(db, tickValue);
  await resolveExpiredGamblingRounds(db, tickValue);
  await pruneActionClaims(db, tickValue);
}

// adv DUR-01: idempotency claims. An action carrying a client token is applied
// exactly once across transports (WS first try, HTTP fallback replay): the
// INSERT is the claim — the first transport in wins, the replay conflicts and
// is acked without re-applying. Tokenless calls (old clients, smoke scripts,
// tests) skip claiming entirely and behave as before.
export async function claimActionToken(db, username, token) {
  const trimmed = typeof token === 'string' ? token.trim().slice(0, 64) : '';
  if (!trimmed) {
    return true;
  }
  const result = await dbRun(
    db,
    'INSERT OR IGNORE INTO actionClaims (claimKey, username) VALUES (?, ?)',
    [`${username}:${trimmed}`, username]
  );
  return changes(result) > 0;
}

// Release a claim after the claimed action FAILED to apply (a validation or
// gameplay throw) so a legitimate client retry isn't refused as a duplicate.
// Never called after a successful apply — that's exactly the replay to refuse.
export async function releaseActionToken(db, username, token) {
  const trimmed = typeof token === 'string' ? token.trim().slice(0, 64) : '';
  if (!trimmed) {
    return;
  }
  await dbRun(db, 'DELETE FROM actionClaims WHERE claimKey = ?', [`${username}:${trimmed}`]);
}

// Claims only matter for the seconds-wide ack window; prune on the same slow
// cadence as stamina recovery so the table stays tiny.
async function pruneActionClaims(db, tickValue) {
  if (tickValue % 3 !== 0) {
    return;
  }
  await dbRun(db, "DELETE FROM actionClaims WHERE createdAt < datetime('now', '-1 hour')");
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

// adv DUR-03: like claimWorldSweep, but the winner also learns WHICH ticks it
// now owns: the half-open range (fromTick, tickValue]. Under load two actions
// can advance the tick back-to-back and the LATER tick's deferred sweep can
// claim first — the earlier tick's sweep then no-ops, and with the plain
// boolean claim any modulo-gated effect that tick carried (the %3 stamina
// pulse) was silently dropped for the whole world. Carrying fromTick lets
// runWorldSweeps make up the skipped hits. Read-then-CAS with one retry: the
// conditional UPDATE only wins against the exact prev it read, so the range is
// never double-owned.
export async function claimWorldSweepRange(db, tickValue, worldDay = getWorldDay()) {
  await dbRun(
    db,
    `INSERT OR IGNORE INTO roomEffectCooldowns
      (username, roomRow, roomCol, effectType, lastAppliedTick, worldDay)
     VALUES (?, 0, 0, ?, -1, ?)`,
    [WORLD_SWEEP_SENTINEL_USER, WORLD_SWEEP_EFFECT_TYPE, worldDay]
  );
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const row = await dbFirst(
      db,
      `SELECT lastAppliedTick FROM roomEffectCooldowns
       WHERE username = ? AND roomRow = 0 AND roomCol = 0 AND effectType = ? AND worldDay = ?`,
      [WORLD_SWEEP_SENTINEL_USER, WORLD_SWEEP_EFFECT_TYPE, worldDay]
    );
    const prev = row ? Number(row.lastAppliedTick) : -1;
    if (prev >= tickValue) {
      return null; // window already swept (or being swept) by someone else
    }
    const claim = await dbRun(
      db,
      `UPDATE roomEffectCooldowns
       SET lastAppliedTick = ?
       WHERE username = ?
         AND roomRow = 0
         AND roomCol = 0
         AND effectType = ?
         AND worldDay = ?
         AND lastAppliedTick = ?`,
      [tickValue, WORLD_SWEEP_SENTINEL_USER, WORLD_SWEEP_EFFECT_TYPE, worldDay, prev]
    );
    if (changes(claim) > 0) {
      return { fromTick: prev };
    }
    // Lost the CAS to a concurrent claimant; re-read once — if the winner's tick
    // still trails ours we can claim the remainder, else we're done.
  }
  return null;
}

// adv-013: the deduped tick driver for the high-fan-out paths (the per-5s hostile-room
// alarm; the cron pulse). Advances the tick cheaply, then runs the world sweeps ONLY if
// this caller is the first in the window — so K alarms fire the sweeps once, not K×. Keeps
// advanceGlobalTick's return shape so its callers are byte-identical.
export async function advanceTickAndMaybeSweep(db) {
  const tick = await advanceTickOnly(db);
  const range = await claimWorldSweepRange(db, tick.tick);
  if (range) {
    await runWorldSweeps(db, tick.tick, range.fromTick);
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
  const range = await claimWorldSweepRange(db, tickValue);
  if (!range) {
    return false;
  }
  await runWorldSweeps(db, tickValue, range.fromTick);
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
