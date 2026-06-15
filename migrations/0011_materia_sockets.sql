-- Plan 020d: materia + sockets. A materia is an item (category 'materia') socketed
-- INTO a host gear item; while the host is equipped, the materia injects its effect.
--   socketedInId: the host item's id this materia sits in (NULL = loose/not socketed).
--   ap: accumulated AP — materia level (and effect strength) grow with it.
-- Socket COUNT is a template property (getItemSockets), so no column is needed for it.
ALTER TABLE items ADD COLUMN socketedInId INTEGER;
ALTER TABLE items ADD COLUMN ap INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_items_socketed ON items (socketedInId);
