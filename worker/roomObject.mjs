// The RoomObject Durable Object, split out of worker/index.mjs mechanically —
// no logic change. index.mjs re-exports it so the wrangler DO class binding
// (entry-module class name) and existing tests resolve unchanged.
import { DurableObject } from 'cloudflare:workers';
import { requireLiveUser } from './auth.mjs';
import {
  ActionError,
  getRoomLoopState,
  getUserOrNull,
  requireRoomUse,
  roomHasActiveHostiles,
  roomNeedsLoop,
  runHostileRoomAction,
  runNpcAmbient,
  runNpcReply
} from './game.mjs';
import { isActionType, performRoomAction, runActionTail } from './actions.mjs';
import { guard } from './observability.mjs';

export class RoomObject extends DurableObject {
  async fetch(request) {
    const url = new URL(request.url);
    const worldPulseMatch = url.pathname.match(/^\/world-pulse\/(\d+)\/(\d+)$/);
    if (worldPulseMatch && request.method === 'POST') {
      const row = Number.parseInt(worldPulseMatch[1], 10);
      const col = Number.parseInt(worldPulseMatch[2], 10);
      let payload = { type: 'world-pulse' };
      try {
        payload = await request.json();
      } catch {
        payload = { type: 'world-pulse' };
      }
      await this.broadcast({ room: { row, col }, ...payload });
      if (await roomHasActiveHostiles(this.env.DB, row, col)) {
        await this.ctx.storage.put('hostileRoom', { row, col });
        // Same guard as /hostiles/start: never reset (and thus starve) a pending
        // combat alarm — the alarm handler owns re-arming.
        if (await this.ctx.storage.getAlarm() === null) {
          await this.ctx.storage.setAlarm(Date.now() + 5000);
        }
      }
      return new Response('ok');
    }

    const hostileMatch = url.pathname.match(/^\/hostiles\/(\d+)\/(\d+)\/start$/);
    if (hostileMatch && request.method === 'POST') {
      const row = Number.parseInt(hostileMatch[1], 10);
      const col = Number.parseInt(hostileMatch[2], 10);
      await this.ctx.storage.put('hostileRoom', { row, col });
      // Plan 013f: only arm if no alarm is pending — frequent presence heartbeats must NOT
      // keep resetting (and thus starving) the loop. The alarm handler owns re-arming.
      if (await this.ctx.storage.getAlarm() === null) {
        await this.ctx.storage.setAlarm(Date.now() + 5000);
      }
      return new Response('ok');
    }

    // Plan 013a: let an NPC react to what a player just said. The model (this.env.AI)
    // is reached only here in the DO, never in a route's latency path; runNpcReply is
    // fallback-first, so a missing/slow binding degrades to a canned line.
    const npcReactMatch = url.pathname.match(/^\/npc-react\/(\d+)\/(\d+)$/);
    if (npcReactMatch && request.method === 'POST') {
      const row = Number.parseInt(npcReactMatch[1], 10);
      const col = Number.parseInt(npcReactMatch[2], 10);
      try {
        const result = await runNpcReply(this.env.DB, this.env.AI, row, col);
        if (result.spoke) {
          // Self-describing (adv DUR-05): the row rides along so clients append
          // it directly — no follow-up fetch that a lagging read replica could miss.
          await this.broadcast({
            type: 'message',
            room: { row, col },
            username: result.npc,
            ...(result.messageRow ? { messages: [result.messageRow] } : {})
          });
        }
        // Plan 013c: hostile speech can flip the room's NPCs — wake the combat loop so
        // they actually come for the player.
        if (result.provoked > 0) {
          await this.ctx.storage.put('hostileRoom', { row, col });
          if (await this.ctx.storage.getAlarm() === null) {
            await this.ctx.storage.setAlarm(Date.now() + 5000);
          }
        }
      } catch (err) {
        console.error('npc-react failed', err);
      }
      return new Response('ok');
    }

    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected WebSocket upgrade', { status: 426 });
    }

