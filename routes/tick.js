const express = require('express');
const router = express.Router();
const db = require('../db/setup');
const authMiddleware = require('../middleware/auth');

router.get('/tick', authMiddleware, (req, res) => {
  db.get("SELECT value FROM tick WHERE rowid = 1", (err, row) => {
    if (err) {
      return res.status(500).send("Internal Server Error");
    }
    res.json({ tick: row.value });
  });
});

// Increment tick value
router.post('/tick', (req, res) => {
  db.run("UPDATE tick SET value = value + 1 WHERE rowid = 1", (err) => {
    if (err) {
      return res.status(500).send("Internal Server Error");
    }

    // Get the updated tick value
    db.get("SELECT value FROM tick WHERE rowid = 1", (err, row) => {
      if (err) {
        return res.status(500).send("Internal Server Error");
      }

      // Increment stamina for all users every 3 ticks
      if (row.value % 3 === 0) {
        db.run("UPDATE users SET stamina = MIN(stamina + 1, maxStamina) WHERE stamina < maxStamina", (err) => { // Ensuring stamina does not exceed maxStamina
          if (err) {
            return res.status(500).send("Internal Server Error");
          }
          res.send("Tick incremented and stamina updated");
        });
      } else {
        res.send("Tick incremented");
      }
    });
  });
});

module.exports = router;
