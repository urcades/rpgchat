// Inventory, equipment, items, crafting, consumables, materia & shop (plan adv-005).
//
// Extracted verbatim from the original worker/game.mjs — a pure mechanical move.
// Cross-seam dependencies are now explicit imports; cycles between seams resolve
// through ESM live bindings (every cross-seam reference is call-time, never
// dereferenced at module load).

import {
  ActionError,
  MODIFIER_KEYS,
  assertAction,
  commandRest,
  emptyModifiers,
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
import { upsertCooldown } from './progression.mjs';
import { getCurrentTickValue, getUser, roomHasEffect } from './world.mjs';


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

  await dbRun(
    db,
    `UPDATE items SET equippedPartId = ?, roomRow = NULL, roomCol = NULL
     WHERE id = ?`,
    [target.id, item.id]
  );

  // Fold this item's HP gear into the worn part (structural, plan 015): raise
  // the part's maxHp and users.maxHealth by the bonus. A positive bonus opens
  // headroom but does NOT heal; a negative bonus clamps hp/health down.
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
  await dbRun(
    db,
    `INSERT INTO items (templateId, name, slotType, rarity, modifiers, ownerUsername, roomRow, roomCol)
     VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`,
    [template.templateId, name, template.slotType, template.rarity, JSON.stringify(template.modifiers || {}), row, col]
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

  for (const input of recipe.inputs) {
    const rows = await dbAll(
      db,
      `SELECT id FROM items
       WHERE ownerUsername = ? AND templateId = ?
         AND equippedPartId IS NULL AND socketedInId IS NULL AND roomRow IS NULL AND roomCol IS NULL
       ORDER BY id ASC LIMIT ?`,
      [username, input.templateId, input.qty]
    );
    for (const r of rows) {
      await dbRun(db, 'DELETE FROM items WHERE id = ?', [r.id]);
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

  await dbRun(db, 'UPDATE items SET socketedInId = ? WHERE id = ?', [host.id, materia.id]);
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

  // Atomic spend (plan 003): the conditional WHERE re-validates gold under
  // concurrency. The cooldown is written only AFTER a successful spend, so a
  // failed payment never burns the player's once-per-day slot for this item.
  const spend = await dbRun(
    db,
    'UPDATE users SET gold = gold - ? WHERE username = ? AND gold >= ?',
    [stockItem.price, username, stockItem.price]
  );
  assertAction(changes(spend) > 0, 'Not enough gold.', 402);

  await upsertCooldown(db, username, row, col, effectType, tickValue, worldDay);
  await createItemForOwner(db, stockItem.templateId, username);
  await insertSystemMessage(db, row, col, `${username} buys ${stockItem.name} for ${stockItem.price} gold.`);
  return { bought: stockItem.name, price: stockItem.price };
}

export async function handleBuyCommand(db, username, row, col, message) {
  const rest = commandRest(message, '/buy').trim();
  assertAction(rest, 'Usage: /buy <item name>');
  return buyShopItem(db, username, row, col, rest);
}
