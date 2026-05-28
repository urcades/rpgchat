const db = require('../db/setup');
const eventBus = require('../eventBus');
const { validateRoomCoordinates } = require('../utils/roomEcology');
const { requireRoomUse, roomHasEffect } = require('../utils/roomMechanics');
const { advanceGlobalTickAsync } = require('../utils/tickUtils');
const { createActionError, runPlayerAction } = require('../utils/playerActions');
const { switchJob } = require('../utils/jobSwitching');
const { JOBS } = require('../utils/jobs');

module.exports = {
  handleJobChange: async (req, res) => {
    const coordinates = validateRoomCoordinates(req.params.row, req.params.col);
    if (!coordinates) {
      return res.status(400).send('Invalid room coordinates');
    }

    const username = req.session.user.username;
    const row = coordinates.row;
    const col = coordinates.col;
    const nextJob = req.body.job;

    try {
      const roomUse = await requireRoomUse(db, username, row, col);
      if (!roomUse.allowed) {
        return res.status(403).send('Inn access required');
      }
      if (!roomHasEffect(row, col, roomUse.tickValue, 'guild', roomUse.worldDay)) {
        throw createActionError('Job changes require a Guild room.', 403);
      }

      const result = await runPlayerAction(db, {
        username,
        staminaCost: 1,
        validate: async () => {
          if (!Object.prototype.hasOwnProperty.call(JOBS, nextJob)) {
            throw createActionError('Invalid job.', 400);
          }
        },
        perform: async () => switchJob(db, {
          username,
          nextJob,
          row,
          col
        }),
        advanceTick: () => advanceGlobalTickAsync(db)
      });

      eventBus.emit('newMessage', { username: 'System', message: result.message });
      res.redirect(`/chat/${row}/${col}`);
    } catch (err) {
      const statusCode = err.statusCode || 500;
      if (statusCode >= 500) {
        console.error('Error changing job:', err);
      }
      res.status(statusCode).send(statusCode >= 500 ? 'Internal Server Error' : err.message);
    }
  }
};
