// Combat: hit resolution, attacks, abilities, affinities, hostile rooms & rolls (plan adv-005).
//
// Extracted verbatim from the original worker/game.mjs — a pure mechanical move.
// Cross-seam dependencies are now explicit imports; cycles between seams resolve
// through ESM live bindings (every cross-seam reference is call-time, never
// dereferenced at module load).

import {
  ActionError,
  CALLED_SHOT_HEAD_BONUS,
  CALLED_SHOT_HIT_PENALTY,
  DEFAULT_STANCE,
  PRESENCE_MAX_AGE_SECONDS,
  REVIVE_HEAL_AMOUNT,
  SPEED_HIT_BASE_CHANCE,
  SPEED_HIT_MAX_CHANCE,
  SPEED_HIT_MIN_CHANCE,
  SPEED_HIT_STEP,
  STANCES,
  assertAction,
  clampNumber,
  escapeRegExp,
  getAbility,
  getAttackTrace,
  getEffectiveUser,
  getPhaseFromTick,
  getTemplate,
  getWorldDay,
  normalizeStance,
  parseCalledShot
} from './shared.mjs';
import {
  changes,
  dbAll,
  dbFirst,
  dbRun,
  lastInsertId
} from '../db.mjs';
import { revivePlayer } from '../resurrection.mjs';
import {
  addStatusEffect,
  applyBodyDamage,
  applyBodyHeal,
  clearOneHarmfulEffect,
  damageUser,
  getConditionAndGearModifiers,
  healUser
} from './body.mjs';
import { descendTowardDeath } from './death.mjs';
import { getSocketedMateriaEffects } from './inventory.mjs';
import { createTrace, insertSystemMessage } from './messages.mjs';
import { provokeRoomNpcs } from './npc.mjs';
import { bumpRiteMastery, getUsableAbilityIds, upsertCooldown } from './progression.mjs';
import {
  advanceGlobalTick,
  getCurrentTickValue,
  getUser,
  resolveExpiredGamblingRounds,
  roomHasEffect
} from './world.mjs';


export function calculateSpeedHitChance(attacker, target, attackerMods = null, targetMods = null, { hitDelta = 0, dodgeDelta = 0 } = {}) {
  const effectiveAttacker = getEffectiveUser(attacker, attackerMods);
  const effectiveTarget = getEffectiveUser(target, targetMods);
  const speedDifference = effectiveAttacker.speed - effectiveTarget.speed;
  // hitDelta raises the attacker's chance; dodgeDelta lowers it (the defender
  // is harder to hit). Both fold in before the [0.25, 0.95] clamp. With both
  // deltas at 0 (the default — standing stance, no called shot) the result is
  // byte-identical to the original curve.
  const hitChance = clampNumber(
    SPEED_HIT_BASE_CHANCE + speedDifference * SPEED_HIT_STEP + hitDelta - dodgeDelta,
    SPEED_HIT_MIN_CHANCE,
    SPEED_HIT_MAX_CHANCE
  );

  return Math.round(hitChance * 100) / 100;
}

function rollSpeedContest(attacker, target, attackerMods = null, targetMods = null, options = {}) {
  const hitChance = calculateSpeedHitChance(attacker, target, attackerMods, targetMods, options);
  return {
    hit: Math.random() < hitChance,
    hitChance
  };
}

// --- Plan 020c: elemental affinities (model B — elements land STATUSES) --------
// A weapon's `element` tags a hit; on landing it applies the element's status to the
// struck part, magnitude scaled by the target's affinity there (worn armor +/− the
// room's mood). No element → the hook never runs → combat stays byte-identical.
const ELEMENT_STATUS = { fire: 'burn', cold: 'chill', shock: 'shock', holy: 'burn', dark: 'burn', poison: 'poison' };
const ELEMENT_ROOM = { fire: 'sun_room', cold: 'cold_room', dark: 'moon_room', poison: 'poison_marsh' };
const ELEMENT_BASE_MAGNITUDE = 2;
const ELEMENT_DURATION = 4;
const ROOM_ELEMENT_AMP = 0.5;

// Plan 021a: creature-level affinities (NPCs have no per-part armor; weak/resist is
// intrinsic to the beast). Keyed by displayName; absent = neutral.
const CREATURE_AFFINITY = {
  'Frost Wyrm': { fire: 0.5, cold: -0.5 },
  'Frost Thrall': { fire: 0.5, cold: -0.5 },
  'Ice Gnawer': { fire: 0.5, cold: -0.5 }
};
function getCreatureAffinity(displayName, element) {
  const map = CREATURE_AFFINITY[displayName] || {};
  return Number(map[element]) || 0;
}

