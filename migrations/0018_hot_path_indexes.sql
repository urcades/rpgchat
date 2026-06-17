-- adv-007: hot-path covering indexes. ALL additive `CREATE INDEX IF NOT EXISTS`
-- — no table/column change, idempotent, and safe to apply ahead of the deploy
-- (an index the code never references is harmless; a missing one only costs a
-- scan). Each backs a query that currently does a full table scan or repeated
-- per-row work. Only the indexes NOT already created by an earlier migration are
-- added here (0005 has idx_bodyParts_user(username,severed); 0006 has
-- idx_items_owner(ownerUsername,equippedPartId), idx_items_room; 0011/0012 cover
-- socketedInId/corpseOf) — so this file adds strictly the missing ones.

-- processCorpseDecay (world.mjs) sweeps every world pulse with
-- `WHERE decayTick IS NOT NULL AND templateId IN (...)`. A partial index on the
-- decaying rows only (the vast majority of items have decayTick NULL) keeps the
-- sweep proportional to live remains/corpses instead of the whole items table.
CREATE INDEX IF NOT EXISTS idx_items_decay ON items (decayTick) WHERE decayTick IS NOT NULL;

-- craftRecipe (inventory.mjs) runs, per recipe input, a COUNT then a DELETE keyed
-- on `ownerUsername = ? AND templateId = ?` (plus carried-only predicates). The
-- existing idx_items_owner leads with (ownerUsername, equippedPartId), which
-- doesn't help the templateId filter; this composite makes the per-template
-- owned-item lookup a direct probe.
CREATE INDEX IF NOT EXISTS idx_items_owner_template ON items (ownerUsername, templateId);

-- The incapacitation bleed / death scans (death.mjs) filter live downed players
-- with `incapacitated = 1`. A partial index over only the (few) incapacitated
-- rows turns that recurring scan into a tiny index range.
CREATE INDEX IF NOT EXISTS idx_users_incapacitated ON users (incapacitated) WHERE incapacitated = 1;

-- attachItemToBody (inventory.mjs) selects equip-candidate parts with
-- `username = ? AND slotType = ? AND severed = 0`. idx_bodyParts_user only covers
-- (username, severed); adding slotType lets the candidate query probe the exact
-- slot instead of scanning all of a user's parts.
CREATE INDEX IF NOT EXISTS idx_bodyParts_user_slot ON bodyParts (username, slotType, severed);
