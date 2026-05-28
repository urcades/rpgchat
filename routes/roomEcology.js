const express = require('express');
const router = express.Router();
const db = require('../db/setup');
const authMiddleware = require('../middleware/auth');
const {
  getWorldDay,
  validateRoomCoordinates,
  getActiveTraces,
  buildRoomEcology
} = require('../utils/roomEcology');
const {
  getCurrentTickValue,
  getRoomAccessState,
  requireRoomUse,
  updatePresence,
  getActiveRound,
  payInnAccess
} = require('../utils/roomMechanics');

function getActiveTracesAsync(row, col, worldDay, tickValue) {
  return new Promise((resolve, reject) => {
    getActiveTraces(db, row, col, worldDay, tickValue, (err, traces) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(traces);
    });
  });
}

router.get('/room-ecology/:row/:col', authMiddleware, async (req, res) => {
  const coordinates = validateRoomCoordinates(req.params.row, req.params.col);

  if (!coordinates) {
    return res.status(400).json({ error: 'Invalid room coordinates' });
  }

  try {
    const worldDay = getWorldDay();
    const tickValue = await getCurrentTickValue(db);
    const traces = await getActiveTracesAsync(coordinates.row, coordinates.col, worldDay, tickValue);
    const innAccess = await getRoomAccessState(
      db,
      req.session.user.username,
      coordinates.row,
      coordinates.col,
      tickValue,
      worldDay
    );
    const activeRound = await getActiveRound(db, coordinates.row, coordinates.col, worldDay, tickValue);

    res.json(buildRoomEcology({
      row: coordinates.row,
      col: coordinates.col,
      tickValue,
      traces,
      innAccess,
      activeRound
    }));
  } catch (err) {
    console.error('Error building room ecology:', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

router.post('/room-presence/:row/:col', authMiddleware, async (req, res) => {
  const coordinates = validateRoomCoordinates(req.params.row, req.params.col);

  if (!coordinates) {
    return res.status(400).json({ error: 'Invalid room coordinates' });
  }

  try {
    const roomUse = await requireRoomUse(db, req.session.user.username, coordinates.row, coordinates.col);
    if (!roomUse.allowed) {
      return res.status(403).json({
        error: 'Inn access required',
        innAccess: roomUse.access
      });
    }

    const presence = await updatePresence(db, req.session.user.username, coordinates.row, coordinates.col);
    res.json({ ok: true, presence });
  } catch (err) {
    console.error('Error updating room presence:', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

router.post('/room-access/:row/:col/pay', authMiddleware, async (req, res) => {
  const coordinates = validateRoomCoordinates(req.params.row, req.params.col);

  if (!coordinates) {
    return res.status(400).send('Invalid room coordinates');
  }

  try {
    const access = await payInnAccess(db, req.session.user.username, coordinates.row, coordinates.col);
    if (req.accepts('html')) {
      return res.redirect(`/chat/${coordinates.row}/${coordinates.col}`);
    }
    res.json({ ok: true, innAccess: access });
  } catch (err) {
    const statusCode = err.statusCode || 500;
    if (statusCode >= 500) {
      console.error('Error paying inn access:', err);
    }
    if (req.accepts('html')) {
      return res.status(statusCode).send(err.message || 'Unable to pay inn access');
    }
    res.status(statusCode).json({ error: err.message || 'Unable to pay inn access' });
  }
});

module.exports = router;
