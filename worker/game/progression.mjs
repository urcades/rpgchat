// Progression grid, abilities granted, XP/level, jobs & stamina (plan adv-005).
//
// Extracted verbatim from the original worker/game.mjs — a pure mechanical move.
// Cross-seam dependencies are now explicit imports; cycles between seams resolve
// through ESM live bindings (every cross-seam reference is call-time, never
// dereferenced at module load).

import {
  ActionError,
  BASE_EXPERIENCE_REQUIRED,
  JOBS,
  PLAYER_ACTION_EXPERIENCE,
  assertAction,
  calculateLevel,
  getAbility,
  getDailyBoard,
  getEffectiveUser,
  getGridEntryNodeIds,
  getGridNode,
  getInnateAbilityIds,
  getTemplate,
  getWorldDay,
  normalizeJob
} from './shared.mjs';
import { changes, dbAll, dbFirst, dbRun } from '../db.mjs';
import { applyBodyDamage } from './body.mjs';
import { getSocketedMateriaEffects } from './inventory.mjs';
import { insertSystemMessage } from './messages.mjs';
import { getCurrentTickValue, getUser, roomHasEffect } from './world.mjs';


export async function assertEnoughStamina(db, username, cost = 1) {
  const user = await dbFirst(db, 'SELECT stamina FROM users WHERE username = ?', [username]);
  if (!user || user.stamina < cost) {
    throw new ActionError('Not enough stamina.', 400);
  }
}

export async function spendStamina(db, username, cost = 1) {
  const result = await dbRun(
    db,
    'UPDATE users SET stamina = stamina - ? WHERE username = ? AND stamina >= ?',
    [cost, username, cost]
  );
  if (changes(result) === 0) {
    throw new ActionError('Not enough stamina.', 400);
  }
}

// Plan 016: spend one attributePoint (granted 10/level by awardExperience) to
// raise a base stat. The map is the allowlist — only these stat names ever reach
// the SQL, which is why the `${stat}` interpolation below is safe. maxStamina
// gives a bigger step so a point is worth spending; maxHealth is deliberately
// NOT here yet (it's body-bound: maxHealth == Σ part maxHp — see the plan).
const ALLOCATABLE_STATS = { strength: 1, speed: 1, intelligence: 1, maxStamina: 5 };

export function getAllocatableStats() {
  return { ...ALLOCATABLE_STATS };
}

export async function allocateAttributePoint(db, username, stat) {
  const step = ALLOCATABLE_STATS[stat];
  assertAction(step, 'You cannot raise that attribute.');
  // Atomic: spends exactly one point, and only if one is available.
  const result = await dbRun(
    db,
    `UPDATE users SET ${stat} = ${stat} + ?, attributePoints = attributePoints - 1
     WHERE username = ? AND attributePoints >= 1 AND isNpc = 0`,
    [step, username]
  );
  assertAction(changes(result) > 0, 'No attribute points to spend.', 400);
  return { stat, step };
}

export async function runPlayerAction(db, { username, staminaCost = 1, validate, perform, advanceTick }) {
  await assertEnoughStamina(db, username, staminaCost);
  if (validate) {
    await validate();
  }
  await spendStamina(db, username, staminaCost);
  const result = await perform();
  const tick = advanceTick ? await advanceTick() : null;
  return { ...result, tick };
}

// Effective max stamina = stored maxStamina + the job's maxStamina bonus.
// Build that bonus as a CASE expression straight from JOBS so it stays in sync
// with utils/jobs.js instead of hardcoding per-job numbers in SQL. Job names are
// our own config keys (never user input), so inlining them carries no injection risk.
function effectiveMaxStaminaSql() {
  const clauses = Object.entries(JOBS)
    .map(([job, definition]) => [job, definition.bonuses?.maxStamina || 0])
    .filter(([, bonus]) => bonus > 0)
    .map(([job, bonus]) => `WHEN '${job}' THEN maxStamina + ${bonus}`);
  return clauses.length > 0 ? `CASE job ${clauses.join(' ')} ELSE maxStamina END` : 'maxStamina';
}

export async function recoverStaminaForAllUsers(db) {
  // Regenerate 1 stamina for every eligible user (and clamp any over-cap values
  // back down) in a single statement instead of one round-trip per row. The
  // WHERE clause writes exactly the rows the per-user loop used to write.
  const effectiveMax = effectiveMaxStaminaSql();
  await dbRun(
    db,
    `UPDATE users
     SET stamina = MIN(stamina + 1, ${effectiveMax})
     WHERE stamina <> (${effectiveMax})`
  );
}

