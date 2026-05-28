const db = require('../db/setup');
const eventBus = require('../eventBus');
const { validateRoomCoordinates, getPhaseFromTick } = require('../utils/roomEcology');
const { requireRoomUse } = require('../utils/roomMechanics');
const { advanceGlobalTickAsync } = require('../utils/tickUtils');
const { runPlayerAction } = require('../utils/playerActions');
const { useClassSkill, validateClassSkillUse } = require('../utils/classSkills');

module.exports = {
  handleSkill: async (req, res) => {
    const coordinates = validateRoomCoordinates(req.params.row, req.params.col);
    if (!coordinates) {
      return res.status(400).send('Invalid room coordinates');
    }

    const username = req.session.user.username;
    const row = coordinates.row;
    const col = coordinates.col;
    const skillId = req.body.skillId;
    const targetUsername = req.body.targetUsername || req.body.message || '';

    try {
      const roomUse = await requireRoomUse(db, username, row, col);
      if (!roomUse.allowed) {
        return res.status(403).send('Inn access required');
      }

      const actionTick = roomUse.tickValue + 1;
      const result = await runPlayerAction(db, {
        username,
        staminaCost: 1,
        validate: async () => validateClassSkillUse(db, {
          username,
          skillId,
          targetUsername
        }),
        perform: async () => useClassSkill(db, {
          username,
          skillId,
          targetUsername,
          row,
          col,
          currentTick: actionTick,
          phase: getPhaseFromTick(actionTick)
        }),
        advanceTick: () => advanceGlobalTickAsync(db)
      });

      eventBus.emit('newMessage', { username: 'System', message: result.message });
      res.redirect(`/chat/${row}/${col}`);
    } catch (err) {
      const statusCode = err.statusCode || 500;
      if (statusCode >= 500) {
        console.error('Error handling skill:', err);
      }
      res.status(statusCode).send(statusCode >= 500 ? 'Internal Server Error' : err.message);
    }
  }
};
