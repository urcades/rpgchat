// adv ARCH-03: LEAF module — the plain keyed-by-username user reads (adv-009's
// consolidation). Imports only db.mjs + shared.mjs (itself a leaf over utils/),
// so the seams that need a user row no longer import world.mjs for it.
// world.mjs re-exports all three, so external imports are unchanged.
import { dbFirst } from '../db.mjs';
import { ActionError } from './shared.mjs';

export async function getUserOrNull(db, username) {
  return dbFirst(db, 'SELECT * FROM users WHERE username = ?', [username]);
}

export async function getUser(db, username, label = 'User') {
  const user = await getUserOrNull(db, username);
  if (!user) {
    throw new ActionError(`${label} not found.`, 404);
  }
  return user;
}

// adv-009: one home for the deliberately-NARROW per-user reads (the adv-006
// perf work selects only the columns a path needs, never `SELECT *`). Callers
// pass the exact column list they require; this preserves that narrowness while
// routing the `SELECT <cols> FROM users WHERE username = ?` shape through a
// single helper. Returns the row (with only the requested columns) or null.
// Columns are our own code-supplied identifiers — never user input — so they
// are interpolated directly, exactly as the inline SELECTs did. NOTE: reads that
// also filter on a predicate (e.g. `AND isNpc = 0`, `AND health > 0`) are a
// different shape and intentionally stay inline — this helper is the plain
// keyed-by-username read only.
export async function selectUserColumns(db, username, columns) {
  const cols = Array.isArray(columns) ? columns.join(', ') : columns;
  return dbFirst(db, `SELECT ${cols} FROM users WHERE username = ?`, [username]);
}