export async function upsertCooldown(db, username, row, col, effectType, currentTick, worldDay) {
  await dbRun(
    db,
    `INSERT INTO roomEffectCooldowns
      (username, roomRow, roomCol, effectType, lastAppliedTick, worldDay)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(username, roomRow, roomCol, effectType, worldDay) DO UPDATE SET
      lastAppliedTick = excluded.lastAppliedTick`,
    [username, row, col, effectType, currentTick, worldDay]
  );
}

// --- Plan 019b: the daily progression grid --------------------------------
// ONE shared board generated per worldDay from a Penrose tiling (utils/progression
// Grid.js). Daily builds: your point budget is your LEVEL, re-spent each day;
// available = budget − cost of TODAY's unlocked nodes. Node IDs are namespaced
// `${worldDay}:${vid}`, so yesterday's rows stop counting and the reset is free and
// automatic — stale rows are swept lazily. Node effects are DERIVED from the
// unlocked set (respec is just deleting today's rows).

// Today's unlocked node IDs only (a prior day's rows belong to a board that no
// longer exists). Sweep those stale rows opportunistically.
async function getStoredUnlockedNodeIds(db, username, worldDay) {
  const rows = await dbAll(db, 'SELECT nodeId FROM playerProgressionNodes WHERE username = ? AND nodeId LIKE ?', [username, `${worldDay}:%`]);
  return rows.map(row => row.nodeId);
}

async function sweepStaleUnlocks(db, username, worldDay) {
  await dbRun(db, 'DELETE FROM playerProgressionNodes WHERE username = ? AND nodeId NOT LIKE ?', [username, `${worldDay}:%`]);
}

// The full unlocked set (the class's entry node + today's unlocks) — for adjacency.
async function getUnlockedNodeIds(db, username, job, worldDay) {
  const stored = await getStoredUnlockedNodeIds(db, username, worldDay);
  return new Set([...getGridEntryNodeIds(worldDay, normalizeJob(job)), ...stored]);
}

// Stat deltas from today's unlocked `stat` / `passive` nodes, folded into the
// effective layer via getConditionAndGearModifiers so they reach combat AND
// display. Passives are binary: one the class already has innately is skipped.
export async function getProgressionModifiers(db, username) {
  const worldDay = getWorldDay();
  const stored = await getStoredUnlockedNodeIds(db, username, worldDay);
  if (!stored.length) {
    return {};
  }
  const user = await getUser(db, username);
  const innatePassives = new Set(
    getInnateAbilityIds(normalizeJob(user.job)).filter(id => {
      const ability = getAbility(id);
      return ability && ability.kind === 'passive';
    })
  );
  const modifiers = {};
  for (const nodeId of stored) {
    const node = getGridNode(worldDay, nodeId);
    if (!node || !node.effect) continue;
    if (node.effect.kind === 'stat') {
      modifiers[node.effect.stat] = (modifiers[node.effect.stat] || 0) + Number(node.effect.amount || 0);
    } else if (node.effect.kind === 'passive') {
      if (innatePassives.has(node.effect.abilityId)) continue; // already folded by getEffectiveUser
      const ability = getAbility(node.effect.abilityId);
      for (const [stat, delta] of Object.entries((ability && ability.statEffects) || {})) {
        modifiers[stat] = (modifiers[stat] || 0) + Number(delta || 0);
      }
    }
  }
  return modifiers;
}

// Active abilities granted by today's unlocked `grant_ability` nodes — unioned with
// item-granted abilities in getGrantedAbilityIds.
async function getProgressionGrantedAbilityIds(db, username) {
  const worldDay = getWorldDay();
  const stored = await getStoredUnlockedNodeIds(db, username, worldDay);
  const granted = [];
  for (const nodeId of stored) {
    const node = getGridNode(worldDay, nodeId);
    if (node && node.effect && node.effect.kind === 'grant_ability') {
      const abilityId = node.effect.abilityId;
      if (getAbility(abilityId) && !granted.includes(abilityId)) granted.push(abilityId);
    }
  }
  return granted;
}

function spentOnNodes(board, nodeIds) {
  let spent = 0;
  for (const id of nodeIds) {
    const node = board.byId.get(id);
    if (node) spent += node.cost || 0;
  }
  return spent;
}

