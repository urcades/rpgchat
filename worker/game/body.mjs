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
  buildAffixRoll,
  distributeAcrossPlan,
  getBodyPlan,
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


// Plan 021 (BOLD): the body gate, generalized. A user's body plan decides whether it
// routes through per-part anatomy (a non-null plan) or scalar HP (null):
//   - System: null (never has a body).
//   - NPCs: getBodyPlan(user.creatureBodyPlan). A NULL column → null → scalar HP,
//     EXACTLY today's behavior (lazy/no-backfill: in-flight scalar NPCs finish
//     scalar; only fresh spawns carry a plan). A non-null plan id → that creature
//     plan, so the NPC falls through the IDENTICAL per-part routing players use.
//   - players: HUMANOID_PLAN (unchanged).
// Exported so the death seam can zero a bodied NPC's parts through the incap/gib
// band (preserving the users.health == Σ bodyParts.hp invariant for NPCs too).
export function bodyPlanFor(user) {
  if (!user || user.username === 'System') {
    return null;
  }
  if (user.isNpc) {
    return getBodyPlan(user.creatureBodyPlan);
  }
  return HUMANOID_PLAN;
}

export function isBodylessUser(user) {
  return bodyPlanFor(user) === null;
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
  const plan = bodyPlanFor(user);
  if (plan === null) {
    return null;
  }
  const existing = await getBodyParts(db, user.username);
  if (existing.length > 0) {
    return existing;
  }

  // Part pools mirror the STORED pool so the invariant is exact; job bonuses
  // live in the effective layer only. Plan 021: `plan` is the user's body plan
  // (HUMANOID_PLAN for players, a creature plan for bodied NPCs) — the player path
  // is byte-identical (plan === HUMANOID_PLAN).
  const storedMax = Math.max(0, Math.floor(user.maxHealth || 0));
  const storedHealth = Math.max(0, Math.min(Math.floor(user.health || 0), storedMax));
  const maxDistribution = distributeAcrossPlan(storedMax, plan);

  // Distribute current hp, clamped per-part to its maxHp; push any clamp
  // overflow to parts with headroom, torso first.
  const hpDistribution = distributeAcrossPlan(storedHealth, plan);
  const parts = plan.map((template, index) => ({
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

  // Plan 021 (BOLD): an elite NPC's affixes shape the body AS IT MATERIALIZES (whether
  // lazily on first hit or at spawn) — so the affix mods are part of the body from birth,
  // never a separate code path that could drift the invariant. Players carry no affixes
  // column, so this is a no-op for them.
  await applyAffixBodyEffects(db, user);

  return getBodyParts(db, user.username);
}

// Parse a bodied NPC's stored `affixes` JSON and fold the spawn-time body effects in:
//   - Hulking → append the extra-part rows (distinct labels; absolute maxHp; full hp).
//   - Armored → fortify EVERY part's maxHp via applyPartMaxHpDelta (which also mirrors
//     users.maxHealth and never destroys hp on a positive delta), exactly as plan 015's
//     structural armor does — so the fortified HP is real headroom the creature fills by
//     healing, and the users.health == Σ bodyParts.hp invariant stays exact.
// No affixes (or a player) → nothing happens. Idempotent in practice: the extra parts use
// INSERT OR IGNORE on the UNIQUE(username,label), and this only runs at body creation.
async function applyAffixBodyEffects(db, user) {
  const names = parseAffixNames(user && user.affixes);
  if (names.length === 0) {
    return;
  }
  const roll = buildAffixRoll(names);
  // Hulking appends EXTRA parts. Each carries its own HP pool, so users.health AND
  // users.maxHealth must grow by exactly the HP we add — otherwise Σ bodyParts.hp would
  // exceed users.health and the invariant breaks. We sum the HP actually inserted (the
  // UNIQUE(username,label) means a duplicate INSERT OR IGNORE adds nothing, so we only
  // count rows that did not already exist).
  let addedHp = 0;
  for (const extra of roll.extraParts) {
    const before = await dbFirst(db, 'SELECT id FROM bodyParts WHERE username = ? AND label = ?', [user.username, extra.label]);
    if (before) {
      continue; // already present — don't double-count on a re-entrant ensureBody
    }
    await dbRun(
      db,
      `INSERT OR IGNORE INTO bodyParts
        (username, partType, label, slotType, vital, hp, maxHp, baseMaxHp, severed)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      [user.username, extra.partType, extra.label, extra.slotType ?? null, extra.vital ? 1 : 0, extra.maxHp, extra.maxHp, extra.maxHp]
    );
    addedHp += Math.max(0, Math.floor(extra.maxHp || 0));
  }
  if (addedHp > 0) {
    await dbRun(
      db,
      'UPDATE users SET health = health + ?, maxHealth = maxHealth + ? WHERE username = ?',
      [addedHp, addedHp, user.username]
    );
  }
  if (roll.partMaxHpDelta) {
    const allParts = await getBodyParts(db, user.username);
    for (const part of allParts) {
      await applyPartMaxHpDelta(db, user.username, part.id, roll.partMaxHpDelta);
    }
  }
}

// Defensive parse of a stored affixes column into a string[] of affix names. Accepts the
// JSON array shape this seam writes (["Vicious","Armored"]); anything else → [].
function parseAffixNames(raw) {
  if (!raw) {
    return [];
  }
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Array.isArray(parsed) ? parsed.filter(name => typeof name === 'string') : [];
  } catch (error) {
    return [];
  }
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
//
// adv-006 (perf, behavior-preserving): one handleAttack computes this for the attacker
// AND each target, re-running getCurrentTickValue + the four sub-queries every time.
// Two opt-in knobs let the attack path avoid that fan-out WITHOUT changing any result:
//   - options.tickValue: the already-known current tick, threaded into the 'chill' read
//     so getStatusStatModifiers skips its own getCurrentTickValue round-trip.
//   - options.cache: a per-attack Map<username, modifiers>. The modifiers are a pure read
//     of state that does not change between the attacker- and target-reads inside one
//     attack, so memoizing by username returns the identical object (and consumes ZERO
//     extra RNG draws — these are all plain DB reads). Absent options => prior behavior.
export async function getConditionAndGearModifiers(db, username, options = {}) {
  const { tickValue = null, cache = null } = options;
  if (cache && cache.has(username)) {
    return cache.get(username);
  }
  const [condition, gear, progression, status] = await Promise.all([
    getBodyConditionModifiers(db, username),
    getEquippedModifiers(db, username),
    getProgressionModifiers(db, username),
    getStatusStatModifiers(db, username, tickValue)
  ]);
  const combined = {};
  for (const key of MODIFIER_KEYS) {
    combined[key] = (Number(condition[key]) || 0) + (Number(gear[key]) || 0) + (Number(progression[key]) || 0) + (Number(status[key]) || 0);
  }
  if (cache) {
    cache.set(username, combined);
  }
  return combined;
}

async function emitConditionTransitions(db, username, beforeParts, afterParts, row, col, displayLabel = username) {
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
    // Plan 021: read by displayLabel (a bodied NPC's display name); for players it
    // defaults to username, so player condition lines are byte-identical.
    const phrase = afterCondition === 'healthy'
      ? `${displayLabel}'s ${after.label} looks healthy again.`
      : `${displayLabel}'s ${after.label} is ${afterCondition}.`;
    await insertSystemMessage(db, row, col, phrase);
  }
}

export async function applyBodyDamage(db, user, amount, options = {}) {
  const { cause, row, col, random = Math.random, targetLabel = null } = options;
  // Plan 021: the name a bodied NPC's wound/sever lines read by ("Frost Wyrm's left
  // wing is destroyed"). Defaults to username, so player messaging is byte-identical.
  const displayLabel = options.displayLabel || user.username;
  const damage = Math.max(0, Math.floor(amount || 0));

  if (isBodylessUser(user)) {
    const nextHealth = Math.max(0, (user.health || 0) - damage);
    await dbRun(db, 'UPDATE users SET health = MAX(health - ?, 0) WHERE username = ?', [damage, user.username]);
    return { died: nextHealth <= 0, npc: true, healthAfter: nextHealth, severedLabels: [], overkill: Math.max(0, damage - (user.health || 0)), struckLabel: null };
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

  // Persist part rows. adv-018: the hp write is RELATIVE — `hp = MAX(hp - dealt, 0)`
  // where `dealt` is the damage this part actually absorbed (its pre-damage hp minus
  // its post-damage hp, both already floored at 0 in JS). A concurrent heal that
  // committed between the read above and this write is therefore composed with, not
  // clobbered by, the hit (the old `hp = <jsAbsolute>` lost that heal). `severed` is a
  // derived boolean state, not an accumulator, so it stays an absolute write — exactly
  // as before; the JS severance/vital-death logic is unchanged.
  const partsBeforeByLabel = new Map(partsBefore.map(part => [part.label, part]));
  for (const part of working) {
    const beforePart = partsBeforeByLabel.get(part.label);
    const beforeHp = Math.max(0, beforePart ? beforePart.hp : part.hp);
    const dealt = beforeHp - Math.max(0, part.hp); // >= 0; the hp this part shed.
    await dbRun(
      db,
      'UPDATE bodyParts SET hp = MAX(hp - ?, 0), severed = ? WHERE username = ? AND label = ?',
      [dealt, part.severed ? 1 : 0, user.username, part.label]
    );
  }

  // Mirror the same total deduction on users.health. adv-018: RELATIVE delta
  // (`health = MAX(health - totalDealt, 0)`) so a concurrent heal/second hit composes
  // instead of being overwritten by a stale absolute. maxHealth already shrank by a
  // relative delta; the severed-part reduction rides the same single UPDATE.
  const healthAfter = Math.max(0, (user.health || 0) - totalDealt);
  if (maxHealthReduction > 0) {
    await dbRun(
      db,
      'UPDATE users SET health = MAX(health - ?, 0), maxHealth = MAX(maxHealth - ?, 0) WHERE username = ?',
      [totalDealt, maxHealthReduction, user.username]
    );
  } else {
    await dbRun(db, 'UPDATE users SET health = MAX(health - ?, 0) WHERE username = ?', [totalDealt, user.username]);
  }

  // Loud states: condition-transition messages (non-severance), then severance.
  await emitConditionTransitions(db, user.username, partsBefore, working, row, col, displayLabel);
  if (row !== undefined && row !== null && col !== undefined && col !== null) {
    for (const part of severedParts) {
      await insertSystemMessage(db, row, col, `${displayLabel}'s ${part.label} is destroyed.`, 'combat');
      // Sever knock-off: whatever was equipped on this part clatters to the
      // floor for anyone to /take (plan 005). Fetch the name BEFORE the UPDATE.
      // (Creature parts carry slotType null and NPCs never wear gear, so this
      // resolves to nothing for a bodied NPC — no spurious floor item.)
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
          `${equipped.name} falls to the floor with ${displayLabel}'s ${part.label}.`
        );
      }
    }
  }

  const died = vitalDestroyed || healthAfter <= 0;
  // Plan 023b: `remaining` is damage that found no HP to land on — the overkill that
  // separates a barely-lethal blow (incapacitate) from an obliterating one (gib).
  // `struckLabel` is the label of the part the blow actually landed on (the honored
  // aimed part, or the weighted-random pickTargetPart choice) — purely informational,
  // for flavor lines; null when there was no live part to hit.
  return { died, npc: false, healthAfter, severedLabels, overkill: Math.max(0, remaining), struckLabel: target ? target.label : null };
}

export async function applyBodyHeal(db, user, amount, options = {}) {
  const { row, col } = options;
  const displayLabel = options.displayLabel || user.username;
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
  // adv-018: RELATIVE per-part write — `hp = MIN(hp + healed, maxHp)` where `healed`
  // is the points this part gained in the fill loop above (its post-heal hp minus its
  // pre-heal hp; 0 for severed/untouched parts, which the loop skips). A concurrent hit
  // that committed between the read and this write is composed with the heal, not lost
  // (the old `hp = <jsAbsolute>` clobbered it). The MIN keeps the per-part cap exact.
  const healPartsBeforeByLabel = new Map(partsBefore.map(part => [part.label, part]));
  for (const part of working) {
    const beforePart = healPartsBeforeByLabel.get(part.label);
    const healed = part.hp - (beforePart ? beforePart.hp : part.hp); // >= 0; gained hp.
    await dbRun(
      db,
      'UPDATE bodyParts SET hp = MIN(hp + ?, maxHp) WHERE username = ? AND label = ?',
      [healed, user.username, part.label]
    );
  }

  // adv-018: users.health rises by a RELATIVE delta (`health = MIN(health + healed,
  // maxHealth)`) so a concurrent hit isn't overwritten by a stale absolute. maxHealth
  // is the persisted cap (the same ceiling the JS budget used, modulo wound penalties
  // that only ever lower the JS budget — never raise health above the row cap here).
  const healthAfter = Math.max(0, (user.health || 0) + totalHealed);
  await dbRun(db, 'UPDATE users SET health = MIN(health + ?, maxHealth) WHERE username = ?', [totalHealed, user.username]);
  await emitConditionTransitions(db, user.username, partsBefore, working, row, col, displayLabel);
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
// adv-006: an already-known current tick may be passed in (the attack path has it) to
// skip the getCurrentTickValue round-trip; when omitted the tick is read as before.
async function getStatusStatModifiers(db, username, knownTickValue = null) {
  const tickValue = knownTickValue === null || knownTickValue === undefined
    ? await getCurrentTickValue(db)
    : knownTickValue;
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
