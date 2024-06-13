const express = require('express');
const router = express.Router();
const db = require('../db/setup');
const authMiddleware = require('../middleware/auth');

router.get('/user-inventory', authMiddleware, (req, res) => {
  const username = req.session.user.username;

  db.get("SELECT inventory FROM users WHERE username = ?", [username], (err, row) => {
    if (err) {
      console.error("Database error: ", err); // Log the error
      return res.status(500).json({ error: "Internal Server Error" });
    }
    if (!row) {
      console.error("User not found: ", username); // Log user not found
      return res.status(404).json({ error: "User Not Found" });
    }
    
    const inventory = JSON.parse(row.inventory);
    if (inventory.length === 0) {
      return res.json([]);
    }

    db.all(`SELECT * FROM inventoryItems WHERE rowid IN (${inventory.join(',')})`, (err, items) => {
      if (err) {
        console.error("Database error: ", err); // Log the error
        return res.status(500).json({ error: "Internal Server Error" });
      }
      res.json(items);
    });
  });
});

module.exports = router;
