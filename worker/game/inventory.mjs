// Inventory, equipment, items, crafting, consumables, materia & shop (plan adv-005).
//
// Extracted verbatim from the original worker/game.mjs — a pure mechanical move.
// Cross-seam dependencies are now explicit imports; cycles between seams resolve
// through ESM live bindings (every cross-seam reference is call-time, never
// dereferenced at module load).

import {
  ActionError,
  CORPSE_CULL_TICKS,
  CORPSE_FRESH_TICKS,
  CORPSE_ROTTEN_TICKS,
  MODIFIER_KEYS,
  assertAction,
  commandRest,
  emptyModifiers,
  escapeRegExp,
  findRecipeByOutputName,
  generateShopStock,
  getItemCategory,
  getItemSockets,
  getMateriaEffect,
  getTemplate,
  getWorldDay
} from './shared.mjs';
import {
  changes,
  dbAll,
  dbBatch,
  dbFirst,
  dbRun,
  lastInsertId
} from '../db.mjs';
import {
  addStatusEffect,
  applyPartMaxHpDelta,
  clearOneHarmfulEffect,
  ensureBody,
  healUser,
  itemMaxHealthBonus,
  parseItemModifiers
} from './body.mjs';
import { insertSystemMessage } from './messages.mjs';
import { logEvent } from '../observability.mjs';
import { syncBodyDoc } from './bodyDoc.mjs';
import { getCurrentTickValue } from './clock.mjs';
import { getUser } from './users.mjs';
import { roomHasEffect } from './ecology.mjs';


// Owned items joined to the equipped part's label; equipped rows first.
export async function getInventory(db, username) {
  return dbAll(
    db,
    `SELECT i.id, i.templateId, i.name, i.slotType, i.rarity, i.modifiers,
            i.equippedPartId, i.quantity, i.socketedInId, bp.label AS partLabel
     FROM items i
     LEFT JOIN bodyParts bp ON bp.id = i.equippedPartId
     WHERE i.ownerUsername = ?
     ORDER BY CASE WHEN i.equippedPartId IS NULL THEN 1 ELSE 0 END,
              bp.label ASC, i.name ASC, i.id ASC`,
    [username]
  );
}

// Sum the modifiers of every equipped item into a modifier object over
// MODIFIER_KEYS EXCEPT maxHealth, which is intentionally excluded: plan 015
// owns HP gear via part maxHp, and applying maxHealth to the effective layer
// now would be an unfillable dead stat (applyBodyHeal caps fill at part maxHp).
// Plan 020d: the effects injected by materia socketed into the given host items.
export async function getSocketedMateriaEffects(db, hostIds) {
  if (!hostIds || !hostIds.length) {
    return [];
  }
  const rows = await dbAll(
    db,
    `SELECT templateId, ap FROM items WHERE socketedInId IN (${hostIds.map(() => '?').join(',')})`,
    hostIds
  );
  return rows.map(row => getMateriaEffect(row.templateId, row.ap)).filter(Boolean);
}

export async function getEquippedModifiers(db, username) {
  const rows = await dbAll(
    db,
    'SELECT id, modifiers FROM items WHERE ownerUsername = ? AND equippedPartId IS NOT NULL',
    [username]
  );
  const modifiers = emptyModifiers();
  delete modifiers.maxHealth; // dead-stat guard: never surface gear maxHealth.
  const equippedIds = [];
  for (const row of rows) {
    equippedIds.push(row.id);
    const parsed = parseItemModifiers(row.modifiers);
    for (const key of MODIFIER_KEYS) {
      if (key === 'maxHealth') {
        continue;
      }
      const value = Number(parsed[key]);
      if (Number.isFinite(value)) {
        modifiers[key] = (modifiers[key] || 0) + value;
      }
    }
  }
  // Plan 020d: socketed-materia stat effects (host must be equipped).
  for (const effect of await getSocketedMateriaEffects(db, equippedIds)) {
    if (effect.kind === 'stat' && effect.stat !== 'maxHealth') {
      modifiers[effect.stat] = (modifiers[effect.stat] || 0) + effect.amount;
    }
  }
  return modifiers;
}

async function findOwnedUnequippedItem(db, username, itemName) {
  return dbFirst(
    db,
    `SELECT id, name, slotType, modifiers FROM items
     WHERE ownerUsername = ? AND equippedPartId IS NULL
       AND roomRow IS NULL AND roomCol IS NULL
       AND LOWER(name) = LOWER(?)
     ORDER BY id ASC
     LIMIT 1`,
    [username, itemName]
  );
}

