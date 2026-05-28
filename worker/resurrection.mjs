import { dbFirst, dbRun } from './db.mjs';

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

export async function createResurrectionCheckout(db, username, paymentLinkUrl) {
  const grave = await latestGrave(db, username);
  if (!grave) {
    return null;
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
  if (request.status !== 'pending') {
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
    await dbRun(
      db,
      `UPDATE resurrectionRequests
       SET status = 'missing_grave',
           stripeSessionId = ?,
           completedAt = CURRENT_TIMESTAMP
       WHERE token = ?`,
      [stripeSessionId || null, token]
    );
    return { revived: false, reason: 'grave_not_found' };
  }

  const liveUser = await dbFirst(db, 'SELECT username FROM users WHERE username = ?', [grave.username]);
  if (!liveUser) {
    await dbRun(
      db,
      `INSERT INTO users
        (username, password, job, health, maxHealth, stamina, maxStamina, speed, strength, intelligence, level, gold)
       VALUES (?, ?, ?, 10, 10, 100, 100, 1, 1, 1, ?, ?)`,
      [grave.username, grave.password || '', grave.job || 'Novice', grave.level || 0, grave.gold || 0]
    );
  }

  await dbRun(db, 'DELETE FROM cemetery WHERE id = ?', [grave.id]);
  await dbRun(
    db,
    `UPDATE resurrectionRequests
     SET status = 'completed',
         stripeSessionId = ?,
         completedAt = CURRENT_TIMESTAMP
     WHERE token = ?
       AND status = 'pending'`,
    [stripeSessionId || null, token]
  );
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
