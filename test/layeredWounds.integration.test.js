// Layered wounds (engine-overhaul, after paperdoll-viewer's DF-style tissues):
// tissue depth derived from the struck part's hp ratio, weapon-class × layer
// flavor, and BLEED as a native tick-oriented status riding the existing
// statusEffects sweep (stacking, cleansable, killing).

const assert = require('node:assert/strict');
const test = require('node:test');
const { createMigratedDb } = require('./.helpers/d1');
const { layerPhrase } = require('../utils/combatFlavor');

async function seedTough(db, username, health = 100) {
  await db.prepare(
    `INSERT INTO users
      (username, password, job, health, maxHealth, stamina, maxStamina, speed, strength, intelligence, level)
     VALUES (?, 'pw', 'Fighter', ?, ?, 100, 100, 1, 4, 1, 1)`
  ).bind(username, health, health).run();
}

test('tissue layers derive from the part hp ratio: fresh=skin, worn=muscle, ruined=bone', async () => {
  const db = await createMigratedDb();
  const game = await import('../worker/game.mjs');
  try {
    await seedTough(db, 'layered');
    await game.ensureBody(db, await game.getUser(db, 'layered'));
    // Torso pool at 100 hp = 30. Successive blows walk down the layers.
    const first = await game.applyBodyDamage(db, await game.getUser(db, 'layered'), 3, {
      cause: 't', targetLabel: 'torso', weaponClass: 'blade', row: 1, col: 1
    });
    assert.equal(first.struckLayer, 'skin', 'a fresh torso takes skin wounds');
    let mid = null;
    for (let i = 0; i < 5; i += 1) {
      mid = await game.applyBodyDamage(db, await game.getUser(db, 'layered'), 3, {
        cause: 't', targetLabel: 'torso', weaponClass: 'blade', row: 1, col: 1
      });
      if (mid.struckLayer === 'muscle') break;
    }
    assert.equal(mid.struckLayer, 'muscle', 'a worn torso exposes muscle');
  } finally {
    await db.close();
  }
});

test('edged wounds past the skin BLEED (and the flavor names the layer); blunt does not', async () => {
  const db = await createMigratedDb();
  const game = await import('../worker/game.mjs');
  try {
    // Edged into muscle -> bleed applied + "Blood wells" line.
    await seedTough(db, 'bleeder');
    await game.ensureBody(db, await game.getUser(db, 'bleeder'));
    for (let i = 0; i < 6; i += 1) {
      await game.applyBodyDamage(db, await game.getUser(db, 'bleeder'), 3, {
        cause: 'knife work', targetLabel: 'torso', weaponClass: 'pierce', row: 2, col: 2, attackerUsername: 'cutter'
      });
      const bleeds = await db.prepare("SELECT COUNT(*) AS c FROM statusEffects WHERE username='bleeder' AND effectType='bleed'").first();
      if (bleeds.c > 0) break;
    }
    const bleeds = await db.prepare(
      "SELECT magnitude, sourceUsername FROM statusEffects WHERE username='bleeder' AND effectType='bleed'"
    ).all();
    assert.ok(bleeds.results.length >= 1, 'a muscle-deep edged wound bleeds');
    assert.equal(bleeds.results[0].sourceUsername, 'cutter', 'bleed attributed to the attacker');
    const lines = (await db.prepare("SELECT message FROM messages WHERE roomRow=2 AND roomCol=2").all()).results.map(r => r.message);
    assert.ok(lines.some(l => /Blood wells from the wound/.test(l)), 'the wound announces itself');

    // Blunt to the same depth: bruises/cracks, never bleeds.
    await seedTough(db, 'bruised');
    await game.ensureBody(db, await game.getUser(db, 'bruised'));
    for (let i = 0; i < 6; i += 1) {
      await game.applyBodyDamage(db, await game.getUser(db, 'bruised'), 3, {
        cause: 'maul work', targetLabel: 'torso', weaponClass: 'blunt', row: 3, col: 3
      });
    }
    const bluntBleeds = await db.prepare(
      "SELECT COUNT(*) AS c FROM statusEffects WHERE username='bruised' AND effectType='bleed'"
    ).first();
    assert.equal(bluntBleeds.c, 0, 'blunt force does not open veins');
  } finally {
    await db.close();
  }
});

