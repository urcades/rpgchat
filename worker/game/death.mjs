// Death & incapacitation: the bleed-out clock, the grave, gibbing & NPC defeat (plan adv-005).
//
// Extracted verbatim from the original worker/game.mjs — a pure mechanical move.
// Cross-seam dependencies are now explicit imports; cycles between seams resolve
// through ESM live bindings (every cross-seam reference is call-time, never
// dereferenced at module load).

import {
  ActionError,
  DEATH_FLOOR,
  GIB_OVERKILL,
  INCAP_BLEED_PER_TICK,
  INCAP_BLOW_MIN,
  PRESENCE_MAX_AGE_SECONDS,
  getWorldDay,
  rollNpcDrop
} from './shared.mjs';
import { dbAll, dbFirst, dbRun } from '../db.mjs';
import { getBodyParts } from './body.mjs';
import { dropItemOnFloor, dropPlayerItemsOnDeath } from './inventory.mjs';
import { createTrace, emitSystemMessage, insertSystemMessage } from './messages.mjs';
import { CREATURE_DEATH_RATTLES, NPC_DEATH_BEGS, emitDeathReaction } from './npc.mjs';
import { awardExperience, upsertCooldown } from './progression.mjs';


export async function moveUserToCemetery(db, username, cause, row, col, options = {}) {
  const user = await dbFirst(db, 'SELECT username, password, level, gold, job FROM users WHERE username = ?', [username]);
  if (!user) {
    return false;
  }

  await dbRun(
    db,
    `INSERT INTO cemetery
      (username, password, level, gold, job, cause, roomRow, roomCol, diedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
    [user.username, user.password || '', user.level || 0, user.gold || 0, user.job || 'Novice', cause, row, col]
  );
  await dbRun(db, 'DELETE FROM users WHERE username = ?', [username]);
  await dbRun(db, 'DELETE FROM roomPresence WHERE username = ?', [username]);
  await dbRun(db, 'DELETE FROM statusEffects WHERE username = ?', [username]);
  const droppedCount = await dropPlayerItemsOnDeath(db, username, row, col);
  if (droppedCount > 0) {
    await emitSystemMessage(db, row, col, `${username}'s belongings scatter across the floor.`, options.deferredSystemMessages);
  }
  await dbRun(db, 'DELETE FROM bodyParts WHERE username = ?', [username]);
  // Plan 022c: the body drops as a corpse — the anchor of resurrection. While it
  // exists (on a floor or in someone's bag) the player can be revived (paid or
  // free); eat or destroy it and the tether snaps — true, permanent death.
  await dbRun(
    db,
    `INSERT INTO items (templateId, name, slotType, rarity, modifiers, roomRow, roomCol, corpseOf)
     VALUES ('player_corpse', ?, 'corpse', 'common', '{}', ?, ?, ?)`,
    [`${username}'s Corpse`, row, col, username]
  );
  await emitSystemMessage(db, row, col, `${username}'s corpse lies here.`, options.deferredSystemMessages, 'death');
  await emitSystemMessage(db, row, col, `${username} has died from ${cause}.`, options.deferredSystemMessages, 'death');
  // Plan 013f: the room reacts — grim gloating if they'd turned on this player (a
  // "criminal" who provoked them), horror otherwise.
  await emitDeathReaction(db, { row, col, deadName: username, deadWasNpc: false, deferredSystemMessages: options.deferredSystemMessages });
  return true;
}

// ---------------------------------------------------------------------------
// Plan 023b: the death progression. Combat no longer entombs a player the instant
// HP hits 0 — it routes through descendTowardDeath, which decides between falling
// incapacitated (the negative-HP band), hastening the death clock, and true death
// or a gib. moveUserToCemetery is now reached only via trueDeath / gibAndKill (and
// the room-hazard path), never directly from a combat site.