// Plan 021b: a creature's elemental basic attack (chills/burns on hit) and its
// offensive ability kit (drawn from the 018 registry, invoked via runAbility).
// Keyed by displayName; absent = a plain physical brute with no kit.
const CREATURE_ELEMENT = { 'Frost Wyrm': 'cold', 'Frost Thrall': 'cold', 'Ice Gnawer': 'cold' };
const CREATURE_ABILITIES = {
  'Frost Wyrm': ['arcane_pin', 'power_strike'],
  'Restless Brute': ['power_strike']
};

// The element of a player's equipped weapon (first equipped item carrying one).
export async function getAttackElement(db, username) {
  const rows = await dbAll(db, 'SELECT templateId FROM items WHERE ownerUsername = ? AND equippedPartId IS NOT NULL', [username]);
  for (const row of rows) {
    const template = getTemplate(row.templateId);
    if (template && template.element) return template.element;
  }
  return null;
}

// Net affinity to `element` on the struck part: armor worn there (resist − / weak +)
// plus the room's amplification (which affects everyone present). 0 = neutral.
export async function getElementAffinity(db, username, element, partLabel, row, col, tickValue) {
  let affinity = 0;
  const rows = await dbAll(
    db,
    `SELECT i.id, i.templateId FROM items i
     LEFT JOIN bodyParts bp ON bp.id = i.equippedPartId
     WHERE i.ownerUsername = ? AND i.equippedPartId IS NOT NULL
       AND (? IS NULL OR bp.label = ?)`,
    [username, partLabel || null, partLabel || null]
  );
  const partItemIds = [];
  for (const r of rows) {
    partItemIds.push(r.id);
    const template = getTemplate(r.templateId);
    if (template && template.affinity && Number.isFinite(template.affinity[element])) {
      affinity += template.affinity[element];
    }
  }
  // Plan 020d: materia socketed into the armor on this part contribute affinity too.
  for (const effect of await getSocketedMateriaEffects(db, partItemIds)) {
    if (effect.kind === 'affinity' && effect.element === element) {
      affinity += effect.amount;
    }
  }
  const roomType = ELEMENT_ROOM[element];
  if (roomType && roomHasEffect(row, col, tickValue, roomType)) {
    affinity += ROOM_ELEMENT_AMP;
  }
  return affinity;
}

// Apply an elemental hit's status to the struck part, scaled by affinity. A part
// that resists hard enough (affinity ≤ −1) takes nothing.
export async function applyElementOnHit(db, { attacker, target, element, partLabel, row, col, currentTick, targetIsNpc = false, targetDisplayName = null }) {
  const statusType = ELEMENT_STATUS[element];
  if (!statusType) {
    return null;
  }
  // Plan 021a: NPCs have no per-part armor — their weak/resist is intrinsic (creature
  // affinity), plus the room's amplification. Players use per-part armor affinity.
  let affinity;
  if (targetIsNpc) {
    affinity = getCreatureAffinity(targetDisplayName, element);
    const roomType = ELEMENT_ROOM[element];
    if (roomType && roomHasEffect(row, col, currentTick, roomType)) {
      affinity += ROOM_ELEMENT_AMP;
    }
  } else {
    affinity = await getElementAffinity(db, target, element, partLabel, row, col, currentTick);
  }
  const magnitude = Math.round(ELEMENT_BASE_MAGNITUDE * (1 + affinity));
  if (magnitude <= 0) {
    return { element, status: statusType, resisted: true };
  }
  await addStatusEffect(db, {
    username: target,
    source: attacker,
    effectType: statusType,
    magnitude,
    currentTick,
    duration: ELEMENT_DURATION,
    row,
    col
  });
  return { element, status: statusType, magnitude };
}

