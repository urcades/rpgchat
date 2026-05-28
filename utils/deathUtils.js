const { dbGet, dbRun } = require('./dbAsync');

async function hasColumn(db, tableName, columnName) {
  const rows = await new Promise((resolve, reject) => {
    db.all(`PRAGMA table_info(${tableName})`, (err, result) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(result);
    });
  });

  return rows.some(row => row.name === columnName);
}

async function insertSystemMessage(db, row, col, message) {
  await dbRun(db, `INSERT INTO messages_${row}_${col} (username, message) VALUES ('System', ?)`, [message]);
}

async function moveUserToCemetery(db, username, cause, row, col) {
  const user = await dbGet(db, 'SELECT username, password, level, gold, job FROM users WHERE username = ?', [username]);
  if (!user) {
    return false;
  }

  const cemeteryHasJob = await hasColumn(db, 'cemetery', 'job');
  if (cemeteryHasJob) {
    await dbRun(
      db,
      `INSERT INTO cemetery
        (username, password, level, gold, job, cause, roomRow, roomCol, diedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
      [user.username, user.password || '', user.level || 0, user.gold || 0, user.job || 'Novice', cause, row, col]
    );
  } else {
    await dbRun(
      db,
      'INSERT INTO cemetery (username, password, level, gold) VALUES (?, ?, ?, ?)',
      [user.username, user.password || '', user.level || 0, user.gold || 0]
    );
  }

  await dbRun(db, 'DELETE FROM users WHERE username = ?', [username]);
  await dbRun(db, 'DELETE FROM roomPresence WHERE username = ?', [username]).catch(() => {});
  await dbRun(db, 'DELETE FROM statusEffects WHERE username = ?', [username]).catch(() => {});
  await insertSystemMessage(db, row, col, `${username} has died from ${cause}.`);
  return true;
}

module.exports = {
  insertSystemMessage,
  moveUserToCemetery
};