// Down but not dead: prone, looted, mute but for garbled speech, bleeding out. The
// body gives out entirely — health and every part drop to 0 so the death clock (not
// stray limb HP) is the single measure of the life left in them. This also keeps the
// `users.health == Σ part hp` invariant exact (0 == 0) through the downed state.
// Plan 023b/013g: down a combatant — player OR NPC — into the bleeding-out band. Body
// zeroed so the death clock is the sole measure of remaining life. Players scatter their
// gear and have body parts to zero; NPCs are bodyless and drop loot only on true death, so
// they just gasp a plea (social) or a broken rattle (beast) and fall.
async function incapacitate(db, user, cause, row, col, { currentTick = null, deferredSystemMessages = null } = {}) {
  const name = user.displayName || user.username;
  await dbRun(
    db,
    "UPDATE users SET incapacitated = 1, deathClock = 0, downedCause = ?, stance = 'prone', health = 0 WHERE username = ?",
    [cause, user.username]
  );
  await dbRun(db, 'DELETE FROM statusEffects WHERE username = ?', [user.username]); // falling clears chill/burn/etc.
  if (user.isNpc) {
    if (user.npcKind === 'social') {
      const beg = NPC_DEATH_BEGS[Math.floor(Math.random() * NPC_DEATH_BEGS.length)];
      await emitSystemMessage(db, row, col, `${name} falls, gasping: "${garbleSpeech(beg)}"`, deferredSystemMessages, 'death');
    } else {
      const rattle = CREATURE_DEATH_RATTLES[Math.floor(Math.random() * CREATURE_DEATH_RATTLES.length)];
      await emitSystemMessage(db, row, col, `${name} ${rattle}, barely clinging on.`, deferredSystemMessages, 'death');
    }
  } else {
    await dbRun(db, 'UPDATE bodyParts SET hp = 0 WHERE username = ?', [user.username]);
    // Items spill NOW, while they still draw breath — the vulnerability is the point.
    const dropped = await dropPlayerItemsOnDeath(db, user.username, row, col);
    if (dropped > 0) {
      await emitSystemMessage(db, row, col, `${name}'s belongings spill across the floor as they fall.`, deferredSystemMessages, 'death');
    }
    await emitSystemMessage(db, row, col, `${name} collapses in a spreading pool of blood, unable to stand.`, deferredSystemMessages, 'death');
  }
  await createTrace(db, { row, col, traceType: 'body', intensity: 2, attacker: getKillerFromCause(cause), target: user.username, createdTick: currentTick ?? 0, expiryTick: null, worldDay: getWorldDay() });
}

// Plan 013g: the true-death router. NPCs end via defeatNpc (loot, remains, kill credit,
// room reaction) — never a cemetery/corpse. Players go to the grave (or gib).
async function finishOff(db, user, { cause, row, col, currentTick = null, gib = false, deferredSystemMessages = null } = {}) {
  if (user.isNpc) {
    const killer = getKillerFromCause(cause) || 'their wounds';
    if (gib) {
      await emitSystemMessage(db, row, col, `${user.displayName || user.username} is torn apart.`, deferredSystemMessages, 'death');
      await createTrace(db, { row, col, traceType: 'body', intensity: 3, attacker: killer, target: user.username, createdTick: currentTick ?? 0, expiryTick: null, worldDay: getWorldDay() });
    }
    await defeatNpc(db, user, { killer, row, col, currentTick, deferredSystemMessages });
    return;
  }
  if (gib) {
    await gibAndKill(db, user.username, cause, row, col, { currentTick, deferredSystemMessages });
  } else {
    await trueDeath(db, user.username, cause, row, col, { currentTick, deferredSystemMessages });
  }
}

// True death without dismemberment — a finishing blow on the downed, or a bleed-out.
async function trueDeath(db, username, cause, row, col, { currentTick = null, deferredSystemMessages = null } = {}) {
  const downed = await dbFirst(db, 'SELECT downedCause, level FROM users WHERE username = ?', [username]);
  const effectiveCause = cause || downed?.downedCause || 'their wounds';
  await recordKill(db, {
    killer: getKillerFromCause(effectiveCause),
    defeatedUsername: username,
    defeatedName: username,
    defeatedKind: 'player',
    defeatedLevel: downed?.level || 0,
    row,
    col,
    currentTick
  });
  await moveUserToCemetery(db, username, effectiveCause, row, col, { deferredSystemMessages });
}

