// Action & command handlers (chat entrypoint + action routers) (plan adv-005).
//
// Extracted verbatim from the original worker/game.mjs — a pure mechanical move.
// Cross-seam dependencies are now explicit imports; cycles between seams resolve
// through ESM live bindings (every cross-seam reference is call-time, never
// dereferenced at module load).

import {
  ActionError,
  JOBS,
  REGROW_EFFECT_TYPE,
  REGROW_GOLD_COST,
  STANCES,
  assertAction,
  commandRest,
  getAbility,
  getEffectiveUser,
  getPhaseFromTick,
  getWorldDay,
  parseCalledShot,
  resolveAbilityStaminaCost,
  riteRankFromCasts,
  shouldApplyEffect
} from './shared.mjs';
import { changes, dbBatch, dbFirst, dbRun, lastInsertId } from '../db.mjs';
import { ensureBody } from './body.mjs';
import {
  RITE_COOLDOWN_EFFECT_PREFIX,
  handleAttack,
  handleRollCommand,
  useClassSkill,
  validateAttackTargets,
  validateClassSkillUse,
  validateRollCommand
} from './combat.mjs';
import { assertActable, garbleSpeech, isIncapacitated } from './death.mjs';
import {
  handleBrewCommand,
  handleBuyCommand,
  handleCookCommand,
  handleDropCommand,
  handleEatCommand,
  handleEquipCommand,
  handleForgeCommand,
  handleGiveCommand,
  handleSocketCommand,
  handleTakeCommand,
  handleUnequipCommand,
  handleUnsocketCommand,
  handleUseCommand,
  validateBuyCommand
} from './inventory.mjs';
import { insertMessage, insertSystemMessage } from './messages.mjs';
import {
  awardGoldMaybe,
  getRiteMastery,
  getUsableAbilityIds,
  runPlayerAction,
  switchJob,
  updateLevel,
  upsertCooldown
} from './progression.mjs';
import {
  advanceTickOnly,
  getCurrentTickValue,
  getRoomAccessState,
  getUser,
  roomHasEffect
} from './world.mjs';


// Space-separated stance keys for usage/error messages, e.g. "standing,
// aggressive, guarding, crouched".
function stanceOptionList() {
  return Object.keys(STANCES).join(', ');
}

// Resolve the severed part the player named in /regrow, normalizing label
// spelling (underscores/case) the same way called shots do. Returns the live
// part row (the named, currently-severed part) plus context, or throws the
// appropriate validation ActionError. Shared by validate and perform so the
// two can't drift.
async function resolveRegrow(db, username, row, col, message) {
  const rest = commandRest(message, '/regrow').trim();
  if (!rest) {
    throw new ActionError('Use /regrow <part label>.');
  }
  // Map 'left_arm'/'RIGHT ARM' to the canonical label via parseCalledShot,
  // which matches any humanoid part label. Fall back to the raw text so the
  // not-a-part error path stays informative.
  const label = parseCalledShot(rest) || rest.toLowerCase();

  const worldDay = getWorldDay();
  const tickValue = await getCurrentTickValue(db);

  // Inn gate: room must be an inn today AND the player must have paid access.
  const access = await getRoomAccessState(db, username, row, col, tickValue, worldDay);
  assertAction(access.required, 'Regrowth rites require an inn.', 403);
  assertAction(access.paid, 'You must pay for inn access first.', 402);

  // One regrowth per player per worldDay (pseudo-room 0,0 — global per day).
  const cooldown = await dbFirst(
    db,
    `SELECT lastAppliedTick FROM roomEffectCooldowns
     WHERE username = ? AND roomRow = 0 AND roomCol = 0 AND effectType = ? AND worldDay = ?`,
    [username, REGROW_EFFECT_TYPE, worldDay]
  );
  assertAction(!cooldown, 'You can only regrow once per day.');

  const user = await getUser(db, username);
  assertAction((user.gold || 0) >= REGROW_GOLD_COST, 'Not enough gold for the rite.', 402);

  const parts = (await ensureBody(db, user)) || [];
  const part = parts.find(p => p.label === label);
  assertAction(part, 'No such body part.');
  assertAction(part.severed, 'That part is not severed.');

  return { user, part, worldDay, tickValue, label: part.label };
}