test('bleed ticks natively on the world sweep like poison, and is cleansable', async () => {
  const db = await createMigratedDb();
  const game = await import('../worker/game.mjs');
  try {
    await seedTough(db, 'ticker', 40);
    await game.ensureBody(db, await game.getUser(db, 'ticker'));
    await db.prepare(
      `INSERT INTO statusEffects (username, source, effectType, magnitude, createdTick, expiryTick, roomRow, roomCol, sourceUsername)
       VALUES ('ticker', 'wound', 'bleed', 2, 0, 8, 1, 1, 'wound')`
    ).run();

    const before = (await db.prepare("SELECT health FROM users WHERE username='ticker'").first()).health;
    await game.runWorldSweeps(db, 1);
    const after = (await db.prepare("SELECT health FROM users WHERE username='ticker'").first()).health;
    assert.equal(before - after, 2, 'the bleed drained exactly its magnitude on one swept tick');

    // Cleansable: bleed is a HARMFUL_EFFECT — each cleanse binds one wound.
    // (The tick above may itself have severed a fresh 1-hp part and opened a
    // stump bleed — the system composes with itself — so assert the DELTA.)
    const { clearOneHarmfulEffect } = await import('../worker/game/body.mjs');
    const beforeCleanse = (await db.prepare("SELECT COUNT(*) AS c FROM statusEffects WHERE username='ticker' AND effectType='bleed'").first()).c;
    assert.equal(await clearOneHarmfulEffect(db, 'ticker'), true, 'the wound can be bound');
    const afterCleanse = (await db.prepare("SELECT COUNT(*) AS c FROM statusEffects WHERE username='ticker' AND effectType='bleed'").first()).c;
    assert.equal(beforeCleanse - afterCleanse, 1, 'one bleed staunched per cleanse');
  } finally {
    await db.close();
  }
});

test('a sever pours: heavy stump bleed regardless of weapon class', async () => {
  const db = await createMigratedDb();
  const game = await import('../worker/game.mjs');
  try {
    await seedTough(db, 'stumped');
    await game.ensureBody(db, await game.getUser(db, 'stumped'));
    for (let i = 0; i < 40; i += 1) {
      const arm = (await game.getBodyParts(db, 'stumped')).find(p => p.label === 'left arm');
      if (!arm || arm.severed) break;
      await game.applyBodyDamage(db, await game.getUser(db, 'stumped'), 3, {
        cause: 'a maul', targetLabel: 'left arm', weaponClass: 'blunt', row: 4, col: 4
      });
    }
    const stumpBleed = await db.prepare(
      "SELECT magnitude FROM statusEffects WHERE username='stumped' AND effectType='bleed' ORDER BY magnitude DESC LIMIT 1"
    ).first();
    assert.ok(stumpBleed && stumpBleed.magnitude === 2, 'the torn-off stump pours (magnitude 2) even from blunt force');
    const lines = (await db.prepare("SELECT message FROM messages WHERE roomRow=4 AND roomCol=4").all()).results.map(r => r.message);
    assert.ok(lines.some(l => /Blood sprays from .*stump/.test(l)), 'stump spray call-out');
  } finally {
    await db.close();
  }
});

test('layer phrases speak the weapon family', () => {
  assert.match(layerPhrase('blade', 'muscle', () => 0), /carving into the muscle/);
  assert.match(layerPhrase('blunt', 'bone', () => 0), /cracking the bone/);
  assert.match(layerPhrase('pierce', 'skin', () => 0.99), /laying the flesh open/);
});