// True death WITH dismemberment — the gib. Up to two non-torso limbs burst free as
// grotesque floor items before the body is entombed.
async function gibAndKill(db, username, cause, row, col, { currentTick = null, deferredSystemMessages = null } = {}) {
  const parts = await getBodyParts(db, username);
  const flying = parts.filter(part => !part.severed && part.partType !== 'torso').slice(0, 2);
  for (const part of flying) {
    await emitSystemMessage(db, row, col, `${username}'s ${part.label} bursts free in a spray of gore.`, deferredSystemMessages, 'death');
    await dropItemOnFloor(db, 'severed_part', row, col, { name: `${username}'s severed ${part.label}` });
  }
  await createTrace(db, { row, col, traceType: 'body', intensity: 3, attacker: getKillerFromCause(cause), target: username, createdTick: currentTick ?? 0, expiryTick: null, worldDay: getWorldDay() });
  await emitSystemMessage(db, row, col, `${username} is torn apart.`, deferredSystemMessages, 'death');
  await trueDeath(db, username, cause, row, col, { currentTick, deferredSystemMessages });
}

// The single decision point every combat death site calls. `blowDamage` is the
// blow's intended damage; `overkill` is damage that spilled past a live body.
export async function descendTowardDeath(db, username, { cause, row, col, blowDamage = 0, overkill = 0, currentTick = null, deferredSystemMessages = null } = {}) {
  // Plan 013g: players AND NPCs descend through the same band — load the full row so
  // finishOff/incapacitate can branch on isNpc.
  const u = await dbFirst(db, 'SELECT * FROM users WHERE username = ?', [username]);
  if (!u) {
    return { state: 'gone' };
  }
  const gib = overkill >= GIB_OVERKILL || blowDamage >= GIB_OVERKILL;
  const name = u.displayName || u.username;

  if (!u.incapacitated) {
    if (gib) {
      await finishOff(db, u, { cause, row, col, currentTick, gib: true, deferredSystemMessages });
      return { state: 'gibbed' };
    }
    await incapacitate(db, u, cause, row, col, { currentTick, deferredSystemMessages });
    return { state: 'incapacitated' };
  }

  // Already down: a fresh blow hastens the end.
  const loss = Math.max(INCAP_BLOW_MIN, blowDamage);
  const next = u.deathClock - loss;
  if (gib || next <= DEATH_FLOOR) {
    await finishOff(db, u, { cause, row, col, currentTick, gib, deferredSystemMessages });
    return { state: gib ? 'gibbed' : 'died' };
  }
  await dbRun(db, 'UPDATE users SET deathClock = ? WHERE username = ?', [next, username]);
  await emitSystemMessage(db, row, col, `${name} is struck where they lie — life pooling out (${next}/${DEATH_FLOOR}).`, deferredSystemMessages, 'death');
  return { state: 'bleeding', deathClock: next };
}

// Healed above 0 while down — back on their feet, clock reset.
export async function reviveFromIncapacitation(db, username, row, col) {
  await dbRun(
    db,
    "UPDATE users SET incapacitated = 0, deathClock = 0, downedCause = NULL, stance = 'standing' WHERE username = ?",
    [username]
  );
  await insertSystemMessage(db, row, col, `${username} staggers back to their feet.`, 'support');
}

// Plan 023b: the passive bleed. Runs each world pulse (~1/min); every incapacitated
// player loses INCAP_BLEED_PER_PULSE from their clock and truly dies at the floor.
// Queries users directly (not via roomPresence) so a disconnected body still bleeds.
export async function processIncapacitationBleed(db, currentTick = null) {
  // Plan 013g: players AND downed NPCs bleed out here. SELECT u.* so finishOff can route a
  // bled-out NPC to defeatNpc and a player to the grave.
  const downed = await dbAll(
    db,
    `SELECT u.*, rp.roomRow, rp.roomCol
     FROM users u
     LEFT JOIN roomPresence rp ON rp.username = u.username
     WHERE u.incapacitated = 1`
  );
  for (const d of downed) {
    const row = d.roomRow ?? 0;
    const col = d.roomCol ?? 0;
    const next = d.deathClock - INCAP_BLEED_PER_TICK;
    if (next <= DEATH_FLOOR) {
      const cause = d.downedCause ? `bled out after ${d.downedCause}` : 'bled out';
      await finishOff(db, d, { cause, row, col, currentTick });
    } else {
      await dbRun(db, 'UPDATE users SET deathClock = ? WHERE username = ?', [next, d.username]);
      // Plan 013e: the health bar shows the falling count live, so the room only gets an
      // occasional gasp (every ~5 points) instead of a line every single tick.
      if (next % 5 === 0) {
        await insertSystemMessage(db, row, col, `${d.displayName || d.username} bleeds, fading (${next}/${DEATH_FLOOR}).`, 'death');
      }
    }
  }
}

