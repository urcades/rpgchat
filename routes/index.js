const express = require('express');
const path = require('path');
const router = express.Router();
const db = require('../db/setup');

router.use('/', require('./auth'));
router.use('/', require('./chat'));
router.use('/', require('./messages'));
router.use('/', require('./tick'));
router.use('/', require('./userAttributes'));
router.use('/', require('./inventory'));
router.use('/', require('./userInventory'));
router.use('/', require('./updateAttributes'));

router.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../public', 'index.html'));
});

router.get('/signup', (req, res) => {
  res.sendFile(path.join(__dirname, '../public', 'signup.html'));
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

router.get('/chat', require('../middleware/auth'), (req, res) => {
  res.sendFile(path.join(__dirname, '../public', 'chat.html'));
});

router.get('/character', require('../middleware/auth'), (req, res) => {
  res.sendFile(path.join(__dirname, '../public', 'character.html'));
});

router.get('/cemetery', (req, res) => {
  db.all("SELECT * FROM cemetery", (err, players) => {
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