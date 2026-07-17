// NPC dialogue: provocation, replies & ambient chatter (plan adv-005).
//
// Extracted verbatim from the original worker/game.mjs — a pure mechanical move.
// Cross-seam dependencies are now explicit imports; cycles between seams resolve
// through ESM live bindings (every cross-seam reference is call-time, never
// dereferenced at module load).

import {
  AMBIENT_VOICE_INTERVAL,
  NPC_HEAL_AMOUNT,
  NPC_VOICE_INTERVAL,
  abilitiesModule,
  getEffectiveUser,
  getWorldDay,
  shouldApplyEffect
} from './shared.mjs';
import { dbFirst, dbRun } from '../db.mjs';
import { logEvent } from '../observability.mjs';
import { generateNpcResponse } from '../npcVoice.mjs';
import { applyBodyHeal } from './body.mjs';
import { runAbility } from './combat.mjs';
import { emitSystemMessage, getMessages, insertMessage, insertSystemMessage, toBroadcastMessageRow } from './messages.mjs';
import { upsertCooldown } from './progression.mjs';
import { getCurrentTickValue } from './clock.mjs';
import { getUserOrNull } from './users.mjs';
import { getRoomDescription, getRoomPresence } from './world.mjs';


// Plan 013c: the model-absent floor for hostile speech. Overt threats/violence provoke
// even with no Workers AI; the model catches the subtler cases (aggressive "rizz", veiled
// menace) via its returned intent.
const HOSTILE_SPEECH = /\b(kill|murder|die|gut|slit|stab|throttle|strangle|destroy you|attack(s|ing)?|i'?ll end|burn you)\b/i;
export function classifyHostileText(text) {
  return HOSTILE_SPEECH.test(String(text || ''));
}

// Plan 013e: what a freshly-provoked NPC snarls so the player knows they started a fight.
const HOSTILE_BARKS = [
  'Stop that — now!',
  "You'll bleed for that.",
  'Guards! Take him!',
  'Draw steel, then.',
  "That's the last mistake you'll make.",
  'You dare?!',
  "Wrong tavern to try that in."
];

// Plan 013f: NPCs die like players — a last broken plea (people beg) or a beast's rattle.
export const NPC_DEATH_BEGS = ['no — please, mercy', 'i yield, i yield', 'spare me, i beg you', 'wait — no —', 'tell my kin i tried'];
export const CREATURE_DEATH_RATTLES = ['lets out a final shriek', 'collapses with a wet snarl', 'shudders and goes still', 'crumples with a gurgling hiss'];
// How the surviving room reacts when someone dies.
const NPC_HORROR = ['Gods — they killed {who}!', 'Murder! Murder, here!', 'Someone help — {who} is dead!', 'No… no, not like this.'];
const NPC_GLOAT = ['Justice, at last.', 'The cur had it coming.', 'One less troublemaker in here.', 'Let that be a lesson.'];

// The surviving social NPCs react to a death: horror over an ally or an innocent; grim
// gloating when the room had already turned hostile on the deceased (a "criminal").
export async function emitDeathReaction(db, { row, col, deadName, deadWasNpc, deferredSystemMessages = null }) {
  const presence = await getRoomPresence(db, row, col, getWorldDay());
  const survivors = presence.filter(p => p.isNpc && p.npcKind === 'social');
  if (survivors.length === 0) {
    return;
  }
  const speaker = survivors[Math.floor(Math.random() * survivors.length)];
  const roomTurnedOnThem = !deadWasNpc && survivors.some(p => p.disposition === 'hostile');
  const pool = roomTurnedOnThem ? NPC_GLOAT : NPC_HORROR;
  const line = pool[Math.floor(Math.random() * pool.length)].replace('{who}', deadName);
  // adv-019: both callers (death.mjs) pass `deferredSystemMessages:`, so this param MUST
  // match that name — when an array is supplied, emitSystemMessage pushes onto it (the
  // reaction lands in handleAttack's flush AFTER the attack + kill/defeat lines) instead
  // of inserting immediately (which mis-ordered it BEFORE them). provokeRoomNpcs already
  // uses this name; the old `deferred` here was a copy-paste slip that dropped the array.
  await emitSystemMessage(db, row, col, `${speaker.displayName || speaker.username}: "${line}"`, deferredSystemMessages, 'npc');
}

// Plan 013d: the model-absent floor for a plea. The model also flags request:'heal' for
// subtler asks; this catches the overt ones (and survives a downed player's garbled cry).
const HELP_REQUEST = /\b(help|heal|save|revive|raise me|mercy|don'?t let me die|please)\b/i;
export function classifyHelpRequest(text) {
  return HELP_REQUEST.test(String(text || ''));
}

// Plan 013d: does this NPC's JOB grant a revival rite? (An NPC Cleric carries 'revive'.)
function npcCanRevive(job) {
  return (abilitiesModule.getAbilitiesForJob(job) || []).some(ability => ability.id === 'revive');
}

// Plan 013c: aggression turns the room. Every present non-hostile social NPC flips to
// hostile — the whole pub jumps you — and the caller's hostile loop wakes the fight.
// Returns { provoked, names }.
export async function provokeRoomNpcs(db, row, col, { deferredSystemMessages = null } = {}) {
  const worldDay = getWorldDay();
  const present = await getRoomPresence(db, row, col, worldDay);
  const turning = present.filter(p => p.isNpc && p.npcKind === 'social' && p.disposition !== 'hostile');
  if (turning.length === 0) {
    return { provoked: 0, names: [] };
  }
  for (const npc of turning) {
    await dbRun(db, "UPDATE users SET disposition = 'hostile' WHERE username = ?", [npc.username]);
  }
  const names = turning.map(n => n.displayName || n.username);
  // Plan 013e: enmity is announced — the lead NPC snarls a warning so the player KNOWS
  // they just bought a fight (not a silent disposition flip).
  const bark = HOSTILE_BARKS[Math.floor(Math.random() * HOSTILE_BARKS.length)];
  await emitSystemMessage(db, row, col, `${names[0]} snarls: "${bark}"`, deferredSystemMessages, 'combat');
  if (names.length > 1) {
    await emitSystemMessage(db, row, col, `${names.slice(1).join(', ')} round on you too.`, deferredSystemMessages, 'combat');
  }
  return { provoked: turning.length, names };
}

// Plan 013a: an NPC reacts to what a human just said/did in this room. Runs ONLY with a
// human present ("alive only when observed"), picks the addressed (or a present) NPC,
// honors a per-room cooldown, and asks the injected `ai` (env.AI) for an ADVISORY
// response. 013a uses only `speech`; 013c/d will consume `intent`/`request`. The model
// never mutates game state — this only inserts a chat line, so a prompt-injection can at
// worst make an NPC say something odd. Returns { spoke, npc?, speech?, intent?, request? }.
export async function runNpcReply(db, ai, row, col) {
  const worldDay = getWorldDay();
  const currentTick = await getCurrentTickValue(db);
  const presence = await getRoomPresence(db, row, col, worldDay);
  const npcs = presence.filter(p => p.isNpc);
  const humans = presence.filter(p => !p.isNpc);
  if (humans.length === 0 || npcs.length === 0) {
    return { spoke: false };
  }

  const recent = await getMessages(db, row, col, currentTick);
  if (recent.length === 0) {
    return { spoke: false, provoked: 0 };
  }
  // Only react when the LAST room line is a human's (they just spoke); never pile onto
  // an NPC's own line, which prevents NPC↔NPC reply loops on this reactive path.
  const last = recent[recent.length - 1];
  const lastIsHuman = last.username && last.username !== 'System' && !npcs.some(n => n.username === last.username);
  if (!lastIsHuman) {
    return { spoke: false, provoked: 0 };
  }

  // Plan 013c (fixed 2026-06-15): provocation is evaluated on EVERY player line, BEFORE
  // the dialogue cooldown — so an overt threat turns the room even if an NPC just spoke
  // and is on cooldown. (The old bug: "i'm going to kill you" was dropped during the
  // cooldown window because the provoke check sat after the early return.)
  let provoked = 0;
  if (classifyHostileText(last.message)) {
    provoked = (await provokeRoomNpcs(db, row, col)).provoked;
  }

  const cooldown = await dbFirst(
    db,
    `SELECT lastAppliedTick FROM roomEffectCooldowns
     WHERE username = '__npc_voice' AND roomRow = ? AND roomCol = ? AND effectType = 'npc_voice' AND worldDay = ?`,
    [row, col, worldDay]
  );
  if (!shouldApplyEffect({ currentTick, lastAppliedTick: cooldown ? cooldown.lastAppliedTick : null, interval: NPC_VOICE_INTERVAL })) {
    return { spoke: false, provoked };
  }

  // Responder: an NPC named in the human's line; else (Plan 013e) the NPC who last spoke
  // here, so a back-and-forth stays with the same character; else a present NPC at random.
  const text = String(last.message || '').toLowerCase();
  const addressed = npcs.find(n => (n.displayName && text.includes(String(n.displayName).toLowerCase())) || text.includes(String(n.username).toLowerCase()));
  let speaker = addressed;
  if (!speaker) {
    const lastNpcLine = [...recent].reverse().find(m => npcs.some(n => n.username === m.username));
    speaker = (lastNpcLine && npcs.find(n => n.username === lastNpcLine.username)) || npcs[Math.floor(Math.random() * npcs.length)];
  }
  if (!speaker) {
    return { spoke: false, provoked };
  }

  // adv-006: the reply only needs the room DESCRIPTION, not the whole ecology
  // payload — getRoomDescription composes the identical string from features +
  // traces alone, skipping the presence/items/round/event/access reads.
  const roomDescription = await getRoomDescription(db, row, col, worldDay, currentTick);
  const response = await generateNpcResponse(ai, {
    npc: {
      displayName: speaker.displayName || speaker.username,
      npcKind: speaker.npcKind,
      role: speaker.role || speaker.npcKind,
      disposition: speaker.disposition
    },
    roomDescription,
    recentMessages: recent.slice(-6),
    addressedBy: last.displayName || last.username,
    mode: 'reply'
  });
  // Diagnostic (2026-06-15): surface whether the line came from the model or a fallback,
  // and why — the failure used to be swallowed silently, hiding a non-working binding.
  // Campaign B (013 tail) cost monitoring (owner-locked: OBSERVE, no hard cap): `billed`
  // is true only when an inference was actually billed (source === 'model'); a fallback
  // line ('fallback:*') costs nothing. Aggregating this in the logs is how cost is watched.
  logEvent({ event: 'npc.reply', roomRow: row, roomCol: col, npc: speaker.username, source: response.source, billed: response.source === 'model', error: response.error });
  if (!response.speech) {
    return { spoke: false, provoked };
  }

  // adv DUR-05: keep the inserted row so the broadcast can be self-describing —
  // clients append it directly instead of a follow-up /messages fetch (which,
  // once D1 read replication is on, could hit a lagging replica and miss it).
  const inserted = await insertMessage(db, row, col, speaker.username, response.speech, 'npc');
  const messageRow = toBroadcastMessageRow(
    { id: inserted.id, username: speaker.username, message: response.speech, timestamp: inserted.timestamp, kind: 'npc' },
    speaker
  );
  await upsertCooldown(db, '__npc_voice', row, col, 'npc_voice', currentTick, worldDay);

  // Model-detected hostility (subtler than the keyword floor — aggressive "rizz", veiled
  // menace) also turns the room, if the keyword pass didn't already.
  if (!provoked && response.intent === 'hostile') {
    provoked = (await provokeRoomNpcs(db, row, col)).provoked;
  }

  // Plan 013d: a plea for help, engine-gated. A friendly NPC cleric REVIVES a downed asker,
  // or TENDS a wounded (but upright) one. The model only asks (request:'heal' / a keyword
  // floor); the engine decides + executes, gated on disposition + the cleric's ability.
  let helped = null;
  if (!provoked && (response.request === 'heal' || classifyHelpRequest(last.message))) {
    const asker = await dbFirst(db, 'SELECT username, incapacitated, health, maxHealth FROM users WHERE username = ? AND isNpc = 0', [last.username]);
    const healer = asker ? npcs.find(n => n.disposition !== 'hostile' && n.job && npcCanRevive(n.job)) : null;
    if (asker && healer) {
      const healerName = healer.displayName || healer.username;
      try {
        if (asker.incapacitated) {
          const healerRow = await getUserOrNull(db, healer.username);
          await runAbility(db, 'revive', {
            username: healerName,
            effectiveActor: getEffectiveUser(healerRow),
            target: asker.username,
            row,
            col,
            currentTick
          });
          helped = { by: healer.username, action: 'revive', target: asker.username };
        } else if ((asker.health || 0) < (asker.maxHealth || 0)) {
          const askerRow = await getUserOrNull(db, asker.username);
          await applyBodyHeal(db, askerRow, NPC_HEAL_AMOUNT, { row, col });
          await insertSystemMessage(db, row, col, `${healerName} tends ${asker.username}'s wounds.`, 'support');
          helped = { by: healer.username, action: 'heal', target: asker.username };
        }
      } catch {
        // Gated/failed (e.g. target rose already) — the NPC simply couldn't; no-op.
      }
    }
  }

  return { spoke: true, npc: speaker.username, speech: response.speech, intent: response.intent, request: response.request, source: response.source, provoked, helped, messageRow };
}

// Plan 013f: a proactive ambient murmur — NPCs talking among themselves so a room feels
// inhabited even when the player is just watching. Runs from the room DO loop, ONLY with a
// human present ("alive only when observed"); the loop's wall-clock cadence paces it so
// cost stays bounded to occupied rooms. Fallback-first like every NPC line.
export async function runNpcAmbient(db, ai, row, col) {
  const worldDay = getWorldDay();
  const currentTick = await getCurrentTickValue(db);
  const presence = await getRoomPresence(db, row, col, worldDay);
  const humans = presence.filter(p => !p.isNpc);
  const npcs = presence.filter(p => p.isNpc && p.npcKind === 'social' && p.disposition !== 'hostile');
  if (humans.length === 0 || npcs.length === 0) {
    return { spoke: false };
  }

  // Campaign B (013 tail) cost monitoring (owner-locked: OBSERVE + THROTTLE, no hard cap):
  // the ambient path used to have NO per-room cooldown — a watched-idle room dripped a
  // (billed) inference every DO loop. Gate it on a per-room ambient cooldown (the existing
  // upsertCooldown/shouldApplyEffect rails, the room's own coords, effectType 'npc_ambient',
  // interval AMBIENT_VOICE_INTERVAL) so back-to-back murmurs are throttled. Checked BEFORE
  // generation, so a throttled room costs nothing. The reply path keeps its own (tighter)
  // cooldown — replies are reactive, ambient is filler.
  const ambientCooldown = await dbFirst(
    db,
    `SELECT lastAppliedTick FROM roomEffectCooldowns
     WHERE username = '__npc_ambient' AND roomRow = ? AND roomCol = ? AND effectType = 'npc_ambient' AND worldDay = ?`,
    [row, col, worldDay]
  );
  if (!shouldApplyEffect({ currentTick, lastAppliedTick: ambientCooldown ? ambientCooldown.lastAppliedTick : null, interval: AMBIENT_VOICE_INTERVAL })) {
    return { spoke: false, throttled: true };
  }

  const speaker = npcs[Math.floor(Math.random() * npcs.length)];
  const recent = await getMessages(db, row, col, currentTick);
  // adv-006: ambient murmurs read only the room description — same lightweight
  // composeRoomDescription path as the reply, not the full ecology payload.
  const roomDescription = await getRoomDescription(db, row, col, worldDay, currentTick);
  const response = await generateNpcResponse(ai, {
    npc: {
      displayName: speaker.displayName || speaker.username,
      npcKind: speaker.npcKind,
      role: speaker.role || speaker.npcKind,
      disposition: speaker.disposition
    },
    roomDescription,
    recentMessages: recent.slice(-6),
    mode: 'ambient'
  });
  if (!response.speech) {
    return { spoke: false };
  }
  const inserted = await insertMessage(db, row, col, speaker.username, response.speech, 'npc');
  // Stamp the cooldown only after a murmur actually lands (mirrors the reply path), so a
  // generation that yielded nothing doesn't burn the room's ambient window.
  await upsertCooldown(db, '__npc_ambient', row, col, 'npc_ambient', currentTick, worldDay);
  // `billed`: true only when the line came from a real (billed) inference, false on a
  // fallback — the cost signal the owner watches.
  logEvent({ event: 'npc.ambient', roomRow: row, roomCol: col, npc: speaker.username, source: response.source, billed: response.source === 'model' });
  return {
    spoke: true,
    npc: speaker.username,
    speech: response.speech,
    // adv DUR-05: self-describing broadcast row (see runNpcReply).
    messageRow: toBroadcastMessageRow(
      { id: inserted.id, username: speaker.username, message: response.speech, timestamp: inserted.timestamp, kind: 'npc' },
      speaker
    )
  };
}
