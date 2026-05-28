const express = require('express');
const router = express.Router();
const db = require('../db/setup');
const authMiddleware = require('../middleware/auth');
const { advanceGlobalTick } = require('../utils/tickUtils');

router.get('/tick', authMiddleware, (req, res) => {
  db.get("SELECT value FROM tick WHERE rowid = 1", (err, row) => {
    if (err) {
      return res.status(500).send("Internal Server Error");
    }
    res.json({ tick: row.value });
  });
});

router.post('/tick', (req, res) => {
  advanceGlobalTick(db, (err, result) => {
    if (err) {
      console.error('Error advancing tick:', err);
      return res.status(500).send("Internal Server Error");
    }

    res.send(result.staminaUpdated ? "Tick incremented and stamina updated" : "Tick incremented");
  });
});

module.exports = router;