// Shared equip core: attach an ALREADY-OWNED item row to a matching body part
// and fold its HP gear (plan 015). The single write path for both /equip (which
// adds a system message afterward) and createItemForOwner's silent grant — so
// the candidate-part selection, swap-off-occupant HP accounting, attach, and
// applyPartMaxHpDelta(+bonus) can't drift between the two callers. `item` must
// have id, slotType, and modifiers. Returns { partId, partLabel }.
async function attachItemToBody(db, user, item) {
  await ensureBody(db, user);
  const candidates = await dbAll(
    db,
    `SELECT id, label FROM bodyParts
     WHERE username = ? AND slotType = ? AND severed = 0
     ORDER BY id ASC`,
    [user.username, item.slotType]
  );
  if (candidates.length === 0) {
    throw new ActionError('You have nowhere to put that.');
  }

  // Which candidate parts already hold an item?
  const occupied = await dbAll(
    db,
    `SELECT equippedPartId FROM items
     WHERE ownerUsername = ? AND equippedPartId IS NOT NULL`,
    [user.username]
  );
  const occupiedIds = new Set(occupied.map(o => o.equippedPartId));

  // Prefer an EMPTY candidate part; if all are occupied, swap on the first one.
  let target = candidates.find(part => !occupiedIds.has(part.id));
  if (!target) {
    target = candidates[0];
    // Swap = unequip-then-equip for HP accounting: the swapped-off item's
    // bonus must leave the part BEFORE the new item's bonus enters, or the
    // part would keep the old armor's HP. Remove every occupant's bonus first.
    const occupants = await dbAll(
      db,
      'SELECT modifiers FROM items WHERE equippedPartId = ?',
      [target.id]
    );
    for (const occupant of occupants) {
      await applyPartMaxHpDelta(db, user.username, target.id, -itemMaxHealthBonus(occupant));
    }
    await dbRun(
      db,
      'UPDATE items SET equippedPartId = NULL WHERE equippedPartId = ?',
      [target.id]
    );
  }

  // adv-018: CLAIM the slot first, fold HP only on a won claim. The non-atomic
  // read-decide-write above can hand two concurrent /equip the SAME empty target;
  // the partial unique index idx_items_one_per_part (one item per equippedPartId)
  // is the arbiter. By gating on changes()===1 BEFORE applyPartMaxHpDelta, a lost
  // claim folds NO HP — so a failed equip can never corrupt users.maxHealth. The
  // item-side guard equippedPartId IS NULL also makes a re-attach of an
  // already-equipped row a no-op rather than a silent re-fold.
  let claimed;
  try {
    claimed = await dbRun(
      db,
      `UPDATE items SET equippedPartId = ?, roomRow = NULL, roomCol = NULL
       WHERE id = ? AND equippedPartId IS NULL`,
      [target.id, item.id]
    );
  } catch (err) {
    // The unique index rejected a colliding claim (the part was filled by a
    // racing equip after our occupancy read). No HP was folded; surface a clean
    // refusal instead of the raw SQLITE_CONSTRAINT.
    throw new ActionError('You have nowhere to put that.');
  }
  if (changes(claimed) !== 1) {
    // Lost the claim (the item was equipped/handed off concurrently). No fold.
    throw new ActionError('You have nowhere to put that.');
  }

  // Fold this item's HP gear into the worn part (structural, plan 015): raise
  // the part's maxHp and users.maxHealth by the bonus — ONLY now that the claim
  // is won. A positive bonus opens headroom but does NOT heal; a negative bonus
  // clamps hp/health down.
  await applyPartMaxHpDelta(db, user.username, target.id, itemMaxHealthBonus(item));

  return { partId: target.id, partLabel: target.label };
}

export async function equipItem(db, user, itemName, row, col) {
  const item = await findOwnedUnequippedItem(db, user.username, itemName);
  if (!item) {
    throw new ActionError("You aren't carrying that.");
  }

  const { partId, partLabel } = await attachItemToBody(db, user, item);

  await insertSystemMessage(db, row, col, `${user.username} equips ${item.name} on their ${partLabel}.`);
  return { item, partId, partLabel };
}

export async function unequipItem(db, user, ref, row, col) {
  await ensureBody(db, user);
  // ref may name the item OR the body part (case-insensitive). Pull the part's
  // id/severed and the item's modifiers too, so we can reverse the HP gear
  // (plan 015) BEFORE clearing equippedPartId.
  const equipped = await dbFirst(
    db,
    `SELECT i.id, i.name, i.modifiers, bp.id AS partId, bp.label AS partLabel, bp.severed
     FROM items i
     JOIN bodyParts bp ON bp.id = i.equippedPartId
     WHERE i.ownerUsername = ? AND i.equippedPartId IS NOT NULL
       AND (LOWER(i.name) = LOWER(?) OR LOWER(bp.label) = LOWER(?))
     ORDER BY i.id ASC
     LIMIT 1`,
    [user.username, ref, ref]
  );
  if (!equipped) {
    throw new ActionError('Nothing equipped there.');
  }

  // Remove this item's HP gear from the part it's leaving — inverse of equip's
  // applyPartMaxHpDelta. A severed part already shed its maxHp (including the
  // gear) on sever, so skip it there to avoid double-subtracting.
  if (!equipped.severed) {
    await applyPartMaxHpDelta(db, user.username, equipped.partId, -itemMaxHealthBonus(equipped));
  }

  await dbRun(db, 'UPDATE items SET equippedPartId = NULL WHERE id = ?', [equipped.id]);
  await insertSystemMessage(db, row, col, `${user.username} stows ${equipped.name}.`);
  return { item: { id: equipped.id, name: equipped.name }, partLabel: equipped.partLabel };
}

// Mint an item from a template and give it to a player. With { equip: true }
// the end state is IDENTICAL to the player carrying it and running /equip —
// including plan 015's HP fold via the shared attachItemToBody — but SILENT (no
// system message) and with NO room needed (signup grants gear off-grid).
// Returns the inserted item id.
export async function createItemForOwner(db, templateId, username, { equip = false } = {}) {
  const template = getTemplate(templateId);
  if (!template) {
    throw new ActionError(`Unknown item template: ${templateId}`);
  }
  const result = await dbRun(
    db,
    `INSERT INTO items (templateId, name, slotType, rarity, modifiers, ownerUsername)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [template.templateId, template.name, template.slotType, template.rarity, JSON.stringify(template.modifiers || {}), username]
  );
  const itemId = lastInsertId(result);

  if (equip) {
    const user = await getUser(db, username);
    // attachItemToBody needs id/slotType/modifiers; reuse the template values.
    await attachItemToBody(db, user, {
      id: itemId,
      slotType: template.slotType,
      modifiers: JSON.stringify(template.modifiers || {})
    });
  }

  return itemId;
}

// Drop a fresh template-minted item onto a room floor (ownerUsername NULL).
// Used for NPC defeat loot.
export async function dropItemOnFloor(db, templateId, row, col, options = {}) {
  const template = getTemplate(templateId);
  if (!template) {
    return null;
  }
  // Plan 023b: an optional name override lets a gib drop a victim-named severed
  // part ("X's severed left arm") from a generic template.
  const name = options.name || template.name;
  // Plan 022 (tail): an optional decayTick starts this item's decay clock (set on
  // remains so processCorpseDecay can age them). NULL for ordinary loot.
  const decayTick = Number.isFinite(options.decayTick) ? options.decayTick : null;
  await dbRun(
    db,
    `INSERT INTO items (templateId, name, slotType, rarity, modifiers, ownerUsername, roomRow, roomCol, decayTick)
     VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
    [template.templateId, name, template.slotType, template.rarity, JSON.stringify(template.modifiers || {}), row, col, decayTick]
  );
}

