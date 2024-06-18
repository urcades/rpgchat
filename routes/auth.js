const express = require('express');
const router = express.Router();
const path = require('path'); // Add this line
const db = require('../db/setup');

// Handle login form submission
router.post('/login', (req, res) => {
  const username = req.body.username;
  const password = req.body.password;

  db.get("SELECT * FROM users WHERE username = ? AND password = ?", [username, password], (err, user) => {
    if (err) {
      return res.status(500).send("Internal Server Error");
    }
    if (!user) {
      return res.sendFile(path.join(__dirname, '../public', 'index.html'));
    }
    req.session.user = user;
    res.redirect('/success');
  });
});

// Handle sign-up form submission
router.post('/signup', (req, res) => {
  const username = req.body.username;
  const password = req.body.password;

  db.run("INSERT INTO users (username, password, health, maxHealth, stamina, maxStamina, speed, strength, intelligence, level, gold) VALUES (?, ?, 10, 10, 100, 100, 1, 1, 1, 0, 0)", [username, password], (err) => {
    if (err) {
      return res.status(500).send("Internal Server Error");
    }
    return res.sendFile(path.join(__dirname, '../public', 'index.html'));
  });
});

module.exports = router;