    const auth = await requireLiveUser(this.env, request);
    if (!auth.user) {
      return new Response('Login required', { status: auth.dead ? 410 : 401 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server, [auth.user.username]);
    // The socket carries its own identity + room so webSocketMessage() can
    // dispatch actions without re-authing — auth happened at upgrade, and the
    // attachment survives hibernation.
    const wsCoordinates = url.pathname.match(/^\/ws\/(\d+)\/(\d+)$/);
    server.serializeAttachment({
      username: auth.user.username,
      row: wsCoordinates ? Number.parseInt(wsCoordinates[1], 10) : null,
      col: wsCoordinates ? Number.parseInt(wsCoordinates[2], 10) : null
    });
    server.send(JSON.stringify({ type: 'connected', username: auth.user.username }));
    return new Response(null, { status: 101, webSocket: client });
  }

  sendSafe(socket, payload) {
    try {
      socket.send(JSON.stringify(payload));
    } catch {
      // The socket died mid-send; the lazy reap in broadcast() handles cleanup.
    }
  }

  // Actions over the socket: the client sends {type:'chat'|'attack', message,
  // targetPart?, seq} and gets an {type:'ack'|'action-error', seq} frame back.
  // Auth rode the upgrade (attachment); the room-use gate and the full game
  // logic are the SAME calls the HTTP routes make — only the transport differs.
  // The ack is sent before the broadcast + post-turn tail so the sender's
  // perceived latency is just the action itself.
  async webSocketMessage(ws, raw) {
    let frame = null;
    try {
      frame = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw));
    } catch {
      return; // not ours — ignore
    }
    // adv ARCH-01: any action type the shared pipeline knows works over the
    // socket — chat/attack today from the client, skill/job for free.
    if (!frame || !isActionType(frame.type)) {
      return;
    }
    const seq = Number(frame.seq) || 0;
    const attachment = (typeof ws.deserializeAttachment === 'function' ? ws.deserializeAttachment() : null) || {};
    const { username, row, col } = attachment;
    if (!username || !Number.isInteger(row) || !Number.isInteger(col)) {
      this.sendSafe(ws, { type: 'action-error', seq, message: 'Reconnect required.', status: 401 });
      return;
    }

