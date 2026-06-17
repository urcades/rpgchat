// adv-006 (perf, behavior-preserving): the per-attack query fan-out reduction.
//
// Two things are pinned here, against the SAME real combat path the rest of the suite
// drives (handleAttack):
//   1) The attacker's equipped-items read happens EXACTLY ONCE per attack, no matter how
//      many targets are struck. Before adv-006 getWeaponClass ran that SELECT once and
//      handleAttack re-ran the element scan once PER TARGET (1 + N scans); now weaponClass
//      AND element are derived from a single fetch (1 scan total). A query-counting proxy
//      wraps the D1 shim and tallies the attacker-scoped equipped-items SELECT.
//   2) The values that fetch feeds still resolve to the SAME answers: element (fire),
//      weaponClass (blade / flametongue), and per-part affinity (resist armor) are all
//      asserted unchanged — proving the dedup is byte-equivalent, not just cheaper.
//
// CommonJS + node:test to match the rest of test/.

const assert = require('node:assert/strict');
const test = require('node:test');
const { createMigratedDb } = require('./.helpers/d1');
const { getWorldDay, generateRoomFeatures } = require('../utils/roomEcology');

function findCalmRoom(worldDay) {
  const hazardous = ['poison_marsh', 'moon_room', 'echo_chamber', 'pub', 'inn', 'sun_room', 'cold_room', 'guild'];
  for (let row = 1; row <= 16; row += 1) {
    for (let col = 1; col <= 16; col += 1) {
      const types = generateRoomFeatures(row, col, worldDay).map(f => f.effect?.type);
      if (!types.some(t => hazardous.includes(t))) return { row, col };
    }
  }
  throw new Error('No calm room for ' + worldDay);
}

async function seedUser(db, username, overrides = {}) {
  const s = { job: 'Novice', health: 30, maxHealth: 30, speed: 1, strength: 1, intelligence: 1, level: 0, ...overrides };
  await db.prepare(
    `INSERT INTO users (username, password, job, health, maxHealth, stamina, maxStamina, speed, strength, intelligence, level, gold)
     VALUES (?, 'pw', ?, ?, ?, 100, 100, ?, ?, ?, ?, 0)`
  ).bind(username, s.job, s.health, s.maxHealth, s.speed, s.strength, s.intelligence, s.level).run();
}

async function equip(db, username, templateId, name, slotType) {
  const part = await db.prepare('SELECT id FROM bodyParts WHERE username = ? AND slotType = ? AND severed = 0 ORDER BY id ASC LIMIT 1').bind(username, slotType).first();
  await db.prepare(
    `INSERT INTO items (templateId, name, slotType, rarity, modifiers, ownerUsername, equippedPartId)
     VALUES (?, ?, ?, 'rare', '{}', ?, ?)`
  ).bind(templateId, name, slotType, username, part.id).run();
}

// Wrap a D1 shim so we can count how often a particular query (matched + param-keyed)
// is prepared+executed. The normalized equipped-items SELECT and the bound username are
// what identify "the attacker reads their equipped items".
function countingDb(inner, predicate) {
  let count = 0;
  return {
    get count() { return count; },
    exec: (...a) => inner.exec(...a),
    close: (...a) => inner.close(...a),
    prepare(sql) {
      const stmt = inner.prepare(sql);
      return {
        bind(...params) {
          stmt.bind(...params);
          this._params = params;
          return this;
        },
        first() { return stmt.first(); },
        all() {
          if (predicate(sql, this._params || [])) count += 1;
          return stmt.all();
        },
        run() { return stmt.run(); }
      };
    }
  };
}

// ---------------------------------------------------------------------------