export async function validateRegrowCommand(db, username, row, col, message) {
  // All failure paths fire here (before spendStamina): bad part, not an inn,
  // unpaid, short on gold, already regrown today.
  await resolveRegrow(db, username, row, col, message);
}

// Dedicated regrow restorer — NOT applyBodyHeal (which skips severed parts).
// Restores the part to its BASE (un-fortified) maxHp, hp 1, un-severs it, and
// folds baseMaxHp back into users.maxHealth and 1 into users.health, keeping
// the invariant `users.maxHealth == Σ non-severed maxHp` exact. The limb
// regrows bare; re-equipping armor re-applies its bonus via plan 015.
async function restoreSeveredPart(db, username, part) {
  const base = Math.max(0, Math.floor(part.baseMaxHp || 0));
  await dbRun(
    db,
    'UPDATE bodyParts SET severed = 0, maxHp = ?, hp = 1 WHERE id = ?',
    [base, part.id]
  );
  await dbRun(
    db,
    'UPDATE users SET maxHealth = maxHealth + ?, health = health + 1 WHERE username = ?',
    [base, username]
  );
}

export async function handleRegrowCommand(db, username, row, col, message) {
  const { part, worldDay, tickValue, label } = await resolveRegrow(db, username, row, col, message);

  // Conditional gold decrement (plan 003 pattern) — only fires once and never
  // overdraws below zero.
  const goldUpdate = await dbRun(
    db,
    'UPDATE users SET gold = gold - ? WHERE username = ? AND gold >= ?',
    [REGROW_GOLD_COST, username, REGROW_GOLD_COST]
  );
  assertAction(changes(goldUpdate) > 0, 'Not enough gold for the rite.', 402);

  await restoreSeveredPart(db, username, part);
  // Stamp the per-day cooldown (pseudo-room 0,0).
  await upsertCooldown(db, username, 0, 0, REGROW_EFFECT_TYPE, tickValue, worldDay);

  const message_ = `${username}'s ${label} regrows, pale and new.`;
  await insertSystemMessage(db, row, col, message_);
  return { regrew: label };
}

export async function handleStanceCommand(db, username, row, col, message) {
  const rest = commandRest(message, '/stance').trim();
  if (!rest) {
    throw new ActionError(`Use /stance <${stanceOptionList()}>.`);
  }
  const requested = rest.split(/\s+/)[0].toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(STANCES, requested)) {
    throw new ActionError(`Unknown stance. Choose one of: ${stanceOptionList()}.`);
  }
  await getUser(db, username); // 404 if the user vanished
  await dbRun(db, 'UPDATE users SET stance = ? WHERE username = ?', [requested, username]);
  const message_ = `${username} takes a ${STANCES[requested].label} stance.`;
  await insertSystemMessage(db, row, col, message_);
  return { stance: requested };
}