// Plan 023b: an incapacitated actor can do nothing but whisper (garbled). Every
// non-speech action verb calls this gate; speech falls through to handleChatAction.
export async function assertActable(db, username) {
  const u = await dbFirst(db, 'SELECT incapacitated FROM users WHERE username = ? AND isNpc = 0', [username]);
  if (u && u.incapacitated) {
    throw new ActionError('You are incapacitated — you can do nothing but whisper.', 409);
  }
}

export async function isIncapacitated(db, username) {
  const u = await dbFirst(db, 'SELECT incapacitated FROM users WHERE username = ? AND isNpc = 0', [username]);
  return Boolean(u && u.incapacitated);
}

// Plan 023c: an incapacitated voice. A downed player can still speak, but the words
// come out in ragged fragments — only ~every fourth survives, the rest collapse into
// an ellipsis ("please … … help … …"). Deterministic by position so it is testable
// and never RNG-flaky.
export const DEATH_NOISES = ['*gurgles*', '*coughs blood*', '*wheezes*', '*chokes*', '*rattles*', '*spits red*'];

export function garbleSpeech(text, random = Math.random) {
  // Plan 013e: a drowning, broken voice. Each word RANDOMLY survives (~1 in 4), is lost to
  // an ellipsis, or breaks into a wet death-noise — so no two pleas read the same. `random`
  // is injectable for tests.
  const noise = () => DEATH_NOISES[Math.floor(random() * DEATH_NOISES.length)] || DEATH_NOISES[0];
  const words = String(text || '').trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) {
    return noise();
  }
  const out = words.map(word => {
    const r = random();
    if (r < 0.25) return word;       // survives
    if (r < 0.34) return noise();    // a wet noise breaks through
    return '…';                      // lost
  });
  let line = out.join(' ').replace(/(?:…\s*){2,}/g, '… ').trim();
  // Never let it collapse to nothing or a lone ellipsis — surface a death rattle.
  if (!line || line === '…') {
    line = `${noise()} …`;
  }
  return line;
}

function getKillerFromCause(cause) {
  const match = String(cause || '').match(/\bby\s+(.+)$/);
  return match ? match[1].trim() : null;
}

async function recordKill(db, {
  killer,
  defeatedUsername,
  defeatedName,
  defeatedKind,
  defeatedLevel,
  experienceGained = 0,
  goldGained = 0,
  row,
  col,
  currentTick
}) {
  if (!killer || !defeatedUsername || killer === defeatedUsername) {
    return;
  }

  // Plan 013g: record the killer by whatever name the cause carries — a player's username
  // OR an NPC's display name (the slayer field "by X" is already a display name post-013e).
  // This credits NPC kills of players in the graveyard; player kill-COUNTS still match by
  // username (an NPC display name simply won't collide with any player's tally).
  await dbRun(
    db,
    `INSERT INTO killHistory
      (killerUsername, defeatedUsername, defeatedName, defeatedKind, defeatedLevel, experienceGained, goldGained, roomRow, roomCol, worldDay, tick)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      killer,
      defeatedUsername,
      defeatedName || defeatedUsername,
      defeatedKind || 'player',
      defeatedLevel || 0,
      experienceGained || 0,
      goldGained || 0,
      row,
      col,
      getWorldDay(),
      currentTick ?? null
    ]
  );
}

async function awardEventVictory(db, event, row, col, currentTick, options = {}) {
  const presentPlayers = await dbAll(
    db,
    `SELECT rp.username
     FROM roomPresence rp
     JOIN users u ON u.username = rp.username
     WHERE rp.roomRow = ?
       AND rp.roomCol = ?
       AND rp.worldDay = ?
       AND rp.lastSeenAt >= datetime('now', ?)
       AND u.isNpc = 0`,
    [row, col, event.worldDay, `-${PRESENCE_MAX_AGE_SECONDS} seconds`]
  );

  for (const player of presentPlayers) {
    await awardExperience(db, player.username, event.rewardExperience || 0);
    await dbRun(db, 'UPDATE users SET gold = gold + ? WHERE username = ?', [event.rewardGold || 0, player.username]);
    await dbRun(
      db,
      `INSERT OR IGNORE INTO worldEventAchievements
        (username, eventId, achievementType, worldDay, earnedTick, rewardExperience, rewardGold)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        player.username,
        event.id,
        event.eventType === 'raid' ? 'raid_victory' : 'event_victory',
        event.worldDay,
        currentTick,
        event.rewardExperience || 0,
        event.rewardGold || 0
      ]
    );
  }

  await dbRun(
    db,
    'UPDATE worldEvents SET status = ?, completedTick = ? WHERE id = ?',
    ['completed', currentTick, event.id]
  );
  await emitSystemMessage(db, row, col, `${event.title} has been cleared.`, options.deferredSystemMessages);
}

