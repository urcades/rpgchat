-- Plan 022c: the resurrection anchor. On death a player's body drops as a corpse
-- item tagged with whose it is; resurrection (paid OR free) requires that corpse to
-- still exist. Eat/destroy it → the tether snaps → true, permanent death.
-- corpseOf is NULL for ordinary items; set to the dead player's username on a corpse.
ALTER TABLE items ADD COLUMN corpseOf TEXT;
CREATE INDEX IF NOT EXISTS idx_items_corpse_of ON items (corpseOf);
