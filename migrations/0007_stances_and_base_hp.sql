ALTER TABLE users ADD COLUMN stance TEXT NOT NULL DEFAULT 'standing';
-- baseMaxHp = a part's UN-fortified max HP (no equipped-armor bonus). Regrow
-- restores a severed part to this, never to a lingering fortified maxHp left
-- over from armor that was knocked off when the limb was severed. Backfill to
-- current maxHp (correct for unarmored parts, which is the overwhelming case).
ALTER TABLE bodyParts ADD COLUMN baseMaxHp INTEGER NOT NULL DEFAULT 0;
UPDATE bodyParts SET baseMaxHp = maxHp WHERE baseMaxHp = 0;
