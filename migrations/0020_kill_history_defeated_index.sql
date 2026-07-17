-- adv PERF-02: /cemetery-data runs a per-grave correlated subquery and
-- /death-data a point lookup on `killHistory.defeatedUsername`, but the only
-- existing index (0003's idx_killHistory_killer) leads with killerUsername —
-- so each slayer lookup is a full killHistory scan, O(graves × killHistory) on the
-- cemetery page and growing with game age. Additive + idempotent, safe to
-- apply ahead of the deploy.
CREATE INDEX IF NOT EXISTS idx_killHistory_defeated
  ON killHistory (defeatedUsername, defeatedKind, id DESC);
