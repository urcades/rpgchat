// Chat / system messages & room traces (plan adv-005).
//
// Extracted verbatim from the original worker/game.mjs — a pure mechanical move.
// Cross-seam dependencies are now explicit imports; cycles between seams resolve
// through ESM live bindings (every cross-seam reference is call-time, never
// dereferenced at module load).

import { ROOM_MESSAGE_HISTORY_LIMIT } from './shared.mjs';
import { dbAll, dbRun, lastInsertId } from '../db.mjs';
import { getCurrentTickValue } from './clock.mjs';


// The timestamp is written explicitly (same UTC 'YYYY-MM-DD HH:MM:SS' shape as the
// column's CURRENT_TIMESTAMP default) and returned with the new row id, so a caller
// can hand a fully-formed, render-ready row to the broadcast without re-reading it.
export async function insertMessage(db, row, col, username, message, kind = 'chat') {
  const timestamp = new Date().toISOString().slice(0, 19).replace('T', ' ');
  const result = await dbRun(
    db,
    'INSERT INTO messages (roomRow, roomCol, username, message, kind, timestamp) VALUES (?, ?, ?, ?, ?, ?)',
    [row, col, username, message, kind, timestamp]
  );
  return { id: lastInsertId(result), timestamp };
}

// adv ARCH-05: the ONE place a broadcast-ready message row is shaped. Every
// self-describing frame (player chat, WS actions, NPC reply/ambient) routes
// through this, so a schema change to the wire shape is a one-file edit —
// previously the enrichment object was hand-assembled at each transport site
// and consumed untyped by chat.html.
export function toBroadcastMessageRow(row, user = {}) {
  return {
    id: row.id,
    username: row.username,
    message: row.message,
    timestamp: row.timestamp,
    kind: row.kind || 'chat',
    job: user.job || null,
    displayName: user.displayName || null,
    statusEffects: []
  };
}

export async function insertSystemMessage(db, row, col, message, kind = 'system') {
  await insertMessage(db, row, col, 'System', message, kind);
}

// kind tags a system message for client styling (combat/skill/support/death/
// dice/ambient/system — see migration 0008). When deferring for flush ordering
// (the attack path), the kind rides along as { message, kind } so the flush loop
// can preserve it instead of collapsing back to a bare string.
export async function emitSystemMessage(db, row, col, message, deferredSystemMessages = null, kind = 'system') {
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

// sinceId (optional): only rows newer than this id — the delta path for
// socket-driven refreshes, so a live client fetches the one or two new lines
// instead of the full history window every event.
export async function getMessages(db, row, col, tickValue = null, sinceId = null) {
  const since = Number.isFinite(Number(sinceId)) && Number(sinceId) > 0 ? Number(sinceId) : null;
  // The delta branch reads ASCENDING from the cursor: if a burst since the last
  // fetch exceeds the window, the client gets the OLDEST rows first and its next
  // `since` continues from where this page ended — nothing in the gap is skipped.
  // (DESC-from-the-top here would jump the cursor past the middle of the burst.)
  // The full-history branch keeps DESC + reverse: the newest window, oldest-first.
  const recent = await dbAll(
    db,
    `SELECT id, username, message, timestamp, kind
     FROM messages
     WHERE roomRow = ?
       AND roomCol = ?
       ${since !== null ? 'AND id > ?' : ''}
     ORDER BY id ${since !== null ? 'ASC' : 'DESC'}
     LIMIT ?`,
    since !== null
      ? [row, col, since, ROOM_MESSAGE_HISTORY_LIMIT]
      : [row, col, ROOM_MESSAGE_HISTORY_LIMIT]
  );
  const rows = since !== null ? recent : recent.reverse();
  const usernames = [...new Set(rows.map(row => row.username).filter(username => username && username !== 'System'))];

  if (usernames.length === 0) {
    return rows.map(row => ({ ...row, job: null, statusEffects: [] }));
  }

  const placeholders = usernames.map(() => '?').join(', ');
  const currentTick = tickValue === null ? await getCurrentTickValue(db) : tickValue;
  const [users, effects] = await Promise.all([
    // Plan 013a: also fetch displayName so NPC-authored lines render as "Frost Wyrm",
    // not the internal id; players still target by the raw username.
    dbAll(db, `SELECT username, job, displayName FROM users WHERE username IN (${placeholders})`, usernames),
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
    displayName: usersByName.get(row.username)?.displayName || null,
    statusEffects: effectsByName.get(row.username) || []
  }));
}
