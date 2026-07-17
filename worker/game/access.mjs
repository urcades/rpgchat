// Room access, movement & inn gating (mechanical split of world.mjs).

import {
  ActionError,
  INN_ACCESS_TYPE,
  assertAction,
  calculateInnFee,
  getWorldDay
} from './shared.mjs';
import { batchRows, changes, dbBatch, dbFirst, dbRun } from '../db.mjs';
import { getCurrentTickValue } from './clock.mjs';
import { getUser, selectUserColumns } from './users.mjs';
import { roomHasEffect } from './ecology.mjs';
import { isIncapacitated } from './death.mjs';

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
    ? await selectUserColumns(db, username, 'gold')
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
  //
  // Position and tick are independent reads on every action, so they share one
  // batched round trip; the incapacitation read only happens on an actual move
  // (distance >= 1), exactly as validateMovement orders it.
  const worldDay = getWorldDay();
  const [positionResult, tickResult] = await dbBatch(db, [
    ['SELECT roomRow AS row, roomCol AS col FROM roomPresence WHERE username = ? AND worldDay = ?', [username, worldDay]],
    ['SELECT value FROM tick WHERE id = 1']
  ]);
  const position = batchRows(positionResult)[0] || null;
  const tickValue = batchRows(tickResult)[0]?.value ?? 0;

  if (position) {
    const distance = Math.max(Math.abs(position.row - row), Math.abs(position.col - col));
    if (distance >= 1 && await isIncapacitated(db, username)) {
      throw new ActionError('You are incapacitated — you cannot move.', 403);
    }
    if (distance > 1) {
      throw new ActionError('Too far to walk there.', 403);
    }
  }

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
  // A genuinely-broke player is rejected BEFORE any write (original ordering for this
  // case), so they never anchor a transient access row that a co-located payer could
  // momentarily mistake for "already paid". The atomic gold>=fee guard below is still
  // the real authority; this is just the cheap early-out.
  assertAction(user.gold >= currentAccess.fee, 'Not enough gold', 402);

  // adv-018: the access ROW is the idempotency anchor, written FIRST. Two concurrent
  // pays both saw "unpaid" and would each spend the fee (charged twice) before either
  // wrote the row. Now we INSERT ... ON CONFLICT DO NOTHING against the (username, room,
  // accessType, worldDay) primary key up front: the FIRST pay inserts (changes()===1)
  // and is the only one allowed to spend gold; a racing second pay conflicts
  // (changes()===0) and is treated as already-paid — no second charge.
  const claimed = await dbRun(
    db,
    `INSERT INTO roomAccess
      (username, roomRow, roomCol, accessType, costPaid, worldDay)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (username, roomRow, roomCol, accessType, worldDay) DO NOTHING`,
    [username, row, col, INN_ACCESS_TYPE, currentAccess.fee, worldDay]
  );

  if (changes(claimed) !== 1) {
    // A concurrent pay already anchored access this tick — already-paid, no charge.
    return await getRoomAccessState(db, username, row, col, tickValue, worldDay);
  }

  const goldUpdate = await dbRun(
    db,
    'UPDATE users SET gold = gold - ? WHERE username = ? AND gold >= ?',
    [currentAccess.fee, username, currentAccess.fee]
  );
  if (changes(goldUpdate) <= 0) {
    // We won the access claim but our gold dropped below the fee since the read (a
    // concurrent same-user spend) — undo the anchor so the fee gate stays truthful and
    // 402 exactly as before, rather than letting them in free.
    await dbRun(
      db,
      `DELETE FROM roomAccess
       WHERE username = ? AND roomRow = ? AND roomCol = ? AND accessType = ? AND worldDay = ?`,
      [username, row, col, INN_ACCESS_TYPE, worldDay]
    );
    assertAction(false, 'Not enough gold', 402);
  }

  return {
    ...currentAccess,
    paid: true,
    costPaid: currentAccess.fee,
    gold: user.gold - currentAccess.fee,
    canPay: true
  };
}
