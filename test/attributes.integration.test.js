// Plan 016 coverage — spending attribute points granted by leveling.
// CommonJS + node:test to match the rest of test/.

const assert = require('node:assert/strict');
const test = require('node:test');
const { createSqliteD1, createMigratedDb } = require('./.helpers/d1');

async function seedUser(db, username, attributePoints) {
  await db.prepare(
    `INSERT INTO users
      (username, password, job, health, maxHealth, stamina, maxStamina, speed, strength, intelligence, level, gold, attributePoints)
     VALUES (?, 'pw', 'Novice', 30, 30, 100, 100, 1, 1, 1, 1, 0, ?)`
  ).bind(username, attributePoints).run();
}

async function userRow(db, username) {
  return db.prepare(
    'SELECT strength, speed, intelligence, maxStamina, attributePoints FROM users WHERE username = ?'
  ).bind(username).first();
}

// ---------------------------------------------------------------------------

test('Plan 016: allocating raises the base stat and spends exactly one point', async () => {
  const db = await createMigratedDb();
  const { allocateAttributePoint, getUserState } = await import('../worker/game.mjs');

  try {
    await seedUser(db, 'hero', 3);

    await allocateAttributePoint(db, 'hero', 'strength');
    let row = await userRow(db, 'hero');
    assert.equal(row.strength, 2, 'strength raised 1 -> 2');
    assert.equal(row.attributePoints, 2, 'one point spent (3 -> 2)');

    // The change flows through to effective stats.
    const state = await getUserState(db, 'hero');
    assert.equal(state.effectiveStats.strength, 2, 'effective strength reflects the allocation');
    assert.equal(state.attributePoints, 2);
  } finally {
    await db.close();
  }
});

test('Plan 016: maxStamina uses a larger step per point', async () => {
  const db = await createMigratedDb();
  const { allocateAttributePoint } = await import('../worker/game.mjs');

  try {
    await seedUser(db, 'hero', 1);
    await allocateAttributePoint(db, 'hero', 'maxStamina');
    const row = await userRow(db, 'hero');
    assert.equal(row.maxStamina, 105, 'maxStamina +5 (100 -> 105)');
    assert.equal(row.attributePoints, 0);
  } finally {
    await db.close();
  }
});

test('Plan 016: allocating with no points is rejected and mutates nothing', async () => {
  const db = await createMigratedDb();
  const { allocateAttributePoint } = await import('../worker/game.mjs');

  try {
    await seedUser(db, 'broke', 0);
    await assert.rejects(allocateAttributePoint(db, 'broke', 'speed'), /No attribute points/);
    const row = await userRow(db, 'broke');
    assert.equal(row.speed, 1, 'speed unchanged');
    assert.equal(row.attributePoints, 0);
  } finally {
    await db.close();
  }
});

test('Plan 016: an unknown or non-allocatable stat is rejected (allowlist holds)', async () => {
  const db = await createMigratedDb();
  const { allocateAttributePoint } = await import('../worker/game.mjs');

  try {
    await seedUser(db, 'hero', 5);
    await assert.rejects(allocateAttributePoint(db, 'hero', 'maxHealth'), /cannot raise/);
    await assert.rejects(allocateAttributePoint(db, 'hero', 'gold'), /cannot raise/);
    await assert.rejects(allocateAttributePoint(db, 'hero', 'strength; DROP TABLE users'), /cannot raise/);
    const row = await userRow(db, 'hero');
    assert.equal(row.attributePoints, 5, 'nothing spent on a rejected allocation');
  } finally {
    await db.close();
  }
});
