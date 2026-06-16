-- Plan 012 (tail): rite mastery. Per-player, per-incantation-ability cumulative
-- successful-cast count. Rank (power + word-cap lift) is DERIVED from `casts` via
-- riteRankFromCasts (floor(log2(casts+1)), capped) and is NEVER stored — only the
-- raw count lives here. This table is persistent: it must survive the daily reset,
-- death, and a job change, so it is NOT swept by cleanupOldWorldDayData and carries
-- no worldDay column. NPC casters never write here (player-cast path only). No
-- users column, no backfill — absent rows simply mean rank 0.
CREATE TABLE IF NOT EXISTS riteMastery (
  username TEXT NOT NULL,
  abilityId TEXT NOT NULL,
  casts INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (username, abilityId)
);
