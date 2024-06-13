const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('database.sqlite');

db.serialize(() => {
  // Create users table if it doesn't exist
  db.run(`CREATE TABLE IF NOT EXISTS users (
    username TEXT, 
    password TEXT, 
    health INTEGER DEFAULT 100, 
    maxHealth INTEGER DEFAULT 100, -- Add maxHealth
    stamina INTEGER DEFAULT 100, 
    maxStamina INTEGER DEFAULT 100, -- Add maxStamina
    speed INTEGER DEFAULT 1, 
    strength INTEGER DEFAULT 1, 
    intelligence INTEGER DEFAULT 1,
    level INTEGER DEFAULT 0, 
    gold INTEGER DEFAULT 0,
    inventory TEXT DEFAULT '[]',
    attributePoints INTEGER DEFAULT 0
  )`);

  // Create messages table if it doesn't exist
  db.run("CREATE TABLE IF NOT EXISTS messages (username TEXT, message TEXT, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");

  // Create tick table if it doesn't exist
  db.run("CREATE TABLE IF NOT EXISTS tick (value INTEGER DEFAULT 0)");
  db.run("INSERT OR IGNORE INTO tick (rowid, value) VALUES (1, 0)");

  // Create inventoryItems table if it doesn't exist
  db.run(`CREATE TABLE IF NOT EXISTS inventoryItems (
    itemName TEXT,
    itemCost INTEGER,
    HealthModifier INTEGER,
    StaminaModifier INTEGER,
    StrengthModifier INTEGER,
    SpeedModifier INTEGER,
    IntelligenceModifier INTEGER
  )`);
});

module.exports = db;