// Drop a CARRIED item (owned, unequipped) onto the current room floor, where
// any player can /take it. Equipped items must be /unequip'd first (that returns
// them to the pack), so this only ever moves carried items. Race-safe: the
// conditional WHERE means a second drop of an item already gone is a no-op.
export async function dropOwnedItem(db, username, itemName, row, col) {
  const item = await findOwnedUnequippedItem(db, username, itemName);
  if (!item) {
    throw new ActionError("You aren't carrying that.");
  }
  const result = await dbRun(
    db,
    `UPDATE items SET ownerUsername = NULL, equippedPartId = NULL, roomRow = ?, roomCol = ?
     WHERE id = ? AND ownerUsername = ? AND equippedPartId IS NULL`,
    [row, col, item.id, username]
  );
  if (changes(result) === 0) {
    throw new ActionError("You aren't carrying that.");
  }
  await insertSystemMessage(db, row, col, `${username} drops ${item.name}.`);
  return { item: { id: item.id, name: item.name } };
}

// Full-loot on death: every item the player owns (carried OR equipped) scatters
// to the room floor where they fell. No HP accounting — the body is deleted on
// death, and a taker re-applies any bonus fresh via /equip. Returns how many
// item rows were scattered.
export async function dropPlayerItemsOnDeath(db, username, row, col) {
  const result = await dbRun(
    db,
    `UPDATE items SET ownerUsername = NULL, equippedPartId = NULL, roomRow = ?, roomCol = ?
     WHERE ownerUsername = ?`,
    [row, col, username]
  );
  return changes(result);
}

// Items lying on a room floor (ownerUsername NULL), for the room payload.
export async function getFloorItems(db, row, col) {
  return dbAll(
    db,
    `SELECT id, name, slotType, rarity, modifiers FROM items
     WHERE ownerUsername IS NULL AND roomRow = ? AND roomCol = ?
     ORDER BY id DESC LIMIT 20`,
    [row, col]
  );
}

// Pick a floor item up by name into the player's pack (carried, NOT equipped —
// no HP fold here). The claim is a conditional update so two players racing for
// the same item can't both win: only the one whose UPDATE still saw
// ownerUsername NULL takes it.
export async function takeItem(db, username, itemName, row, col) {
  const item = await dbFirst(
    db,
    `SELECT * FROM items
     WHERE ownerUsername IS NULL AND roomRow = ? AND roomCol = ? AND LOWER(name) = LOWER(?)
     ORDER BY id ASC
     LIMIT 1`,
    [row, col, itemName]
  );
  if (!item) {
    throw new ActionError('There is no such thing here.');
  }
  const result = await dbRun(
    db,
    `UPDATE items SET ownerUsername = ?, roomRow = NULL, roomCol = NULL
     WHERE id = ? AND ownerUsername IS NULL`,
    [username, item.id]
  );
  if (changes(result) === 0) {
    throw new ActionError('Someone snatched it first.');
  }
  await insertSystemMessage(db, row, col, `${username} takes ${item.name}.`);
  return { item: { id: item.id, name: item.name } };
}

export async function handleEquipCommand(db, username, row, col, message) {
  const rest = commandRest(message, '/equip');
  if (!rest) {
    throw new ActionError('Use /equip <item name>.');
  }
  const user = await getUser(db, username);
  const { item } = await equipItem(db, user, rest, row, col);
  return { equipped: item.name };
}

export async function handleUnequipCommand(db, username, row, col, message) {
  const rest = commandRest(message, '/unequip');
  if (!rest) {
    throw new ActionError('Use /unequip <item name or part>.');
  }
  const user = await getUser(db, username);
  const { item } = await unequipItem(db, user, rest, row, col);
  return { unequipped: item.name };
}

export async function handleTakeCommand(db, username, row, col, message) {
  const rest = commandRest(message, '/take');
  if (!rest) {
    throw new ActionError('Use /take <item name>.');
  }
  const { item } = await takeItem(db, username, rest, row, col);
  return { taken: item.name };
}

export async function handleDropCommand(db, username, row, col, message) {
  const rest = commandRest(message, '/drop');
  if (!rest) {
    throw new ActionError('Use /drop <item name>.');
  }
  const { item } = await dropOwnedItem(db, username, rest, row, col);
  return { dropped: item.name };
}

// --- /give: one-way item hand-off between co-located players -----------------
// Move a CARRIED item (owned, unequipped) straight from the giver's pack into the
// recipient's. The item stays carried — ownerUsername flips and roomRow/roomCol stay
// NULL (it never touches a floor, unlike /drop). Conditional WHERE makes the move
// race-safe: a second give of an item already gone (handed off, dropped, equipped) is
// a no-op. Returns the resolved item row so the caller can announce its canonical name.
export async function giveItem(db, fromUsername, itemName, toUsername, row, col) {
  const item = await findOwnedUnequippedItem(db, fromUsername, itemName);
  if (!item) {
    throw new ActionError("You aren't carrying that.");
  }
  const result = await dbRun(
    db,
    `UPDATE items SET ownerUsername = ?, roomRow = NULL, roomCol = NULL
     WHERE id = ? AND ownerUsername = ? AND equippedPartId IS NULL`,
    [toUsername, item.id, fromUsername]
  );
  if (changes(result) === 0) {
    throw new ActionError("You aren't carrying that.");
  }

  // adv-018: orphan guard. The recipient was confirmed present/alive during
  // resolution, but death (DELETE FROM users + dropPlayerItemsOnDeath) can land
  // between that resolve and this ownership flip — leaving the item owned by a
  // username with no users row: invisible, on no floor, unrecoverable. Re-check
  // the recipient still exists; if they vanished, drop the item to the floor of
  // the giver's room (ownerUsername NULL + roomRow/roomCol) so it stays in play.
  // Conditional on the item still sitting where we just put it, so a concurrent
  // take/equip by a (re-created) recipient isn't clobbered.
  const recipientExists = await dbFirst(
    db,
    'SELECT 1 AS hit FROM users WHERE username = ?',
    [toUsername]
  );
  if (!recipientExists && Number.isFinite(row) && Number.isFinite(col)) {
    await dbRun(
      db,
      `UPDATE items SET ownerUsername = NULL, roomRow = ?, roomCol = ?
       WHERE id = ? AND ownerUsername = ? AND equippedPartId IS NULL AND socketedInId IS NULL`,
      [row, col, item.id, toUsername]
    );
  }

  // engine-overhaul Phase B: the RECEIVER's document changed too (the giver's
  // syncs at the command dispatch).
  await syncBodyDoc(db, toUsername, 'give-received');
  return { id: item.id, name: item.name };
}

