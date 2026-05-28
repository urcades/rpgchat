const express = require('express');
const router = express.Router();
const path = require('path'); // Add this line
const db = require('../db/setup');
const {
  JOBS,
  normalizeJob,
  validateStartingAllocation,
  buildStartingStats
} = require('../utils/jobs');

// Handle login form submission
router.post('/login', (req, res) => {
  const username = req.body.username;
  const password = req.body.password;

  db.get("SELECT * FROM users WHERE username = ? AND password = ?", [username, password], (err, user) => {
    if (err) {
      return res.status(500).send("Internal Server Error");
    }
    if (!user) {
      return db.get(
        `SELECT username
         FROM cemetery
         WHERE username = ? AND password = ?
         ORDER BY diedAt DESC, rowid DESC
         LIMIT 1`,
        [username, password],
        (cemeteryErr, deadUser) => {
          if (cemeteryErr) {
            return res.status(500).send("Internal Server Error");
          }
          if (deadUser) {
            req.session.deadUser = { username: deadUser.username };
            delete req.session.user;
            return res.redirect('/death');
          }
          return res.sendFile(path.join(__dirname, '../public', 'index.html'));
        }
      );
    }
    delete req.session.deadUser;
    req.session.user = user;
    res.redirect('/success');
  });
});

// Handle sign-up form submission
router.post('/signup', (req, res) => {
  const username = req.body.username;
  const password = req.body.password;
  const job = normalizeJob(req.body.job);
  const allocationResult = validateStartingAllocation({
    health: req.body.health,
    stamina: req.body.stamina,
    speed: req.body.speed,
    strength: req.body.strength,
    intelligence: req.body.intelligence
  });

  if (!Object.prototype.hasOwnProperty.call(JOBS, req.body.job)) {
    return res.status(400).send('Invalid job');
  }

  if (!allocationResult.valid) {
    return res.status(400).send(allocationResult.errors[0]);
  }

  const stats = buildStartingStats(allocationResult.allocation);

  db.get("SELECT username FROM users WHERE username = ?", [username], (findErr, existingUser) => {
    if (findErr) {
      return res.status(500).send("Internal Server Error");
    }
    if (existingUser) {
      return res.status(400).send("Username already taken");
    }

    db.run(
      `INSERT INTO users
        (username, password, job, health, maxHealth, stamina, maxStamina, speed, strength, intelligence, level, gold)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0)`,
      [
        username,
        password,
        job,
        stats.health,
        stats.maxHealth,
        stats.stamina,
        stats.maxStamina,
        stats.speed,
        stats.strength,
        stats.intelligence
      ],
      (err) => {
    if (err) {
      return res.status(500).send("Internal Server Error");
    }
        return res.redirect('/');
      }
    );
  });
});

module.exports = router;
