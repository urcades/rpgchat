-- Plan 019: the progression grid (shared skill-tree board).
-- Skill Points are a SEPARATE currency from 016's attribute points (granted 1 per
-- level by awardExperience). Backfill existing players to their level so they get
-- the points they've already earned. playerProgressionNodes records PAID unlocks;
-- a class's entry node is implicit (derived from job), never stored. Node effects
-- are derived from the unlocked set, so respec is just deleting these rows.

ALTER TABLE users ADD COLUMN skillPoints INTEGER NOT NULL DEFAULT 0;

UPDATE users SET skillPoints = level WHERE isNpc = 0 AND level > 0;

CREATE TABLE IF NOT EXISTS playerProgressionNodes (
  username TEXT NOT NULL,
  nodeId TEXT NOT NULL,
  unlockedTick INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (username, nodeId)
);

CREATE INDEX IF NOT EXISTS idx_player_progression_user ON playerProgressionNodes (username);