    const db = this.env.DB;
    try {
      // The user row gates liveness AND supplies the enrichment fields —
      // one read, mirroring what the HTTP path's auth join provides.
      const user = await getUserOrNull(db, username);
      if (!user || user.isNpc) {
        this.sendSafe(ws, { type: 'dead', seq });
        return;
      }
      const roomUse = await requireRoomUse(db, username, row, col);
      if (!roomUse.allowed) {
        throw new ActionError('Inn access required', 403);
      }

      const performed = await performRoomAction(db, {
        type: frame.type,
        user,
        row,
        col,
        payload: frame,
        roomUse
      });
      if (performed.duplicate) {
        // Another transport already applied this exact action (lost-ack replay);
        // its broadcast already reached the room — just settle the client.
        this.sendSafe(ws, { type: 'ack', seq, action: performed.broadcastType, duplicate: true });
        return;
      }

      // The ack goes out before the broadcast + tail so the sender's perceived
      // latency is just the action itself.
      this.sendSafe(ws, { type: 'ack', seq, action: performed.broadcastType, result: performed.result });
      await this.broadcast({ room: { row, col }, ...performed.broadcastPayload });

      // Post-turn tail — same ORDER as the HTTP routes (runActionTail owns it),
      // with DO-flavored hooks: this object IS the room, so it touches its own
      // storage/sockets instead of pinging a stub.
      await guard('ws-action.tail.error', async () => {
        await runActionTail(db, performed, {
          wakeLoop: async () => {
            if (await roomNeedsLoop(db, row, col)) {
              await this.ctx.storage.put('hostileRoom', { row, col });
              if (await this.ctx.storage.getAlarm() === null) {
                await this.ctx.storage.setAlarm(Date.now() + 5000);
              }
            }
          },
          npcReply: async () => {
            const reply = await runNpcReply(db, this.env.AI, row, col);
            if (reply.spoke) {
              await this.broadcast({
                type: 'message',
                room: { row, col },
                username: reply.npc,
                ...(reply.messageRow ? { messages: [reply.messageRow] } : {})
              });
            }
            if (reply.provoked > 0) {
              await this.ctx.storage.put('hostileRoom', { row, col });
              if (await this.ctx.storage.getAlarm() === null) {
                await this.ctx.storage.setAlarm(Date.now() + 5000);
              }
            }
          }
        });
      }, { fields: { roomRow: row, roomCol: col, username } });
    } catch (err) {
      const status = (err && err.statusCode) || 500;
      this.sendSafe(ws, {
        type: 'action-error',
        seq,
        message: status >= 500 ? 'Internal Server Error' : err.message,
        status
      });
      if (status >= 500) {
        console.error('ws action failed', err);
      }
    }
  }

  async broadcast(payload) {
    const message = JSON.stringify(payload);
    for (const socket of this.ctx.getWebSockets()) {
      try {
        socket.send(message);
      } catch {
        socket.close(1011, 'Unable to deliver message');
      }
    }
  }

  async alarm() {
    const room = await this.ctx.storage.get('hostileRoom');
    if (!room) {
      return;
    }

    // Plan 013f: one loop drives both combat and ambient life. If the room is in combat,
    // run the hostile action (5s cadence). Otherwise a present-but-peaceful social room
    // gets a throttled NPC murmur (slower cadence; runNpcAmbient owns the real throttle).
    const fields = { roomRow: room.row, roomCol: room.col };
    // adv PERF-06: ONE loop-state scan answers both the branch choice here and
    // (for the peaceful branch, which cannot change the state) the re-arm
    // decision below — previously two identical queries per wake.
    const loopState = await guard('alarm.loop-state.error', () =>
      getRoomLoopState(this.env.DB, room.row, room.col),
    { fields, fallback: null });
    if (!loopState) {
      // Couldn't read the state; retry on the fast cadence rather than guessing.
      await guard('alarm.rearm.retry-failed', async () => {
        await this.ctx.storage.setAlarm(Date.now() + 5000);
      }, { fields });
      return;
    }
    let peaceful = true;
    if (loopState.hasActiveHostiles) {
      // peaceful is fixed BEFORE the guarded action so a throwing hostile turn still
      // re-arms on the fast (5s) combat cadence below, not the slow peaceful one.
      peaceful = false;
      // Boundary: previously UNGUARDED. A throw here escaped alarm() entirely, so the
      // re-arm tail never ran and the room's combat loop died silently. guard() catches +
      // logs + continues so the loop survives one bad turn (matching the ambient branch).
      await guard('alarm.hostile.error', async () => {
        const result = await runHostileRoomAction(this.env.DB, room.row, room.col);
        await this.broadcast({ type: 'hostile', room, result });
      }, { fields });
    } else {
      await guard('alarm.ambient.error', async () => {
        const ambient = await runNpcAmbient(this.env.DB, this.env.AI, room.row, room.col);
        if (ambient.spoke) {
          await this.broadcast({
            type: 'message',
            room,
            username: ambient.npc,
            ...(ambient.messageRow ? { messages: [ambient.messageRow] } : {})
          });
        }
      }, { fields });
    }

    // Re-arm tail: this MUST run even after a caught action error above so the loop
    // proceeds. It is itself guarded so a transient DB hiccup while deciding whether to
    // continue still re-arms a retry instead of wedging the alarm permanently.
    const rearmed = await guard('alarm.rearm.error', async () => {
      // A hostile turn can end combat (deaths, flee), so that branch re-reads;
      // the ambient branch mutates nothing loop-relevant, so its earlier read
      // is still authoritative and the second query is skipped.
      const needsLoop = peaceful
        ? loopState.needsLoop
        : await roomNeedsLoop(this.env.DB, room.row, room.col);
      if (needsLoop) {
        await this.ctx.storage.setAlarm(Date.now() + (peaceful ? 12000 : 5000));
      } else {
        await this.ctx.storage.delete('hostileRoom');
      }
      return true;
    }, { fields, fallback: false });

    if (!rearmed) {
      // Deciding whether to continue threw; retry on the next cadence rather than
      // leaving the loop dead. The follow-up alarm will re-evaluate roomNeedsLoop.
      await guard('alarm.rearm.retry-failed', async () => {
        await this.ctx.storage.setAlarm(Date.now() + (peaceful ? 12000 : 5000));
      }, { fields });
    }
  }
}
