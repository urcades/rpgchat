const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('database.sqlite');

db.serialize(() => {
  // Create users table if it doesn't exist
  db.run(`CREATE TABLE IF NOT EXISTS users (
    username TEXT, 
    password TEXT, 
    health INTEGER DEFAULT 10, 
    maxHealth INTEGER DEFAULT 10, -- Add maxHealth
    stamina INTEGER DEFAULT 100, 
    maxStamina INTEGER DEFAULT 100, -- Add maxStamina
    speed INTEGER DEFAULT 1, 
    strength INTEGER DEFAULT 1, 
    intelligence INTEGER DEFAULT 1,
    level INTEGER DEFAULT 0, 
    ExperienceCount INTEGER DEFAULT 0,
    ExperienceRequired INTEGER DEFAULT 100,
    gold INTEGER DEFAULT 0,
    inventory TEXT DEFAULT '[]',
    attributePoints INTEGER DEFAULT 0,
    class TEXT DEFAULT 'Novice'
  )`);

  db.run(`INSERT OR IGNORE INTO users (username, password, health, maxHealth, stamina, maxStamina, speed, strength, intelligence, level, gold)
    VALUES ('System', 'system', 9999, 9999, 9999, 9999, 9999, 9999, 9999, 0, 9999)`);

  // Create messages table if it doesn't exist
  db.run("CREATE TABLE IF NOT EXISTS messages (username TEXT, message TEXT, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");

  // Create tick table if it doesn't exist
  db.run("CREATE TABLE IF NOT EXISTS tick (value INTEGER DEFAULT 0)");
  db.run("INSERT OR IGNORE INTO tick (rowid, value) VALUES (1, 0)");

  // Create cemetery table if it doesn't exist
  db.run(`CREATE TABLE IF NOT EXISTS cemetery (
    username TEXT,
    password TEXT,
    level INTEGER,
    gold INTEGER
  )`);

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

const gridSize = 16; // Change this value to match the grid size in success.html

for (let i = 1; i <= gridSize; i++) {
  for (let j = 1; j <= gridSize; j++) {
    db.run(`CREATE TABLE IF NOT EXISTS messages_${i}_${j} (
      username TEXT,
      message TEXT,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
  }
}

module.exports = db;