// Resolve the @target a /give names to a present, alive, non-NPC OTHER player. Mirrors
// combat's room-presence + displayName matching (whole-name boundaries, @self/@me, match
// by username OR displayName) so naming works the same way everywhere — but the gate set
// is give-specific: no self-give, players only, and the recipient must be standing here
// (present and not incapacitated/a corpse). Throws the precise ActionError per failure.
//
// adv-006: the recipient must be CO-LOCATED, so the candidate pool is resolved from
// roomPresence JOIN users for THIS room (mirroring validateAttackTargets) instead of a
// full users scan filtered in JS. The presence semantics match the prior give gate
// exactly — a roomPresence row for this room+worldDay (no lastSeenAt staleness filter,
// so a present-but-idle recipient still resolves as before) — and the giver is added to
// the pool so @self/@me still resolves. A named target that resolves to NO co-located
// row falls through to a TARGETED (by-mention, not full-scan) existence check purely to
// pick the right miss message: "<name> is not here." when that user exists elsewhere,
// "No such person here." when no user matches at all — byte-identical to before.
async function resolveGiveTarget(db, giverUsername, row, col, message) {
  const mentioned = [...message.matchAll(/@([A-Za-z0-9_-]+)/g)].map(m => m[1].toLowerCase());
  if (mentioned.length === 0) {
    throw new ActionError('Name who you are giving it to: /give <item> @who.');
  }
  const selfNamed = mentioned.includes('self') || mentioned.includes('me');
  const worldDay = getWorldDay();

  const matchesName = (name) => {
    const n = String(name || '').toLowerCase();
    if (n.length < 2) {
      return false;
    }
    return new RegExp(`(^|[^a-z0-9_-])${escapeRegExp(n)}([^a-z0-9_-]|$)`, 'i').test(message);
  };
  const matchesMention = (user) => {
    if (selfNamed && user.username === giverUsername) {
      return true;
    }
    const uname = String(user.username).toLowerCase();
    const dname = String(user.displayName).toLowerCase();
    if (mentioned.includes(uname) || mentioned.includes(dname)) {
      return true;
    }
    return matchesName(dname) || matchesName(uname);
  };

  // Co-located candidates only: a roomPresence row for this room+day, plus the giver
  // (so @self/@me resolves). Same room-presence join /attack uses — the recipient has
  // to be standing here anyway, so the whole-table scan was wasted work.
  const occupants = await dbAll(
    db,
    `SELECT u.username, COALESCE(u.displayName, u.username) AS displayName, u.isNpc, u.incapacitated
     FROM roomPresence rp
     JOIN users u ON u.username = rp.username
     WHERE rp.roomRow = ?
       AND rp.roomCol = ?
       AND rp.worldDay = ?
       AND rp.username != 'System'`,
    [row, col, worldDay]
  );
  const giver = await dbFirst(
    db,
    "SELECT username, COALESCE(displayName, username) AS displayName, isNpc, incapacitated FROM users WHERE username = ? AND username != 'System'",
    [giverUsername]
  );
  const pool = giver
    ? [...occupants.filter(o => o.username !== giverUsername), giver]
    : occupants;
  const named = pool.filter(matchesMention);

  // Gates IN ORDER, each with its own message: exists/present, not self, not an NPC.
  // Prefer a non-giver match (so "/give x @me @other" hands to other, as before).
  const target = named.find(user => user.username !== giverUsername) || named[0] || null;
  if (selfNamed && (!target || target.username === giverUsername)) {
    throw new ActionError('You cannot give an item to yourself.');
  }
  if (!target) {
    // No co-located match. Distinguish "named a real user who's elsewhere" (→ is not
    // here, by displayName) from "named nobody" (→ No such person here), via a targeted
    // existence check on the mentioned names — no full-table scan.
    const absent = mentioned.length
      ? await dbFirst(
        db,
        `SELECT COALESCE(displayName, username) AS displayName
         FROM users
         WHERE username != 'System'
           AND (LOWER(username) IN (${mentioned.map(() => '?').join(',')})
                OR LOWER(COALESCE(displayName, username)) IN (${mentioned.map(() => '?').join(',')}))
         ORDER BY username ASC
         LIMIT 1`,
        [...mentioned, ...mentioned]
      )
      : null;
    const namedElsewhere = absent || (await findNamedUserByMessage(db, giverUsername, message, matchesMention));
    if (namedElsewhere) {
      throw new ActionError(`${namedElsewhere.displayName} is not here.`);
    }
    throw new ActionError('No such person here.');
  }
  if (target.username === giverUsername) {
    throw new ActionError('You cannot give an item to yourself.');
  }
  if (target.isNpc) {
    throw new ActionError('You can only give items to other players.');
  }
  if (target.incapacitated) {
    throw new ActionError(`${target.displayName} cannot take that right now.`);
  }
  return target;
}

// adv-006: the give resolver's "is not here" fallback recovers a named-but-absent
// user's displayName. The exact @mention IN-list catches the common case cheaply; this
// covers the whole-name-boundary fuzzy match (e.g. a multi-word displayName embedded in
// the message) the original full-scan filter also honored, by scanning users ONLY when
// the cheap exact lookup missed AND a mention was given — never on the hot path.
async function findNamedUserByMessage(db, giverUsername, message, matchesMention) {
  const everyUser = await dbAll(
    db,
    "SELECT username, COALESCE(displayName, username) AS displayName, isNpc, incapacitated FROM users WHERE username != 'System'"
  );
  const named = everyUser.filter(matchesMention);
  return named.find(user => user.username !== giverUsername) || named[0] || null;
}

