// Brutal segmented combat (engine-overhaul, after paperdoll-viewer's Combatant):
// distal sever cascade, decapitation, and weapon-class sever narration.

const assert = require('node:assert/strict');
const test = require('node:test');
const { createMigratedDb } = require('./.helpers/d1');
const { HUMANOID_PLAN, distalPartLabels, severJointFor } = require('../utils/body');

async function seedTough(db, username, health = 100) {
  await db.prepare(
    `INSERT INTO users
      (username, password, job, health, maxHealth, stamina, maxStamina, speed, strength, intelligence, level)
     VALUES (?, 'pw', 'Fighter', ?, ?, 100, 100, 1, 4, 1, 1)`
  ).bind(username, health, health).run();
}

async function partsOf(db, game, username) {
  return game.getBodyParts(db, username);
}

test('the plan is segmented: hands/feet hang off limbs, the head hangs off the neck', () => {
  assert.equal(HUMANOID_PLAN.length, 11, 'eleven parts');
  assert.deepEqual(distalPartLabels(HUMANOID_PLAN, 'left arm'), ['left hand']);
  assert.deepEqual(distalPartLabels(HUMANOID_PLAN, 'neck'), ['head']);
  assert.equal(distalPartLabels(HUMANOID_PLAN, 'torso').length, 10, 'everything hangs off the torso');
  assert.equal(HUMANOID_PLAN.reduce((s, p) => s + p.share, 0), 1, 'shares sum to 1');
  assert.equal(severJointFor('arm'), 'shoulder');
  assert.equal(severJointFor('hand'), 'wrist');
});

test('severing an arm cascades: the hand goes with it, and both hp pools leave users.health', async () => {
  const db = await createMigratedDb();
  const game = await import('../worker/game.mjs');
  try {
    await seedTough(db, 'cascade_victim');
    const user = await game.getUser(db, 'cascade_victim');
    await game.ensureBody(db, user);

    // Hammer the left arm down through the REAL damage path until it severs.
    let result = null;
    for (let i = 0; i < 40; i += 1) {
      const fresh = await game.getUser(db, 'cascade_victim');
      const arm = (await partsOf(db, game, 'cascade_victim')).find(p => p.label === 'left arm');
      if (!arm || arm.severed) break;
      result = await game.applyBodyDamage(db, fresh, 3, {
        cause: 'test cleaver', targetLabel: 'left arm', weaponClass: 'blade', row: 2, col: 2
      });
    }

    const parts = await partsOf(db, game, 'cascade_victim');
    assert.equal(parts.find(p => p.label === 'left arm').severed, 1, 'arm severed');
    assert.equal(parts.find(p => p.label === 'left hand').severed, 1, 'the hand went with it');
    assert.ok(result.severedLabels.includes('left hand'), 'cascade reported');

    // Invariant: users.health == Σ part hp after the cascade shed the hand pool.
    const health = (await db.prepare("SELECT health FROM users WHERE username='cascade_victim'").first()).health;
    const sum = parts.reduce((s, p) => s + p.hp, 0);
    assert.equal(health, sum, 'health mirrors the parts through the cascade');

    // Narration: edged sever at the joint + the cascade call-out.
    const lines = (await db.prepare(
      "SELECT message FROM messages WHERE roomRow=2 AND roomCol=2 ORDER BY id ASC"
    ).all()).results.map(r => r.message);
    assert.ok(lines.some(l => /left arm is severed clean at the shoulder!/.test(l)), `edged sever line (got: ${lines.join(' | ')})`);
    assert.ok(lines.some(l => /left hand goes with it, still attached at the wrist/.test(l)), 'cascade line');
  } finally {
    await db.close();
  }
});

