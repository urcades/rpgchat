// Plan 008 server coverage — system messages persist a typed `kind` so the
// client can style them without regexing English prose, and getMessages surfaces
// it. CommonJS + node:test to match the rest of test/.

const assert = require('node:assert/strict');
const test = require('node:test');
const { createSqliteD1, createMigratedDb } = require('./.helpers/d1');
const { getWorldDay, generateRoomFeatures } = require('../utils/roomEcology');

function findCalmRoom(worldDay) {
  const hazardous = ['poison_marsh', 'moon_room', 'echo_chamber', 'pub', 'inn', 'sun_room', 'cold_room', 'guild'];
  for (let row = 1; row <= 16; row += 1) {
    for (let col = 1; col <= 16; col += 1) {
      const types = generateRoomFeatures(row, col, worldDay).map(f => f.effect?.type);
      if (!types.some(t => hazardous.includes(t))) {
        return { row, col };
      }
    }
  }
  throw new Error('No calm room for ' + worldDay);
}

async function seedLiveUser(db, username, job = 'Novice') {
  await db.prepare(
    `INSERT INTO users
      (username, password, job, health, maxHealth, stamina, maxStamina, speed, strength, intelligence, level, gold)
     VALUES (?, 'pw', ?, 30, 30, 100, 100, 1, 1, 1, 0, 0)`
  ).bind(username, job).run();
}

async function kindOf(db, like) {
  const row = await db.prepare('SELECT kind FROM messages WHERE message LIKE ? ORDER BY id DESC LIMIT 1').bind(like).first();
  return row && row.kind;
}

// ---------------------------------------------------------------------------

test('Plan 008: chat, skill, and support messages persist their kind', async () => {
  const db = await createMigratedDb();
  const { handleChatAction, handleSkillAction, getCurrentTickValue, getUserState, updatePresence } = await import('../worker/game.mjs');

  try {
    const calm = findCalmRoom(getWorldDay());
    await seedLiveUser(db, 'novice', 'Novice');
    await seedLiveUser(db, 'cleric', 'Cleric');
    await seedLiveUser(db, 'ally', 'Novice');
    for (const name of ['novice', 'cleric', 'ally']) {
      await updatePresence(db, name, calm.row, calm.col);
      await getUserState(db, name); // instantiate bodies
    }
    const tick = await getCurrentTickValue(db);

    await handleChatAction(db, 'novice', calm.row, calm.col, 'hello there');
    assert.equal(await kindOf(db, 'hello there'), 'chat', 'a plain chat line is kind=chat');

    await handleSkillAction(db, 'novice', calm.row, calm.col, 'scrounge', '', tick);
    assert.equal(await kindOf(db, 'novice scrounges%'), 'skill', 'scrounge is kind=skill');

    await handleSkillAction(db, 'cleric', calm.row, calm.col, 'bless', 'ally', tick);
    assert.equal(await kindOf(db, 'cleric blesses%'), 'support', 'bless is kind=support');
  } finally {
    await db.close();
  }
});

test('Plan 008: death writes kind=death and getMessages surfaces the kind field', async () => {
  const db = await createMigratedDb();
  const { handleChatAction, moveUserToCemetery, getMessages, updatePresence } = await import('../worker/game.mjs');

  try {
    const calm = findCalmRoom(getWorldDay());
    await seedLiveUser(db, 'doomed', 'Novice');
    await updatePresence(db, 'doomed', calm.row, calm.col);

    await handleChatAction(db, 'doomed', calm.row, calm.col, 'last words');
    await moveUserToCemetery(db, 'doomed', 'a falling rock', calm.row, calm.col);

    assert.equal(await kindOf(db, 'doomed has died from%'), 'death', 'death line is kind=death');

    const messages = await getMessages(db, calm.row, calm.col);
    const chat = messages.find(m => m.message === 'last words');
    const death = messages.find(m => m.message.startsWith('doomed has died from'));
    assert.equal(chat.kind, 'chat', 'getMessages surfaces kind on chat lines');
    assert.equal(death.kind, 'death', 'getMessages surfaces kind on death lines');
  } finally {
    await db.close();
  }
});

test('getMessages sinceId returns only rows newer than the watermark (delta path)', async () => {
  const db = await createMigratedDb();
  const { getMessages, insertMessage } = await import('../worker/game.mjs');
  try {
    await seedLiveUser(db, 'delta_talker');
    await insertMessage(db, 3, 3, 'delta_talker', 'first line');
    await insertMessage(db, 3, 3, 'delta_talker', 'second line');
    const all = await getMessages(db, 3, 3);
    assert.equal(all.length, 2, 'full fetch sees both');
    const watermark = all[0].id;

    const delta = await getMessages(db, 3, 3, null, watermark);
    assert.equal(delta.length, 1, 'delta fetch sees only the newer row');
    assert.equal(delta[0].message, 'second line');
    assert.equal(delta[0].job, 'Novice', 'delta rows stay enriched');

    const junk = await getMessages(db, 3, 3, null, 'not-a-number');
    assert.equal(junk.length, 2, 'non-numeric since falls back to the full window');
  } finally {
    await db.close();
  }
});

test('getMessages sinceId fills a >LIMIT gap oldest-first so no rows are skipped', async () => {
  const db = await createMigratedDb();
  const { getMessages, insertMessage } = await import('../worker/game.mjs');
  const { ROOM_MESSAGE_HISTORY_LIMIT } = await import('../worker/game/shared.mjs');
  try {
    await seedLiveUser(db, 'burst_talker');
    await insertMessage(db, 4, 4, 'burst_talker', 'cursor line');
    const before = await getMessages(db, 4, 4);
    const watermark = before[0].id;

    // A burst bigger than the window lands after the cursor.
    const burst = ROOM_MESSAGE_HISTORY_LIMIT + 20;
    for (let i = 0; i < burst; i++) {
      await insertMessage(db, 4, 4, 'burst_talker', `burst ${i}`);
    }

    // Page 1: the OLDEST rows of the gap, ascending — not the newest 100.
    const page1 = await getMessages(db, 4, 4, null, watermark);
    assert.equal(page1.length, ROOM_MESSAGE_HISTORY_LIMIT, 'delta page is capped at the window');
    assert.equal(page1[0].message, 'burst 0', 'the page starts at the cursor, not the top');
    assert.ok(page1.every((row, i) => i === 0 || row.id > page1[i - 1].id), 'rows ascend');

    // Page 2 from the new watermark drains the remainder — nothing was skipped.
    const page2 = await getMessages(db, 4, 4, null, page1[page1.length - 1].id);
    assert.equal(page2.length, burst - ROOM_MESSAGE_HISTORY_LIMIT, 'the rest of the gap arrives');
    assert.equal(page2[page2.length - 1].message, `burst ${burst - 1}`);
  } finally {
    await db.close();
  }
});
