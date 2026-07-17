// engine-overhaul Phase B — the dual-written paperdoll body document.
//
// Rows (bodyParts + items) stay authoritative; every structural chokepoint
// rebuilds the document and lands it under CAS with the paperfold diff logged.
// These tests prove the Phase B contract:
//   1. materializing a body creates a valid document that AGREES with the rows
//   2. equip/sever flow through to the doc (equipped element moves vessel,
//      severed vessel disappears) and the patch log records the change
//   3. the CAS survives concurrent structural writes (two-attacker contention)
//   4. death deletes the doc; the reconcile sweep repairs induced drift
//   5. a logged sever patch INVERTS and re-applies (the Phase C/D regrow seed)

const assert = require('node:assert/strict');
const test = require('node:test');
const { createMigratedDb } = require('./.helpers/d1');
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

async function seedFighter(db, username) {
  await db.prepare(
    `INSERT INTO users
      (username, password, job, health, maxHealth, stamina, maxStamina, speed, strength, intelligence, level, gold)
     VALUES (?, 'pw', 'Fighter', 30, 30, 100, 100, 1, 4, 1, 1, 100)`
  ).bind(username).run();
}

function vesselIds(doc) {
  return Object.keys(doc.body.vessels).sort();
}

// Every non-severed part row must be a vessel; every owned item an element.
async function assertRowDocAgreement(db, game, username) {
  const stored = await game.getBodyDoc(db, username);
  assert.ok(stored, `${username} has a document`);
  const paperdoll = await import('paperdoll');
  const parsed = paperdoll.parseDocument(stored.doc);
  assert.ok(parsed.ok, 'stored document is kernel-valid');

  const parts = await db.prepare('SELECT label, severed FROM bodyParts WHERE username = ?').bind(username).all();
  for (const part of parts.results) {
    const vessel = stored.doc.body.vessels[part.label.replace(/[^a-z0-9]+/g, '-')];
    if (part.severed) {
      assert.equal(vessel, undefined, `severed ${part.label} is ABSENT from the doc`);
    } else {
      assert.ok(vessel, `part ${part.label} is a vessel`);
    }
  }
  const items = await db.prepare(
    'SELECT id FROM items WHERE ownerUsername = ?'
  ).bind(username).all();
  const docJson = JSON.stringify(stored.doc);
  for (const item of items.results) {
    assert.ok(docJson.includes(`"item-${item.id}"`), `item ${item.id} present in the doc`);
  }
  return stored;
}

test('Phase B: materializing a body dual-writes a valid, row-agreeing document', async () => {
  const db = await createMigratedDb();
  const game = await import('../worker/game.mjs');
  try {
    await seedFighter(db, 'doc_hero');
    const user = await game.getUser(db, 'doc_hero');
    await game.ensureBody(db, user);

    const stored = await assertRowDocAgreement(db, game, 'doc_hero');
    assert.equal(stored.version, 1, 'fresh doc at version 1');
    assert.ok(vesselIds(stored.doc).includes('carried'), 'carried pool vessel exists');
    assert.ok(vesselIds(stored.doc).includes('torso'), 'torso vessel exists');
  } finally {
    await db.close();
  }
});

test('Phase B: equip moves the element into the part vessel; the patch log records it', async () => {
  const db = await createMigratedDb();
  const game = await import('../worker/game.mjs');
  try {
    const calm = findCalmRoom(getWorldDay());
    await seedFighter(db, 'doc_equipper');
    const user = await game.getUser(db, 'doc_equipper');
    await game.ensureBody(db, user);
    await game.createItemForOwner(db, 'iron_cleaver', 'doc_equipper');

    // /equip through the real command dispatch (which owns the Phase B sync).
    await game.updatePresence(db, 'doc_equipper', calm.row, calm.col);
    await game.handleChatAction(db, 'doc_equipper', calm.row, calm.col, '/equip Iron Cleaver');

    const stored = await assertRowDocAgreement(db, game, 'doc_equipper');
    const equippedRow = await db.prepare(
      "SELECT i.id, bp.label FROM items i JOIN bodyParts bp ON bp.id = i.equippedPartId WHERE i.ownerUsername = 'doc_equipper'"
    ).first();
    const vessel = stored.doc.body.vessels[equippedRow.label.replace(/[^a-z0-9]+/g, '-')];
    assert.ok(
      (vessel.contains || []).some(el => el.id === `item-${equippedRow.id}`),
      'the equipped cleaver is contained by the part vessel it is equipped on'
    );

    const patches = await db.prepare(
      "SELECT cause FROM bodyPatches WHERE username = 'doc_equipper' ORDER BY id ASC"
    ).all();
    assert.ok(patches.results.some(p => p.cause === 'equip'), 'the equip patch was logged');
  } finally {
    await db.close();
  }
});

