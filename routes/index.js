const express = require('express');
const path = require('path');
const router = express.Router();
const db = require('../db/setup');
const { validateRoomCoordinates } = require('../utils/roomEcology');
const {
  getCurrentTickValue,
  getRoomAccessState
} = require('../utils/roomMechanics');

router.use('/', require('./auth'));
router.use('/', require('./chat'));
router.use('/', require('./messages'));
router.use('/', require('./tick'));
router.use('/', require('./userAttributes'));
router.use('/', require('./roomEcology'));
router.use('/', require('./inventory'));
router.use('/', require('./userInventory'));
router.use('/', require('./updateAttributes'));

router.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../public', 'index.html'));
});

router.get('/signup', (req, res) => {
  res.sendFile(path.join(__dirname, '../public', 'signup.html'));
});

router.get('/death', (req, res) => {
  if (!req.session.deadUser) {
    return res.redirect('/');
  }
  res.sendFile(path.join(__dirname, '../public', 'death.html'));
});

router.get('/death-data', (req, res) => {
  if (!req.session.deadUser) {
    return res.status(401).json({ error: 'No dead character in this session' });
  }

  db.get(
    `SELECT username, level, gold, job, cause, roomRow, roomCol, diedAt
     FROM cemetery
     WHERE username = ?
     ORDER BY diedAt DESC, rowid DESC
     LIMIT 1`,
    [req.session.deadUser.username],
    (err, grave) => {
      if (err) {
        return res.status(500).json({ error: 'Internal Server Error' });
      }
      if (!grave) {
        req.session.destroy(() => {});
        return res.status(404).json({ error: 'Grave not found' });
      }

      res.json({
        ...grave,
        kills: 0,
        achievements: []
      });
    }
  );
});

router.get('/success', require('../middleware/auth'), (req, res) => {
  res.sendFile(path.join(__dirname, '../public', 'success.html'));
});

router.get('/protected', require('../middleware/auth'), (req, res) => {
  res.send('This is a protected page. Only logged-in users can see this.');
});

router.get('/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      return res.status(500).send("Internal Server Error");
    }
    res.redirect('/');
  });
});

router.get('/chat/:row/:col', require('../middleware/auth'), async (req, res) => {
  const coordinates = validateRoomCoordinates(req.params.row, req.params.col);
  if (!coordinates) {
    return res.status(400).send('Invalid room coordinates');
  }

  try {
    const tickValue = await getCurrentTickValue(db);
    const access = await getRoomAccessState(
      db,
      req.session.user.username,
      coordinates.row,
      coordinates.col,
      tickValue
    );

    if (access.required && !access.paid) {
      return res.render('innGate', {
        row: coordinates.row,
        col: coordinates.col,
        innAccess: access
      });
    }

    res.render('chat', { row: coordinates.row, col: coordinates.col });
  } catch (err) {
    console.error('Error rendering chat room:', err);
    res.status(500).send('Internal Server Error');
  }
});

router.get('/character', require('../middleware/auth'), (req, res) => {
  res.sendFile(path.join(__dirname, '../public', 'character.html'));
});

router.get('/cemetery', (req, res) => {
  res.sendFile(path.join(__dirname, '../public', 'cemetery.html'));
});

router.get('/cemetery-data', (req, res) => {
  db.all("SELECT username, level, gold, job, cause, roomRow, roomCol, diedAt FROM cemetery ORDER BY diedAt DESC, rowid DESC", (err, players) => {
    if (err) {
      return res.status(500).send("Internal Server Error");
    }
    res.json(players);
  });
});

router.get('/leaderboard', (req, res) => {
  res.sendFile(path.join(__dirname, '../public', 'leaderboard.html'));
});

router.get('/leaderboard-data', (req, res) => {
  db.all("SELECT username, gold FROM users ORDER BY gold DESC", (err, players) => {
    if (err) {
      return res.status(500).send("Internal Server Error");
    }
    res.json(players);
  });
});

module.exports = router;
