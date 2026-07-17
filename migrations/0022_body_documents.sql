-- engine-overhaul Phase B: the paperdoll body document, dual-written alongside
-- the row representation. `doc` is a paper-doll/v3 document (structure only:
-- vessels/parts, equipped gear, socketed materia, carried inventory); per-part
-- hp stays in bodyParts. `version` is the CAS guard for concurrent structural
-- writes. bodyPatches is the append-only paperfold log (regrow/resurrection
-- invert from it in Phase C/D). Additive + idempotent.
CREATE TABLE IF NOT EXISTS bodies (
  username TEXT PRIMARY KEY,
  doc TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  updatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS bodyPatches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL,
  patch TEXT NOT NULL,
  cause TEXT,
  tick INTEGER,
  createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_bodyPatches_user ON bodyPatches (username, id DESC);
