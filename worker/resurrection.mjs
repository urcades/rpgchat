import { changes, dbFirst, dbRun } from './db.mjs';
import { deleteCorpseAnchor, findCorpseAnchor } from './game.mjs';

function appendClientReferenceId(paymentLinkUrl, token) {
  const url = new URL(paymentLinkUrl);
  url.searchParams.set('client_reference_id', token);
  return url.toString();
}

async function latestGrave(db, username) {
  return dbFirst(
    db,
    `SELECT id, username, password, level, gold, job, roomRow, roomCol
     FROM cemetery
     WHERE username = ?
     ORDER BY diedAt DESC, id DESC
     LIMIT 1`,
    [username]
  );
}

// Plan 022c: resurrection requires the player's corpse to still exist (a floor item
// or in someone's bag). If it has been eaten/destroyed, the tether is severed — no
// resurrection is possible, even a paid one.
async function hasCorpse(db, username) {
  const row = await findCorpseAnchor(db, username);
  return Boolean(row);
}

// Recreate a live `users` row from a grave's stored stats. The resurrected character
// returns at baseline vitals (the grave only persists identity + progression: password,
// job, level, gold), so health/stamina/attributes reset to starting values. Shared by
// the free Cleric revival and the paid checkout fulfillment so the two paths can never
// drift in what a resurrected body looks like.
async function insertResurrectedUser(db, grave) {
  await dbRun(
    db,
    `INSERT OR IGNORE INTO users
      (username, password, job, health, maxHealth, stamina, maxStamina, speed, strength, intelligence, level, gold)
     VALUES (?, ?, ?, 30, 30, 100, 100, 1, 1, 1, ?, ?)`,
    [grave.username, grave.password || '', grave.job || 'Novice', grave.level || 0, grave.gold || 0]
  );
}

// Plan 011: restore a dead player from their grave (a free, Cleric-driven revival).
// Recreates the user, deletes the grave, consumes the corpse, clears the dead
// session. No-op return when there's no grave. The caller (the Cleric ability) is
// responsible for the corpse-in-room proximity check before calling this.
export async function revivePlayer(db, username, row, col) {
  const grave = await latestGrave(db, username);
  if (!grave) {
    return { revived: false, reason: 'no_grave' };
  }
  // adv-017: claim the grave FIRST, mirroring fulfillResurrectionCheckout's claim-first
  // style. Two Cleric revives on one corpse used to both pass the liveUser check and then
  // collide — the 2nd INSERT PK-violates, or both delete the grave/corpse. Deleting the
  // grave by id is the single gate: only the caller that removes it (changes()===1)
  // recreates the user and consumes the corpse; the loser sees the grave already gone and
  // returns the same no_grave result a stale revive would. Recreate with INSERT OR IGNORE
  // and consume the corpse only after winning, so the whole revive is idempotent.
  const claim = await dbRun(db, 'DELETE FROM cemetery WHERE id = ?', [grave.id]);
  if (changes(claim) !== 1) {
    return { revived: false, reason: 'no_grave' };
  }
  const liveUser = await dbFirst(db, 'SELECT username FROM users WHERE username = ?', [username]);
  if (!liveUser) {
    await insertResurrectedUser(db, grave);
  }
  await deleteCorpseAnchor(db, username);
  await dbRun(db, 'UPDATE sessions SET username = ?, deadUsername = NULL WHERE deadUsername = ?', [username, username]);
  return { revived: true, username };
}

export async function createResurrectionCheckout(db, username, paymentLinkUrl) {
  const grave = await latestGrave(db, username);
  if (!grave) {
    return null;
  }
  // Plan 022c: never sell a resurrection that can't happen — the corpse must exist.
  if (!await hasCorpse(db, username)) {
    return { severed: true };
  }

  const token = crypto.randomUUID();
  await dbRun(
    db,
    `INSERT INTO resurrectionRequests (token, username, graveId, status)
     VALUES (?, ?, ?, 'pending')`,
    [token, username, grave.id]
  );

  return {
    token,
    url: appendClientReferenceId(paymentLinkUrl, token)
  };
}

export async function fulfillResurrectionCheckout(db, token, stripeSessionId) {
  if (!token) {
    return { revived: false, reason: 'missing_token' };
  }

  const request = await dbFirst(
    db,
    `SELECT token, username, graveId, status
     FROM resurrectionRequests
     WHERE token = ?`,
    [token]
  );
  if (!request) {
    return { revived: false, reason: 'request_not_found' };
  }

  // Atomically claim the request: only one caller can flip pending -> completed.
  // Every side effect below runs ONLY for the winner, so a retried or concurrent
  // webhook for the same token is a clean no-op (already_completed) instead of
  // both passing a stale status read and then colliding on the user INSERT,
  // which would throw a PK violation and leave the grave deleted but the request
  // unfinished. The conditional WHERE + changes() check is the single gate.
  const claim = await dbRun(
    db,
    `UPDATE resurrectionRequests
     SET status = 'completed',
         stripeSessionId = ?,
         completedAt = CURRENT_TIMESTAMP
     WHERE token = ?
       AND status = 'pending'`,
    [stripeSessionId || null, token]
  );
  if (changes(claim) !== 1) {
    return { revived: false, reason: 'already_completed' };
  }

  const grave = await dbFirst(
    db,
    `SELECT id, username, password, level, gold, job, roomRow, roomCol
     FROM cemetery
     WHERE id = ?
       AND username = ?`,
    [request.graveId, request.username]
  );
  if (!grave) {
    // Already claimed above; record the terminal state so it isn't retried.
    await dbRun(
      db,
      `UPDATE resurrectionRequests SET status = 'missing_grave' WHERE token = ?`,
      [token]
    );
    return { revived: false, reason: 'grave_not_found' };
  }

  // Plan 022c: re-check the corpse at fulfillment — it may have been destroyed
  // between checkout and payment. If it's gone, the tether is severed: do not revive.
  if (!await hasCorpse(db, request.username)) {
    await dbRun(db, `UPDATE resurrectionRequests SET status = 'corpse_destroyed' WHERE token = ?`, [token]);
    return { revived: false, reason: 'corpse_destroyed' };
  }

  const liveUser = await dbFirst(db, 'SELECT username FROM users WHERE username = ?', [grave.username]);
  if (!liveUser) {
    await insertResurrectedUser(db, grave);
  }

  await dbRun(db, 'DELETE FROM cemetery WHERE id = ?', [grave.id]);
  // Plan 022c: the body returns to life — consume the corpse so it can't be reused.
  await deleteCorpseAnchor(db, grave.username);
  await dbRun(
    db,
    `UPDATE sessions
     SET username = ?,
         deadUsername = NULL
     WHERE deadUsername = ?`,
    [grave.username, grave.username]
  );

  return {
    revived: true,
    username: grave.username
  };
}
