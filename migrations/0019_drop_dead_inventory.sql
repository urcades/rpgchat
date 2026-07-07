-- perf: drop dead legacy storage.
--
-- users.inventory (JSON blob, 0001) has been unused since items moved to the
-- relational `items` table in 0006 — no worker code reads or writes it, but it
-- rides along in every `SELECT * FROM users` (the hottest read in the app,
-- including the per-request auth join). Dropping it shrinks every full-row read.
--
-- inventoryItems (0001) is a never-referenced table from the pre-Worker app.
--
-- Deploy-order safe in BOTH directions: the running code never references
-- either object, so applying this before or after any deploy cannot break a
-- query. (SQLite ALTER TABLE ... DROP COLUMN requires 3.35+, which D1 and the
-- test shim both exceed.)
ALTER TABLE users DROP COLUMN inventory;

DROP TABLE IF EXISTS inventoryItems;
