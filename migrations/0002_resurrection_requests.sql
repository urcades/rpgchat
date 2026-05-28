CREATE TABLE IF NOT EXISTS resurrectionRequests (
  token TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  graveId INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  stripeSessionId TEXT,
  createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completedAt TEXT
);

CREATE INDEX IF NOT EXISTS idx_resurrectionRequests_username_status
  ON resurrectionRequests (username, status, createdAt);

