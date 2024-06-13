const express = require('express');
const router = express.Router();
const db = require('../db/setup');
const authMiddleware = require('../middleware/auth');

// Add a new inventory item
router.post('/add-item', authMiddleware, (req, res) => {
  const { itemName, itemCost, HealthModifier, StaminaModifier, StrengthModifier, SpeedModifier, IntelligenceModifier } = req.body;

  db.run("INSERT INTO inventoryItems (itemName, itemCost, HealthModifier, StaminaModifier, StrengthModifier, SpeedModifier, IntelligenceModifier) VALUES (?, ?, ?, ?, ?, ?, ?)", 
  [itemName, itemCost, HealthModifier, StaminaModifier, StrengthModifier, SpeedModifier, IntelligenceModifier], (err) => {
    if (err) {
      return res.status(500).send("Internal Server Error");
    }
    res.send("Item added successfully");
  });
});

// Get all inventory items
router.get('/items', authMiddleware, (req, res) => {
  db.all("SELECT * FROM inventoryItems", (err, rows) => {
    if (err) {
      return res.status(500).send("Internal Server Error");
    }
    res.json(rows);
  });
});

// Assign an item to a user
router.post('/assign-item', authMiddleware, (req, res) => {
  const username = req.session.user.username;
  const itemId = req.body.itemId;

  db.get("SELECT inventory FROM users WHERE username = ?", [username], (err, row) => {
    if (err) {
      return res.status(500).send("Internal Server Error");
    }
    let inventory = JSON.parse(row.inventory);
    inventory.push(itemId);

    db.run("UPDATE users SET inventory = ? WHERE username = ?", [JSON.stringify(inventory), username], (err) => {
      if (err) {
        return res.status(500).send("Internal Server Error");
      }
      res.send("Item assigned to user successfully");
    });
  });
});

module.exports = router;