// The board state for the UI: today's board with every node tagged unlocked /
// unlockable / locked, plus the daily point budget.
export async function getProgressionGrid(db, username) {
  const worldDay = getWorldDay();
  await sweepStaleUnlocks(db, username, worldDay);
  const board = getDailyBoard(worldDay);
  const user = await getUser(db, username);
  const job = normalizeJob(user.job);
  const budget = Number(user.level || 0);
  const stored = await getStoredUnlockedNodeIds(db, username, worldDay);
  const unlocked = new Set([...getGridEntryNodeIds(worldDay, job), ...stored]);
  const spent = spentOnNodes(board, stored);
  const available = Math.max(0, budget - spent);

  const nodes = board.nodes.map(node => {
    const isUnlocked = unlocked.has(node.id);
    const onFrontier = node.neighbors.some(neighborId => unlocked.has(neighborId));
    const cost = node.cost || 0;
    return {
      id: node.id,
      label: node.label,
      x: node.x,
      y: node.y,
      cost,
      effect: node.effect,
      entryFor: node.entryFor || null,
      region: node.region,
      neighbors: node.neighbors,
      state: isUnlocked ? 'unlocked' : (onFrontier && available >= cost ? 'unlockable' : 'locked')
    };
  });
  return { worldDay, job, budget, spent, available, canvas: board.canvas, nodes };
}

// Unlock a node on TODAY's board: claim-first (the PK guards double-unlock races),
// then verify the daily budget still holds — rolling the claim back if it doesn't.
export async function unlockProgressionNode(db, username, nodeId) {
  const worldDay = getWorldDay();
  const board = getDailyBoard(worldDay);
  const node = board.byId.get(nodeId);
  assertAction(node, 'That node is not on today\'s board.', 404);
  await sweepStaleUnlocks(db, username, worldDay);

  const user = await getUser(db, username);
  const job = normalizeJob(user.job);
  const budget = Number(user.level || 0);
  const stored = await getStoredUnlockedNodeIds(db, username, worldDay);
  const unlocked = new Set([...getGridEntryNodeIds(worldDay, job), ...stored]);
  assertAction(!unlocked.has(nodeId), 'That node is already unlocked.', 400);
  assertAction(node.neighbors.some(neighborId => unlocked.has(neighborId)), 'That node is not reachable yet.', 400);

  const cost = node.cost || 0;
  assertAction(budget - spentOnNodes(board, stored) >= cost, 'Not enough skill points today.', 400);

  const claim = await dbRun(
    db,
    'INSERT OR IGNORE INTO playerProgressionNodes (username, nodeId, unlockedTick) VALUES (?, ?, ?)',
    [username, nodeId, await getCurrentTickValue(db)]
  );
  assertAction(changes(claim) > 0, 'That node is already unlocked.', 400);

  // Re-check the budget against the now-committed set; roll back on overspend.
  const after = await getStoredUnlockedNodeIds(db, username, worldDay);
  if (spentOnNodes(board, after) > budget) {
    await dbRun(db, 'DELETE FROM playerProgressionNodes WHERE username = ? AND nodeId = ?', [username, nodeId]);
    throw new ActionError('Not enough skill points today.', 400);
  }
  return getProgressionGrid(db, username);
}

const RESPEC_GOLD_COST = 50;

// Respec at a guild (where class reselection lives): pay gold to clear TODAY's
// unlocks so the day's budget can be re-spent. (The board itself resets free at
// the daily rollover; this is for re-planning mid-day.)
export async function respecProgression(db, username, row, col) {
  const worldDay = getWorldDay();
  const tickValue = await getCurrentTickValue(db);
  assertAction(roomHasEffect(row, col, tickValue, 'guild', worldDay), 'You can only respec at a guild.', 400);

  const stored = await getStoredUnlockedNodeIds(db, username, worldDay);
  assertAction(stored.length > 0, 'You have no unlocked nodes to respec today.', 400);

  const paid = await dbRun(
    db,
    'UPDATE users SET gold = gold - ? WHERE username = ? AND gold >= ? AND isNpc = 0',
    [RESPEC_GOLD_COST, username, RESPEC_GOLD_COST]
  );
  assertAction(changes(paid) > 0, `Respec costs ${RESPEC_GOLD_COST} gold.`, 400);

  await dbRun(db, 'DELETE FROM playerProgressionNodes WHERE username = ? AND nodeId LIKE ?', [username, `${worldDay}:%`]);
  return getProgressionGrid(db, username);
}

export async function awardGoldMaybe(db, username) {
  if (Math.random() < 0.1) {
    const goldAmount = Math.floor(Math.random() * 3) + 1;
    await dbRun(db, 'UPDATE users SET gold = gold + ? WHERE username = ?', [goldAmount, username]);
    return goldAmount;
  }
  return 0;
}

export async function updateLevel(db, username, row, col) {
  const result = await awardExperience(db, username, PLAYER_ACTION_EXPERIENCE);

  if (result.leveled) {
    await insertSystemMessage(db, row, col, `${username} reached level ${result.level} and gained 10 attribute points.`);
  }
}