// adv-010: the slash-command dispatch table. Each row is ONE command —
// add a verb by adding a row, not by hand-rolling another
// `if (startsWith) return runPlayerAction(...)` block. The table is an ORDERED
// array (not a keyed map) because dispatch is first-prefix-wins on
// `message.trim().toLowerCase().startsWith(prefix)`, and that order is
// load-bearing: `/unsocket` must be tested before `/socket`. Every row carries
// the exact stamina cost, optional validate, and the perform handler that the
// inline blocks used. `perform`/`validate` are factories taking the call
// context `{ db, username, row, col, message }` so each command passes exactly
// the args it always did — note /socket and /unsocket deliberately call their
// handler WITHOUT row/col, preserving their (db, username, message) signature.
//
// Two row kinds:
//   • standard — wrapped in runPlayerAction with staminaCost + advanceTick
//     (advanceTickOnly), exactly like every wrapped command before.
//   • raw — dispatched directly (no runPlayerAction here). /cast routes through
//     handleCastAction, which owns its own runPlayerAction (stamina/tick), so it
//     must NOT be wrapped again — the `raw: true` flag keeps it in the same
//     ordered table at its original position rather than as a special case.
const COMMAND_REGISTRY = [
  { prefix: '/stance', staminaCost: 1, perform: ({ db, username, row, col, message }) => handleStanceCommand(db, username, row, col, message) },
  { prefix: '/regrow', staminaCost: 20, validate: ({ db, username, row, col, message }) => validateRegrowCommand(db, username, row, col, message), perform: ({ db, username, row, col, message }) => handleRegrowCommand(db, username, row, col, message) },
  { prefix: '/roll', staminaCost: 1, validate: ({ db, username, row, col, message }) => validateRollCommand(db, username, row, col, message), perform: ({ db, username, row, col, message }) => handleRollCommand(db, username, row, col, message) },
  { prefix: '/equip', staminaCost: 1, perform: ({ db, username, row, col, message }) => handleEquipCommand(db, username, row, col, message) },
  { prefix: '/unequip', staminaCost: 1, perform: ({ db, username, row, col, message }) => handleUnequipCommand(db, username, row, col, message) },
  { prefix: '/take', staminaCost: 1, perform: ({ db, username, row, col, message }) => handleTakeCommand(db, username, row, col, message) },
  { prefix: '/drop', staminaCost: 1, perform: ({ db, username, row, col, message }) => handleDropCommand(db, username, row, col, message) },
  { prefix: '/give', staminaCost: 1, perform: ({ db, username, row, col, message }) => handleGiveCommand(db, username, row, col, message) },
  { prefix: '/use', staminaCost: 1, perform: ({ db, username, row, col, message }) => handleUseCommand(db, username, row, col, message) },
  { prefix: '/cook', staminaCost: 1, perform: ({ db, username, row, col, message }) => handleCookCommand(db, username, row, col, message) },
  { prefix: '/brew', staminaCost: 1, perform: ({ db, username, row, col, message }) => handleBrewCommand(db, username, row, col, message) },
  { prefix: '/forge', staminaCost: 1, perform: ({ db, username, row, col, message }) => handleForgeCommand(db, username, row, col, message) },
  { prefix: '/eat', staminaCost: 1, perform: ({ db, username, row, col, message }) => handleEatCommand(db, username, row, col, message) },
  // handleCastAction routes through handleSkillAction, which owns the
  // runPlayerAction (stamina/tick), so it isn't wrapped again here.
  { prefix: '/cast', raw: true, dispatch: ({ db, username, row, col, message }) => handleCastAction(db, username, row, col, message) },
  { prefix: '/unsocket', staminaCost: 1, perform: ({ db, username, message }) => handleUnsocketCommand(db, username, message) },
  { prefix: '/socket', staminaCost: 1, perform: ({ db, username, message }) => handleSocketCommand(db, username, message) },
  { prefix: '/buy', staminaCost: 1, validate: ({ db, username, row, col, message }) => validateBuyCommand(db, username, row, col, message), perform: ({ db, username, row, col, message }) => handleBuyCommand(db, username, row, col, message) }
];

export async function handleChatAction(db, username, row, col, message) {
  // Plan 023b: the incapacitated may speak (garbled — see the plain-speech path
  // below) but every slash-command is an action and is refused.
  const downed = await isIncapacitated(db, username);
  if (downed && message.trim().startsWith('/')) {
    throw new ActionError('You are incapacitated — you can do nothing but whisper.', 409);
  }

  const normalized = message.trim().toLowerCase();
  const command = COMMAND_REGISTRY.find(entry => normalized.startsWith(entry.prefix));
  if (command) {
    const ctx = { db, username, row, col, message };
    if (command.raw) {
      return command.dispatch(ctx);
    }
    return runPlayerAction(db, {
      username,
      staminaCost: command.staminaCost,
      ...(command.validate ? { validate: async () => command.validate(ctx) } : {}),
      perform: async () => command.perform(ctx),
      advanceTick: () => advanceTickOnly(db)
    });
  }

  // Plan 023c: a downed player's plea comes out broken — garbled, and free of the
  // usual stamina/gold/XP/tick machinery (a dying breath doesn't farm or move the
  // world). The banner + garbling carry the pathos.
  if (downed) {
    const garbled = garbleSpeech(message);
    const inserted = await insertMessage(db, row, col, username, garbled, 'rite');
    return {
      message: garbled,
      garbled: true,
      messageRow: { id: inserted.id, username, message: garbled, timestamp: inserted.timestamp, kind: 'rite' }
    };
  }

  return runPlayerAction(db, {
    username,
    staminaCost: 1,
    perform: async () => {
      const inserted = await insertMessage(db, row, col, username, message);
      await awardGoldMaybe(db, username);
      await updateLevel(db, username, row, col);
      // The fully-formed row rides back so the broadcast can carry it — clients
      // append it directly instead of fetching a delta.
      return {
        message,
        messageRow: { id: inserted.id, username, message, timestamp: inserted.timestamp, kind: 'chat' }
      };
    },
    advanceTick: () => advanceTickOnly(db)
  });
}

