-- Plan 022 (tail): corpse decay. Remains and corpses age over world ticks. A
-- per-instance `decayTick` records the tick at which the item was created (the
-- start of its decay clock); NULL for ordinary items (they never decay).
--   - MONSTER remains advance fresh → rotten → bones in place, then are CULLED.
--   - PLAYER corpses are renamed cosmetically only — NEVER auto-deleted, and
--     `corpseOf` is ALWAYS kept, so the resurrection anchor persists indefinitely.
-- Additive + nullable: existing rows keep decayTick NULL and are unaffected.
ALTER TABLE items ADD COLUMN decayTick INTEGER;
