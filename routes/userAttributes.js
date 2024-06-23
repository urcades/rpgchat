const express = require('express');
const router = express.Router();
const db = require('../db/setup');
const authMiddleware = require('../middleware/auth');

router.get('/user-attributes', authMiddleware, (req, res) => {
  const username = req.session.user.username;

  db.get("SELECT level, ExperienceCount, ExperienceRequired, health, stamina, gold, speed, strength, intelligence FROM users WHERE username = ?", [username], (err, user) => {
    if (err) {
      console.error("Database error: ", err);
      return res.status(500).json({ error: "Internal Server Error" });
    }
    if (!user) {
      console.error("User not found: ", username);
      return res.status(404).json({ error: "User Not Found" });
    }
    res.json(user);
  });
});

module.exports = router;