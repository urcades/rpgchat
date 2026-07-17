// adv ARCH-03: LEAF module — the global tick read. Imports only db.mjs, never
// another game seam, so death/body/messages/inventory/progression can depend on
// it without re-entering world.mjs (which imports all of them — the old
// world↔seam import cycles only worked because every cross-import was a hoisted
// function). world.mjs re-exports this, so external imports are unchanged.
import { dbFirst } from '../db.mjs';

export async function getCurrentTickValue(db) {
  const row = await dbFirst(db, 'SELECT value FROM tick WHERE id = 1');
  return row ? row.value : 0;
}
