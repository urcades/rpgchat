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
  baseCreatureName,
  buildAffixRoll,
  clampNumber,
  describeAttack,
  describeSelfMiss,
  escapeRegExp,
  getAbility,
  getActiveAbilitiesForJob,
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
  dbBatch,
  dbFirst,
  dbRun
} from '../db.mjs';
import { revivePlayer } from '../resurrection.mjs';
import {
  addStatusEffect,
  applyBodyDamage,
  applyBodyHeal,
  clearOneHarmfulEffect,
  damageUser,
  ensureBody,
  getConditionAndGearModifiers,
  healUser
} from './body.mjs';
import { descendTowardDeath } from './death.mjs';
import { getSocketedMateriaEffects } from './inventory.mjs';
import { createTrace, insertSystemMessage } from './messages.mjs';
import { provokeRoomNpcs } from './npc.mjs';
import { bumpRiteMastery, getUsableAbilityIds, upsertCooldown } from './progression.mjs';
import {
  advanceTickAndMaybeSweep,
  getCurrentTickValue,
  getRoomPresence,
  getUser,
  resolveExpiredGamblingRounds,
  roomHasEffect
} from './world.mjs';


// A deterministic, SELF-CONTAINED RNG for the cosmetic attack-flavor pick. It is
// seeded from the blow's stable fields (attacker, target, tick, damage) so the verb/
// part-noun choice varies attack-to-attack in production, yet is fully reproducible.
// Crucially it draws from its OWN stream — NOT the global Math.random the combat
// resolver uses — so injecting it into describeAttack consumes ZERO draws from the
// mocked Math.random sequence every combat test seeds, leaving RNG order byte-stable.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function flavorRandom(parts) {
  const s = parts.join('|');
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return mulberry32(h >>> 0);
}

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
  // Plan 021: resolve by BASE name so an elite ("Vicious Frost Wyrm") keeps the base
  // creature's intrinsic affinity (fire-weak/cold-resistant), not neutral.
  const map = CREATURE_AFFINITY[baseCreatureName(displayName)] || CREATURE_AFFINITY[displayName] || {};
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

// Parse a stored affixes JSON column to a string[] of affix names (defensive; [] on junk).
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

// The element a creature's basic bite lands. Plan 021: a base-name lookup (so an elite
// keeps its kind's element), OVERRIDDEN by a Rending affix's intrinsic element if rolled.
// Null → a plain physical bite (no status), exactly as before for an unmapped creature.
function creatureElementFor(npc) {
  const affixElement = buildAffixRoll(parseAffixNames(npc.affixes)).element;
  if (affixElement) {
    return affixElement;
  }
  return CREATURE_ELEMENT[baseCreatureName(npc.displayName)] || CREATURE_ELEMENT[npc.displayName] || null;
}

// adv-006: ONE read of a user's equipped item rows (id, templateId), shared by the
// attacker-side derivations below. getAttackElement and getWeaponClass each used to run
// this exact SELECT, and handleAttack re-ran the element scan once per target — so an
// attack on N targets scanned the attacker's items 1 (weaponClass) + N (element) times.
// Fetching once and deriving element + weaponClass from the SAME rows collapses that to a
// single scan, with byte-identical results (same query, same row order, same lookups).
export async function getEquippedItems(db, username) {
  return dbAll(db, 'SELECT id, templateId FROM items WHERE ownerUsername = ? AND equippedPartId IS NOT NULL', [username]);
}

// The element of a player's equipped weapon (first equipped item carrying one), derived
// from pre-fetched equipped rows. Order-preserving: rows arrive in the SELECT's order, so
// "first equipped item carrying an element" is unchanged from the per-query version.
function deriveAttackElement(rows) {
  for (const row of rows) {
    const template = getTemplate(row.templateId);
    if (template && template.element) return template.element;
  }
  return null;
}