export async function handleGiveCommand(db, username, row, col, message) {
  // Strip the @mention(s) off the command rest; what remains is the item name.
  const rest = commandRest(message, '/give');
  const itemName = rest.replace(/@[A-Za-z0-9_-]+/g, '').replace(/\s+/g, ' ').trim();
  if (!itemName) {
    throw new ActionError('Use /give <item name> @target.');
  }

  // Resolve & gate the recipient BEFORE touching items: exists, not self, a player,
  // present and able to receive.
  const target = await resolveGiveTarget(db, username, row, col, message);

  // The giver must own a matching item that isn't equipped. Distinguish "you aren't
  // carrying that" from "it's equipped" so the equipped case tells them to unequip first.
  const carried = await findOwnedUnequippedItem(db, username, itemName);
  if (!carried) {
    const equipped = await dbFirst(
      db,
      `SELECT name FROM items
       WHERE ownerUsername = ? AND equippedPartId IS NOT NULL AND LOWER(name) = LOWER(?)
       ORDER BY id ASC LIMIT 1`,
      [username, itemName]
    );
    if (equipped) {
      throw new ActionError(`Unequip the ${equipped.name} before giving it.`);
    }
    throw new ActionError("You aren't carrying that.");
  }

  const item = await giveItem(db, username, itemName, target.username, row, col);

  // Public room line — everyone present sees the hand-off (kind 'support': a peaceful
  // exchange, not a blow). The recipient is named by what players SEE (displayName).
  await insertSystemMessage(db, row, col, `${username} hands the ${item.name} to ${target.displayName}.`, 'support');

  // One structured audit line on success.
  logEvent({ event: 'item.give', giver: username, recipient: target.username, item: item.name });

  return { gave: item.name, to: target.username };
}

// --- Plan 020a: consumables + the effects-walker ---------------------------
// applyItemEffect dispatches ONE on_use effect to the SAME shared primitives that
// skills use (healUser / addStatusEffect / clearOneHarmfulEffect), so a potion and
// an ability resolve through one path. 020c/d add more effect kinds here.
async function applyItemEffect(db, ctx, effect) {
  if (!effect || typeof effect !== 'object') {
    return;
  }
  switch (effect.kind) {
    case 'heal':
      await healUser(db, ctx.username, Number(effect.amount) || 0, ctx.row, ctx.col);
      return;
    case 'status':
      await addStatusEffect(db, {
        username: ctx.username,
        source: ctx.username,
        effectType: effect.type,
        magnitude: Number(effect.magnitude) || 1,
        currentTick: ctx.currentTick,
        duration: Number(effect.duration) || 1,
        row: ctx.row,
        col: ctx.col
      });
      return;
    case 'clear_status':
      await clearOneHarmfulEffect(db, ctx.username);
      return;
    default:
      return; // gear-time kinds (stat / grant_ability / affinity) don't fire on use
  }
}

async function findOwnedConsumable(db, username, itemName) {
  return dbFirst(
    db,
    `SELECT id, templateId, name, quantity FROM items
     WHERE ownerUsername = ? AND equippedPartId IS NULL AND roomRow IS NULL AND roomCol IS NULL
       AND LOWER(name) = LOWER(?)
     ORDER BY id ASC LIMIT 1`,
    [username, itemName]
  );
}

export async function useItem(db, username, itemName, row, col) {
  const item = await findOwnedConsumable(db, username, itemName);
  assertAction(item, `You are not carrying ${itemName}.`, 404);
  assertAction(getItemCategory(item.templateId) === 'consumable', `${item.name} cannot be used.`, 400);
  const template = getTemplate(item.templateId);
  const currentTick = await getCurrentTickValue(db);
  for (const effect of (template.onUse || [])) {
    await applyItemEffect(db, { username, row, col, currentTick }, effect);
  }
  // Consume one charge from the stack; delete the row when the last is used.
  if (Number(item.quantity || 1) > 1) {
    await dbRun(db, 'UPDATE items SET quantity = quantity - 1 WHERE id = ?', [item.id]);
  } else {
    await dbRun(db, 'DELETE FROM items WHERE id = ?', [item.id]);
  }
  const message = `${username} uses ${item.name}.`;
  await insertSystemMessage(db, row, col, message, 'support');
  return { used: item.name, message };
}

export async function handleUseCommand(db, username, row, col, message) {
  const rest = commandRest(message, '/use');
  if (!rest) {
    throw new ActionError('Use /use <item name>.');
  }
  return useItem(db, username, rest, row, col);
}

// --- Plan 022a: crafting -----------------------------------------------------
// A crafting verb (cook/brew/forge) consumes recipe inputs the player is carrying
// and produces the output. Inputs are carried (not equipped/socketed/floor) items.
export async function craftRecipe(db, username, verb, outputName) {
  const recipe = findRecipeByOutputName(verb, outputName);
  assertAction(recipe, `No ${verb} recipe makes "${outputName}".`, 404);

  // Pre-flight read so a clearly-impossible craft (missing inputs) is refused
  // before any delete — preserves the "You need N ×" message and spends nothing.
  for (const input of recipe.inputs) {
    const have = await dbFirst(
      db,
      `SELECT COUNT(*) AS c FROM items
       WHERE ownerUsername = ? AND templateId = ?
         AND equippedPartId IS NULL AND socketedInId IS NULL AND roomRow IS NULL AND roomCol IS NULL`,
      [username, input.templateId]
    );
    assertAction((have.c || 0) >= input.qty, `You need ${input.qty} × ${getTemplate(input.templateId)?.name || input.templateId}.`, 400);
  }

  // adv-018: consume each input as an ATOMIC claim. The old SELECT-ids-then-
  // DELETE-each let two crafts (or a craft racing a /give or /drop) grab the SAME
  // rows and double-consume one input set. Instead, delete exactly `qty` rows in
  // ONE statement (DELETE ... WHERE id IN (subselect LIMIT qty)) and trust
  // changes() for how many we actually claimed — a racing craft that took some
  // rows leaves us short. If ANY input comes up short we must NOT partially
  // consume: re-mint everything claimed so far (inputs are fungible by template)
  // and bail with the same shortfall message, so the player is made whole.
  const consumed = [];
  const restore = async () => {
    for (const { templateId, count } of consumed) {
      for (let i = 0; i < count; i += 1) {
        await createItemForOwner(db, templateId, username);
      }
    }
  };
  for (const input of recipe.inputs) {
    const claim = await dbRun(
      db,
      `DELETE FROM items
       WHERE id IN (
         SELECT id FROM items
         WHERE ownerUsername = ? AND templateId = ?
           AND equippedPartId IS NULL AND socketedInId IS NULL AND roomRow IS NULL AND roomCol IS NULL
         ORDER BY id ASC LIMIT ?
       )`,
      [username, input.templateId, input.qty]
    );
    const got = changes(claim);
    if (got > 0) {
      consumed.push({ templateId: input.templateId, count: got });
    }
    if (got < input.qty) {
      await restore();
      throw new ActionError(`You need ${input.qty} × ${getTemplate(input.templateId)?.name || input.templateId}.`, 400);
    }
  }

  for (let i = 0; i < (recipe.output.qty || 1); i += 1) {
    await createItemForOwner(db, recipe.output.templateId, username);
  }
  return { crafted: recipe.label };
}

