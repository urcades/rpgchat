const express = require('express');
const router = express.Router();
const db = require('../db/setup');
const authMiddleware = require('../middleware/auth');
const { validateRoomCoordinates } = require('../utils/roomEcology');
const { requireRoomUse, getCurrentTickValue } = require('../utils/roomMechanics');
const { dbAll } = require('../utils/dbAsync');

router.get('/messages/:row/:col', authMiddleware, async (req, res) => {
  const coordinates = validateRoomCoordinates(req.params.row, req.params.col);
  if (!coordinates) {
    return res.status(400).send('Invalid room coordinates');
  }

  try {
    const roomUse = await requireRoomUse(db, req.session.user.username, coordinates.row, coordinates.col);
    if (!roomUse.allowed) {
      return res.status(403).json({
        error: 'Inn access required',
        innAccess: roomUse.access
      });
    }

    const rows = await dbAll(db, `SELECT * FROM messages_${coordinates.row}_${coordinates.col} ORDER BY timestamp ASC`);
    const usernames = [...new Set(rows.map(row => row.username).filter(username => username && username !== 'System'))];
    let usersByName = new Map();
    let effectsByName = new Map();

    if (usernames.length > 0) {
      const placeholders = usernames.map(() => '?').join(', ');
      const users = await dbAll(
        db,
        `SELECT username, job FROM users WHERE username IN (${placeholders})`,
        usernames
      );
      usersByName = new Map(users.map(user => [user.username, user]));

      const tickValue = await getCurrentTickValue(db);
      const effects = await dbAll(
        db,
        `SELECT username, effectType
         FROM statusEffects
         WHERE username IN (${placeholders})
           AND expiryTick > ?
         ORDER BY username ASC, expiryTick ASC, id ASC`,
        [...usernames, tickValue]
      );
      effectsByName = effects.reduce((map, effect) => {
        if (!map.has(effect.username)) {
          map.set(effect.username, []);
        }
        if (!map.get(effect.username).includes(effect.effectType)) {
          map.get(effect.username).push(effect.effectType);
        }
        return map;
      }, new Map());
    }

    res.json(rows.map(row => ({
      ...row,
      job: usersByName.get(row.username)?.job || null,
      statusEffects: effectsByName.get(row.username) || []
    })));
  } catch (err) {
    console.error('Error loading messages:', err);
    res.status(500).send('Internal Server Error');
  }
});

module.exports = router;
