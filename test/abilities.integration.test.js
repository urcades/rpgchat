// Plan 018: the ability registry. 018a moved ability DATA into utils/abilities.js
// and made dispatch registry-driven (runAbility by id); 018b gives a class a real
// multi-ability kit (a second active + a passive) and folds passive stat deltas
// into the effective layer. These tests pin the registry shape, the passive fold,
// and the usable-set gate. CommonJS + node:test to match the rest of test/.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const sqlite3 = require('sqlite3').verbose();
const { getWorldDay, generateRoomFeatures } = require('../utils/roomEcology');
const abilities = require('../utils/abilities');
const { getEffectiveUser } = require('../utils/jobs');

function createSqliteD1() {
  const raw = new sqlite3.Database(':memory:');
  return {
    raw,
    exec(sql) {
      return new Promise((resolve, reject) => {
        raw.exec(sql, err => (err ? reject(err) : resolve()));
      });
    },
    close() {
      return new Promise((resolve, reject) => {
        raw.close(err => (err ? reject(err) : resolve()));
      });
    },
    prepare(sql) {
      return {
        params: [],
        bind(...params) {
          this.params = params;
          return this;
        },
        first() {
          return new Promise((resolve, reject) => {
            raw.get(sql, this.params, (err, row) => (err ? reject(err) : resolve(row || null)));
          });
        },
        all() {
          return new Promise((resolve, reject) => {
            raw.all(sql, this.params, (err, rows) => (err ? reject(err) : resolve({ results: rows })));
          });
        },
        run() {
          return new Promise((resolve, reject) => {
            raw.run(sql, this.params, function onRun(err) {
              if (err) {
                reject(err);
                return;
              }
              resolve({ meta: { changes: this.changes, last_row_id: this.lastID } });
            });
          });
        }
      };
    }
  };
}

async function createMigratedDb() {
  const db = createSqliteD1();
  const migrationsDir = path.join(__dirname, '../migrations');
  const migrations = fs.readdirSync(migrationsDir).filter(file => file.endsWith('.sql')).sort();
  for (const migrationFile of migrations) {
    await db.exec(fs.readFileSync(path.join(migrationsDir, migrationFile), 'utf8'));
  }
  return db;
}

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

const ids = list => list.map(ability => ability.id);

// ---------------------------------------------------------------------------
// Registry shape (pure)

test('Plan 018: every class kit resolves to registered abilities with display data', () => {
  for (const job of Object.keys(abilities.CLASS_ABILITIES)) {
    const kit = abilities.getAbilitiesForJob(job);
    assert.ok(kit.length >= 1, `${job} has at least one ability`);
    for (const ability of kit) {
      assert.ok(ability && ability.id && ability.label, `${job} ability is well-formed`);
      assert.ok(Array.isArray(ability.effects) && ability.effects.length, `${ability.id} lists effects`);
      assert.ok(ability.kind === 'active' || ability.kind === 'passive', `${ability.id} has a kind`);
    }
  }
});

test('Plan 018b: the Fighter has a multi-ability kit split into actives and a passive', () => {
  assert.deepEqual(ids(abilities.getAbilitiesForJob('Fighter')), ['power_strike', 'brace', 'toughness']);
  assert.deepEqual(ids(abilities.getActiveAbilitiesForJob('Fighter')), ['power_strike', 'brace']);
  assert.deepEqual(ids(abilities.getPassiveAbilitiesForJob('Fighter')), ['toughness']);
  // The starter (back-compat shape) is still the first innate ability.
  assert.equal(abilities.getStarterAbility('Fighter').id, 'power_strike');
});

test('Plan 018b: a passive folds its stat delta into the effective layer like a job bonus', () => {
  // Fighter strength = base 1 + job bonus 2 + Toughness passive 1 = 4.
  const fighter = getEffectiveUser({ job: 'Fighter', strength: 1 });
  assert.equal(fighter.strength, 4);
  assert.deepEqual(abilities.getPassiveStatModifiers('Fighter'), { strength: 1 });

  // A class with no passive is unaffected.
  const novice = getEffectiveUser({ job: 'Novice', strength: 1 });
  assert.equal(novice.strength, 1);
  assert.deepEqual(abilities.getPassiveStatModifiers('Novice'), {});

  // getEffectiveUser surfaces the kit + passives for the client.
  assert.deepEqual(ids(fighter.skills), ['power_strike', 'brace']);
  assert.deepEqual(ids(fighter.passives), ['toughness']);
});

// ---------------------------------------------------------------------------
// Usable-set gate + behavior (live DB)

test('Plan 018b: a Fighter fires the second active (Brace) and wards themselves', async () => {
  const db = await createMigratedDb();
  const { handleSkillAction, getCurrentTickValue, getUserState, updatePresence } = await import('../worker/game.mjs');
  try {
    const calm = findCalmRoom(getWorldDay());
    await seedLiveUser(db, 'fighter', 'Fighter');
    await updatePresence(db, 'fighter', calm.row, calm.col);
    await getUserState(db, 'fighter'); // instantiate body
    const tick = await getCurrentTickValue(db);

    await handleSkillAction(db, 'fighter', calm.row, calm.col, 'brace', '', tick);

    const line = await db.prepare("SELECT message, kind FROM messages WHERE message LIKE 'fighter braces%' ORDER BY id DESC LIMIT 1").bind().first();
    assert.ok(line, 'Brace posts a system line');
    assert.equal(line.kind, 'support', 'Brace is a support-kind message');

    const ward = await db.prepare("SELECT magnitude FROM statusEffects WHERE username = 'fighter' AND effectType = 'ward' ORDER BY id DESC LIMIT 1").bind().first();
    assert.ok(ward, 'Brace adds a ward to the Fighter themselves');
    assert.equal(ward.magnitude, 1, 'the self-ward is weaker than a Paladin ward');

    const state = await getUserState(db, 'fighter');
    assert.deepEqual(ids(state.skills), ['power_strike', 'brace'], 'the hotbar payload carries both actives');
    assert.deepEqual(ids(state.passives), ['toughness'], 'passives are surfaced read-only');
  } finally {
    await db.close();
  }
});

