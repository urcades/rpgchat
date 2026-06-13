-- Items attach to body PART ROWS, not abstract slot names (plan 014).
-- A character with two arms has two `hand` mounts; grow a third arm and it
-- can hold a third item with zero schema change; lose an arm and whatever it
-- held clatters to the floor.
--
-- Three states, distinguished by which columns are set:
--   carried   = ownerUsername set, equippedPartId NULL, roomRow/roomCol NULL
--   equipped  = ownerUsername set, equippedPartId set
--   floor     = ownerUsername NULL, roomRow/roomCol set
-- One item per part is enforced by the partial unique index below.
CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  templateId TEXT NOT NULL,
  name TEXT NOT NULL,
  slotType TEXT NOT NULL,          -- head|torso|trinket|hand|leg
  rarity TEXT NOT NULL DEFAULT 'common',
  modifiers TEXT NOT NULL DEFAULT '{}',   -- JSON stat deltas (MODIFIER_KEYS)
  ownerUsername TEXT,
  equippedPartId INTEGER,          -- bodyParts.id; NULL = carried
  roomRow INTEGER, roomCol INTEGER,  -- set when on a room floor
  createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_items_owner ON items (ownerUsername, equippedPartId);
CREATE INDEX IF NOT EXISTS idx_items_room ON items (roomRow, roomCol);
CREATE UNIQUE INDEX IF NOT EXISTS idx_items_one_per_part
  ON items (equippedPartId) WHERE equippedPartId IS NOT NULL;