// Plan (aim never blocks): a called shot is now ALWAYS best-effort and is resolved
// per-target inside handleAttack — if the aimed part is missing or severed the blow
// lands as a normal weighted-random hit (with a flavor note), never a rejection. There
// is therefore no pre-flight aim gate: the only thing /attack validates is that a
// target is present, so an attack always proceeds and spends its stamina/advances the
// tick like any landed action. (The former validateCalledShot, which threw "There is
// nothing left to aim at." here, is gone.)
export async function handleAttackAction(db, username, row, col, message, targetPart = null) {
  await assertActable(db, username); // Plan 023b: the downed cannot strike.
  return runPlayerAction(db, {
    username,
    staminaCost: 1,
    validate: async () => validateAttackTargets(db, message, row, col, username),
    perform: async () => {
      const deferredSystemMessages = [];
      const updatedMessage = await handleAttack(db, username, message, row, col, { deferredSystemMessages, targetPart });
      // Perf (attack-latency): the attack line + its deferred system lines used
      // to land as 1+N sequential round trips on the ack path; one dbBatch
      // writes them together. The formed rows (with real ids) are RETURNED so
      // the broadcast can be self-describing — clients append them directly
      // instead of debounced-refetching the whole room state to see an attack.
      const timestamp = new Date().toISOString().slice(0, 19).replace('T', ' ');
      const pending = [
        { username, message: updatedMessage, kind: 'chat' },
        ...deferredSystemMessages.map(deferred => ({
          username: 'System',
          message: deferred.message,
          kind: deferred.kind || 'system'
        }))
      ];
      const inserted = await dbBatch(db, pending.map(rowSpec => [
        'INSERT INTO messages (roomRow, roomCol, username, message, kind, timestamp) VALUES (?, ?, ?, ?, ?, ?)',
        [row, col, rowSpec.username, rowSpec.message, rowSpec.kind, timestamp]
      ]));
      const messageRows = pending.map((rowSpec, index) => ({
        id: lastInsertId(inserted[index]),
        username: rowSpec.username,
        message: rowSpec.message,
        timestamp,
        kind: rowSpec.kind
      }));
      await awardGoldMaybe(db, username);
      await updateLevel(db, username, row, col);
      return { updatedMessage, messageRows };
    },
    advanceTick: () => advanceTickOnly(db)
  });
}

// Plan 012 (tail): the per-ability rite cooldown gate. Mirrors /regrow's
// SELECT-then-assert against roomEffectCooldowns, on the same rail
// (effectType 'rite:<abilityId>', pseudo-room 0,0, keyed by worldDay). Runs inside
// handleSkillAction's validate — BEFORE spendStamina — so a blocked rite costs NO
// stamina and does NOT advance the tick. Only abilities that declare cooldownTicks
// are gated; every existing skill (no cooldownTicks) is untouched.
async function assertRiteOffCooldown(db, username, ability, currentTick) {
  if (!ability || !Number.isFinite(ability.cooldownTicks) || ability.cooldownTicks <= 0) {
    return;
  }
  const worldDay = getWorldDay();
  const cooldown = await dbFirst(
    db,
    `SELECT lastAppliedTick FROM roomEffectCooldowns
     WHERE username = ? AND roomRow = 0 AND roomCol = 0 AND effectType = ? AND worldDay = ?`,
    [username, RITE_COOLDOWN_EFFECT_PREFIX + ability.id, worldDay]
  );
  const ready = shouldApplyEffect({
    currentTick,
    lastAppliedTick: cooldown ? cooldown.lastAppliedTick : null,
    interval: ability.cooldownTicks
  });
  assertAction(ready, 'That rite is still gathering — wait a few ticks.', 429);
}

