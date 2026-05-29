ALTER TABLE users ADD COLUMN experience INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN isNpc INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN displayName TEXT;
ALTER TABLE users ADD COLUMN npcKind TEXT;
ALTER TABLE users ADD COLUMN worldEventId TEXT;

CREATE INDEX IF NOT EXISTS idx_users_npc_room
  ON users (isNpc, worldEventId, username);

CREATE TABLE IF NOT EXISTS worldEvents (
  id TEXT PRIMARY KEY,
  worldDay TEXT NOT NULL,
  eventType TEXT NOT NULL,
  roomRow INTEGER NOT NULL,
  roomCol INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  rewardExperience INTEGER NOT NULL DEFAULT 0,
  rewardGold INTEGER NOT NULL DEFAULT 0,
  createdTick INTEGER NOT NULL DEFAULT 0,
  expiresTick INTEGER,
  completedTick INTEGER,
  createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_worldEvents_day_status
  ON worldEvents (worldDay, status, eventType);

CREATE INDEX IF NOT EXISTS idx_worldEvents_room
  ON worldEvents (roomRow, roomCol, worldDay, status);

CREATE TABLE IF NOT EXISTS worldEventEntities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  eventId TEXT NOT NULL,
  username TEXT NOT NULL UNIQUE,
  entityKind TEXT NOT NULL,
  maxPopulation INTEGER NOT NULL DEFAULT 1,
  respawnInterval INTEGER NOT NULL DEFAULT 20,
  lastDefeatedTick INTEGER,
  rewardExperience INTEGER NOT NULL DEFAULT 0,
  rewardGold INTEGER NOT NULL DEFAULT 0,
  createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_worldEventEntities_event
  ON worldEventEntities (eventId, entityKind);

CREATE TABLE IF NOT EXISTS worldEventAchievements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL,
  eventId TEXT NOT NULL,
  achievementType TEXT NOT NULL,
  worldDay TEXT NOT NULL,
  earnedTick INTEGER NOT NULL,
  rewardExperience INTEGER NOT NULL DEFAULT 0,
  rewardGold INTEGER NOT NULL DEFAULT 0,
  createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (username, eventId, achievementType)
);

CREATE INDEX IF NOT EXISTS idx_worldEventAchievements_user
  ON worldEventAchievements (username, worldDay);