// The equipped HAND weapon's flavor identity derived from pre-fetched equipped rows: its
// template weaponClass (the brutal verb SET) plus its templateId (the per-weapon SIGNATURE
// pool, when one exists). Defaults to { weaponClass: 'fist', weaponId: null } unarmed.
function deriveWeaponClass(rows) {
  for (const row of rows) {
    const template = getTemplate(row.templateId);
    if (template && template.slotType === 'hand' && template.weaponClass) {
      return { weaponClass: template.weaponClass, weaponId: row.templateId };
    }
  }
  return { weaponClass: 'fist', weaponId: null };
}

// The element of a player's equipped weapon (first equipped item carrying one).
// Thin wrapper over the shared fetch + derivation, kept for external callers/tests.
export async function getAttackElement(db, username) {
  return deriveAttackElement(await getEquippedItems(db, username));
}

// The equipped HAND weapon's flavor identity: its template weaponClass (the brutal
// verb SET) plus its templateId (the per-weapon SIGNATURE pool, when one exists).
// Mirrors getAttackElement but scoped to the 'hand' slot. Defaults to
// { weaponClass: 'fist', weaponId: null } when nothing is wielded.
export async function getWeaponClass(db, username) {
  return deriveWeaponClass(await getEquippedItems(db, username));
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

// Campaign B (013 tail): a hostile NPC's offensive ability kit. Three pure guards
// decide it; the engine — never a name — owns targeting, so a flipped social NPC can
// threaten with its job abilities but can NEVER turn a beneficial one on the player.

// Whether a hostile may use this ability AT ALL. The "scarier support" set: a hostile
// is allowed self-buffs, ally buffs/heals, and offensive abilities — but NEVER a
// 'corpse'-target (a hostile must never `revive`). Default-deny: unknown targets out.
export function isHostileUsable(ability) {
  if (!ability) {
    return false;
  }
  if (ability.kind === 'passive') {
    return false;
  }
  return ability.target === 'enemy' || ability.target === 'self' || ability.target === 'none' || ability.target === 'ally';
}

// The kit a hostile NPC draws from. 021 monsters are UNCHANGED — a non-empty
// CREATURE_ABILITIES entry (keyed by displayName) takes precedence and is returned
// byte-identical (an array of ability ids). Otherwise derive from the NPC's JOB: every
// active ability the job grants, filtered to the hostile-usable set. A jobless / unkitted
// NPC yields [] → the caller falls to basic attacks.
export function getHostileKit(npc) {
  // Plan 021: an elite's displayName is prefixed ("Vicious Frost Wyrm"); resolve the kit
  // by BASE name so it keeps the base creature's CREATURE_ABILITIES.
  const creatureKit = CREATURE_ABILITIES[baseCreatureName(npc.displayName)] || CREATURE_ABILITIES[npc.displayName];
  if (creatureKit && creatureKit.length) {
    return creatureKit;
  }
  return getActiveAbilitiesForJob(npc.job)
    .filter(isHostileUsable)
    .map(ability => ability.id);
}

// THE hard safety guard. The ability's declared `target` — set by the ENGINE in the
// 018 registry, never inferred from a name — decides who a hostile cast lands on:
//   enemy → the player (the only path that EVER returns the player)
//   self  → the casting NPC
//   ally  → the most-wounded OTHER hostile NPC in the room, else the caster itself
//           (NEVER the player — a hostile heal/buff can never benefit you)
//   none  → the caster (the resolver is ignored by the behavior)
//   anything else → null → the caller SKIPS the cast (default-deny).
// INVARIANT: a non-'enemy' ability can NEVER resolve onto the player.
export function resolveHostileTarget(ability, npc, player, alliedHostiles = []) {
  if (!ability) {
    return null;
  }
  switch (ability.target) {
    case 'enemy':
      return player.username;
    case 'self':
    case 'none':
      return npc.username;
    case 'ally': {
      const candidates = (alliedHostiles || []).filter(a => a && a.username !== npc.username);
      if (candidates.length === 0) {
        return npc.username;
      }
      // Most-wounded first (lowest health), so a hostile cleric's heal goes where it
      // helps the mob most; ties are stable by username for determinism.
      const mostWounded = candidates
        .slice()
        .sort((a, b) => (Number(a.health) || 0) - (Number(b.health) || 0) || String(a.username).localeCompare(String(b.username)))[0];
      return mostWounded.username;
    }
    default:
      return null;
  }
}

// The allied hostiles a caster may buff/heal: every OTHER NPC sharing the room that is
// itself hostile and still standing. Used by resolveHostileTarget for 'ally' abilities —
// the player is never in this set, so an 'ally' cast can never touch them.
async function getAlliedHostiles(db, row, col, casterUsername) {
  const worldDay = getWorldDay();
  const presence = await getRoomPresence(db, row, col, worldDay);
  return presence
    .filter(p => p.isNpc
      && p.username !== casterUsername
      && (p.disposition === null || p.disposition === undefined || p.disposition === 'hostile')
      && !p.incapacitated)
    .map(p => ({ username: p.username, health: Number(p.health) }));
}

export async function runHostileRoomAction(db, row, col) {
  // adv-013: the per-5s hostile-room alarm advances the tick (so the combat cadence and NPC
  // turn parity are preserved exactly), then runs the global sweeps ONLY if it is the first
  // driver in this tick-window. With K hostile rooms, this collapses ~5K world scans/window
  // down to one — the sweeps still fire on the 5s combat cadence, just once, not K×.
  const tick = await advanceTickAndMaybeSweep(db);
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

  // Plan 021b + Campaign B (013 tail): a hostile with an ability kit CASTS on alternating
  // ticks — drawn from the 018 registry and invoked via runAbility (the same resolver
  // players use), with a display-named actor so the messages read well. 021 monsters keep
  // their CREATURE_ABILITIES kit byte-identical; a flipped social NPC derives its kit from
  // its JOB (getHostileKit). Targeting is decided by the ENGINE via ability.target
  // (resolveHostileTarget), never by name — so a non-'enemy' ability can NEVER land on the
  // player (a hostile cleric heals/buffs itself or an allied hostile, throws offense at you,
  // but never benefits you). Other ticks fall through to the basic attack below.
  const kit = getHostileKit(npc);
  if (kit.length && tick.tick % 2 === 0) {
    const abilityId = kit[Math.floor(tick.tick / 2) % kit.length];
    const ability = getAbility(abilityId);
    const alliedHostiles = ability && ability.target === 'ally'
      ? await getAlliedHostiles(db, row, col, npc.username)
      : [];
    const target = resolveHostileTarget(ability, npc, player, alliedHostiles);
    // Default-deny: an ability whose target the engine can't safely resolve (e.g. 'corpse')
    // is SKIPPED — we never improvise a target. Falls through to the basic attack.
    if (target !== null) {
      const actorName = npc.displayName || npc.username;
      const effectiveActor = { ...getEffectiveUser(npc), username: actorName };
      try {
        await runAbility(db, abilityId, {
          username: actorName,
          effectiveActor,
          target,
          row,
          col,
          currentTick: tick.tick,
          phase: getPhaseFromTick(tick.tick)
        });
        return { tick, acted: true, target, cast: abilityId };
      } catch (err) {
        // Any ability error → fall through to a basic attack.
      }
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
  await insertSystemMessage(db, row, col, describeAttack({
    attacker: npc.displayName || npc.username,
    target: player.username,
    weaponClass: 'fist',
    part: damageResult.struckLabel,
    damage,
    isCritical: isCriticalAttack,
    targetDowned: Boolean(player.incapacitated)
  }, flavorRandom([npc.username, player.username, tick.tick, damage, isCriticalAttack ? 'c' : ''])), 'combat');

  // Plan 021b: a creature's elemental bite lands its element's status on the player.
  // Plan 021 (BOLD): resolve by base name + Rending affix, so an elite still bites cold.
  if (!damageResult.died) {
    const element = creatureElementFor(npc);
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
    // adv-018: opening a round is INSERT-then-RESELECT. Two first-rollers in the same
    // den/tick both saw "no open round" and would each INSERT one — splitting the pool
    // and paying two winners when resolveExpiredGamblingRounds swept both. There is no
    // uniqueness on (room, day, open) to lean on, so instead of trusting our own
    // lastInsertId we INSERT, then re-SELECT the EARLIEST surviving open round for this
    // (room, worldDay) and join THAT. Both racers run the identical deterministic
    // ORDER BY (startTick ASC, id ASC) over the same rows, so they converge on ONE
    // round (the lower id); the extra row, if any, is just an empty open round that the
    // sweep later closes with zero entries. No migration required.
    await dbRun(
      db,
      `INSERT INTO gamblingRounds
        (roomRow, roomCol, worldDay, startTick, endTick, status, pool)
       VALUES (?, ?, ?, ?, ?, 'open', 0)`,
      [row, col, worldDay, tickValue, tickValue + 10]
    );
    round = await dbFirst(
      db,
      `SELECT *
       FROM gamblingRounds
       WHERE roomRow = ?
         AND roomCol = ?
         AND worldDay = ?
         AND status = 'open'
         AND endTick >= ?
       ORDER BY startTick ASC, id ASC
       LIMIT 1`,
      [row, col, worldDay, tickValue]
    );
  }

  const roll = Math.floor(Math.random() * 20) + 1;
  const goldUpdate = await dbRun(
    db,
    'UPDATE users SET gold = gold - ? WHERE username = ? AND gold >= ?',
    [wager, username, wager]
  );
  assertAction(changes(goldUpdate) > 0, 'Not enough gold for that wager.');

  const systemMessage = `${username} enters the dice round with ${wager} gold and rolls ${roll}. The round closes at tick ${round.endTick}.`;
  try {
    // One atomic round trip: the entry, the pool bump, and the table talk land (or
    // fail) together, so the catch-refund below never leaves a half-recorded entry.
    await dbBatch(db, [
      [`INSERT INTO gamblingEntries
         (roundId, username, wager, roll, enteredTick)
        VALUES (?, ?, ?, ?, ?)`, [round.id, username, wager, roll, tickValue]],
      ['UPDATE gamblingRounds SET pool = pool + ? WHERE id = ?', [wager, round.id]],
      [`INSERT INTO messages (roomRow, roomCol, username, message, kind)
        VALUES (?, ?, 'System', ?, 'dice')`, [row, col, systemMessage]]
    ]);
  } catch (err) {
    await dbRun(db, 'UPDATE users SET gold = gold + ? WHERE username = ?', [wager, username]);
    throw err;
  }

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

  // adv-018: the DELETE is the CLAIM. Two simultaneous hits can both SELECT the same
  // ward/mark row, but only one DELETE removes it (changes()===1); the loser sees
  // changes()===0 and credits nothing. Without this both subtracted the magnitude off
  // one row, so a single ward absorbed two hits / a mark double-counted. The SELECT
  // only tells us the magnitude to apply — the delete decides whether we apply it.
  const claim = await dbRun(db, 'DELETE FROM statusEffects WHERE id = ?', [effect.id]);
  return changes(claim) === 1 ? (effect.magnitude || 0) : 0;
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

  // adv-006: condition/gear modifiers for the attacker AND every target are read through
  // ONE per-attack cache keyed by username (a pure read that doesn't change mid-attack), and
  // the current tick is threaded in so the 'chill' lookup skips its own getCurrentTickValue.
  // Self-attacks (attacker === target) thus compute the modifiers once, not twice — same
  // values, fewer queries. Zero RNG draws ride these reads, so the mocked sequence is intact.
  const modifierCache = new Map();
  const modifierOptions = { tickValue: currentTick, cache: modifierCache };
  const attackerMods = attacker.isNpc ? null : await getConditionAndGearModifiers(db, username, modifierOptions);
  // Plan: the attacker's weapon class drives the brutal flavor verb set (blade/pierce/
  // blunt/fist) and its templateId selects a per-weapon SIGNATURE pool when one exists.
  // adv-006: the attacker's equipped items are fetched ONCE here; weaponClass AND the
  // weapon element are derived from that single result (the element was previously
  // re-queried once per target). An unarmed attacker (or an NPC, who never wields a
  // weaponClass item) → 'fist' / null id / null element.
  const attackerEquipped = await getEquippedItems(db, username);
  const { weaponClass: attackerWeaponClass, weaponId: attackerWeaponId } = deriveWeaponClass(attackerEquipped);
  const attackerElement = deriveAttackElement(attackerEquipped);

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
    const targetMods = target.isNpc ? null : await getConditionAndGearModifiers(db, target.username, modifierOptions);
    // Plan 021 (BOLD): called shots now land on a BODIED NPC (creatureBodyPlan set) too —
    // the engine, not a name, decides: a player always has a body; an NPC has one only
    // when it carries a plan; a scalar NPC (null plan) still ignores aim (no parts to hit).
    // Players are byte-identical (the else branch is the original expression).
    const targetIsBodied = target.isNpc ? Boolean(target.creatureBodyPlan) : true;
    let calledShot = targetIsBodied ? (aimedPart || parseCalledShot(message)) : null;
    const targetStance = target.isNpc ? STANCES[DEFAULT_STANCE] : STANCES[normalizeStance(target.stance)];

    // Plan: aiming is best-effort — a called shot must NEVER block the attack. If the
    // aimed part is no longer on this bodied target (missing or already severed), we drop
    // the aim BEFORE the accuracy penalty/head-bonus are figured and let the blow land as a
    // normal weighted-random hit (applyBodyDamage falls back to pickTargetPart when
    // targetLabel doesn't match a live part). The flavor note (pushed on a landed hit
    // below, so it never reads alongside a "dodged" line) tells the player why their aim
    // didn't take. The toolbar aim is sticky, so this is the common case once a head/limb
    // is destroyed mid-fight. `aimedLabel` is held for the note since calledShot is nulled.
    const targetName = user.displayName || user.username;
    let aimDroppedLabel = null;
    if (calledShot && targetIsBodied) {
      const liveParts = (await ensureBody(db, target)) || [];
      const aimed = liveParts.find(part => part.label === calledShot);
      if (!aimed || aimed.severed) {
        aimDroppedLabel = calledShot;
        calledShot = null;
      }
    }

    // Contest deltas: attacker stance hitBonus and (when aiming) the called-shot
    // accuracy penalty raise/lower the attacker; defender stance dodgeBonus
    // makes the defender harder to hit. Folded in before the [0.25, 0.95] clamp.
    let hitDelta = attackerStance.hitBonus;
    if (calledShot) {
      hitDelta -= CALLED_SHOT_HIT_PENALTY;
    }
    const dodgeDelta = targetStance.dodgeBonus;

    const speedContest = rollSpeedContest(attacker, target, attackerMods, targetMods, { hitDelta, dodgeDelta });
    if (!speedContest.hit) {
      // A self-targeted whiff reads reflexively ("mog swings at themselves and
      // misses"); a normal dodge stays "X dodged Y's attack".
      attackMessages.push(user.username === username
        ? describeSelfMiss(username, flavorRandom([username, createdTick, 'selfmiss']))
        : `${targetName} dodged ${username}'s attack`);
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
      targetLabel: calledShot,
      // Plan 021: a bodied NPC's wound/sever lines read by its display name
      // ("Frost Wyrm's left wing is destroyed"). Players have no displayName, so this
      // is null and applyBodyDamage falls back to the username — byte-identical.
      displayLabel: target.displayName || null
    });

    // adv-006: the post-damage health is already returned by applyBodyDamage
    // (damageResult.healthAfter is exactly what a re-SELECT of users.health would yield,
    // since the write is the same relative deduction). disposition/isNpc don't change
    // when a body takes damage, so the pre-damage `target` row still carries them — the
    // redundant `SELECT * FROM users` after the hit is dropped.
    const remainingHealth = damageResult.healthAfter;
    const wasKilled = damageResult.died;
    const attackMessage = describeAttack({
      attacker: username,
      target: targetName,
      weaponClass: attackerWeaponClass,
      weaponId: attackerWeaponId,
      part: calledShot || damageResult.struckLabel,
      damage,
      isCritical: isCriticalAttack,
      targetDowned: Boolean(target.incapacitated),
      self: user.username === username
    }, flavorRandom([username, user.username, createdTick, damage, isCriticalAttack ? 'c' : '']));

    attackMessages.push(attackMessage);
    // Best-effort aim: the named part was gone, so the blow landed where it could.
    if (aimDroppedLabel) {
      attackMessages.push(`${username} can't get a clean shot at the ${aimDroppedLabel} — strikes where they can.`);
    }

    // Plan 020c/021a: if the attacker's weapon is elemental and the target survived,
    // the hit lands the element's status — on a player's struck part (per-part armor
    // affinity) or on an NPC (intrinsic creature affinity). No element → skipped →
    // combat is byte-identical.
    if (!wasKilled) {
      const element = attackerElement;
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
    // then wakes the fight, so the whole pub comes for you. adv-006: isNpc/disposition are
    // read off the already-loaded `target` row — taking damage never alters them, and the
    // disposition flip itself only happens here (after this read), so it's byte-identical.
    if (target.isNpc && target.disposition && target.disposition !== 'hostile') {
      await provokeRoomNpcs(db, row, col, { deferredSystemMessages: options.deferredSystemMessages });
    }
  }

  return `${message} (${attackMessages.join(', ')})`;
}

function getSkillTarget(invoker, targetUsername) {
  return targetUsername && targetUsername.trim() ? targetUsername.trim() : invoker;
}

export async function validateClassSkillUse(db, { username, skillId, targetUsername, row, col }) {
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
    const targetUser = await getUser(db, target, 'Target');
    // adv-014: co-location gate. A skill aimed at ANOTHER PLAYER must reach someone
    // standing in this room — mirroring /attack's presence gate (validateAttackTargets).
    // Without this, a named ally/enemy resolved by existence alone, so power_strike,
    // dose, mark, arcane_pin, ward, bless &c. could land on any player anywhere on the
    // map. Self-casts, room/no-target abilities, and NPC targets (co-located by
    // construction in the hostile loop, which bypasses this path) keep prior behavior.
    if (!targetUser.isNpc && target !== username) {
      await assertTargetCoLocated(db, target, row, col);
    }
  }

  return { actor, effectiveActor, target, ability };
}

// adv-014: is `target` standing in (row, col) right now? Reuses the exact presence
// semantics /attack relies on — a roomPresence row for this worldDay whose lastSeenAt
// is within PRESENCE_MAX_AGE_SECONDS (NPCs are always "present", but this helper is only
// called for players, so that branch never fires here). Throws "They aren't here."
// otherwise. row/col may be undefined if a caller omitted them — treat that as not present.
async function assertTargetCoLocated(db, target, row, col) {
  const worldDay = getWorldDay();
  const present = await dbFirst(
    db,
    `SELECT rp.username
       FROM roomPresence rp
       JOIN users u ON u.username = rp.username
      WHERE rp.username = ?
        AND rp.roomRow = ?
        AND rp.roomCol = ?
        AND rp.worldDay = ?
        AND (u.isNpc = 1 OR rp.lastSeenAt >= datetime('now', ?))`,
    [target, row, col, worldDay, `-${PRESENCE_MAX_AGE_SECONDS} seconds`]
  );
  if (!present) {
    throw new ActionError('They aren\'t here.');
  }
}

async function tryHarmfulSkillHit(db, { effectiveActor, target, skillLabel, row, col }) {
  const targetUser = await getUser(db, target, 'Target');
  const speedContest = rollSpeedContest(effectiveActor, targetUser);
  if (speedContest.hit) {
    return true;
  }

  const message = isSelf(effectiveActor.username, target)
    ? `${effectiveActor.username} swings ${skillLabel} at themselves and misses.`
    : `${target} dodged ${effectiveActor.username}'s ${skillLabel}.`;
  await insertSystemMessage(db, row, col, message, 'combat');
  return false;
}

export async function useClassSkill(db, { username, skillId, targetUsername, row, col, currentTick, phase, incantation = '', rank = 0 }) {
  const { effectiveActor, target } = await validateClassSkillUse(db, { username, skillId, targetUsername, row, col });
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

// Plan 013e (tail): a cast lands on the SELF when the resolved target IS the actor
// (you named @self / @me, or the toolbar aimed you). Only the human-readable message
// flips to reflexive prose on this branch — formulas, status writes, kinds, and return
// shapes are byte-identical to a cast on someone else.
const isSelf = (a, t) => !!t && t === a;

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
      const message = isSelf(username, target)
        ? `${username} wraps a ward around themselves for 5 ticks.`
        : `${username} wards ${target} for 5 ticks.`;
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
        return {
          message: isSelf(username, target)
            ? `${username} swings Power Strike at themselves and misses.`
            : `${target} dodged ${username}'s Power Strike.`,
          missed: true
        };
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
      // adv-018: DELETE-as-claim, same as consumeStatusModifier. The mark bonus / ward
      // reduction applies ONLY if THIS cast's DELETE removed the row (changes()===1) —
      // so two concurrent power strikes can't both consume one mark/ward. Magnitude is
      // read from the SELECT; the delete is the authority on whether it counts.
      if (marked) {
        const claimedMark = await dbRun(db, 'DELETE FROM statusEffects WHERE id = ?', [marked.id]);
        if (changes(claimedMark) === 1) {
          damage += marked.magnitude;
        }
      }
      if (ward) {
        const claimedWard = await dbRun(db, 'DELETE FROM statusEffects WHERE id = ?', [ward.id]);
        if (changes(claimedWard) === 1) {
          damage = Math.max(0, damage - ward.magnitude);
        }
      }
      const result = damage > 0
        ? await damageUser(db, target, damage, `power strike by ${username}`, row, col)
        : { killed: false, remainingHealth: null };
      const message = isSelf(username, target)
        ? `${username} drives Power Strike into themselves for ${damage} damage.`
        : `${username} power strikes ${target} for ${damage} damage.`;
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
          return {
            message: isSelf(username, target)
              ? `${username} fumbles Dose against themselves.`
              : `${target} dodged ${username}'s Dose.`,
            missed: true
          };
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
        const message = isSelf(username, target)
          ? `${username} doses themselves with something bitter.`
          : `${username} doses ${target} with something bitter.`;
        await insertSystemMessage(db, row, col, message, 'skill');
        return { message };
      }

      const amount = 2 + Math.floor(effectiveActor.intelligence / 4);
      await healUser(db, target, amount, row, col);
      const message = isSelf(username, target)
        ? `${username} patches their own wounds for ${amount} health.`
        : `${username} patches up ${target} for ${amount} health.`;
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
        return {
          message: isSelf(username, target)
            ? `${username} fumbles Arcane Pin against themselves.`
            : `${target} dodged ${username}'s Arcane Pin.`,
          missed: true
        };
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
      const message = isSelf(username, target)
        ? `${username} pins themselves with a humming spell.`
        : `${username} pins ${target} with a humming spell.`;
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
        return {
          message: isSelf(username, target)
            ? `${username} can't quite mark themselves.`
            : `${target} dodged ${username}'s Mark.`,
          missed: true
        };
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
      const message = isSelf(username, target)
        ? `${username} marks themselves.`
        : `${username} marks ${target}.`;
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
      const message = isSelf(username, target)
        ? (cleared
            ? `${username} blesses themselves and shrugs off a harmful effect.`
            : `${username} blesses themselves.`)
        : (cleared
            ? `${username} blesses ${target} and clears a harmful effect.`
            : `${username} blesses ${target}.`);
      await insertSystemMessage(db, row, col, message, 'support');
      return { message };
    }
    case 'brace': {
      // Self only — ward the actor. `target` is the engine-resolved self: for a player
      // cast getSkillTarget returns the invoker (target === username, byte-identical);
      // for an NPC cast resolveHostileTarget('self') returns the NPC's real username, so
      // the ward lands on the NPC's row (not its opaque-vs-display-name mismatch). The
      // message still reads by the actor's name (username = display name for NPCs).
      await addStatusEffect(db, {
        username: target || username,
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