export async function runHostileRoomAction(db, row, col) {
  const tick = await advanceGlobalTick(db);
  const worldDay = getWorldDay();
  const npc = await dbFirst(
    db,
    `SELECT u.*
     FROM users u
     JOIN roomPresence rp ON rp.username = u.username
     WHERE u.isNpc = 1
       AND u.health > 0
       AND (u.disposition IS NULL OR u.disposition = 'hostile')
       AND rp.roomRow = ?
       AND rp.roomCol = ?
       AND rp.worldDay = ?
     ORDER BY CASE u.npcKind WHEN 'raid_boss' THEN 0 ELSE 1 END, u.username ASC
     LIMIT 1`,
    [row, col, worldDay]
  );
  const player = await dbFirst(
    db,
    `SELECT u.*
     FROM users u
     JOIN roomPresence rp ON rp.username = u.username
     WHERE u.isNpc = 0
       AND (u.health > 0 OR u.incapacitated = 1)
       AND rp.roomRow = ?
       AND rp.roomCol = ?
       AND rp.worldDay = ?
       AND rp.lastSeenAt >= datetime('now', ?)
     ORDER BY rp.lastSeenAt DESC, u.username ASC
     LIMIT 1`,
    [row, col, worldDay, `-${PRESENCE_MAX_AGE_SECONDS} seconds`]
  );

  if (!npc || !player) {
    return { tick, acted: false };
  }

  // Plan 021b: a creature with an ability kit CASTS on alternating ticks — drawn
  // from the 018 registry and invoked via runAbility (the same resolver players use),
  // with a display-named actor so the messages read well. Other ticks fall through
  // to the basic attack below.
  const kit = CREATURE_ABILITIES[npc.displayName] || [];
  if (kit.length && tick.tick % 2 === 0) {
    const abilityId = kit[Math.floor(tick.tick / 2) % kit.length];
    const actorName = npc.displayName || npc.username;
    const effectiveActor = { ...getEffectiveUser(npc), username: actorName };
    try {
      await runAbility(db, abilityId, {
        username: actorName,
        effectiveActor,
        target: player.username,
        row,
        col,
        currentTick: tick.tick,
        phase: getPhaseFromTick(tick.tick)
      });
      return { tick, acted: true, target: player.username, cast: abilityId };
    } catch (err) {
      // Any ability error → fall through to a basic attack.
    }
  }

  const playerMods = await getConditionAndGearModifiers(db, player.username);
  // Only the defending PLAYER's stance applies against an NPC: dodgeBonus makes
  // them harder to hit, damageTakenDelta adjusts the blow. The NPC has no stance.
  const playerStance = STANCES[normalizeStance(player.stance)];
  const contest = rollSpeedContest(npc, player, null, playerMods, { dodgeDelta: playerStance.dodgeBonus });
  if (!contest.hit) {
    await insertSystemMessage(db, row, col, `${player.username} dodged ${npc.displayName || npc.username}.`, 'combat');
    return { tick, acted: true, missed: true };
  }

  const { damage: baseDamage, isCriticalAttack } = await calculateAttackDamage(db, npc, player.username, tick.tick, null);
  const damage = Math.max(0, baseDamage + playerStance.damageTakenDelta);
  const damageResult = await applyBodyDamage(db, player, damage, {
    cause: `attack by ${npc.displayName || npc.username}`,
    row,
    col
  });
  const hitText = isCriticalAttack ? 'critically hits' : 'attacks';
  await insertSystemMessage(db, row, col, `${npc.displayName || npc.username} ${hitText} ${player.username} for ${damage} damage.`, 'combat');

  // Plan 021b: a creature's elemental bite lands its element's status on the player.
  if (!damageResult.died) {
    const element = CREATURE_ELEMENT[npc.displayName];
    if (element) {
      await applyElementOnHit(db, {
        attacker: npc.displayName || npc.username,
        target: player.username,
        element,
        partLabel: null,
        row,
        col,
        currentTick: tick.tick
      });
    }
  }

  if (damageResult.died) {
    // Plan 023b: a creature's killing bite downs the player (or finishes a downed one).
    await descendTowardDeath(db, player.username, {
      cause: `attack by ${npc.displayName || npc.username}`,
      row,
      col,
      blowDamage: damage,
      overkill: damageResult.overkill || 0,
      currentTick: tick.tick
    });
  }

  return { tick, acted: true, target: player.username, damage };
}

function parseRollCommand(message) {
  const match = message.trim().match(/^\/roll\s+(\d+)$/i);
  return match ? Number.parseInt(match[1], 10) : null;
}

export async function validateRollCommand(db, username, row, col, message) {
  const wager = parseRollCommand(message);
  if (!wager || wager < 1) {
    throw new ActionError('Use /roll <gold> with a positive wager.');
  }

  const worldDay = getWorldDay();
  const tickValue = await getCurrentTickValue(db);
  assertAction(roomHasEffect(row, col, tickValue, 'gambling_den', worldDay), '/roll can only be used in a gambling den.');

  const user = await getUser(db, username);
  assertAction(user.gold >= wager, 'Not enough gold for that wager.');

  const existingRound = await dbFirst(
    db,
    `SELECT *
     FROM gamblingRounds
     WHERE roomRow = ?
       AND roomCol = ?
       AND worldDay = ?
       AND status = 'open'
       AND endTick >= ?
     ORDER BY startTick ASC
     LIMIT 1`,
    [row, col, worldDay, tickValue]
  );

  const existingEntry = existingRound
    ? await dbFirst(db, 'SELECT id FROM gamblingEntries WHERE roundId = ? AND username = ?', [existingRound.id, username])
    : null;

  assertAction(!existingEntry, 'You have already entered this dice round.');
  return { wager, tickValue, worldDay };
}