export async function handleCookCommand(db, username, row, col, message) {
  const rest = commandRest(message, '/cook');
  if (!rest) {
    throw new ActionError('Use /cook <recipe>, e.g. /cook Cooked Remains.');
  }
  const result = await craftRecipe(db, username, 'cook', rest);
  await insertSystemMessage(db, row, col, `${username} cooks ${result.crafted}.`, 'support');
  return result;
}

// Plan 022 (tail): Brew mirrors /cook exactly — craftRecipe is verb-agnostic, so this
// just passes 'brew'. UNGATED (any job). The dispatch in handlers.mjs charges 1 stamina
// and advances a tick, identical to /cook.
export async function handleBrewCommand(db, username, row, col, message) {
  const rest = commandRest(message, '/brew');
  if (!rest) {
    throw new ActionError('Use /brew <recipe>, e.g. /brew Crimson Tonic.');
  }
  const result = await craftRecipe(db, username, 'brew', rest);
  await insertSystemMessage(db, row, col, `${username} brews ${result.crafted}.`, 'support');
  return result;
}

// Plan 022 (tail): Forge mirrors /cook exactly — reforges scrap (and dual-use trophies)
// into existing gear templates. UNGATED.
export async function handleForgeCommand(db, username, row, col, message) {
  const rest = commandRest(message, '/forge');
  if (!rest) {
    throw new ActionError('Use /forge <recipe>, e.g. /forge Rusty Knife.');
  }
  const result = await craftRecipe(db, username, 'forge', rest);
  await insertSystemMessage(db, row, col, `${username} forges ${result.crafted}.`, 'support');
  return result;
}

// --- Plan 022b/c: eating remains and corpses ---------------------------------
const EAT_HEAL_AMOUNT = 5;

// An edible item the player can reach: carried, or on the floor of their room.
async function findEatable(db, username, itemName, row, col) {
  return dbFirst(
    db,
    `SELECT id, templateId, name, corpseOf FROM items
     WHERE LOWER(name) = LOWER(?)
       AND ( (ownerUsername = ? AND equippedPartId IS NULL AND socketedInId IS NULL AND roomRow IS NULL AND roomCol IS NULL)
             OR (ownerUsername IS NULL AND roomRow = ? AND roomCol = ?) )
     ORDER BY id ASC LIMIT 1`,
    [itemName, username, row, col]
  );
}

export async function eatItem(db, username, itemName, row, col) {
  const item = await findEatable(db, username, itemName, row, col);
  assertAction(item, `There is no ${itemName} to eat here.`, 404);
  const category = getItemCategory(item.templateId);
  assertAction(category === 'part' || category === 'corpse', `${item.name} is not edible.`, 400);

  await healUser(db, username, EAT_HEAL_AMOUNT, row, col);
  await dbRun(db, 'DELETE FROM items WHERE id = ?', [item.id]);

  if (item.corpseOf) {
    // Plan 022c: devouring a corpse severs that player's resurrection — for good.
    await insertSystemMessage(db, row, col, `${username} devours ${item.name}. ${item.corpseOf} can never return.`, 'death');
    return { ate: item.name, severed: item.corpseOf };
  }
  // Plan 022 (tail): eating rotten remains raw poisons you — the decay made it foul.
  if (item.templateId === 'rotten_remains') {
    const currentTick = await getCurrentTickValue(db);
    await addStatusEffect(db, {
      username,
      source: username,
      effectType: 'poison',
      magnitude: 1,
      currentTick,
      duration: 5,
      row,
      col
    });
    await insertSystemMessage(db, row, col, `${username} chokes down ${item.name} — it is rancid.`, 'combat');
    return { ate: item.name, poisoned: true };
  }
  await insertSystemMessage(db, row, col, `${username} eats ${item.name}.`, 'support');
  return { ate: item.name };
}

export async function handleEatCommand(db, username, row, col, message) {
  const rest = commandRest(message, '/eat');
  if (!rest) {
    throw new ActionError('Use /eat <item>.');
  }
  return eatItem(db, username, rest, row, col);
}

// --- Plan 020d: socketing materia into gear ---------------------------------
// An owned item that isn't on a room floor (carried, equipped, or already socketed).
async function findOwnedItemByName(db, username, itemName) {
  return dbFirst(
    db,
    `SELECT id, templateId, name, equippedPartId, socketedInId FROM items
     WHERE ownerUsername = ? AND roomRow IS NULL AND roomCol IS NULL
       AND LOWER(name) = LOWER(?)
     ORDER BY id ASC LIMIT 1`,
    [username, itemName]
  );
}

