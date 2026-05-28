CREATE TABLE IF NOT EXISTS users (
  username TEXT PRIMARY KEY,
  password TEXT NOT NULL,
  job TEXT NOT NULL DEFAULT 'Novice',
  health INTEGER NOT NULL DEFAULT 10,
  maxHealth INTEGER NOT NULL DEFAULT 10,
  stamina INTEGER NOT NULL DEFAULT 100,
  maxStamina INTEGER NOT NULL DEFAULT 100,
  speed INTEGER NOT NULL DEFAULT 1,
  strength INTEGER NOT NULL DEFAULT 1,
  intelligence INTEGER NOT NULL DEFAULT 1,
  level INTEGER NOT NULL DEFAULT 0,
  gold INTEGER NOT NULL DEFAULT 0,
  inventory TEXT NOT NULL DEFAULT '[]',
  attributePoints INTEGER NOT NULL DEFAULT 0,
  createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT OR IGNORE INTO users
  (username, password, job, health, maxHealth, stamina, maxStamina, speed, strength, intelligence, level, gold)
VALUES
  ('System', 'system', 'Novice', 9999, 9999, 9999, 9999, 9999, 9999, 9999, 0, 9999);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  username TEXT,
  deadUsername TEXT,
  createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expiresAt TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_username ON sessions (username);
CREATE INDEX IF NOT EXISTS idx_sessions_dead_username ON sessions (deadUsername);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions (expiresAt);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  roomRow INTEGER NOT NULL,
  roomCol INTEGER NOT NULL,
  username TEXT NOT NULL,
  message TEXT NOT NULL,
  timestamp TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_messages_room_time ON messages (roomRow, roomCol, id);
CREATE INDEX IF NOT EXISTS idx_messages_username ON messages (username);

CREATE TABLE IF NOT EXISTS tick (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  value INTEGER NOT NULL DEFAULT 0
);

INSERT OR IGNORE INTO tick (id, value) VALUES (1, 0);

CREATE TABLE IF NOT EXISTS cemetery (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL,
  password TEXT NOT NULL DEFAULT '',
  level INTEGER NOT NULL DEFAULT 0,
  gold INTEGER NOT NULL DEFAULT 0,
  job TEXT NOT NULL DEFAULT 'Novice',
  cause TEXT,
  roomRow INTEGER,
  roomCol INTEGER,
  diedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_cemetery_username ON cemetery (username, diedAt);

CREATE TABLE IF NOT EXISTS inventoryItems (
  itemName TEXT,
  itemCost INTEGER,
  HealthModifier INTEGER,
  StaminaModifier INTEGER,
  StrengthModifier INTEGER,
  SpeedModifier INTEGER,
  IntelligenceModifier INTEGER
);

CREATE TABLE IF NOT EXISTS roomTraces (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  roomRow INTEGER NOT NULL,
  roomCol INTEGER NOT NULL,
  traceType TEXT NOT NULL,
  intensity INTEGER NOT NULL DEFAULT 1,
  attacker TEXT,
  target TEXT,
  createdTick INTEGER NOT NULL,
  expiryTick INTEGER,
  worldDay TEXT NOT NULL,
  createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_roomTraces_room_day
  ON roomTraces (roomRow, roomCol, worldDay, expiryTick);

CREATE TABLE IF NOT EXISTS roomPresence (
  username TEXT NOT NULL,
  roomRow INTEGER NOT NULL,
  roomCol INTEGER NOT NULL,
  lastSeenTick INTEGER NOT NULL,
  worldDay TEXT NOT NULL,
  lastSeenAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (username, worldDay)
);

CREATE INDEX IF NOT EXISTS idx_roomPresence_room_day
  ON roomPresence (roomRow, roomCol, worldDay, lastSeenAt);

CREATE TABLE IF NOT EXISTS roomEffectCooldowns (
  username TEXT NOT NULL,
  roomRow INTEGER NOT NULL,
  roomCol INTEGER NOT NULL,
  effectType TEXT NOT NULL,
  lastAppliedTick INTEGER NOT NULL,
  worldDay TEXT NOT NULL,
  PRIMARY KEY (username, roomRow, roomCol, effectType, worldDay)
);

CREATE TABLE IF NOT EXISTS roomAccess (
  username TEXT NOT NULL,
  roomRow INTEGER NOT NULL,
  roomCol INTEGER NOT NULL,
  accessType TEXT NOT NULL,
  costPaid INTEGER NOT NULL,
  worldDay TEXT NOT NULL,
  createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (username, roomRow, roomCol, accessType, worldDay)
);

CREATE TABLE IF NOT EXISTS gamblingRounds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  roomRow INTEGER NOT NULL,
  roomCol INTEGER NOT NULL,
  worldDay TEXT NOT NULL,
  startTick INTEGER NOT NULL,
  endTick INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  pool INTEGER NOT NULL DEFAULT 0,
  winner TEXT,
  winningRoll INTEGER,
  createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_gamblingRounds_room_day
  ON gamblingRounds (roomRow, roomCol, worldDay, status, endTick);

CREATE TABLE IF NOT EXISTS gamblingEntries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  roundId INTEGER NOT NULL,
  username TEXT NOT NULL,
  wager INTEGER NOT NULL,
  roll INTEGER NOT NULL,
  enteredTick INTEGER NOT NULL,
  createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (roundId, username)
);

CREATE TABLE IF NOT EXISTS statusEffects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL,
  source TEXT NOT NULL,
  effectType TEXT NOT NULL,
  magnitude INTEGER NOT NULL DEFAULT 1,
  createdTick INTEGER NOT NULL,
  expiryTick INTEGER NOT NULL,
  roomRow INTEGER,
  roomCol INTEGER,
  sourceUsername TEXT,
  createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_statusEffects_user_expiry
  ON statusEffects (username, expiryTick, effectType);