test('adv-006: the attacker\'s equipped-items read fires exactly ONCE per attack, across multiple targets', async () => {
  const base = await createMigratedDb();
  const { handleAttack, getUserState, updatePresence } = await import('../worker/game.mjs');
  try {
    const calm = findCalmRoom(getWorldDay());
    // High-speed attacker so the lone speed contest lands at roll 0.5 (base hits widen),
    // two co-located targets so the OLD code would have scanned the attacker's items 1
    // (weaponClass) + 2 (element, once per target) = 3 times.
    await seedUser(base, 'striker', { speed: 20, strength: 2 });
    await seedUser(base, 'dummy1', { speed: 1 });
    await seedUser(base, 'dummy2', { speed: 1 });
    for (const name of ['striker', 'dummy1', 'dummy2']) {
      await updatePresence(base, name, calm.row, calm.col);
      await getUserState(base, name); // instantiate body parts
    }
    await equip(base, 'striker', 'flametongue', 'Flametongue', 'hand'); // fire + blade weaponClass

    // Count only the attacker-scoped equipped-items SELECT (id, templateId ... equippedPartId
    // IS NOT NULL), bound to 'striker'. getElementAffinity's JOINed target read and
    // getEquippedModifiers' (id, modifiers) read are intentionally NOT matched.
    const isStrikerEquippedScan = (sql, params) =>
      /SELECT\s+id,\s*templateId\s+FROM\s+items/i.test(sql)
      && /equippedPartId\s+IS\s+NOT\s+NULL/i.test(sql)
      && Array.isArray(params) && params[0] === 'striker';

    const db = countingDb(base, isStrikerEquippedScan);

    // One attack naming BOTH targets. mocked RNG, 3 draws per landed target
    // (contest / crit / pick); the helper repeats the last value once exhausted.
    const originalRandom = Math.random;
    let i = 0;
    const seqVals = [0.5, 0.99, 0.5, 0.5, 0.99, 0.5];
    Math.random = () => seqVals[Math.min(i++, seqVals.length - 1)];
    let line;
    try {
      line = await handleAttack(db, 'striker', 'I cut @dummy1 and @dummy2', calm.row, calm.col);
    } finally {
      Math.random = originalRandom;
    }

    assert.match(line, /dummy1/, 'the line resolves both targets');
    assert.match(line, /dummy2/, 'the line resolves both targets');
    assert.equal(db.count, 1, 'the attacker reads their equipped items exactly once for the whole attack (was 1 + N)');
  } finally {
    await base.close();
  }
});

test('adv-006: element, weaponClass, and per-part affinity still resolve to the SAME values', async () => {
  const db = await createMigratedDb();
  // getAttackElement / getElementAffinity ride the facade; getWeaponClass is a private
  // cross-seam helper (not re-exported), so it's imported straight from the combat seam.
  const { getUserState, getCurrentTickValue } = await import('../worker/game.mjs');
  const { getAttackElement, getWeaponClass, getElementAffinity } = await import('../worker/game/combat.mjs');
  try {
    const calm = findCalmRoom(getWorldDay());
    await seedUser(db, 'w');
    await getUserState(db, 'w');
    const tick = await getCurrentTickValue(db);

    // Unarmed / unarmored baselines.
    assert.equal(await getAttackElement(db, 'w'), null, 'no weapon -> no element');
    assert.deepEqual(await getWeaponClass(db, 'w'), { weaponClass: 'fist', weaponId: null }, 'no weapon -> fist / null');
    assert.equal(await getElementAffinity(db, 'w', 'fire', null, calm.row, calm.col, tick), 0, 'no armor -> neutral');

    // Equip Flametongue: element fire, weaponClass blade, weaponId flametongue.
    await equip(db, 'w', 'flametongue', 'Flametongue', 'hand');
    assert.equal(await getAttackElement(db, 'w'), 'fire', 'Flametongue reads fire (derivation unchanged)');
    assert.deepEqual(await getWeaponClass(db, 'w'), { weaponClass: 'blade', weaponId: 'flametongue' }, 'Flametongue reads blade / flametongue');

    // Equip fire-resist torso armor: the struck-part affinity is unchanged (−0.5).
    await equip(db, 'w', 'wyrmscale_cloak', 'Wyrmscale Cloak', 'torso');
    const torso = (await db.prepare('SELECT label FROM bodyParts WHERE username = ? AND slotType = ? AND severed = 0 ORDER BY id ASC LIMIT 1').bind('w', 'torso').first()).label;
    assert.equal(await getElementAffinity(db, 'w', 'fire', torso, calm.row, calm.col, tick), -0.5, 'resist armor affinity unchanged');
  } finally {
    await db.close();
  }
});
