-- adv DUR-01: server-side action idempotency. A client re-sends any un-acked
-- WS action over HTTP when the socket dies, but the server commits BEFORE the
-- ack — a blip in that window replayed the action (duplicate chat line, double
-- stamina, a second resolved attack). Each action now carries a client token;
-- the first transport to INSERT its claim row wins, the replay sees a conflict
-- and is acked without re-applying. Rows are pruned by the world sweep.
CREATE TABLE IF NOT EXISTS actionClaims (
  claimKey TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_actionClaims_createdAt ON actionClaims (createdAt);
