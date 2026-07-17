// Actions over the WebSocket: RoomObject.webSocketMessage dispatches chat/attack
// frames through the SAME game logic as the HTTP routes, acks the sender, and
// broadcasts a self-describing frame (enriched message rows) to the room.
//
// worker/index.mjs is imported with `cloudflare:workers` stubbed (the shared
// errorBoundaries/roomAlarmCadence pattern); RoomObject is constructed directly
// with a mocked ctx and a real migrated D1.

const assert = require('node:assert/strict');
const test = require('node:test');
const { registerHooks } = require('node:module');
const { createMigratedDb } = require('./.helpers/d1');
const { getWorldDay } = require('../utils/roomEcology');

const CF_STUB_URL = 'cfstub:workers-wsactions';
const CF_STUB_SOURCE =
  'export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }';

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'cloudflare:workers') {
      return { url: CF_STUB_URL, shortCircuit: true };
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url === CF_STUB_URL) {
      return { format: 'module', shortCircuit: true, source: CF_STUB_SOURCE };
    }
    return next(url, context);
  }
});

async function quiet(fn) {
  const originalLog = console.log;
  const originalError = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

function mockSocket(attachment) {
  return {
    sent: [],
    send(raw) {
      this.sent.push(JSON.parse(raw));
    },
    deserializeAttachment() {
      return attachment;
    }
  };
}

function mockCtx(sockets) {
  return {
    storage: {
      _store: new Map(),
      _alarm: null,
      async get(key) { return this._store.get(key); },
      async put(key, value) { this._store.set(key, value); },
      async delete(key) { this._store.delete(key); },
      async setAlarm(time) { this._alarm = time; },
      async getAlarm() { return this._alarm; }
    },
    getWebSockets() {
      return sockets;
    }
  };
}

async function seedPlayer(db, username, row, col, worldDay) {
  await db.prepare(
    `INSERT INTO users
      (username, password, job, health, maxHealth, stamina, maxStamina, speed, strength, intelligence, displayName)
     VALUES (?, 'pw', 'Novice', 30, 30, 100, 100, 1, 1, 1, ?)`
  ).bind(username, username).run();
  await db.prepare(
    `INSERT INTO roomPresence (username, roomRow, roomCol, lastSeenTick, worldDay, lastSeenAt)
     VALUES (?, ?, ?, 0, ?, CURRENT_TIMESTAMP)`
  ).bind(username, row, col, worldDay).run();
}

test('ws chat action: ack to sender, enriched broadcast to the room, message persisted', async () => {
  const mod = await import('../worker/index.mjs');
  const db = await createMigratedDb();
  try {
    const worldDay = getWorldDay();
    await seedPlayer(db, 'ws_hero', 5, 5, worldDay);

    const sender = mockSocket({ username: 'ws_hero', row: 5, col: 5 });
    const peer = mockSocket({ username: 'ws_peer', row: 5, col: 5 });
    const room = new mod.RoomObject(mockCtx([sender, peer]), { DB: db, AI: {} });

    await quiet(() => room.webSocketMessage(sender, JSON.stringify({ type: 'chat', message: 'hello room', seq: 7 })));

    const ack = sender.sent.find(frame => frame.type === 'ack');
    assert.ok(ack, 'sender got an ack');
    assert.equal(ack.seq, 7);
    assert.equal(ack.result.message, 'hello room');

    const broadcast = peer.sent.find(frame => frame.type === 'message');
    assert.ok(broadcast, 'the room got the message broadcast');
    assert.ok(Array.isArray(broadcast.messages) && broadcast.messages.length === 1, 'frame is self-describing');
    assert.equal(broadcast.messages[0].message, 'hello room');
    assert.equal(broadcast.messages[0].username, 'ws_hero');
    assert.ok(broadcast.messages[0].id > 0, 'row id rides along');
    assert.equal(broadcast.messages[0].job, 'Novice', 'enriched with the author job');

    const row = await db.prepare(
      "SELECT username, message FROM messages WHERE kind = 'chat' ORDER BY id DESC LIMIT 1"
    ).bind().first();
    assert.equal(row.message, 'hello room', 'the row persisted');

    const user = await db.prepare('SELECT stamina FROM users WHERE username = ?').bind('ws_hero').first();
    assert.equal(user.stamina, 99, 'the action spent stamina like the HTTP path');
  } finally {
    await db.close();
  }
});

test('ws action against a dead/missing user answers a dead frame, never throws', async () => {
  const mod = await import('../worker/index.mjs');
  const db = await createMigratedDb();
  try {
    const ghost = mockSocket({ username: 'ws_ghost', row: 5, col: 5 });
    const room = new mod.RoomObject(mockCtx([ghost]), { DB: db, AI: {} });

    await quiet(() => room.webSocketMessage(ghost, JSON.stringify({ type: 'chat', message: 'am I alive?', seq: 1 })));

    assert.ok(ghost.sent.some(frame => frame.type === 'dead'), 'dead frame sent');
    assert.equal(ghost.sent.some(frame => frame.type === 'ack'), false, 'no ack');
  } finally {
    await db.close();
  }
});

test('ws action errors (empty message / bad frame) answer action-error or are ignored', async () => {
  const mod = await import('../worker/index.mjs');
  const db = await createMigratedDb();
  try {
    const worldDay = getWorldDay();
    await seedPlayer(db, 'ws_mute', 6, 6, worldDay);
    const socket = mockSocket({ username: 'ws_mute', row: 6, col: 6 });
    const room = new mod.RoomObject(mockCtx([socket]), { DB: db, AI: {} });

    await quiet(() => room.webSocketMessage(socket, JSON.stringify({ type: 'chat', message: '   ', seq: 3 })));
    const error = socket.sent.find(frame => frame.type === 'action-error');
    assert.ok(error, 'empty message answers action-error');
    assert.equal(error.seq, 3);
    assert.equal(error.message, 'Message required.');

    socket.sent.length = 0;
    await quiet(() => room.webSocketMessage(socket, 'not json at all'));
    await quiet(() => room.webSocketMessage(socket, JSON.stringify({ type: 'unknown' })));
    assert.equal(socket.sent.length, 0, 'garbage and unknown frames are ignored');
  } finally {
    await db.close();
  }
});

test('ws attack action: broadcast is self-describing (attack line + system lines ride along)', async () => {
  const mod = await import('../worker/index.mjs');
  const db = await createMigratedDb();
  try {
    const worldDay = getWorldDay();
    await seedPlayer(db, 'ws_striker', 6, 6, worldDay);
    await seedPlayer(db, 'ws_dummy', 6, 6, worldDay);

    const sender = mockSocket({ username: 'ws_striker', row: 6, col: 6 });
    const peer = mockSocket({ username: 'ws_dummy', row: 6, col: 6 });
    const room = new mod.RoomObject(mockCtx([sender, peer]), { DB: db, AI: {} });

    await quiet(() => room.webSocketMessage(sender, JSON.stringify({
      type: 'attack', message: 'attack ws_dummy', seq: 11
    })));

    const ack = sender.sent.find(frame => frame.type === 'ack');
    assert.ok(ack, 'attacker got an ack');
    assert.ok(Array.isArray(ack.result.messageRows) && ack.result.messageRows.length >= 1,
      'the result carries the formed rows');

    const broadcast = peer.sent.find(frame => frame.type === 'attack');
    assert.ok(broadcast, 'the room got the attack broadcast');
    assert.ok(Array.isArray(broadcast.messages) && broadcast.messages.length >= 1,
      'the attack frame is self-describing — clients need no refetch to render the lines');
    const attackRow = broadcast.messages[0];
    assert.equal(attackRow.username, 'ws_striker', 'first row is the attack line, authored by the attacker');
    assert.ok(attackRow.id > 0, 'real row ids ride along');
    assert.equal(attackRow.job, 'Novice', 'attacker rows are enriched');
    // Every broadcast row exists in the DB with a matching id (batch insert ids are real).
    for (const rowData of broadcast.messages) {
      const persisted = await db.prepare('SELECT username, message FROM messages WHERE id = ?').bind(rowData.id).first();
      assert.ok(persisted, `row ${rowData.id} persisted`);
      assert.equal(persisted.message, rowData.message, 'broadcast text matches the persisted row');
    }
  } finally {
    await db.close();
  }
});
