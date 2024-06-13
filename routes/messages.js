const express = require('express');
const router = express.Router();
const db = require('../db/setup');
const authMiddleware = require('../middleware/auth');

router.get('/messages', authMiddleware, (req, res) => {
  db.all("SELECT * FROM messages ORDER BY timestamp ASC", (err, rows) => {
    if (err) {
      return res.status(500).send("Internal Server Error");
    }
    res.json(rows);
  });
});

module.exports = router;
