const express = require('express');
const router = express.Router();
const db = require('../db/setup');
const authMiddleware = require('../middleware/auth');
const { getEffectiveUser } = require('../utils/jobs');

router.get('/user-attributes', authMiddleware, (req, res) => {
  const username = req.session.user.username;

  db.get("SELECT username, job, health, maxHealth, stamina, maxStamina, speed, strength, intelligence, level, gold, attributePoints FROM users WHERE username = ?", [username], (err, user) => {
    if (err) {
      console.error("Database error: ", err); // Log the error
      return res.status(500).json({ error: "Internal Server Error" });
    }
    if (!user) {
      console.error("User not found: ", username); // Log user not found
      return res.status(404).json({ error: "User Not Found" });
    }

    const effective = getEffectiveUser(user);
    res.json({
      ...user,
      job: effective.job,
      baseStats: effective.baseStats,
      jobBonuses: effective.jobBonuses,
      effectiveStats: {
        health: effective.health,
        maxHealth: effective.maxHealth,
        stamina: effective.stamina,
        maxStamina: effective.maxStamina,
        speed: effective.speed,
        strength: effective.strength,
        intelligence: effective.intelligence
      },
      skill: effective.skill
    });
  });
});

module.exports = router;
