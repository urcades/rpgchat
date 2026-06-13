CREATE TABLE IF NOT EXISTS bodyParts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL,
  partType TEXT NOT NULL,
  label TEXT NOT NULL,
  slotType TEXT,
  vital INTEGER NOT NULL DEFAULT 0,
  hp INTEGER NOT NULL,
  maxHp INTEGER NOT NULL,
  severed INTEGER NOT NULL DEFAULT 0,
  createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (username, label)
);
CREATE INDEX IF NOT EXISTS idx_bodyParts_user ON bodyParts (username, severed);

-- HP rebase ×3 (owner decision): gives parts meaningful pools.
-- NPCs and System keep their numbers; cemetery rows carry no HP.
UPDATE users SET health = health * 3, maxHealth = maxHealth * 3
WHERE isNpc = 0 AND username != 'System';