export async function handleRollCommand(db, username, row, col, message) {
  const { wager, tickValue, worldDay } = await validateRollCommand(db, username, row, col, message);
  await resolveExpiredGamblingRounds(db, tickValue);
  let round = await dbFirst(
    db,
    `SELECT *
     FROM gamblingRounds
     WHERE roomRow = ?
       AND roomCol = ?
       AND worldDay = ?
       AND status = 'open'
       AND endTick >= ?
     ORDER BY startTick ASC
     LIMIT 1`,
    [row, col, worldDay, tickValue]
  );

  if (!round) {
    const created = await dbRun(
      db,
      `INSERT INTO gamblingRounds
        (roomRow, roomCol, worldDay, startTick, endTick, status, pool)
       VALUES (?, ?, ?, ?, ?, 'open', 0)`,
      [row, col, worldDay, tickValue, tickValue + 10]
    );
    round = {
      id: lastInsertId(created),
      roomRow: row,
      roomCol: col,
      worldDay,
      startTick: tickValue,
      endTick: tickValue + 10,
      status: 'open',
      pool: 0
    };
  }

  const roll = Math.floor(Math.random() * 20) + 1;
  const goldUpdate = await dbRun(
    db,
    'UPDATE users SET gold = gold - ? WHERE username = ? AND gold >= ?',
    [wager, username, wager]
  );
  assertAction(changes(goldUpdate) > 0, 'Not enough gold for that wager.');

  try {
    await dbRun(
      db,
      `INSERT INTO gamblingEntries
        (roundId, username, wager, roll, enteredTick)
       VALUES (?, ?, ?, ?, ?)`,
      [round.id, username, wager, roll, tickValue]
    );
  } catch (err) {
    await dbRun(db, 'UPDATE users SET gold = gold + ? WHERE username = ?', [wager, username]);
    throw err;
  }

  await dbRun(db, 'UPDATE gamblingRounds SET pool = pool + ? WHERE id = ?', [wager, round.id]);
  const systemMessage = `${username} enters the dice round with ${wager} gold and rolls ${roll}. The round closes at tick ${round.endTick}.`;
  await insertSystemMessage(db, row, col, systemMessage, 'dice');

  return {
    wager,
    roll,
    roundId: round.id,
    endTick: round.endTick,
    systemMessage
  };
}

async function consumeStatusModifier(db, targetUsername, effectType, currentTick) {
  const effect = await dbFirst(
    db,
    `SELECT id, magnitude
     FROM statusEffects
     WHERE username = ?
       AND effectType = ?
       AND expiryTick > ?
     ORDER BY expiryTick ASC, id ASC
     LIMIT 1`,
    [targetUsername, effectType, currentTick]
  );

  if (!effect) {
    return 0;
  }

  await dbRun(db, 'DELETE FROM statusEffects WHERE id = ?', [effect.id]);
  return effect.magnitude || 0;
}

async function calculateAttackDamage(db, attacker, targetUsername, currentTick, attackerMods = null) {
  const effectiveAttacker = getEffectiveUser(attacker, attackerMods);
  const isCriticalAttack = Math.random() < 0.01;
  const markedBonus = await consumeStatusModifier(db, targetUsername, 'marked', currentTick);
  const wardReduction = await consumeStatusModifier(db, targetUsername, 'ward', currentTick);
  const baseDamage = 1 + Math.floor(effectiveAttacker.strength / 4);
  const criticalDamage = isCriticalAttack ? baseDamage + 1 : baseDamage;
  const damage = Math.max(0, criticalDamage + markedBonus - wardReduction);

  return { damage, isCriticalAttack };
}

export async function validateAttackTargets(db, message, row, col, attackerUsername) {
  const worldDay = getWorldDay();
  const occupants = await dbAll(
    db,
    `SELECT u.username, COALESCE(u.displayName, u.username) AS displayName
     FROM roomPresence rp
     JOIN users u ON u.username = rp.username
     WHERE rp.roomRow = ?
       AND rp.roomCol = ?
       AND rp.worldDay = ?
       AND rp.username != 'System'
       AND (u.isNpc = 1 OR rp.lastSeenAt >= datetime('now', ?))`,
    [row, col, worldDay, `-${PRESENCE_MAX_AGE_SECONDS} seconds`]
  );
  // Plan 013e: self-attack is allowed when explicitly named (or @self / @me). Put the
  // attacker in the pool so naming yourself resolves; everyone else stays a normal target.
  const attacker = await dbFirst(db, 'SELECT username, COALESCE(displayName, username) AS displayName FROM users WHERE username = ?', [attackerUsername]);
  const pool = attacker
    ? [...occupants.filter(o => o.username !== attackerUsername), attacker]
    : occupants;

  const mentioned = [...message.matchAll(/@([A-Za-z0-9_-]+)/g)].map(m => m[1].toLowerCase());
  const selfNamed = mentioned.includes('self') || mentioned.includes('me');
  // Plan 013e: match by displayName (what players SEE) as well as username — social NPC
  // usernames are unmentionable ids like "soc:..:clerk:0", so naming them needs the display
  // name. Whole-name boundaries (not raw substring) so "moss" doesn't match "mossy".
  const matchesName = (name) => {
    const n = String(name || '').toLowerCase();
    if (n.length < 2) {
      return false;
    }
    return new RegExp(`(^|[^a-z0-9_-])${escapeRegExp(n)}([^a-z0-9_-]|$)`, 'i').test(message);
  };

  const matches = pool.filter(target => {
    if (selfNamed && target.username === attackerUsername) {
      return true;
    }
    const uname = String(target.username).toLowerCase();
    const dname = String(target.displayName).toLowerCase();
    if (mentioned.includes(uname) || mentioned.includes(dname)) {
      return true;
    }
    return matchesName(dname) || matchesName(uname);
  });
  const targets = [...new Map(matches.map(target => [target.username, target])).values()];
  if (targets.length === 0) {
    // A specific @mention that matched no one => that target isn't here; otherwise the
    // player simply named no one.
    if (mentioned.length > 0) {
      throw new ActionError('No such target here.');
    }
    throw new ActionError("Attack needs a target name (the NPC's name, or @self).");
  }
  return targets;
}

