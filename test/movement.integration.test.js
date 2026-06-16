// Plan 009 coverage — adjacency-constrained movement. First placement of the
// world day is free; after that, only Chebyshev-distance-1 rooms are reachable.
// CommonJS + node:test to match the rest of test/.

const assert = require('node:assert/strict');
const test = require('node:test');
const { createSqliteD1, createMigratedDb } = require('./.helpers/d1');

async function seedLiveUser(db, username) {
  await db.prepare(
    `INSERT INTO users
      (username, password, job, health, maxHealth, stamina, maxStamina, speed, strength, intelligence, level, gold)
     VALUES (?, 'pw', 'Novice', 30, 30, 100, 100, 1, 1, 1, 0, 0)`
  ).bind(username).run();
}

// ---------------------------------------------------------------------------

test('Plan 009: the first placement of the day is free (spawn anywhere)', async () => {
  const db = await createMigratedDb();
  const { validateMovement } = await import('../worker/game.mjs');
  try {
    await seedLiveUser(db, 'wanderer');
    const result = await validateMovement(db, 'wanderer', 9, 9);
    assert.deepEqual(result, { allowed: true, first: true });
  } finally {
    await db.close();
  }
});

test('Plan 009: adjacent rooms (incl. diagonals and staying put) are reachable', async () => {
  const db = await createMigratedDb();
  const { validateMovement, updatePresence } = await import('../worker/game.mjs');
  try {
    await seedLiveUser(db, 'walker');
    await updatePresence(db, 'walker', 5, 5); // now standing at (5,5)

    assert.equal((await validateMovement(db, 'walker', 6, 6)).allowed, true, 'diagonal step allowed');
    assert.equal((await validateMovement(db, 'walker', 4, 5)).allowed, true, 'orthogonal step allowed');
    assert.equal((await validateMovement(db, 'walker', 5, 5)).allowed, true, 'staying in place (distance 0) allowed');
    // The non-first moves report where you came from, not first:true.
    assert.equal((await validateMovement(db, 'walker', 6, 6)).first, undefined);
  } finally {
    await db.close();
  }
});

test('Plan 009: distant rooms are rejected, and requireRoomUse throws Too far to walk', async () => {
  const db = await createMigratedDb();
  const { validateMovement, requireRoomUse, updatePresence } = await import('../worker/game.mjs');
  try {
    await seedLiveUser(db, 'walker');
    await updatePresence(db, 'walker', 5, 5);

    const far = await validateMovement(db, 'walker', 8, 5); // distance 3
    assert.equal(far.allowed, false);
    assert.deepEqual(far.from, { row: 5, col: 5 });

    await assert.rejects(
      requireRoomUse(db, 'walker', 8, 5),
      /Too far to walk/,
      'acting in an unreachable room is rejected (closes the curl loophole)'
    );
    // ...and the adjacent room still passes the gate.
    await assert.doesNotReject(requireRoomUse(db, 'walker', 6, 6));
  } finally {
    await db.close();
  }
});

test('Plan 009: NPC placement is exempt — it never goes through the movement gate', async () => {
  const db = await createMigratedDb();
  const { createNpcForEvent } = await import('../worker/game.mjs');
  try {
    const npc = {
      username: 'wraith_test', displayName: 'Wraith', npcKind: 'raid_add',
      worldEventId: 'test-event', health: 10, stamina: 100, speed: 5, strength: 5, intelligence: 1
    };
    await createNpcForEvent(db, { ...npc, row: 1, col: 1 });
    // A respawn clear across the map — no adjacency rule applies to NPCs.
    await createNpcForEvent(db, { ...npc, row: 16, col: 16 });

    const pos = await db.prepare("SELECT roomRow, roomCol FROM roomPresence WHERE username = 'wraith_test'").first();
    assert.deepEqual({ row: pos.roomRow, col: pos.roomCol }, { row: 16, col: 16 }, 'NPC moved freely across the grid');
  } finally {
    await db.close();
  }
});

test('Plan 009: a new world day resets position to free placement', async () => {
  const db = await createMigratedDb();
  const { validateMovement } = await import('../worker/game.mjs');
  try {
    await seedLiveUser(db, 'timetraveler');
    // Yesterday's position — keyed by an old worldDay, so today there is no row.
    await db.prepare(
      `INSERT INTO roomPresence (username, roomRow, roomCol, lastSeenTick, worldDay)
       VALUES ('timetraveler', 1, 1, 0, '2000-01-01')`
    ).run();

    const result = await validateMovement(db, 'timetraveler', 16, 16);
    assert.deepEqual(result, { allowed: true, first: true }, 'a fresh day frees movement regardless of yesterday');
  } finally {
    await db.close();
  }
});
