const express = require('express');
const router = express.Router();
const db = require('../db/setup');
const authMiddleware = require('../middleware/auth');

router.get('/messages/:row/:col', authMiddleware, (req, res) => {
  const row = parseInt(req.params.row);
  const col = parseInt(req.params.col);

  db.all(`SELECT * FROM messages_${row}_${col} ORDER BY timestamp ASC`, (err, rows) => {
    if (err) {
      return res.status(500).send("Internal Server Error");
    }
    res.json(rows);
  });
});

module.exports = router;