export async function handleAttack(db, username, message, row, col, options = {}) {
  const currentTick = await getCurrentTickValue(db);
  const createdTick = currentTick + 1;
  const worldDay = getWorldDay();
  const attacker = await getUser(db, username);
  const targets = await validateAttackTargets(db, message, row, col, username);
  const attackMessages = [];

  const attackerMods = attacker.isNpc ? null : await getConditionAndGearModifiers(db, username);

  // Stance and called shot are attacker-message-level (apply to every target in
  // this attack). NPCs have no parts, so a called shot only routes at player
  // targets; against NPCs it's ignored. standing/no-aim => deltas are all zero,
  // so every existing combat number is unchanged.
  const attackerStance = STANCES[normalizeStance(attacker.stance)];
  // Plan 024: the targeting toolbar can name an aimed part out-of-band (options.targetPart)
  // so the limb never has to ride in the chat prose. Normalized through the same
  // parseCalledShot matcher so 'left_arm'/'Head' resolve to canonical labels; when
  // absent we fall back to the part named in the message, so typed called shots and
  // every existing combat test stay byte-identical.
  const aimedPart = options.targetPart ? parseCalledShot(options.targetPart) : null;

  for (const user of targets) {
    const target = await getUser(db, user.username, 'Target');
    const targetMods = target.isNpc ? null : await getConditionAndGearModifiers(db, target.username);
    const calledShot = target.isNpc ? null : (aimedPart || parseCalledShot(message));
    const targetStance = target.isNpc ? STANCES[DEFAULT_STANCE] : STANCES[normalizeStance(target.stance)];

    // Contest deltas: attacker stance hitBonus and (when aiming) the called-shot
    // accuracy penalty raise/lower the attacker; defender stance dodgeBonus
    // makes the defender harder to hit. Folded in before the [0.25, 0.95] clamp.
    let hitDelta = attackerStance.hitBonus;
    if (calledShot) {
      hitDelta -= CALLED_SHOT_HIT_PENALTY;
    }
    const dodgeDelta = targetStance.dodgeBonus;

    const speedContest = rollSpeedContest(attacker, target, attackerMods, targetMods, { hitDelta, dodgeDelta });
    // Plan 013e fix: NPC usernames are opaque ids (soc:..:barmaid:1) — combat lines must
    // read by display name. Players have none, so displayName falls back to username.
    const targetName = user.displayName || user.username;
    if (!speedContest.hit) {
      attackMessages.push(`${targetName} dodged ${username}'s attack`);
      continue;
    }

    const { damage: baseDamage, isCriticalAttack } = await calculateAttackDamage(db, attacker, user.username, createdTick, attackerMods);
    // Damage modifiers: aimed head bonus, attacker stance damageBonus, and the
    // defender's stance damageTakenDelta. Floor at 0. standing => all zero.
    const headBonus = calledShot === 'head' ? CALLED_SHOT_HEAD_BONUS : 0;
    const damage = Math.max(0, baseDamage + headBonus + attackerStance.damageBonus + targetStance.damageTakenDelta);
    const damageResult = await applyBodyDamage(db, target, damage, {
      cause: `attack by ${username}`,
      row,
      col,
      targetLabel: calledShot
    });

    const attackedUser = await dbFirst(db, 'SELECT * FROM users WHERE username = ?', [user.username]);
    const remainingHealth = attackedUser ? attackedUser.health : 0;
    const wasKilled = damageResult.died;
    const attackMessage = isCriticalAttack
      ? `${username} landed a critical hit on ${targetName} for ${damage} damage!`
      : `${username} attacked ${targetName} for ${damage} damage`;

    attackMessages.push(attackMessage);

    // Plan 020c/021a: if the attacker's weapon is elemental and the target survived,
    // the hit lands the element's status — on a player's struck part (per-part armor
    // affinity) or on an NPC (intrinsic creature affinity). No element → skipped →
    // combat is byte-identical.
    if (!wasKilled) {
      const element = await getAttackElement(db, username);
      if (element) {
        const applied = await applyElementOnHit(db, {
          attacker: username,
          target: user.username,
          element,
          partLabel: calledShot,
          row,
          col,
          currentTick: createdTick,
          targetIsNpc: Boolean(target.isNpc),
          targetDisplayName: target.displayName || null
        });
        if (applied && applied.status && !applied.resisted) {
          attackMessages.push(`${targetName} suffers ${applied.status} (${applied.magnitude})`);
        }
      }
    }

    const trace = getAttackTrace({
      row,
      col,
      attacker: username,
      target: user.username,
      damage,
      isCritical: isCriticalAttack,
      remainingHealth,
      wasKilled,
      createdTick,
      worldDay
    });

    if (wasKilled) {
      // Plan 013g: players AND NPCs descend through the same band — the blow downs them
      // (begging, bleeding); a finishing blow or a gib ends them. descendTowardDeath routes
      // an NPC's true death to defeatNpc and a player's to the grave.
      await descendTowardDeath(db, user.username, {
        cause: `attack by ${username}`,
        row,
        col,
        blowDamage: damage,
        overkill: damageResult.overkill || 0,
        currentTick: createdTick,
        deferredSystemMessages: options.deferredSystemMessages
      });
    }

    await createTrace(db, trace);

    // Plan 013c: striking a non-hostile NPC turns it — and the rest of the room's social
    // cast — hostile. The attack route's startHostileLoopIfNeeded (after this resolves)
    // then wakes the fight, so the whole pub comes for you.
    if (attackedUser.isNpc && attackedUser.disposition && attackedUser.disposition !== 'hostile') {
      await provokeRoomNpcs(db, row, col, { deferredSystemMessages: options.deferredSystemMessages });
    }
  }

  return `${message} (${attackMessages.join(', ')})`;
}