export async function socketMateria(db, username, materiaName, hostName) {
  const materia = await findOwnedItemByName(db, username, materiaName);
  assertAction(materia, `You are not carrying ${materiaName}.`, 404);
  assertAction(getItemCategory(materia.templateId) === 'materia', `${materia.name} is not materia.`, 400);
  assertAction(!materia.socketedInId, `${materia.name} is already socketed.`, 400);

  const host = await findOwnedItemByName(db, username, hostName);
  assertAction(host, `You are not carrying ${hostName}.`, 404);
  assertAction(getItemCategory(host.templateId) === 'gear', `${host.name} cannot hold materia.`, 400);
  const sockets = getItemSockets(host.templateId);
  assertAction(sockets > 0, `${host.name} has no sockets.`, 400);
  const used = await dbFirst(db, 'SELECT COUNT(*) AS c FROM items WHERE socketedInId = ?', [host.id]);
  assertAction((used.c || 0) < sockets, `${host.name}'s sockets are full.`, 400);

  // adv-018: claim-then-recheck (mirrors unlockProgressionNode). The COUNT above
  // and this attach aren't atomic — two concurrent sockets into the same last
  // free slot both pass the count. CLAIM by attaching only while still loose
  // (gate changes()===1), then re-count under the host: keep this materia only
  // if it ranks within the host's socket capacity by id ASC; otherwise roll the
  // attach back (unsocket) so over-capacity is rejected and exactly one racer wins.
  const claim = await dbRun(
    db,
    'UPDATE items SET socketedInId = ? WHERE id = ? AND socketedInId IS NULL',
    [host.id, materia.id]
  );
  assertAction(changes(claim) === 1, `${materia.name} is already socketed.`, 400);

  const occupants = await dbAll(
    db,
    'SELECT id FROM items WHERE socketedInId = ? ORDER BY id ASC',
    [host.id]
  );
  const rank = occupants.findIndex(o => o.id === materia.id);
  if (rank < 0 || rank >= sockets) {
    await dbRun(db, 'UPDATE items SET socketedInId = NULL WHERE id = ?', [materia.id]);
    throw new ActionError(`${host.name}'s sockets are full.`, 400);
  }
  return { socketed: materia.name, into: host.name };
}

export async function unsocketMateria(db, username, materiaName) {
  const materia = await findOwnedItemByName(db, username, materiaName);
  assertAction(materia, `You are not carrying ${materiaName}.`, 404);
  assertAction(materia.socketedInId, `${materia.name} is not socketed.`, 400);
  await dbRun(db, 'UPDATE items SET socketedInId = NULL WHERE id = ?', [materia.id]);
  return { unsocketed: materia.name };
}

export async function handleSocketCommand(db, username, message) {
  const rest = commandRest(message, '/socket');
  const parts = rest.split(/\s+into\s+/i);
  if (parts.length !== 2 || !parts[0].trim() || !parts[1].trim()) {
    throw new ActionError('Use /socket <materia> into <item>.');
  }
  return socketMateria(db, username, parts[0].trim(), parts[1].trim());
}

export async function handleUnsocketCommand(db, username, message) {
  const rest = commandRest(message, '/unsocket');
  if (!rest) {
    throw new ActionError('Use /unsocket <materia>.');
  }
  return unsocketMateria(db, username, rest);
}

// Resolve the shop stock line a /buy names, or throw the right ActionError.
// Shared by the /buy validate (so a bad buy spends no stamina) and the perform
// below, so the two can't drift. Returns the matched stock line + the per-day
// cooldown key.
async function resolveShopPurchase(db, username, row, col, itemName) {
  const worldDay = getWorldDay();
  const tickValue = await getCurrentTickValue(db);
  assertAction(roomHasEffect(row, col, tickValue, 'shop', worldDay), '/buy only works in a shop.');

  const stockItem = generateShopStock(row, col, worldDay).find(
    item => item.name.toLowerCase() === itemName.toLowerCase()
  );
  assertAction(stockItem, 'Not stocked here today.');

  // One of each stock line per player per room per day. effectType is namespaced
  // (`buy:<templateId>`) so it never collides with passive room effects.
  const effectType = `buy:${stockItem.templateId}`;
  const already = await dbFirst(
    db,
    `SELECT 1 AS hit FROM roomEffectCooldowns
     WHERE username = ? AND roomRow = ? AND roomCol = ? AND effectType = ? AND worldDay = ?`,
    [username, row, col, effectType, worldDay]
  );
  assertAction(!already, 'Sold out for you today.');

  return { stockItem, effectType, worldDay, tickValue };
}

export async function validateBuyCommand(db, username, row, col, message) {
  const rest = commandRest(message, '/buy').trim();
  assertAction(rest, 'Usage: /buy <item name>');
  const { stockItem } = await resolveShopPurchase(db, username, row, col, rest);
  const user = await getUser(db, username);
  assertAction((user.gold || 0) >= stockItem.price, 'Not enough gold.', 402);
}

export async function buyShopItem(db, username, row, col, itemName) {
  const { stockItem, effectType, worldDay, tickValue } = await resolveShopPurchase(db, username, row, col, itemName);

  // adv-018: CLAIM the once-per-day slot FIRST so two concurrent /buy can't both
  // pass the read-then-write cap and double-spend/double-mint. INSERT ... ON
  // CONFLICT DO NOTHING against the cooldown PK; proceed only if changes()===1
  // (we won the slot). Using upsertCooldown's DO UPDATE here would always
  // "succeed" and couldn't arbitrate, which is the bug.
  const claim = await dbRun(
    db,
    `INSERT INTO roomEffectCooldowns
      (username, roomRow, roomCol, effectType, lastAppliedTick, worldDay)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(username, roomRow, roomCol, effectType, worldDay) DO NOTHING`,
    [username, row, col, effectType, tickValue, worldDay]
  );
  assertAction(changes(claim) > 0, 'Sold out for you today.');

  // Atomic spend (plan 003): the conditional WHERE re-validates gold under
  // concurrency. If payment fails, RELEASE the slot we just claimed so a failed
  // payment never burns the player's once-per-day slot for this item (preserved
  // from the prior cooldown-after-spend ordering).
  const spend = await dbRun(
    db,
    'UPDATE users SET gold = gold - ? WHERE username = ? AND gold >= ?',
    [stockItem.price, username, stockItem.price]
  );
  if (changes(spend) === 0) {
    await dbRun(
      db,
      `DELETE FROM roomEffectCooldowns
       WHERE username = ? AND roomRow = ? AND roomCol = ? AND effectType = ? AND worldDay = ?`,
      [username, row, col, effectType, worldDay]
    );
    throw new ActionError('Not enough gold.', 402);
  }

  await createItemForOwner(db, stockItem.templateId, username);
  await insertSystemMessage(db, row, col, `${username} buys ${stockItem.name} for ${stockItem.price} gold.`);
  return { bought: stockItem.name, price: stockItem.price };
}

