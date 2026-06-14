-- Plan 020a: consumables stack. `category` (gear/consumable/materia/part) is a
-- TEMPLATE property (utils/items.js), derived from templateId — no column needed.
-- Only the current stack count is per-instance, so all we add is `quantity`.
-- Existing rows are single items → backfilled to 1.
ALTER TABLE items ADD COLUMN quantity INTEGER NOT NULL DEFAULT 1;