function getSkillTarget(invoker, targetUsername) {
  return targetUsername && targetUsername.trim() ? targetUsername.trim() : invoker;
}

export async function validateClassSkillUse(db, { username, skillId, targetUsername }) {
  const actor = await getUser(db, username);
  const effectiveActor = getEffectiveUser(actor);
  const ability = getAbility(skillId);
  const usableIds = await getUsableAbilityIds(db, username, effectiveActor);

  if (!ability || !usableIds.includes(skillId)) {
    throw new ActionError(`${effectiveActor.job} cannot use that skill.`);
  }

  // Only abilities that aim at someone else validate a target. 'none' (room/no
  // target) and 'self' resolve to the actor and need no lookup.
  const target = getSkillTarget(username, targetUsername);
  if ((ability.target === 'ally' || ability.target === 'enemy') && target) {
    await getUser(db, target, 'Target');
  }

  return { actor, effectiveActor, target, ability };
}

async function tryHarmfulSkillHit(db, { effectiveActor, target, skillLabel, row, col }) {
  const targetUser = await getUser(db, target, 'Target');
  const speedContest = rollSpeedContest(effectiveActor, targetUser);
  if (speedContest.hit) {
    return true;
  }

  const message = `${target} dodged ${effectiveActor.username}'s ${skillLabel}.`;
  await insertSystemMessage(db, row, col, message, 'combat');
  return false;
}

export async function useClassSkill(db, { username, skillId, targetUsername, row, col, currentTick, phase, incantation = '', rank = 0 }) {
  const { effectiveActor, target } = await validateClassSkillUse(db, { username, skillId, targetUsername });
  // isPlayerCast = true: this is the player-invoked path (the only caller of
  // useClassSkill). It authorizes the rite-mastery + cooldown writes in runAbility,
  // which must NEVER fire for an NPC caster (whose username is an opaque id).
  return runAbility(db, skillId, { username, effectiveActor, target, row, col, currentTick, phase, incantation, rank, isPlayerCast: true });
}

// Plan 012 (tail): stamp the per-ability rite cooldown on the same rail /regrow
// uses — effectType 'rite:<abilityId>', pseudo-room (0,0) (rooms are 1-indexed so
// 0,0 never collides), keyed by worldDay. The gate that READS this lives in
// handleSkillAction's validate (before stamina is spent). Player-only — the caller
// guards on isPlayerCast.
export const RITE_COOLDOWN_EFFECT_PREFIX = 'rite:';

async function stampRiteCooldown(db, username, abilityId, currentTick) {
  await upsertCooldown(db, username, 0, 0, RITE_COOLDOWN_EFFECT_PREFIX + abilityId, currentTick, getWorldDay());
}

