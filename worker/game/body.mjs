// Body parts, health, body damage/heal & status effects (plan adv-005).
//
// Extracted verbatim from the original worker/game.mjs — a pure mechanical move.
// Cross-seam dependencies are now explicit imports; cycles between seams resolve
// through ESM live bindings (every cross-seam reference is call-time, never
// dereferenced at module load).

import {
  HARMFUL_EFFECTS,
  HUMANOID_PLAN,
  MODIFIER_KEYS,
  bodyPenaltyModifiers,
  distributeAcrossPlan,
  getEffectiveUser,
  partCondition,
  pickTargetPart
} from './shared.mjs';
import { dbAll, dbFirst, dbRun } from '../db.mjs';
import { descendTowardDeath, reviveFromIncapacitation } from './death.mjs';
import { getEquippedModifiers } from './inventory.mjs';
import { insertSystemMessage } from './messages.mjs';
import { getProgressionModifiers } from './progression.mjs';
import { getCurrentTickValue, getUser } from './world.mjs';


function isBodylessUser(user) {
  return Boolean(user && (user.isNpc || user.username === 'System'));
}

export async function getBodyParts(db, username) {
  return dbAll(
    db,
    `SELECT id, username, partType, label, slotType, vital, hp, maxHp, baseMaxHp, severed
     FROM bodyParts
     WHERE username = ?
     ORDER BY CASE partType WHEN 'torso' THEN 0 ELSE 1 END, id ASC`,
    [username]
  );
}

