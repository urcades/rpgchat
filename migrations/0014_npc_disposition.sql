-- Plan 013b: the living NPC population.
-- disposition gates combat: only hostile NPCs are drafted as attackers (NULL also reads
--   as hostile, so existing/legacy NPCs are unaffected; only explicitly friendly/neutral
--   social NPCs sit out the fight until 013c flips them).
-- role drives dialogue demeanor + fallback lines (bartender/barmaid/patron/guard/...).
-- npcWorldDay anchors social NPCs to the daily reset, like rooms.
ALTER TABLE users ADD COLUMN disposition TEXT;
ALTER TABLE users ADD COLUMN role TEXT;
ALTER TABLE users ADD COLUMN npcWorldDay TEXT;

-- Every NPC that exists today is a hostile.
UPDATE users SET disposition = 'hostile' WHERE isNpc = 1;
