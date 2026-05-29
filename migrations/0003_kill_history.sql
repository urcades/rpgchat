CREATE TABLE IF NOT EXISTS killHistory (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  killerUsername TEXT NOT NULL,
  defeatedUsername TEXT NOT NULL,
  defeatedName TEXT NOT NULL,
  defeatedKind TEXT NOT NULL DEFAULT 'player',
  defeatedLevel INTEGER NOT NULL DEFAULT 0,
  experienceGained INTEGER NOT NULL DEFAULT 0,
  goldGained INTEGER NOT NULL DEFAULT 0,
  roomRow INTEGER,
  roomCol INTEGER,
  worldDay TEXT NOT NULL,
  tick INTEGER,
  createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_killHistory_killer
  ON killHistory (killerUsername, id DESC);