export async function ensureBody(db, user) {
  if (isBodylessUser(user)) {
    return null;
  }
  const existing = await getBodyParts(db, user.username);
  if (existing.length > 0) {
    return existing;
  }

  // Part pools mirror the STORED pool so the invariant is exact; job bonuses
  // live in the effective layer only.
  const storedMax = Math.max(0, Math.floor(user.maxHealth || 0));
  const storedHealth = Math.max(0, Math.min(Math.floor(user.health || 0), storedMax));
  const maxDistribution = distributeAcrossPlan(storedMax, HUMANOID_PLAN);

  // Distribute current hp, clamped per-part to its maxHp; push any clamp
  // overflow to parts with headroom, torso first.
  const hpDistribution = distributeAcrossPlan(storedHealth, HUMANOID_PLAN);
  const parts = HUMANOID_PLAN.map((template, index) => ({
    ...template,
    maxHp: maxDistribution[index].amount,
    hp: Math.min(hpDistribution[index].amount, maxDistribution[index].amount)
  }));
  let overflow = parts.reduce(
    (sum, part, index) => sum + Math.max(0, hpDistribution[index].amount - part.maxHp),
    0
  );
  if (overflow > 0) {
    const order = parts
      .map((part, index) => ({ part, index, isTorso: part.partType === 'torso' }))
      .sort((a, b) => (b.isTorso ? 1 : 0) - (a.isTorso ? 1 : 0) || a.index - b.index);
    for (const entry of order) {
      if (overflow <= 0) {
        break;
      }
      const headroom = entry.part.maxHp - entry.part.hp;
      const add = Math.min(headroom, overflow);
      entry.part.hp += add;
      overflow -= add;
    }
  }

  for (const part of parts) {
    // baseMaxHp mirrors the distributed base maxHp at creation (plan 006). Armor
    // bonuses (plan 015's applyPartMaxHpDelta) move maxHp transiently but never
    // touch baseMaxHp, so /regrow can restore the permanent, un-fortified base.
    await dbRun(
      db,
      `INSERT OR IGNORE INTO bodyParts
        (username, partType, label, slotType, vital, hp, maxHp, baseMaxHp, severed)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      [user.username, part.partType, part.label, part.slotType, part.vital ? 1 : 0, part.hp, part.maxHp, part.maxHp]
    );
  }

  return getBodyParts(db, user.username);
}

export async function getBodyConditionModifiers(db, username) {
  const parts = await getBodyParts(db, username);
  return bodyPenaltyModifiers(parts);
}

// Defensive parse of an item's stored modifiers JSON into a plain object.
export function parseItemModifiers(raw) {
  if (!raw) {
    return {};
  }
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (error) {
    return {};
  }
}

// The integer maxHealth an item contributes to the body part it's worn on.
// Single source of truth for plan 015's structural HP gear: 0 when absent/NaN.
// May be negative (e.g. Mage's Humming Focus -3), which lowers the part's cap.
export function itemMaxHealthBonus(item) {
  const parsed = parseItemModifiers(item && item.modifiers);
  const value = Math.trunc(Number(parsed.maxHealth));
  return Number.isFinite(value) ? value : 0;
}

// Move an item's maxHealth bonus into (delta > 0) or out of (delta < 0) the
// part it's worn on, mirroring users.maxHealth and the EXACT hp the part loses
// onto users.health. The bonus lives in exactly one place at a time — this is
// the only write path for it, so equip and unequip can't drift. Floors caps at
// 0. Critically, users.health drops by precisely the per-part hp destroyed (a
// negative delta can clamp the part's hp), never by a coarse MIN-to-maxHealth,
// so users.health == Σ hp stays exact even when other parts hold the surplus.
export async function applyPartMaxHpDelta(db, username, partId, delta) {
  if (!delta) {
    return;
  }
  const before = await dbFirst(db, 'SELECT hp FROM bodyParts WHERE id = ?', [partId]);
  const hpBefore = before ? Math.max(0, Math.floor(before.hp || 0)) : 0;

  await dbRun(
    db,
    'UPDATE bodyParts SET maxHp = MAX(maxHp + ?, 0) WHERE id = ?',
    [delta, partId]
  );
  // A negative delta can push hp above the lowered cap; clamp it down.
  await dbRun(
    db,
    'UPDATE bodyParts SET hp = MIN(hp, maxHp) WHERE id = ?',
    [partId]
  );

  const after = await dbFirst(db, 'SELECT hp FROM bodyParts WHERE id = ?', [partId]);
  const hpAfter = after ? Math.max(0, Math.floor(after.hp || 0)) : 0;
  const hpLost = hpBefore - hpAfter; // >= 0; only a negative delta destroys hp.

  await dbRun(
    db,
    'UPDATE users SET maxHealth = MAX(maxHealth + ?, 0) WHERE username = ?',
    [delta, username]
  );
  // Mirror the exact hp the part shed onto users.health (floor 0). Equip with a
  // positive bonus destroys nothing (hpLost 0), so health is untouched.
  if (hpLost > 0) {
    await dbRun(
      db,
      'UPDATE users SET health = MAX(health - ?, 0) WHERE username = ?',
      [hpLost, username]
    );
  }
}

// Element-wise sum of wound penalties and equipped-gear bonuses. Swapped in at
// every site that previously fed getBodyConditionModifiers / bodyPenaltyModifiers
// into getEffectiveUser, so wounds and gear ride one modifier channel.
export async function getConditionAndGearModifiers(db, username) {
  const [condition, gear, progression, status] = await Promise.all([
    getBodyConditionModifiers(db, username),
    getEquippedModifiers(db, username),
    getProgressionModifiers(db, username),
    getStatusStatModifiers(db, username)
  ]);
  const combined = {};
  for (const key of MODIFIER_KEYS) {
    combined[key] = (Number(condition[key]) || 0) + (Number(gear[key]) || 0) + (Number(progression[key]) || 0) + (Number(status[key]) || 0);
  }
  return combined;
}

async function emitConditionTransitions(db, username, beforeParts, afterParts, row, col) {
  if (row === undefined || row === null || col === undefined || col === null) {
    return;
  }
  const beforeByLabel = new Map(beforeParts.map(part => [part.label, part]));
  for (const after of afterParts) {
    const before = beforeByLabel.get(after.label);
    if (!before) {
      continue;
    }
    const beforeCondition = partCondition(before);
    const afterCondition = partCondition(after);
    if (beforeCondition === afterCondition) {
      continue;
    }
    if (after.severed) {
      // Severance gets its own "destroyed" line from the caller; skip here.
      continue;
    }
    const phrase = afterCondition === 'healthy'
      ? `${username}'s ${after.label} looks healthy again.`
      : `${username}'s ${after.label} is ${afterCondition}.`;
    await insertSystemMessage(db, row, col, phrase);
  }
}

export async function applyBodyDamage(db, user, amount, options = {}) {
  const { cause, row, col, random = Math.random, targetLabel = null } = options;
  const damage = Math.max(0, Math.floor(amount || 0));

  if (isBodylessUser(user)) {
    const nextHealth = Math.max(0, (user.health || 0) - damage);
    await dbRun(db, 'UPDATE users SET health = MAX(health - ?, 0) WHERE username = ?', [damage, user.username]);
    return { died: nextHealth <= 0, npc: true, healthAfter: nextHealth, severedLabels: [], overkill: Math.max(0, damage - (user.health || 0)) };
  }

  const partsBefore = await ensureBody(db, user);
  const liveParts = partsBefore.filter(part => !part.severed);

  // Snapshot for condition-transition messaging.
  const working = partsBefore.map(part => ({ ...part }));
  const workingByLabel = new Map(working.map(part => [part.label, part]));
  const torso = working.find(part => part.partType === 'torso');

  let remaining = damage;
  // A called shot (targetLabel) routes damage to the named, non-severed part
  // instead of the weighted-random pick. Spill-to-torso and every other rule
  // below is unchanged. When targetLabel is absent this is byte-identical to the
  // original random routing (the `random` draw is still consumed, preserving the
  // RNG order callers rely on).
  let target = pickTargetPart(liveParts, random);
  if (targetLabel) {
    const aimed = liveParts.find(part => part.label === targetLabel);
    if (aimed) {
      target = aimed;
    }
  }
  const targetWorking = target ? workingByLabel.get(target.label) : null;

  let totalDealt = 0;
  if (targetWorking && remaining > 0) {
    const dealt = Math.min(remaining, targetWorking.hp);
    targetWorking.hp -= dealt;
    totalDealt += dealt;
    remaining -= dealt;
  }

  // Spill remainder into the torso (if the target wasn't the torso); anything
  // beyond torso hp is dropped (total is already 0 by then).
  if (remaining > 0 && torso && (!targetWorking || targetWorking.label !== torso.label) && !torso.severed) {
    const dealt = Math.min(remaining, torso.hp);
    torso.hp -= dealt;
    totalDealt += dealt;
    remaining -= dealt;
  }

  // Determine transitions: severance for non-vital parts driven >0 -> 0,
  // and death for any vital part driven >0 -> 0.
  const severedLabels = [];
  const severedParts = []; // { id, label } — id resolves the knock-off UPDATE.
  let vitalDestroyed = false;
  let maxHealthReduction = 0;
  for (const part of working) {
    const before = workingByLabel.get(part.label);
    const wasAlive = partsBefore.find(p => p.label === part.label).hp > 0;
    if (part.hp <= 0 && wasAlive) {
      if (part.vital) {
        vitalDestroyed = true;
      } else if (!part.severed) {
        part.severed = 1;
        severedLabels.push(part.label);
        severedParts.push({ id: part.id, label: part.label });
        maxHealthReduction += part.maxHp;
      }
    }
  }

  // Persist part rows.
  for (const part of working) {
    await dbRun(
      db,
      'UPDATE bodyParts SET hp = ?, severed = ? WHERE username = ? AND label = ?',
      [Math.max(0, part.hp), part.severed ? 1 : 0, user.username, part.label]
    );
  }

  // Mirror the same total deduction on users.health in a single UPDATE.
  const healthAfter = Math.max(0, (user.health || 0) - totalDealt);
  if (maxHealthReduction > 0) {
    await dbRun(
      db,
      'UPDATE users SET health = ?, maxHealth = MAX(maxHealth - ?, 0) WHERE username = ?',
      [healthAfter, maxHealthReduction, user.username]
    );
  } else {
    await dbRun(db, 'UPDATE users SET health = ? WHERE username = ?', [healthAfter, user.username]);
  }

  // Loud states: condition-transition messages (non-severance), then severance.
  await emitConditionTransitions(db, user.username, partsBefore, working, row, col);
  if (row !== undefined && row !== null && col !== undefined && col !== null) {
    for (const part of severedParts) {
      await insertSystemMessage(db, row, col, `${user.username}'s ${part.label} is destroyed.`, 'combat');
      // Sever knock-off: whatever was equipped on this part clatters to the
      // floor for anyone to /take (plan 005). Fetch the name BEFORE the UPDATE.
      const equipped = await dbFirst(
        db,
        'SELECT id, name FROM items WHERE equippedPartId = ?',
        [part.id]
      );
      if (equipped) {
        await dbRun(
          db,
          `UPDATE items SET ownerUsername = NULL, equippedPartId = NULL, roomRow = ?, roomCol = ?
           WHERE equippedPartId = ?`,
          [row, col, part.id]
        );
        await insertSystemMessage(
          db,
          row,
          col,
          `${equipped.name} falls to the floor with ${user.username}'s ${part.label}.`
        );
      }
    }
  }

  const died = vitalDestroyed || healthAfter <= 0;
  // Plan 023b: `remaining` is damage that found no HP to land on — the overkill that
  // separates a barely-lethal blow (incapacitate) from an obliterating one (gib).
  return { died, npc: false, healthAfter, severedLabels, overkill: Math.max(0, remaining) };
}

export async function applyBodyHeal(db, user, amount, options = {}) {
  const { row, col } = options;
  const heal = Math.max(0, Math.floor(amount || 0));

  if (isBodylessUser(user)) {
    const effective = getEffectiveUser(user);
    const nextHealth = Math.min(effective.maxHealth, (user.health || 0) + heal);
    await dbRun(db, 'UPDATE users SET health = ? WHERE username = ?', [nextHealth, user.username]);
    return nextHealth;
  }

  const partsBefore = await ensureBody(db, user);
  // Combine wound penalties (from the just-read parts) with equipped-gear
  // bonuses so the heal cap rides the same modifier channel as combat. Gear
  // maxHealth is intentionally excluded (getEquippedModifiers), so the cap is
  // unchanged for HP until plan 015 makes it real via part maxHp.
  const conditionModifiers = bodyPenaltyModifiers(partsBefore);
  const gearModifiers = await getEquippedModifiers(db, user.username);
  const combinedModifiers = {};
  for (const key of MODIFIER_KEYS) {
    combinedModifiers[key] = (Number(conditionModifiers[key]) || 0) + (Number(gearModifiers[key]) || 0);
  }
  const effective = getEffectiveUser(user, combinedModifiers);

  const working = partsBefore.map(part => ({ ...part }));
  // Fill non-severed parts worst-ratio-first up to maxHp until the pool or the
  // effective max is exhausted. Severed parts are never restored (plan 006).
  const currentTotal = working.reduce((sum, part) => sum + (part.severed ? 0 : part.hp), 0);
  let budget = Math.max(0, Math.min(heal, effective.maxHealth - currentTotal));

  while (budget > 0) {
    const candidates = working
      .filter(part => !part.severed && part.hp < part.maxHp)
      .sort((a, b) => (a.hp / a.maxHp) - (b.hp / b.maxHp));
    if (candidates.length === 0) {
      break;
    }
    const target = candidates[0];
    target.hp += 1;
    budget -= 1;
  }

  const totalHealed = working.reduce((sum, part) => sum + (part.severed ? 0 : part.hp), 0)
    - currentTotal;
  for (const part of working) {
    await dbRun(
      db,
      'UPDATE bodyParts SET hp = ? WHERE username = ? AND label = ?',
      [part.hp, user.username, part.label]
    );
  }

  const healthAfter = Math.max(0, (user.health || 0) + totalHealed);
  await dbRun(db, 'UPDATE users SET health = ? WHERE username = ?', [healthAfter, user.username]);
  await emitConditionTransitions(db, user.username, partsBefore, working, row, col);
  // Plan 023b: a heal that lifts a downed player back above 0 stands them up.
  if (healthAfter > 0 && row !== undefined && row !== null && col !== undefined && col !== null) {
    const downed = await dbFirst(db, 'SELECT incapacitated FROM users WHERE username = ?', [user.username]);
    if (downed && downed.incapacitated) {
      await reviveFromIncapacitation(db, user.username, row, col);
    }
  }
  return healthAfter;
}

export async function damageUser(db, username, amount, cause, row, col) {
  const target = await getUser(db, username, 'Target');
  const result = await applyBodyDamage(db, target, amount, { cause, row, col });
  const nextHealth = result.healthAfter;

  if (result.died) {
    // Plan 013g: players AND NPCs descend through the same band — descendTowardDeath reads
    // the incapacitated state and either downs them, hastens the clock, or finishes them
    // (true death / gib), routing an NPC's end to defeatNpc and a player's to the grave.
    const outcome = await descendTowardDeath(db, username, {
      cause,
      row,
      col,
      blowDamage: amount,
      overkill: result.overkill || 0,
      currentTick: await getCurrentTickValue(db)
    });
    const killed = outcome.state === 'died' || outcome.state === 'gibbed';
    return { killed, incapacitated: outcome.state === 'incapacitated', remainingHealth: 0 };
  }

  return { killed: false, remainingHealth: nextHealth };
}

export async function healUser(db, username, amount, row, col) {
  const user = await getUser(db, username, 'Target');
  return applyBodyHeal(db, user, amount, { row, col });
}

async function drainStamina(db, username, amount) {
  const user = await getUser(db, username, 'Target');
  const nextStamina = Math.max(0, user.stamina - amount);
  await dbRun(db, 'UPDATE users SET stamina = ? WHERE username = ?', [nextStamina, username]);
  return nextStamina;
}

export async function addStatusEffect(db, {
  username,
  source,
  effectType,
  magnitude,
  currentTick,
  duration,
  row,
  col
}) {
  await dbRun(
    db,
    `INSERT INTO statusEffects
      (username, source, effectType, magnitude, createdTick, expiryTick, roomRow, roomCol, sourceUsername)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [username, source, effectType, magnitude, currentTick, currentTick + duration, row, col, source]
  );
}

export async function clearOneHarmfulEffect(db, username) {
  const placeholders = [...HARMFUL_EFFECTS].map(() => '?').join(', ');
  const effect = await dbFirst(
    db,
    `SELECT id
     FROM statusEffects
     WHERE username = ?
       AND effectType IN (${placeholders})
     ORDER BY expiryTick ASC, id ASC
     LIMIT 1`,
    [username, ...HARMFUL_EFFECTS]
  );

  if (!effect) {
    return false;
  }

  await dbRun(db, 'DELETE FROM statusEffects WHERE id = ?', [effect.id]);
  return true;
}

// Active 'chill' (cold) saps effective speed while it lasts — folded into the
// effective layer via getConditionAndGearModifiers so it reaches the speed contest.
async function getStatusStatModifiers(db, username) {
  const tickValue = await getCurrentTickValue(db);
  const rows = await dbAll(
    db,
    "SELECT magnitude FROM statusEffects WHERE username = ? AND effectType = 'chill' AND expiryTick > ?",
    [username, tickValue]
  );
  let chill = 0;
  for (const row of rows) {
    chill += Number(row.magnitude) || 0;
  }
  return chill > 0 ? { speed: -chill } : {};
}

export async function processStatusEffects(db, currentTick) {
  const activeEffects = await dbAll(
    db,
    `SELECT *
     FROM statusEffects
     WHERE expiryTick > ?
       AND createdTick < ?
       AND effectType IN ('poison', 'arcane_pin', 'bless', 'burn', 'shock')
     ORDER BY id ASC`,
    [currentTick, currentTick]
  );

  for (const effect of activeEffects) {
    const stillExists = await dbFirst(db, 'SELECT username FROM users WHERE username = ?', [effect.username]);
    if (!stillExists) {
      continue;
    }

    if (effect.effectType === 'poison') {
      const cause = effect.sourceUsername ? `dose by ${effect.sourceUsername}` : 'poison';
      await damageUser(db, effect.username, effect.magnitude || 1, cause, effect.roomRow, effect.roomCol);
    } else if (effect.effectType === 'burn') {
      // Plan 020c: fire DoT (also holy/dark, per ELEMENT_STATUS).
      const cause = effect.sourceUsername ? `burn from ${effect.sourceUsername}` : 'burn';
      await damageUser(db, effect.username, effect.magnitude || 1, cause, effect.roomRow, effect.roomCol);
    } else if (effect.effectType === 'arcane_pin' || effect.effectType === 'shock') {
      // Plan 020c: shock (lightning) saps stamina each tick, like arcane_pin.
      await drainStamina(db, effect.username, effect.magnitude || 1);
    } else if (effect.effectType === 'bless') {
      await healUser(db, effect.username, effect.magnitude || 1, effect.roomRow, effect.roomCol);
    }
  }

  await dbRun(db, 'DELETE FROM statusEffects WHERE expiryTick <= ?', [currentTick]);
}