export async function defeatNpc(db, npc, { killer, row, col, currentTick, deferredSystemMessages = null }) {
  const entity = await dbFirst(db, 'SELECT rewardExperience, rewardGold FROM worldEventEntities WHERE username = ?', [npc.username]);
  const event = npc.worldEventId
    ? await dbFirst(db, 'SELECT * FROM worldEvents WHERE id = ?', [npc.worldEventId])
    : null;
  const eventVictoryExperience = event && (event.eventType === 'lesser' || (event.eventType === 'raid' && npc.npcKind === 'raid_boss'))
    ? event.rewardExperience || 0
    : 0;
  const eventVictoryGold = event && (event.eventType === 'lesser' || (event.eventType === 'raid' && npc.npcKind === 'raid_boss'))
    ? event.rewardGold || 0
    : 0;
  await recordKill(db, {
    killer,
    defeatedUsername: npc.username,
    defeatedName: npc.displayName || npc.username,
    defeatedKind: npc.npcKind || 'npc',
    defeatedLevel: npc.level || 0,
    experienceGained: eventVictoryExperience || (entity ? entity.rewardExperience : 0),
    goldGained: eventVictoryGold || (entity ? entity.rewardGold : 0),
    row,
    col,
    currentTick
  });

  // Plan 013g: the dying gasp/beg happened when they were downed (incapacitate); defeatNpc
  // is the true death — removal, loot, kill credit, and the room's reaction.
  await dbRun(db, 'DELETE FROM users WHERE username = ? AND isNpc = 1', [npc.username]);
  await dbRun(db, 'DELETE FROM roomPresence WHERE username = ?', [npc.username]);
  await dbRun(db, 'DELETE FROM statusEffects WHERE username = ?', [npc.username]);
  await dbRun(db, 'UPDATE worldEventEntities SET lastDefeatedTick = ? WHERE username = ?', [currentTick, npc.username]);
  // Plan 013f: a slain SOCIAL NPC stays slain for the day — mark its slot so the social
  // populator won't resurrect it on the next presence heartbeat.
  if (npc.npcKind === 'social') {
    await upsertCooldown(db, npc.username, row, col, 'npc_dead', currentTick ?? 0, getWorldDay());
  }
  await emitSystemMessage(db, row, col, `${npc.displayName || npc.username} is defeated by ${killer}.`, deferredSystemMessages, 'combat');
  // Plan 013f: the surviving room reacts to the kill.
  await emitDeathReaction(db, { row, col, deadName: npc.displayName || npc.username, deadWasNpc: true, deferredSystemMessages });

  const drop = rollNpcDrop(npc.npcKind);
  if (drop) {
    await dropItemOnFloor(db, drop.templateId, row, col);
    await emitSystemMessage(db, row, col, `${npc.displayName || npc.username} drops ${drop.name}.`, deferredSystemMessages);
  }

  // Plan 022a: every defeated creature leaves remains — the corpse substrate that
  // feeds crafting, far more common than finished gear.
  await dropItemOnFloor(db, 'monster_remains', row, col);
  await emitSystemMessage(db, row, col, `${npc.displayName || npc.username} leaves behind remains.`, deferredSystemMessages);

  if (event && ['raid', 'lesser'].includes(event.eventType) && npc.npcKind === 'raid_boss') {
    await awardEventVictory(db, event, row, col, currentTick, { deferredSystemMessages });
    return;
  }

  if (event && event.eventType === 'lesser') {
    await awardEventVictory(db, event, row, col, currentTick, { deferredSystemMessages });
    return;
  }

  if (killer && entity) {
    await awardExperience(db, killer, entity.rewardExperience || 0);
    await dbRun(db, 'UPDATE users SET gold = gold + ? WHERE username = ?', [entity.rewardGold || 0, killer]);
  }
}