test('Plan 018b: passives are not activatable and kits are class-gated', async () => {
  const db = await createMigratedDb();
  const { validateClassSkillUse, getUserState, updatePresence } = await import('../worker/game.mjs');
  try {
    const calm = findCalmRoom(getWorldDay());
    await seedLiveUser(db, 'fighter', 'Fighter');
    await seedLiveUser(db, 'novice', 'Novice');
    for (const name of ['fighter', 'novice']) {
      await updatePresence(db, name, calm.row, calm.col);
      await getUserState(db, name);
    }

    // A passive cannot be invoked as a skill, even though it is in the kit.
    await assert.rejects(
      () => validateClassSkillUse(db, { username: 'fighter', skillId: 'toughness', targetUsername: '' }),
      /cannot use that skill/
    );
    // A class cannot borrow another class's active.
    await assert.rejects(
      () => validateClassSkillUse(db, { username: 'novice', skillId: 'brace', targetUsername: '' }),
      /cannot use that skill/
    );
    // The Fighter's own second active validates fine.
    const ok = await validateClassSkillUse(db, { username: 'fighter', skillId: 'brace', targetUsername: '' });
    assert.equal(ok.ability.id, 'brace');
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// Plan 018c: grant-ability hook (item → usable ability + hotbar)

test('Plan 018c: equipping an item that grants an ability makes it usable and adds it to the hotbar', async () => {
  const db = await createMigratedDb();
  const { handleSkillAction, validateClassSkillUse, getCurrentTickValue, getUserState, updatePresence } = await import('../worker/game.mjs');
  try {
    const calm = findCalmRoom(getWorldDay());
    await seedLiveUser(db, 'novice', 'Novice');
    await updatePresence(db, 'novice', calm.row, calm.col);
    await getUserState(db, 'novice'); // instantiate body

    // Survey is the Dungeoneer's skill — a Novice cannot use it bare-handed.
    await assert.rejects(
      () => validateClassSkillUse(db, { username: 'novice', skillId: 'survey', targetUsername: '' }),
      /cannot use that skill/
    );

    // Equip the Old Map Scrap (grantsAbility: 'survey') onto the Novice's hand.
    const hand = await db.prepare("SELECT id FROM bodyParts WHERE username = 'novice' AND slotType = 'hand' AND severed = 0 ORDER BY id ASC LIMIT 1").bind().first();
    assert.ok(hand, 'the Novice has a hand to equip onto');
    await db.prepare(
      `INSERT INTO items (templateId, name, slotType, rarity, modifiers, ownerUsername, equippedPartId)
       VALUES ('old_map_scrap', 'Old Map Scrap', 'hand', 'shop', '{"speed":1}', 'novice', ?)`
    ).bind(hand.id).run();

    // Now the granted ability is in the hotbar payload and usable.
    const state = await getUserState(db, 'novice');
    assert.ok(ids(state.skills).includes('survey'), 'the granted ability shows on the hotbar');
    const tick = await getCurrentTickValue(db);
    await handleSkillAction(db, 'novice', calm.row, calm.col, 'survey', '', tick);
    const line = await db.prepare("SELECT message FROM messages WHERE message LIKE 'novice surveys%' ORDER BY id DESC LIMIT 1").bind().first();
    assert.ok(line, 'the Novice can now Survey because of the equipped item');
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// Plan 018c: linguistic-cost evaluator (the plan 012 on-ramp)

test('Plan 018c: evaluateLinguisticCost reads text properties, rounds, clamps, and floors at 0', () => {
  assert.equal(abilities.evaluateLinguisticCost({ perWord: 2 }, 'hello world'), 4);
  assert.equal(abilities.evaluateLinguisticCost({ perCapital: 1 }, 'HELLO there'), 5);
  assert.equal(abilities.evaluateLinguisticCost({ perCharacter: 1 }, '  ab  '), 2, 'length is trimmed');
  assert.equal(abilities.evaluateLinguisticCost({ perWord: 10, max: 3 }, 'a b c'), 3, 'max clamps the surcharge');
  assert.equal(abilities.evaluateLinguisticCost(null, 'anything'), 0, 'no spec means no cost');
  assert.equal(abilities.evaluateLinguisticCost({ perWord: 1 }, ''), 0, 'empty text means no cost');
});

test('Plan 018c: resolveAbilityStaminaCost defaults to 1 and adds the linguistic surcharge', () => {
  // Every shipped ability still costs a flat 1 (parity).
  assert.equal(abilities.resolveAbilityStaminaCost(abilities.getAbility('scrounge')), 1);
  assert.equal(abilities.resolveAbilityStaminaCost(abilities.getAbility('brace')), 1);
  assert.equal(abilities.resolveAbilityStaminaCost(null), 1, 'an unknown ability defaults to 1');

  // A hypothetical linguistic spell (plan 012 content) is charged base + surcharge.
  const spell = { id: 'incant', cost: { stamina: 1, linguistic: { perWord: 1, max: 5 } } };
  assert.equal(abilities.resolveAbilityStaminaCost(spell, { text: 'one two three' }), 4);
  assert.equal(abilities.resolveAbilityStaminaCost(spell, { text: '' }), 1, 'no incantation means base cost');
  assert.equal(abilities.resolveAbilityStaminaCost(spell, {}), 1, 'missing context means base cost');
});