export async function handleBuyCommand(db, username, row, col, message) {
  const rest = commandRest(message, '/buy').trim();
  assertAction(rest, 'Usage: /buy <item name>');
  return buyShopItem(db, username, row, col, rest);
}

// ---------------------------------------------------------------------------
// adv engine-overhaul Phase A: the item-table chokepoints. Every module that
// used to touch `items` with raw SQL (resurrection, death, sweeps, combat,
// progression) now calls these — sealing the seam so the paperdoll-document
// representation (Phase B+) has exactly one place to hook.

// The resurrection anchor. While a player_corpse row with corpseOf=username
// exists anywhere, that player can be revived; delete it and the tether snaps.
export async function findCorpseAnchor(db, username) {
  return dbFirst(db, 'SELECT id, roomRow, roomCol FROM items WHERE corpseOf = ? LIMIT 1', [username]);
}

export async function findCorpseAnchorInRoom(db, username, row, col) {
  return dbFirst(
    db,
    'SELECT id FROM items WHERE corpseOf = ? AND roomRow = ? AND roomCol = ?',
    [username, row, col]
  );
}

export async function deleteCorpseAnchor(db, username) {
  await dbRun(db, 'DELETE FROM items WHERE corpseOf = ?', [username]);
}

// The corpse row a true death leaves behind (plan 022c). Decay renames it
// cosmetically but NEVER deletes it or clears corpseOf.
export async function createCorpseItem(db, { username, row, col, decayTick }) {
  await dbRun(
    db,
    `INSERT INTO items (templateId, name, slotType, rarity, modifiers, roomRow, roomCol, corpseOf, decayTick)
     VALUES ('player_corpse', ?, 'corpse', 'common', '{}', ?, ?, ?, ?)`,
    [`${username}'s Corpse`, row, col, username, decayTick]
  );
}

// Narrow equipped-item refs (id + templateId) — the shape combat's element/
// granted-ability paths and progression's ability scan read.
export async function getEquippedItemRefs(db, username) {
  return dbAll(db, 'SELECT id, templateId FROM items WHERE ownerUsername = ? AND equippedPartId IS NOT NULL', [username]);
}

// Same, filtered to gear worn on one named part (null partLabel = all parts) —
// combat's per-part elemental affinity read.
export async function getEquippedItemRefsForPart(db, username, partLabel) {
  return dbAll(
    db,
    `SELECT i.id, i.templateId FROM items i
     LEFT JOIN bodyParts bp ON bp.id = i.equippedPartId
     WHERE i.ownerUsername = ? AND i.equippedPartId IS NOT NULL
       AND (? IS NULL OR bp.label = ?)`,
    [username, partLabel || null, partLabel || null]
  );
}

// The materia-AP accrual as a STATEMENT BUILDER, not a call: progression's
// awardExperience composes it into its one-round-trip dbBatch alongside the
// XP bump, so re-homing the SQL must not add a round trip.
export function materiaApAccrualStatement(username) {
  return [
    `UPDATE items SET ap = ap + 1
      WHERE socketedInId IN (SELECT id FROM items WHERE ownerUsername = ? AND equippedPartId IS NOT NULL)
        AND EXISTS (SELECT 1 FROM users WHERE username = ? AND isNpc = 0)`,
    [username, username]
  ];
}

//
//   MONSTER remains (monster_remains → rotten_remains → bones): rewritten in place
//   (templateId + name) at each stage, then CULLED (DELETE) at the bones-age cap so
//   floors don't fill with bones. The rotten stage stays edible — a raw /eat poisons.
//
//   PLAYER corpses (player_corpse): COSMETIC ONLY (owner decision). Renamed to
//   "<player>'s Skeletal Remains" once aged, but NEVER deleted and corpseOf is ALWAYS
//   kept — the resurrection anchor must persist indefinitely. Decay must NOT
//   permadeath; only a deliberate /eat or destroy (unchanged) severs the tether.
export async function processCorpseDecay(db, tickValue = null) {
  const tick = tickValue === null ? await getCurrentTickValue(db) : tickValue;
  const decaying = await dbAll(
    db,
    `SELECT id, templateId, name, corpseOf, decayTick
     FROM items
     WHERE decayTick IS NOT NULL
       AND templateId IN ('monster_remains', 'rotten_remains', 'bones', 'player_corpse')`
  );

  // Collect every stage transition, then land them in one batched round trip
  // instead of one await per aging item.
  const writes = [];
  for (const item of decaying) {
    const age = tick - item.decayTick;
    if (age < CORPSE_FRESH_TICKS) {
      continue; // still fresh — nothing to do
    }

    if (item.templateId === 'player_corpse') {
      // Cosmetic-only: once aged, rename to skeletal remains. NEVER delete; NEVER
      // touch corpseOf or templateId — the resurrection anchor is sacrosanct. Only
      // rename once (idempotent) so we don't rewrite every pulse.
      if (item.corpseOf) {
        const skeletalName = `${item.corpseOf}'s Skeletal Remains`;
        if (item.name !== skeletalName) {
          writes.push(['UPDATE items SET name = ? WHERE id = ?', [skeletalName, item.id]]);
        }
      }
      continue;
    }

    // Monster remains: cull at the bones-age cap, else advance the stage in place.
    if (age >= CORPSE_CULL_TICKS) {
      writes.push(['DELETE FROM items WHERE id = ?', [item.id]]);
      continue;
    }
    if (age >= CORPSE_FRESH_TICKS + CORPSE_ROTTEN_TICKS) {
      if (item.templateId !== 'bones') {
        writes.push(["UPDATE items SET templateId = 'bones', name = 'Bones' WHERE id = ?", [item.id]]);
      }
      continue;
    }
    // FRESH..(FRESH+ROTTEN): rotten.
    if (item.templateId !== 'rotten_remains') {
      writes.push(["UPDATE items SET templateId = 'rotten_remains', name = 'Rotten Remains' WHERE id = ?", [item.id]]);
    }
  }
  if (writes.length > 0) {
    await dbBatch(db, writes);
  }
}
