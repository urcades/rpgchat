const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('database.sqlite');

function ensureColumn(tableName, columnName, definition, callback = () => {}) {
  db.all(`PRAGMA table_info(${tableName})`, (err, columns) => {
    if (err) {
      console.error(`Error reading ${tableName} schema:`, err);
      callback(err);
      return;
    }

    if (!columns.some(column => column.name === columnName)) {
      db.run(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`, (alterErr) => {
        if (alterErr) {
          console.error(`Error adding ${tableName}.${columnName}:`, alterErr);
        }
        callback(alterErr);
      });
      return;
    }

    callback();
  });
}

db.serialize(() => {
  // Create users table if it doesn't exist
  db.run(`CREATE TABLE IF NOT EXISTS users (
    username TEXT, 
    password TEXT, 
    job TEXT DEFAULT 'Novice',
    health INTEGER DEFAULT 10, 
    maxHealth INTEGER DEFAULT 10, -- Add maxHealth
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

  ensureColumn('users', 'job', "TEXT DEFAULT 'Novice'", () => {
    db.run("UPDATE users SET job = 'Novice' WHERE job IS NULL OR job = ''");
    db.run(`INSERT INTO users (username, password, job, health, maxHealth, stamina, maxStamina, speed, strength, intelligence, level, gold)
      SELECT 'System', 'system', 'Novice', 9999, 9999, 9999, 9999, 9999, 9999, 9999, 0, 9999
      WHERE NOT EXISTS (SELECT 1 FROM users WHERE username = 'System')`);
  });

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
    gold INTEGER,
    job TEXT DEFAULT 'Novice',
    cause TEXT,
    roomRow INTEGER,
    roomCol INTEGER,
    diedAt DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  ensureColumn('cemetery', 'job', "TEXT DEFAULT 'Novice'");
  ensureColumn('cemetery', 'cause', "TEXT");
  ensureColumn('cemetery', 'roomRow', "INTEGER");
  ensureColumn('cemetery', 'roomCol', "INTEGER");
  ensureColumn('cemetery', 'diedAt', "DATETIME");

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

  db.run(`CREATE TABLE IF NOT EXISTS roomTraces (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    roomRow INTEGER,
    roomCol INTEGER,
    traceType TEXT,
    intensity INTEGER DEFAULT 1,
    attacker TEXT,
    target TEXT,
    createdTick INTEGER,
    expiryTick INTEGER,
    worldDay TEXT,
    createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE INDEX IF NOT EXISTS idx_roomTraces_room_day
    ON roomTraces (roomRow, roomCol, worldDay, expiryTick)`);

  db.run(`CREATE TABLE IF NOT EXISTS roomPresence (
    username TEXT,
    roomRow INTEGER,
    roomCol INTEGER,
    lastSeenTick INTEGER,
    worldDay TEXT,
    lastSeenAt DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (username, worldDay)
  )`);

  db.run(`CREATE INDEX IF NOT EXISTS idx_roomPresence_room_day
    ON roomPresence (roomRow, roomCol, worldDay, lastSeenAt)`);

  db.run(`CREATE TABLE IF NOT EXISTS roomEffectCooldowns (
    username TEXT,
    roomRow INTEGER,
    roomCol INTEGER,
    effectType TEXT,
    lastAppliedTick INTEGER,
    worldDay TEXT,
    PRIMARY KEY (username, roomRow, roomCol, effectType, worldDay)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS roomAccess (
    username TEXT,
    roomRow INTEGER,
    roomCol INTEGER,
    accessType TEXT,
    costPaid INTEGER,
    worldDay TEXT,
    createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (username, roomRow, roomCol, accessType, worldDay)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS gamblingRounds (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    roomRow INTEGER,
    roomCol INTEGER,
    worldDay TEXT,
    startTick INTEGER,
    endTick INTEGER,
    status TEXT DEFAULT 'open',
    pool INTEGER DEFAULT 0,
    winner TEXT,
    winningRoll INTEGER,
    createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE INDEX IF NOT EXISTS idx_gamblingRounds_room_day
    ON gamblingRounds (roomRow, roomCol, worldDay, status, endTick)`);

  db.run(`CREATE TABLE IF NOT EXISTS gamblingEntries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    roundId INTEGER,
    username TEXT,
    wager INTEGER,
    roll INTEGER,
    enteredTick INTEGER,
    createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (roundId, username)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS statusEffects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT,
    source TEXT,
    effectType TEXT,
    magnitude INTEGER DEFAULT 1,
    createdTick INTEGER,
    expiryTick INTEGER,
    roomRow INTEGER,
    roomCol INTEGER,
    sourceUsername TEXT,
    createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE INDEX IF NOT EXISTS idx_statusEffects_user_expiry
    ON statusEffects (username, expiryTick, effectType)`);
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
