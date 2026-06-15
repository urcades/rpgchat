-- Plan 023b: the incapacitated negative-HP band ("Bleeding Out").
-- At 0 HP a player no longer dies instantly — they fall incapacitated (prone,
-- looted, mute but for garbled speech) and a death clock bleeds them out from 0
-- toward -30 on the world pulse. True death fires at the floor, or on a gib.
ALTER TABLE users ADD COLUMN incapacitated INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN deathClock INTEGER NOT NULL DEFAULT 0;
-- The cause recorded at the moment of downing, so a passive bleed-out still
-- attributes the kill to whoever felled them.
ALTER TABLE users ADD COLUMN downedCause TEXT;