test('a light neck sever leaves the head hanging; a HEAVY blow decapitates (death)', async () => {
  const db = await createMigratedDb();
  const game = await import('../worker/game.mjs');
  try {
    // Light: chip the neck down with 1-damage taps — head must NOT come off.
    await seedTough(db, 'neck_light');
    await game.ensureBody(db, await game.getUser(db, 'neck_light'));
    for (let i = 0; i < 30; i += 1) {
      const neck = (await partsOf(db, game, 'neck_light')).find(p => p.label === 'neck');
      if (!neck || neck.severed) break;
      await game.applyBodyDamage(db, await game.getUser(db, 'neck_light'), 1, {
        cause: 'taps', targetLabel: 'neck', weaponClass: 'blade', row: 3, col: 3
      });
    }
    let parts = await partsOf(db, game, 'neck_light');
    assert.equal(parts.find(p => p.label === 'neck').severed, 1, 'neck severed by chipping');
    assert.equal(parts.find(p => p.label === 'head').severed, 0, 'the head stays on — hanging by a thread');
    const lightLines = (await db.prepare(
      "SELECT message FROM messages WHERE roomRow=3 AND roomCol=3 ORDER BY id ASC"
    ).all()).results.map(r => r.message);
    assert.ok(lightLines.some(l => /head hangs by a thread of sinew/.test(l)), 'hanging call-out');

    // Heavy: a single big blade blow through the neck takes the head with it.
    await seedTough(db, 'neck_heavy');
    await game.ensureBody(db, await game.getUser(db, 'neck_heavy'));
    const heavy = await game.applyBodyDamage(db, await game.getUser(db, 'neck_heavy'), 9, {
      cause: 'an executioner swing', targetLabel: 'neck', weaponClass: 'blade', row: 4, col: 4
    });
    assert.equal(heavy.died, true, 'decapitation is death');
    assert.ok(heavy.severedLabels.includes('head'), 'the head came away');
    const heavyLines = (await db.prepare(
      "SELECT message FROM messages WHERE roomRow=4 AND roomCol=4 ORDER BY id ASC"
    ).all()).results.map(r => r.message);
    assert.ok(heavyLines.some(l => /DECAPITATED — the head comes away with the neck/.test(l)), 'decapitation call-out');
  } finally {
    await db.close();
  }
});

test('blunt force tears off rather than severing clean', async () => {
  const db = await createMigratedDb();
  const game = await import('../worker/game.mjs');
  try {
    await seedTough(db, 'blunt_victim');
    await game.ensureBody(db, await game.getUser(db, 'blunt_victim'));
    for (let i = 0; i < 40; i += 1) {
      const arm = (await partsOf(db, game, 'blunt_victim')).find(p => p.label === 'right arm');
      if (!arm || arm.severed) break;
      await game.applyBodyDamage(db, await game.getUser(db, 'blunt_victim'), 3, {
        cause: 'a maul', targetLabel: 'right arm', weaponClass: 'blunt', row: 5, col: 5
      });
    }
    const lines = (await db.prepare(
      "SELECT message FROM messages WHERE roomRow=5 AND roomCol=5 ORDER BY id ASC"
    ).all()).results.map(r => r.message);
    assert.ok(lines.some(l => /right arm is crushed and torn off at the shoulder!/.test(l)), `blunt tear line (got: ${lines.join(' | ')})`);
  } finally {
    await db.close();
  }
});

test('the dead can be struck: a corpse is attackable until pulped — and pulping a player corpse snaps the tether', async () => {
  const db = await createMigratedDb();
  const game = await import('../worker/game.mjs');
  try {
    await seedTough(db, 'desecrator');
    await game.ensureBody(db, await game.getUser(db, 'desecrator'));
    await game.updatePresence(db, 'desecrator', 6, 6);

    // A dead player's corpse lies here (the resurrection anchor).
    await db.prepare(
      `INSERT INTO items (templateId, name, slotType, rarity, modifiers, roomRow, roomCol, corpseOf)
       VALUES ('player_corpse', 'fallen_hero''s Corpse', 'corpse', 'common', '{}', 6, 6, 'fallen_hero')`
    ).run();

    // Attacking the dead by @name resolves the corpse, not a "no such target" error.
    let lastResult = null;
    for (let i = 0; i < 20; i += 1) {
      const corpse = await db.prepare("SELECT id FROM items WHERE corpseOf = 'fallen_hero'").first();
      if (!corpse) break;
      lastResult = await game.handleAttack(db, 'desecrator', '@fallen_hero', 6, 6, {});
    }

    const gone = await db.prepare("SELECT COUNT(*) AS c FROM items WHERE corpseOf = 'fallen_hero'").first();
    assert.equal(gone.c, 0, 'the corpse was eventually pulped and destroyed');
    const lines = (await db.prepare(
      'SELECT message FROM messages WHERE roomRow=6 AND roomCol=6 ORDER BY id ASC'
    ).all()).results.map(r => r.message);
    assert.ok(lines.some(l => /pulped beyond recognition/.test(l)), 'pulp call-out');
    assert.ok(lines.some(l => /fallen_hero's tether to life is destroyed forever/.test(l)), 'tether snap call-out');
    assert.ok(String(lastResult).length > 0, 'the mutilation swing produced attack prose');

    // Named monster remains resolve by their possessive owner too.
    await db.prepare(
      `INSERT INTO items (templateId, name, slotType, rarity, modifiers, roomRow, roomCol)
       VALUES ('monster_remains', 'Frost Wyrm''s Dead Body', 'part', 'common', '{}', 6, 6)`
    ).run();
    const swing = await game.handleAttack(db, 'desecrator', 'attack the frost wyrm', 6, 6, {});
    assert.match(String(swing), /Frost Wyrm's Dead Body/, 'the dead wyrm takes the blow');
  } finally {
    await db.close();
  }
});