// The ability resolver: behavior keyed by ability id, callable by any invoker (a
// player class skill today; an equipped item or an NPC tomorrow — plans 018c/021).
// Behavior parity with the per-class switch it replaced: identical formulas,
// messages, and message kinds. Validation and targeting happen in the caller.
export async function runAbility(db, abilityId, { username, effectiveActor, target, row, col, currentTick, phase, incantation = '', rank = 0, isPlayerCast = false }) {
  switch (abilityId) {
    case 'scrounge': {
      const gold = 1 + Math.max(1, Math.floor(effectiveActor.intelligence / 2));
      await dbRun(db, 'UPDATE users SET gold = gold + ? WHERE username = ?', [gold, username]);
      const message = `${username} scrounges up ${gold} gold.`;
      await insertSystemMessage(db, row, col, message, 'skill');
      return { message };
    }
    case 'ward': {
      await addStatusEffect(db, {
        username: target,
        source: username,
        effectType: 'ward',
        magnitude: 2,
        currentTick,
        duration: 5,
        row,
        col
      });
      const message = `${username} wards ${target} for 5 ticks.`;
      await insertSystemMessage(db, row, col, message, 'support');
      return { message };
    }
    case 'power_strike': {
      const hit = await tryHarmfulSkillHit(db, {
        effectiveActor,
        target,
        skillLabel: 'Power Strike',
        row,
        col
      });
      if (!hit) {
        return { message: `${target} dodged ${username}'s Power Strike.`, missed: true };
      }

      const marked = await dbFirst(
        db,
        'SELECT id, magnitude FROM statusEffects WHERE username = ? AND effectType = ? AND expiryTick > ? ORDER BY expiryTick ASC LIMIT 1',
        [target, 'marked', currentTick]
      );
      const ward = await dbFirst(
        db,
        'SELECT id, magnitude FROM statusEffects WHERE username = ? AND effectType = ? AND expiryTick > ? ORDER BY expiryTick ASC LIMIT 1',
        [target, 'ward', currentTick]
      );
      let damage = 1 + Math.floor(effectiveActor.strength / 2);
      if (marked) {
        damage += marked.magnitude;
        await dbRun(db, 'DELETE FROM statusEffects WHERE id = ?', [marked.id]);
      }
      if (ward) {
        damage = Math.max(0, damage - ward.magnitude);
        await dbRun(db, 'DELETE FROM statusEffects WHERE id = ?', [ward.id]);
      }
      const result = damage > 0
        ? await damageUser(db, target, damage, `power strike by ${username}`, row, col)
        : { killed: false, remainingHealth: null };
      const message = `${username} power strikes ${target} for ${damage} damage.`;
      await insertSystemMessage(db, row, col, message, 'skill');
      return { message, damage, ...result };
    }
    case 'dose': {
      if (phase === 'Night') {
        const hit = await tryHarmfulSkillHit(db, {
          effectiveActor,
          target,
          skillLabel: 'Dose',
          row,
          col
        });
        if (!hit) {
          return { message: `${target} dodged ${username}'s Dose.`, missed: true };
        }

        await addStatusEffect(db, {
          username: target,
          source: username,
          effectType: 'poison',
          magnitude: 1,
          currentTick,
          duration: 5,
          row,
          col
        });
        const message = `${username} doses ${target} with something bitter.`;
        await insertSystemMessage(db, row, col, message, 'skill');
        return { message };
      }

      const amount = 2 + Math.floor(effectiveActor.intelligence / 4);
      await healUser(db, target, amount, row, col);
      const message = `${username} patches up ${target} for ${amount} health.`;
      await insertSystemMessage(db, row, col, message, 'support');
      return { message };
    }
    case 'survey': {
      await createTrace(db, {
        row,
        col,
        traceType: 'survey',
        intensity: 1,
        attacker: username,
        target: `Room ${row}, ${col}`,
        createdTick: currentTick + 1,
        expiryTick: currentTick + 20,
        worldDay: getWorldDay()
      });
      await dbRun(db, 'UPDATE users SET gold = gold + 1 WHERE username = ?', [username]);
      const message = `${username} surveys the room and finds 1 gold.`;
      await insertSystemMessage(db, row, col, message, 'skill');
      return { message };
    }
    case 'arcane_pin': {
      const hit = await tryHarmfulSkillHit(db, {
        effectiveActor,
        target,
        skillLabel: 'Arcane Pin',
        row,
        col
      });
      if (!hit) {
        return { message: `${target} dodged ${username}'s Arcane Pin.`, missed: true };
      }

      await addStatusEffect(db, {
        username: target,
        source: username,
        effectType: 'arcane_pin',
        magnitude: 2,
        currentTick,
        duration: 4,
        row,
        col
      });
      const message = `${username} pins ${target} with a humming spell.`;
      await insertSystemMessage(db, row, col, message, 'skill');
      return { message };
    }
    case 'mark': {
      const hit = await tryHarmfulSkillHit(db, {
        effectiveActor,
        target,
        skillLabel: 'Mark',
        row,
        col
      });
      if (!hit) {
        return { message: `${target} dodged ${username}'s Mark.`, missed: true };
      }

      await addStatusEffect(db, {
        username: target,
        source: username,
        effectType: 'marked',
        magnitude: 2,
        currentTick,
        duration: 6,
        row,
        col
      });
      const message = `${username} marks ${target}.`;
      await insertSystemMessage(db, row, col, message, 'skill');
      return { message };
    }
    case 'bless': {
      const cleared = await clearOneHarmfulEffect(db, target);
      await addStatusEffect(db, {
        username: target,
        source: username,
        effectType: 'bless',
        magnitude: 1,
        currentTick,
        duration: 5,
        row,
        col
      });
      const message = cleared
        ? `${username} blesses ${target} and clears a harmful effect.`
        : `${username} blesses ${target}.`;
      await insertSystemMessage(db, row, col, message, 'support');
      return { message };
    }
    case 'brace': {
      // Self only — ward the actor regardless of any selected target.
      await addStatusEffect(db, {
        username,
        source: username,
        effectType: 'ward',
        magnitude: 1,
        currentTick,
        duration: 3,
        row,
        col
      });
      const message = `${username} braces, warding themselves for 3 ticks.`;
      await insertSystemMessage(db, row, col, message, 'support');
      return { message };
    }
    case 'revive': {
      assertAction(target && target !== username, 'Name the fallen ally to revive.', 400);
      // Plan 023d: the Cleric's real-time window. If the ally is DOWNED (incapacitated)
      // and still here, lift them — no corpse needed, they aren't dead yet. Healing
      // above 0 trips reviveFromIncapacitation, standing them back up. This is the free
      // in-game path; Stripe (createResurrectionCheckout) stays the post-DEATH, corpse-
      // gated path, so the two no longer overlap.
      const downed = await dbFirst(
        db,
        `SELECT u.username FROM users u
         JOIN roomPresence rp ON rp.username = u.username
         WHERE u.username = ? AND u.incapacitated = 1 AND rp.roomRow = ? AND rp.roomCol = ?`,
        [target, row, col]
      );
      if (downed) {
        const downedUser = await getUser(db, target, 'Target');
        await applyBodyHeal(db, downedUser, REVIVE_HEAL_AMOUNT, { row, col });
        const message = `${username} pulls ${target} back from the brink!`;
        await insertSystemMessage(db, row, col, message, 'support');
        return { message, revived: target, fromBrink: true };
      }
      // Plan 011: otherwise, raise a truly-dead ally whose corpse (the 022c anchor)
      // lies in this room; revivePlayer restores them from the grave and consumes it.
      const corpse = await dbFirst(
        db,
        'SELECT id FROM items WHERE corpseOf = ? AND roomRow = ? AND roomCol = ?',
        [target, row, col]
      );
      assertAction(corpse, `There is no corpse of ${target} here to revive.`, 404);
      const result = await revivePlayer(db, target, row, col);
      assertAction(result.revived, `${target} cannot be revived — their grave is gone.`, 400);
      const message = `${username} revives ${target}!`;
      await insertSystemMessage(db, row, col, message, 'support');
      return { message, revived: target };
    }
    case 'word_bolt': {
      // Plan 012: the rite's power scales with the incantation's word count (its
      // stamina cost already scaled, in handleSkillAction). Language as mechanics.
      // Plan 012 (tail): mastery adds rank to the damage and lifts the word cap;
      // the per-ability cooldown is stamped once the rite FIRES (hit or miss — the
      // gathering is spent either way), and mastery accrues only on a LANDED cast.
      // Both writes are PLAYER-ONLY (isPlayerCast) — an NPC casting this would never
      // touch the cooldown or mastery tables under its opaque username.
      const hit = await tryHarmfulSkillHit(db, { effectiveActor, target, skillLabel: 'Word Bolt', row, col });
      if (isPlayerCast) {
        await stampRiteCooldown(db, username, abilityId, currentTick);
      }
      if (!hit) {
        return { message: `${target} dodged ${username}'s Word Bolt.`, missed: true };
      }
      const words = String(incantation || '').trim().split(/\s+/).filter(Boolean).length;
      const masteryRank = Math.max(0, Math.floor(Number(rank) || 0));
      const damage = 2 + words + masteryRank;
      const result = await damageUser(db, target, damage, `word bolt by ${username}`, row, col);
      if (isPlayerCast) {
        await bumpRiteMastery(db, username, abilityId);
      }
      // Mastery surfaces MINIMALLY — folded into the existing rite line only.
      const rankTag = masteryRank > 0 ? ` (rank ${masteryRank})` : '';
      const message = words > 0
        ? `${username} incants a ${words}-word bolt at ${target} for ${damage} damage${rankTag}.`
        : `${username} sputters a wordless bolt at ${target} for ${damage} damage${rankTag}.`;
      await insertSystemMessage(db, row, col, message, 'rite');
      return { message, damage, words, rank: masteryRank, ...result };
    }
    default:
      throw new ActionError('Unknown skill.');
  }
}