export async function handleSkillAction(db, username, row, col, skillId, targetUsername, actionTick, incantation = '') {
  await assertActable(db, username); // Plan 023b: the downed cannot invoke skills (incl. their own rescue).
  const ability = getAbility(skillId);
  // Plan 012 (tail): mastery rank (derived from the player's cumulative successful
  // casts of THIS ability — never stored) raises the rite's power AND lifts its
  // word cap. Non-rite skills carry no mastery row, so rank is 0 and the cost is
  // unchanged. NPCs never reach this handler (player-only entrypoint).
  const rank = riteRankFromCasts(await getRiteMastery(db, username, skillId));
  // Plan 018c: cost is data-driven — base plus any linguistic surcharge from the
  // typed incantation. Every ability defaults to 1 stamina with no prose, so this
  // is parity today; plan 012 supplies linguistic abilities and the prose path.
  // Plan 012 (tail): rank lifts the linguistic word cap (rank 0 = byte-identical).
  const staminaCost = resolveAbilityStaminaCost(ability, { text: incantation, rank });
  return runPlayerAction(db, {
    username,
    staminaCost,
    validate: async () => {
      // Cooldown gate fires BEFORE stamina is spent: a blocked rite throws 429 here,
      // so runPlayerAction never reaches spendStamina or advanceTick.
      await assertRiteOffCooldown(db, username, ability, actionTick);
      return validateClassSkillUse(db, { username, skillId, targetUsername, row, col });
    },
    perform: async () => useClassSkill(db, {
      username,
      skillId,
      targetUsername,
      row,
      col,
      currentTick: actionTick,
      phase: getPhaseFromTick(actionTick),
      incantation,
      rank
    }),
    advanceTick: () => advanceTickOnly(db)
  });
}

// Plan 012: cast a keyword rite from chat — /cast <incantation> @target. Resolves
// the player's linguistic ability (one whose cost reads the words), extracts the
// @mention target, and runs it through the normal skill flow with the incantation
// (which scales both its stamina cost and its power).
export async function handleCastAction(db, username, row, col, message) {
  await assertActable(db, username); // Plan 023b: no incanting while bleeding out.
  const rest = commandRest(message, '/cast');
  if (!rest) {
    throw new ActionError('Use /cast <incantation> @target.');
  }
  const mention = rest.match(/@([A-Za-z0-9_-]+)/);
  const target = mention ? mention[1] : '';
  assertAction(target, 'Name a target: /cast <incantation> @who.', 400);
  const incantation = rest.replace(/@[A-Za-z0-9_-]+/g, '').replace(/\s+/g, ' ').trim();

  const actor = await getUser(db, username);
  const effectiveActor = getEffectiveUser(actor);
  const usable = await getUsableAbilityIds(db, username, effectiveActor);
  const abilityId = usable.find(id => {
    const ability = getAbility(id);
    return ability && ability.cost && ability.cost.linguistic;
  });
  assertAction(abilityId, 'You know no rites to cast.', 400);

  const actionTick = await getCurrentTickValue(db);
  return handleSkillAction(db, username, row, col, abilityId, target, actionTick, incantation);
}

export async function handleJobChangeAction(db, username, row, col, nextJob, roomUse) {
  await assertActable(db, username); // Plan 023b: the downed cannot change jobs.
  return runPlayerAction(db, {
    username,
    staminaCost: 1,
    validate: async () => {
      if (!roomHasEffect(row, col, roomUse.tickValue, 'guild', roomUse.worldDay)) {
        throw new ActionError('Job changes require a Guild room.', 403);
      }
      if (!Object.prototype.hasOwnProperty.call(JOBS, nextJob)) {
        throw new ActionError('Invalid job.');
      }
    },
    perform: async () => switchJob(db, { username, nextJob, row, col }),
    advanceTick: () => advanceTickOnly(db)
  });
}
