// engine-overhaul Phase D — papermold structural profiles over the dual-written
// body documents. A profile is a stencil ("what must this body structurally
// have"); judgment is pure and data-blind (hp is invisible — exactly right for
// this game, which reifies death structurally: severed vessels, corpses).
//
// These are ADVISORY consumers of the Phase B document today: use them for new
// mechanics (gear requirements, boss-phase checks) rather than replacing the
// battle-tested aliveness predicates until the doc is authoritative (Phase C
// flip). Nothing imports them on the hot path.

import { parseProfiles, judge, conforms, PAPERMOLD_PROTOCOL } from 'papermold';
import { getBodyDoc } from './bodyDoc.mjs';

// The game's first profile document. Vessel ids are the slugged part labels
// (bodyDoc.slugId). Extend by adding profiles — judgment never reads data.
export const GAME_PROFILE_DOCUMENT = {
  protocol: PAPERMOLD_PROTOCOL,
  profiles: {
    // Structurally whole enough to fight: head + torso present.
    'able-bodied': {
      vessels: {
        head: { exists: true },
        torso: { exists: true }
      }
    },
    // Armed: something gear-like held in either arm.
    armed: {
      atLeast: {
        n: 1,
        of: [
          { vessel: 'left-arm', check: { containsAtLeast: [{ kind: 'gear', type: 'hand' }] } },
          { vessel: 'right-arm', check: { containsAtLeast: [{ kind: 'gear', type: 'hand' }] } }
        ]
      }
    },
    // Ambulatory: legs intact (a wyrm/quadruped will fail this humanoid
    // profile — profiles are per-plan stencils, not universal truths).
    ambulatory: {
      vessels: {
        legs: { exists: true }
      }
    }
  }
};

let parsedDocument = null;
function profileDocument() {
  if (!parsedDocument) {
    const parsed = parseProfiles(GAME_PROFILE_DOCUMENT);
    if (!parsed.ok) {
      throw new Error('GAME_PROFILE_DOCUMENT invalid: ' + JSON.stringify(parsed.errors[0]));
    }
    parsedDocument = parsed.value;
  }
  return parsedDocument;
}

// Judge a live combatant's stored document against a named profile.
// Returns { known: boolean, failures: ProtocolError[] } — `known: false` when
// the user has no document yet (bodyless NPC, pre-materialization).
export async function judgeUserBody(db, username, profileId) {
  const stored = await getBodyDoc(db, username);
  if (!stored) {
    return { known: false, failures: [] };
  }
  return { known: true, failures: judge(stored.doc.body, profileDocument(), profileId) };
}

export async function userBodyConforms(db, username, profileId) {
  const stored = await getBodyDoc(db, username);
  if (!stored) {
    return null; // unknown — caller falls back to its row-based predicate
  }
  return conforms(stored.doc.body, profileDocument(), profileId);
}
