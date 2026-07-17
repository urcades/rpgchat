// adv ARCH-01 — the ONE transport-agnostic action pipeline.
//
// Before this module, the four HTTP action routes and the DO's
// webSocketMessage each re-implemented the same lifecycle (validate →
// idempotency claim → game handler → enrich → broadcast → post-turn tail) and
// had already drifted: the WS path supported only chat/attack, the enrichment
// block was copy-pasted, and the hostile-loop wake existed in three variants.
// Both transports are now thin adapters over:
//
//   performRoomAction(db, {...})  — validate, claim the idempotency token,
//     run the game handler, and shape the self-describing broadcast payload.
//     A throw AFTER the claim releases it so a legitimate retry isn't refused.
//   runActionTail(db, action, hooks) — the post-turn ORDER (deferred world
//     sweeps → room-loop wake → NPC reply for chat). The hooks are
//     transport-flavored: the HTTP route pings the room DO, the DO itself
//     touches its own storage/sockets — but what happens, and in what order,
//     is defined once, here.
//
// Adding a lifecycle step or a new action type is now a one-file change, and
// every action type works over BOTH transports for free.

import {
  ActionError,
  claimActionToken,
  handleAttackAction,
  handleChatAction,
  handleJobChangeAction,
  handleSkillAction,
  releaseActionToken,
  runDeferredWorldSweeps,
  toBroadcastMessageRow
} from './game.mjs';

export const ACTION_SPECS = {
  chat: {
    broadcastType: 'message',
    npcReply: true, // after a player's line lands, a present NPC may answer
    validate(payload) {
      if (!String(payload.message || '').trim()) {
        throw new ActionError('Message required.');
      }
    },
    handle(db, username, row, col, payload) {
      return handleChatAction(db, username, row, col, String(payload.message || ''));
    }
  },
  attack: {
    broadcastType: 'attack',
    validate(payload) {
      if (!String(payload.message || '').trim()) {
        throw new ActionError('Message required.');
      }
    },
    handle(db, username, row, col, payload) {
      const targetPart = payload.targetPart ? String(payload.targetPart) : null;
      return handleAttackAction(db, username, row, col, String(payload.message || ''), targetPart);
    }
  },
  skill: {
    broadcastType: 'skill',
    handle(db, username, row, col, payload, roomUse) {
      const skillId = String(payload.skillId || '');
      const targetUsername = String(payload.targetUsername || payload.message || '');
      return handleSkillAction(db, username, row, col, skillId, targetUsername, roomUse.tickValue + 1);
    }
  },
  job: {
    broadcastType: 'job',
    handle(db, username, row, col, payload, roomUse) {
      return handleJobChangeAction(db, username, row, col, String(payload.job || ''), roomUse);
    }
  }
};

export function isActionType(type) {
  return Boolean(ACTION_SPECS[type]);
}

// `user` is the already-fetched auth/user row (it also supplies the broadcast
// enrichment fields); `payload` is the parsed form body (HTTP) or the WS frame
// — both carry the idempotency token as `actionToken`/`token`.
export async function performRoomAction(db, { type, user, row, col, payload, roomUse }) {
  const spec = ACTION_SPECS[type];
  if (!spec) {
    throw new ActionError(`Unsupported action '${type}'.`, 400);
  }
  if (spec.validate) {
    spec.validate(payload);
  }
  const token = payload.actionToken ?? payload.token;
  if (!(await claimActionToken(db, user.username, token))) {
    // Another transport already applied this exact action (the lost-ack
    // replay); tell the caller to ack it without re-applying.
    return { duplicate: true, type, broadcastType: spec.broadcastType };
  }
  let result;
  try {
    result = await spec.handle(db, user.username, row, col, payload, roomUse);
  } catch (err) {
    // The action did NOT apply — free the token so a retry isn't refused.
    await releaseActionToken(db, user.username, token);
    throw err;
  }
  // Self-describing frames: `messageRows` (attack — the attack line plus its
  // deferred system lines) or `messageRow` (chat) ride in the broadcast so
  // clients append them directly — no debounced room-state refetch just to see
  // the text. System rows get no author enrichment; the actor's rows get the
  // already-fetched user row's job/displayName.
  const enrichedRows = Array.isArray(result.messageRows) && result.messageRows.length > 0
    ? result.messageRows.map(rowData =>
      toBroadcastMessageRow(rowData, rowData.username === user.username ? user : {}))
    : result.messageRow
      ? [toBroadcastMessageRow(result.messageRow, user)]
      : undefined;
  return {
    duplicate: false,
    type,
    broadcastType: spec.broadcastType,
    npcReply: Boolean(spec.npcReply),
    result,
    broadcastPayload: {
      type: spec.broadcastType,
      username: user.username,
      result,
      ...(enrichedRows ? { messages: enrichedRows } : {})
    }
  };
}

// The post-turn tail, in its one canonical order. Hooks:
//   wakeLoop() — start/keep the room's DO loop if the room needs it
//   npcReply() — give a present NPC a chance to answer (chat only)
// Both are transport-flavored; either may be omitted by callers that cannot
// perform them.
export async function runActionTail(db, action, { wakeLoop, npcReply } = {}) {
  await runDeferredWorldSweeps(db, action.result?.tick?.tick);
  if (wakeLoop) {
    await wakeLoop();
  }
  if (action.npcReply && npcReply) {
    await npcReply();
  }
}
