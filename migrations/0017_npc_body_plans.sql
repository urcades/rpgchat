-- Plan 021 (BOLD): NPC anatomy parity + elite growth.
--
-- creatureBodyPlan: the body-plan id a bodied NPC routes through (wyrm/quadruped/brute/
--   humanoid). NULL = scalar HP — the bodyless gate's today-behavior. NO BACKFILL is the
--   whole point of the lazy contract: any NPC already in flight finishes the day on scalar
--   HP; only NEW spawns (createNpcForEvent via the decorated template) carry a plan. Bodies
--   are still instantiated lazily on first hit by ensureBody, exactly like players — the
--   column just records WHICH plan to distribute over.
--
-- affixes: a JSON array of elite affix names (e.g. ["Vicious","Armored"]) or NULL for a
--   non-elite. Drives the displayName prefix, the stat/element deltas (applied at spawn),
--   and the spawn-time body riders (Hulking's extra parts, Armored's part-maxHp
--   fortification) that ensureBody reads back. NULL default, no backfill.
--
-- The bodyParts table (0005) already stores arbitrary partType/label/slotType with a
-- baseMaxHp (0007), so a wyrm's wing/tail or an elite's extra limb need NO schema change.
ALTER TABLE users ADD COLUMN creatureBodyPlan TEXT;
ALTER TABLE users ADD COLUMN affixes TEXT;
