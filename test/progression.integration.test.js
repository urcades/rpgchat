// Plan 019: the progression grid. Skill Points (1/level, separate from attribute
// points) unlock nodes on ONE shared board; adjacency gates what's reachable;
// node effects (stat / grant_ability / passive) fold into the effective layer and
// the usable-ability set; respec is gold-priced and guild-gated. CommonJS +
// node:test to match the rest of test/.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const sqlite3 = require('sqlite3').verbose();
const { getWorldDay, generateRoomFeatures } = require('../utils/roomEcology');
const grid = require('../utils/progressionGrid');
const abilities = require('../utils/abilities');

function createSqliteD1() {
  const raw = new sqlite3.Database(':memory:');
  return {
    raw,
    exec(sql) { return new Promise((resolve, reject) => raw.exec(sql, err => (err ? reject(err) : resolve()))); },
    close() { return new Promise((resolve, reject) => raw.close(err => (err ? reject(err) : resolve()))); },
    prepare(sql) {
      return {
        params: [],
        bind(...params) { this.params = params; return this; },
        first() { return new Promise((resolve, reject) => raw.get(sql, this.params, (err, row) => (err ? reject(err) : resolve(row || null)))); },
        all() { return new Promise((resolve, reject) => raw.all(sql, this.params, (err, rows) => (err ? reject(err) : resolve({ results: rows })))); },
        run() {
          return new Promise((resolve, reject) => {
            raw.run(sql, this.params, function onRun(err) {
              if (err) { reject(err); return; }
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
  const dir = path.join(__dirname, '../migrations');
  for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) {
    await db.exec(fs.readFileSync(path.join(dir, file), 'utf8'));
  }
  return db;
}

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

function findRoomWithEffect(worldDay, effectType) {
  for (let row = 1; row <= 16; row += 1) {
    for (let col = 1; col <= 16; col += 1) {
      const types = generateRoomFeatures(row, col, worldDay).map(f => f.effect?.type);
      if (types.includes(effectType)) return { row, col };
    }
  }
  return null;
}

async function seedPlayer(db, username, job, { skillPoints = 0, gold = 0, level = 0 } = {}) {
  await db.prepare(
    `INSERT INTO users (username, password, job, health, maxHealth, stamina, maxStamina, speed, strength, intelligence, level, gold, skillPoints)
     VALUES (?, 'pw', ?, 30, 30, 100, 100, 1, 1, 1, ?, ?, ?)`
  ).bind(username, job, level, gold, skillPoints).run();
}

const ids = list => list.map(x => x.id);

// ---------------------------------------------------------------------------
// Board integrity (pure)

test('Plan 019: the shared board is well-formed (edges symmetric, effects valid, one entry per class)', () => {
  const nodes = grid.getAllNodes();
  assert.ok(nodes.length >= 16, 'the board is reasonably expansive');

  for (const node of nodes) {
    for (const neighborId of grid.getNeighbors(node.id)) {
      assert.ok(grid.getNode(neighborId), `edge target ${neighborId} exists`);
      assert.ok(grid.getNeighbors(neighborId).includes(node.id), `edge ${node.id}-${neighborId} is symmetric`);
    }
    const effect = node.effect || {};
    if (effect.kind === 'stat') {
      assert.ok(['strength', 'speed', 'intelligence', 'maxStamina'].includes(effect.stat), `${node.id} bumps an allowlisted stat`);
    } else if (effect.kind === 'grant_ability' || effect.kind === 'passive') {
      assert.ok(abilities.getAbility(effect.abilityId), `${node.id} references a real ability (${effect.abilityId})`);
    }
  }

  for (const job of ['Novice', 'Paladin', 'Fighter', 'Chemist', 'Dungeoneer', 'Mage', 'Assassin', 'Cleric']) {
    assert.equal(grid.getEntryNodeIds(job).length, 1, `${job} has exactly one entry node`);
  }
});

// ---------------------------------------------------------------------------
// Grid state + unlock flow (live DB)

test('Plan 019: a fresh player sees their entry unlocked, its neighbor unlockable, the rest locked', async () => {
  const db = await createMigratedDb();
  const { getProgressionGrid } = await import('../worker/game.mjs');
  try {
    await seedPlayer(db, 'fighter', 'Fighter', { skillPoints: 3 });
    const board = await getProgressionGrid(db, 'fighter');
    const byId = Object.fromEntries(board.nodes.map(n => [n.id, n]));
    assert.equal(board.skillPoints, 3);
    assert.equal(byId.fighter_root.state, 'unlocked', 'class entry auto-unlocked');
    assert.equal(byId.fighter_stat.state, 'unlockable', 'neighbor of entry is unlockable');
    assert.equal(byId.core_int.state, 'locked', 'a distant node is locked');
  } finally {
    await db.close();
  }
});

test('Plan 019: unlocking spends a point, applies the effect, and opens the next node', async () => {
  const db = await createMigratedDb();
  const { getProgressionGrid, unlockProgressionNode, getUserState, updatePresence } = await import('../worker/game.mjs');
  try {
    const calm = findCalmRoom(getWorldDay());
    await seedPlayer(db, 'fighter', 'Fighter', { skillPoints: 3 });
    await updatePresence(db, 'fighter', calm.row, calm.col);

    const before = await getUserState(db, 'fighter');
    await unlockProgressionNode(db, 'fighter', 'fighter_stat'); // +1 strength
    const after = await getUserState(db, 'fighter');

    assert.equal(after.skillPoints, 2, 'one skill point spent');
    assert.equal(after.effectiveStats.strength, before.effectiveStats.strength + 1, 'the stat node folds into effective strength');

    const board = await getProgressionGrid(db, 'fighter');
    const byId = Object.fromEntries(board.nodes.map(n => [n.id, n]));
    assert.equal(byId.fighter_stat.state, 'unlocked');
    assert.equal(byId.fighter_passive.state, 'unlockable', 'the next node along the spoke opened up');
  } finally {
    await db.close();
  }
});

test('Plan 019: a grant_ability node puts the ability on the hotbar (and an already-innate passive does not double)', async () => {
  const db = await createMigratedDb();
  const { unlockProgressionNode, getUserState, updatePresence } = await import('../worker/game.mjs');
  try {
    const calm = findCalmRoom(getWorldDay());
    await seedPlayer(db, 'fighter', 'Fighter', { skillPoints: 5 });
    await updatePresence(db, 'fighter', calm.row, calm.col);

    const before = await getUserState(db, 'fighter');
    await unlockProgressionNode(db, 'fighter', 'fighter_stat');     // +1 str
    await unlockProgressionNode(db, 'fighter', 'fighter_passive');  // toughness — Fighter already has it innately
    await unlockProgressionNode(db, 'fighter', 'core_survey');      // grants Survey

    const after = await getUserState(db, 'fighter');
    // Only the stat node moves the needle; the redundant Toughness folds to 0.
    assert.equal(after.effectiveStats.strength, before.effectiveStats.strength + 1, 'stat node folds; innate passive does not stack');
    assert.ok(ids(after.skills).includes('survey'), 'the board-granted ability is on the hotbar');
  } finally {
    await db.close();
  }
});

test('Plan 019: a passive node folds its stat for a class that does not already have it', async () => {
  const db = await createMigratedDb();
  const { unlockProgressionNode, getUserState, updatePresence } = await import('../worker/game.mjs');
  try {
    const calm = findCalmRoom(getWorldDay());
    await seedPlayer(db, 'mage', 'Mage', { skillPoints: 2 });
    await updatePresence(db, 'mage', calm.row, calm.col);

    const before = await getUserState(db, 'mage');
    await unlockProgressionNode(db, 'mage', 'mage_stat');     // +1 intelligence
    await unlockProgressionNode(db, 'mage', 'mage_passive');  // Acuity (+1 intelligence), not innate to Mage

    const after = await getUserState(db, 'mage');
    assert.equal(after.effectiveStats.intelligence, before.effectiveStats.intelligence + 2, 'stat node + non-redundant passive both fold');
  } finally {
    await db.close();
  }
});

test('Plan 019: unlock rejects unreachable nodes, double-unlocks, and empty-handed spends', async () => {
  const db = await createMigratedDb();
  const { unlockProgressionNode } = await import('../worker/game.mjs');
  try {
    await seedPlayer(db, 'fighter', 'Fighter', { skillPoints: 1 });

    // Not adjacent to anything unlocked.
    await assert.rejects(() => unlockProgressionNode(db, 'fighter', 'core_int'), /not reachable/);
    // Another class's spoke is also unreachable from the Fighter root.
    await assert.rejects(() => unlockProgressionNode(db, 'fighter', 'mage_stat'), /not reachable/);

    await unlockProgressionNode(db, 'fighter', 'fighter_stat'); // spends the only point
    await assert.rejects(() => unlockProgressionNode(db, 'fighter', 'fighter_stat'), /already unlocked/);
    // Out of points now.
    await assert.rejects(() => unlockProgressionNode(db, 'fighter', 'fighter_passive'), /Not enough skill points/);
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// Respec (gold-priced, guild-gated)

test('Plan 019: respec at a guild refunds nodes and charges gold; elsewhere it is refused', async () => {
  const db = await createMigratedDb();
  const { unlockProgressionNode, respecProgression, getProgressionGrid, getUserState, updatePresence } = await import('../worker/game.mjs');
  try {
    const worldDay = getWorldDay();
    const guild = findRoomWithEffect(worldDay, 'guild');
    if (!guild) {
      // No guild room today — respec is unreachable; assert the gate refuses a calm room and stop.
      const calm = findCalmRoom(worldDay);
      await seedPlayer(db, 'fighter', 'Fighter', { skillPoints: 3, gold: 100 });
      await updatePresence(db, 'fighter', calm.row, calm.col);
      await unlockProgressionNode(db, 'fighter', 'fighter_stat');
      await assert.rejects(() => respecProgression(db, 'fighter', calm.row, calm.col), /only respec at a guild/);
      return;
    }

    await seedPlayer(db, 'fighter', 'Fighter', { skillPoints: 3, gold: 100 });
    await updatePresence(db, 'fighter', guild.row, guild.col);
    await unlockProgressionNode(db, 'fighter', 'fighter_stat');
    await unlockProgressionNode(db, 'fighter', 'fighter_passive');

    const spent = await getUserState(db, 'fighter');
    assert.equal(spent.skillPoints, 1, 'two points spent');

    // Wrong room: refused.
    const calm = findCalmRoom(worldDay);
    await assert.rejects(() => respecProgression(db, 'fighter', calm.row, calm.col), /only respec at a guild/);

    // At the guild: refunds the two points, charges 50 gold, re-locks the nodes.
    const board = await respecProgression(db, 'fighter', guild.row, guild.col);
    assert.equal(board.skillPoints, 3, 'both points refunded');
    const after = await getUserState(db, 'fighter');
    assert.equal(after.gold, 50, 'respec charged 50 gold');
    assert.equal(after.effectiveStats.strength, spent.effectiveStats.strength - 1, 'the unlocked stat reverted');
    const byId = Object.fromEntries(board.nodes.map(n => [n.id, n]));
    assert.equal(byId.fighter_stat.state, 'unlockable', 'nodes are re-locked (back to unlockable)');
  } finally {
    await db.close();
  }
});
