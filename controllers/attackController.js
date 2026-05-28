const db = require('../db/setup');
const { awardGold } = require('../utils/goldUtils');
const { handleAttack, validateAttackTargets } = require('../utils/attackUtils');
const { calculateLevel } = require('../utils/leveling');
const eventBus = require('../eventBus');
const { validateRoomCoordinates } = require('../utils/roomEcology');
const { requireRoomUse } = require('../utils/roomMechanics');
const { advanceGlobalTickAsync } = require('../utils/tickUtils');
const { dbGet, dbRun } = require('../utils/dbAsync');
const { runPlayerAction } = require('../utils/playerActions');

function handleAttackAsync(username, message, row, col) {
  return new Promise((resolve, reject) => {
    handleAttack(username, message, row, col, (err, updatedMessage) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(updatedMessage);
    });
  });
}

async function updateLevel(username, row, col) {
  const countRow = await dbGet(db, `SELECT COUNT(*) AS messageCount FROM messages_${row}_${col} WHERE username = ?`, [username]);
  const newLevel = calculateLevel(countRow.messageCount);
  const user = await dbGet(db, 'SELECT level FROM users WHERE username = ?', [username]);

  if (user && newLevel > user.level) {
    await dbRun(
      db,
      'UPDATE users SET level = ?, attributePoints = attributePoints + 10 WHERE username = ?',
      [newLevel, username]
    );
  }
}

module.exports = {
  handleAttack: async (req, res) => {
    const coordinates = validateRoomCoordinates(req.params.row, req.params.col);
    if (!coordinates) {
      return res.status(400).send('Invalid room coordinates');
    }

    const username = req.session.user.username;
    const message = req.body.message || '';
    const row = coordinates.row;
    const col = coordinates.col;

    try {
      const roomUse = await requireRoomUse(db, username, row, col);
      if (!roomUse.allowed) {
        return res.status(403).send('Inn access required');
      }

      const result = await runPlayerAction(db, {
        username,
        staminaCost: 1,
        validate: async () => validateAttackTargets(db, username, message),
        perform: async () => {
          const updatedMessage = await handleAttackAsync(username, message, row, col);
          await dbRun(db, `INSERT INTO messages_${row}_${col} (username, message) VALUES (?, ?)`, [username, updatedMessage]);
          awardGold(username);
          return { updatedMessage };
        },
        advanceTick: () => advanceGlobalTickAsync(db)
      });
      await updateLevel(username, row, col);
      eventBus.emit('newMessage', { username, message: result.updatedMessage });
      res.redirect(`/chat/${row}/${col}`);
    } catch (err) {
      const statusCode = err.statusCode || 500;
      if (statusCode >= 500) {
        console.error('Error handling attack:', err);
      }
      res.status(statusCode).send(statusCode >= 500 ? 'Internal Server Error' : err.message);
    }
  }
};