test('Phase B: a combat sever removes the vessel from the doc and logs an invertible patch', async () => {
  const db = await createMigratedDb();
  const game = await import('../worker/game.mjs');
  try {
    await seedFighter(db, 'doc_victim');
    const user = await game.getUser(db, 'doc_victim');
    await game.ensureBody(db, user);

    // Drive the left arm to 0 through the REAL damage path (applyBodyDamage
    // routes overflow; aimed part absorbs first) until it severs.
    for (let i = 0; i < 30; i += 1) {
      const fresh = await game.getUser(db, 'doc_victim');
      const parts = await game.getBodyParts(db, 'doc_victim');
      const arm = parts.find(p => p.label === 'left arm');
      if (!arm || arm.severed) break;
      await game.applyBodyDamage(db, fresh, 2, { cause: 'test blows', targetPart: 'left arm' });
    }
    const arm = (await game.getBodyParts(db, 'doc_victim')).find(p => p.label === 'left arm');
    assert.equal(arm.severed, 1, 'the arm severed');

    const stored = await assertRowDocAgreement(db, game, 'doc_victim');
    assert.equal(stored.doc.body.vessels['left-arm'], undefined, 'severed arm is absent from the doc');

    // The logged sever patch inverts (deleteVessel destruction record → insertVessel).
    const patchRow = await db.prepare(
      "SELECT patch FROM bodyPatches WHERE username = 'doc_victim' AND cause = 'sever' ORDER BY id DESC LIMIT 1"
    ).first();
    assert.ok(patchRow, 'the sever logged a patch');
    const paperfold = await import('paperfold');
    const patch = JSON.parse(patchRow.patch);
    const inverse = paperfold.invertPatch(patch);
    const regrown = paperfold.applyPatch(stored.doc.body, inverse);
    assert.ok(regrown.ok, 'the sever patch inverts and re-applies cleanly');
    assert.ok(regrown.value.vessels['left-arm'], 'inversion restores the arm vessel');
  } finally {
    await db.close();
  }
});

test('Phase B: concurrent structural writes survive the CAS (two-attacker contention)', async () => {
  const db = await createMigratedDb();
  const game = await import('../worker/game.mjs');
  try {
    await seedFighter(db, 'doc_contended');
    const user = await game.getUser(db, 'doc_contended');
    await game.ensureBody(db, user);

    // Two interleaved syncs racing the same version. The shim serializes the
    // statements, so this exercises the CAS retry rather than true parallelism —
    // the same interleave two Workers hit against real D1.
    const results = await Promise.all([
      game.syncBodyDoc(db, 'doc_contended', 'race-a'),
      game.syncBodyDoc(db, 'doc_contended', 'race-b')
    ]);
    assert.ok(results.every(r => r === true), 'both syncs settle without throwing');

    const stored = await assertRowDocAgreement(db, game, 'doc_contended');
    assert.ok(stored.version >= 1, 'version is coherent');
  } finally {
    await db.close();
  }
});

test('Phase B: death deletes the doc; the reconcile sweep repairs induced drift', async () => {
  const db = await createMigratedDb();
  const game = await import('../worker/game.mjs');
  try {
    const calm = findCalmRoom(getWorldDay());
    await seedFighter(db, 'doc_doomed');
    const user = await game.getUser(db, 'doc_doomed');
    await game.ensureBody(db, user);
    assert.ok(await game.getBodyDoc(db, 'doc_doomed'), 'doc exists while alive');

    await game.moveUserToCemetery(db, 'doc_doomed', 'a test anvil', calm.row, calm.col);
    assert.equal(await game.getBodyDoc(db, 'doc_doomed'), null, 'true death removes the document');

    // Drift repair: corrupt a live user's doc, then reconcile.
    await seedFighter(db, 'doc_drifter');
    await game.ensureBody(db, await game.getUser(db, 'doc_drifter'));
    await db.prepare(
      "UPDATE bodies SET doc = '{\"protocol\":\"paper-doll/v3\",\"body\":{\"root\":\"x\",\"vessels\":{\"x\":{}}}}' WHERE username = 'doc_drifter'"
    ).run();
    const { repaired } = await game.reconcileBodyDocs(db);
    assert.ok(repaired >= 1, 'the reconcile sweep repaired the drifted doc');
    await assertRowDocAgreement(db, game, 'doc_drifter');
  } finally {
    await db.close();
  }
});
