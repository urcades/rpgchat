const db = require('../db/setup');
const { calculateLevel } = require('../utils/leveling');
const eventBus = require('../eventBus');
const { awardGold } = require('../utils/goldUtils');
const { validateRoomCoordinates } = require('../utils/roomEcology');
const {
  requireRoomUse,
  handleRollCommand,
  validateRollCommand
} = require('../utils/roomMechanics');
const { advanceGlobalTickAsync } = require('../utils/tickUtils');
const { dbGet, dbRun } = require('../utils/dbAsync');
const { runPlayerAction } = require('../utils/playerActions');

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
  handleChat: async (req, res) => {
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

      if (message.trim().toLowerCase().startsWith('/roll')) {
        const result = await runPlayerAction(db, {
          username,
          staminaCost: 1,
          validate: async () => validateRollCommand(db, username, row, col, message),
          perform: async () => handleRollCommand(db, username, row, col, message),
          advanceTick: () => advanceGlobalTickAsync(db)
        });
        eventBus.emit('newMessage', { username: 'System', message: result.systemMessage });
        return res.redirect(`/chat/${row}/${col}`);
      }

      await runPlayerAction(db, {
        username,
        staminaCost: 1,
        perform: async () => {
          await dbRun(db, `INSERT INTO messages_${row}_${col} (username, message) VALUES (?, ?)`, [username, message]);
          awardGold(username);
          return { message };
        },
        advanceTick: () => advanceGlobalTickAsync(db)
      });
      await updateLevel(username, row, col);
      eventBus.emit('newMessage', { username, message });
      res.redirect(`/chat/${row}/${col}`);
    } catch (err) {
      const statusCode = err.statusCode || 500;
      if (statusCode >= 500) {
        console.error('Error handling chat:', err);
      }
      res.status(statusCode).send(statusCode >= 500 ? 'Internal Server Error' : err.message);
    }
  },
};