export async function awardExperience(db, username, amount) {
  const user = await dbFirst(db, 'SELECT experience, level, isNpc FROM users WHERE username = ?', [username]);
  if (!user || user.isNpc) {
    return { experience: 0, level: 0, leveled: false };
  }

  const nextExperience = (user.experience || 0) + amount;
  const nextLevel = calculateLevel(nextExperience, BASE_EXPERIENCE_REQUIRED);
  const levelDelta = Math.max(0, nextLevel - user.level);
  if (levelDelta > 0) {
    await dbRun(
      db,
      // Plan 016 grants 10 attribute points/level; plan 019 grants 1 skill point/
      // level (a SEPARATE currency for the progression grid).
      'UPDATE users SET experience = ?, level = ?, attributePoints = attributePoints + ?, skillPoints = skillPoints + ? WHERE username = ?',
      [nextExperience, nextLevel, levelDelta * 10, levelDelta, username]
    );
  } else {
    await dbRun(db, 'UPDATE users SET experience = ? WHERE username = ?', [nextExperience, username]);
  }

  // Plan 020d: materia socketed in equipped gear grow with the wielder's deeds.
  await dbRun(
    db,
    `UPDATE items SET ap = ap + 1
     WHERE socketedInId IN (SELECT id FROM items WHERE ownerUsername = ? AND equippedPartId IS NOT NULL)`,
    [username]
  );

  return { experience: nextExperience, level: nextLevel, leveled: levelDelta > 0 };
}

// Plan 018c: abilities granted by a player's EQUIPPED items (an item template's
// grantsAbility), deduped to ids that resolve to a registered ability. Unioned
// into the usable set and the hotbar so gear can hand a class a verb.
export async function getGrantedAbilityIds(db, username) {
  const rows = await dbAll(
    db,
    'SELECT id, templateId FROM items WHERE ownerUsername = ? AND equippedPartId IS NOT NULL',
    [username]
  );
  const granted = [];
  const equippedIds = [];
  for (const row of rows) {
    equippedIds.push(row.id);
    const template = getTemplate(row.templateId);
    const abilityId = template && template.grantsAbility;
    if (abilityId && getAbility(abilityId) && !granted.includes(abilityId)) {
      granted.push(abilityId);
    }
  }
  // Plan 020d: abilities granted by materia socketed into equipped gear.
  for (const effect of await getSocketedMateriaEffects(db, equippedIds)) {
    if (effect.kind === 'grant_ability' && getAbility(effect.abilityId) && !granted.includes(effect.abilityId)) {
      granted.push(effect.abilityId);
    }
  }
  // Plan 019: abilities granted by unlocked progression-grid nodes ride the same
  // usable-set + hotbar channel as item-granted abilities.
  for (const abilityId of await getProgressionGrantedAbilityIds(db, username)) {
    if (!granted.includes(abilityId)) {
      granted.push(abilityId);
    }
  }
  return granted;
}

// The abilities a player may invoke right now: their innate class kit plus any
// abilities granted by equipped items (plan 018c) — actives only (passives are
// never activated). Async so the granted source can hit the DB.
export async function getUsableAbilityIds(db, username, effectiveActor) {
  const candidateIds = [
    ...getInnateAbilityIds(effectiveActor.job),
    ...(await getGrantedAbilityIds(db, username))
  ];
  const usable = [];
  for (const id of candidateIds) {
    const ability = getAbility(id);
    if (ability && ability.kind !== 'passive' && !usable.includes(id)) {
      usable.push(id);
    }
  }
  return usable;
}

export async function switchJob(db, { username, nextJob, row, col }) {
  if (!Object.prototype.hasOwnProperty.call(JOBS, nextJob)) {
    throw new ActionError('Invalid job.');
  }

  const user = await getUser(db, username);
  const nextEffective = getEffectiveUser({ ...user, job: nextJob });
  const nextStamina = Math.min(user.stamina, nextEffective.maxStamina);

  // Job and stamina update directly; the downward health clamp routes through
  // the body chokepoint so part HP and the invariant stay consistent.
  await dbRun(
    db,
    'UPDATE users SET job = ?, stamina = ? WHERE username = ?',
    [nextJob, nextStamina, username]
  );

  if (user.health > nextEffective.maxHealth) {
    const difference = user.health - nextEffective.maxHealth;
    await applyBodyDamage(db, { ...user, job: nextJob }, difference, {
      cause: 'the change of vocation',
      row,
      col
    });
  }

  const message = `${username} changes job to ${nextJob}.`;
  await insertSystemMessage(db, row, col, message);
  return { message, job: nextJob };
}
