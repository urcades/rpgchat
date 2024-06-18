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

// Increment tick value and update stamina every 3 ticks
router.post('/tick', (req, res) => {
  db.run("UPDATE tick SET value = value + 1 WHERE rowid = 1", (err) => {
    if (err) {
      return res.status(500).send("Internal Server Error");
    }

    db.get("SELECT value FROM tick WHERE rowid = 1", (err, row) => {
      if (err) {
        return res.status(500).send("Internal Server Error");
      }

      const tickValue = row.value;
      if (tickValue % 3 === 0) {
        db.run("UPDATE users SET stamina = MIN(stamina + 1, maxStamina)", (err) => {
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