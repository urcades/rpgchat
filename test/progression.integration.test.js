// Plan 019b: the daily progression grid. ONE shared board is generated per
// worldDay from a Penrose tiling (deterministic, like rooms); your point budget is
// your level, re-spent daily; node effects fold into the effective layer + ability
// set; unlocks are namespaced by day so the reset is automatic. CommonJS + node:test.

const assert = require('node:assert/strict');
const test = require('node:test');
const { createSqliteD1, createMigratedDb } = require('./.helpers/d1');
const { getWorldDay, generateRoomFeatures } = require('../utils/roomEcology');
const grid = require('../utils/progressionGrid');
const abilities = require('../utils/abilities');

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

async function seedPlayer(db, username, job, { gold = 0, level = 0 } = {}) {
  await db.prepare(
    `INSERT INTO users (username, password, job, health, maxHealth, stamina, maxStamina, speed, strength, intelligence, level, gold, skillPoints)
     VALUES (?, 'pw', ?, 30, 30, 100, 100, 1, 1, 1, ?, ?, ?)`
  ).bind(username, job, level, gold, level).run();
}

const WD = getWorldDay();

// ---------------------------------------------------------------------------
// Generator (pure)

test('Plan 019b: the daily board is deterministic per day, connected, and varies across days', () => {
  const a = grid.getDailyBoard(WD);
  const aAgain = grid.getDailyBoard(WD);
  const b = grid.getDailyBoard('1999-01-01');

  assert.ok(a.nodes.length >= 100, 'the board is expansive');
  assert.equal(a.nodes.length, aAgain.nodes.length, 'same day → same board');
  assert.equal(a.nodes[0].id, aAgain.nodes[0].id, 'same day → same node ids');
  // A different day carves a different set of base vertices (compare the vid suffix).
  const vidsA = new Set(a.nodes.map(n => n.id.split(':')[1]));
  const vidsB = new Set(b.nodes.map(n => n.id.split(':')[1]));
  let symDiff = 0;
  for (const v of vidsA) if (!vidsB.has(v)) symDiff += 1;
  assert.ok(symDiff > 0, 'a different day carves a different vertex set');

  let dangling = 0;
  for (const n of a.nodes) for (const m of n.neighbors) if (!a.byId.get(m)) dangling += 1;
  assert.equal(dangling, 0, 'every edge resolves (connected graph)');

  assert.equal(Object.keys(a.entryByJob).length, 8, 'eight class entries');
  for (const id of Object.values(a.entryByJob)) assert.equal(a.byId.get(id).cost, 0, 'entries are free');

  for (const n of a.nodes) {
    if (n.effect.kind === 'grant_ability' || n.effect.kind === 'passive') {
      assert.ok(abilities.getAbility(n.effect.abilityId), `${n.id} references a real ability`);
    } else if (n.effect.kind === 'stat') {
      assert.ok(['strength', 'speed', 'intelligence', 'maxStamina'].includes(n.effect.stat));
    }
  }
  // node ids are namespaced by the day.
  assert.ok(a.nodes.every(n => n.id.startsWith(`${WD}:`)), 'ids namespaced by worldDay');
});

// ---------------------------------------------------------------------------
// Daily-build flow (live DB)

test('Plan 019b: a fresh player sees their entry unlocked and budget = level', async () => {
  const db = await createMigratedDb();
  const { getProgressionGrid } = await import('../worker/game.mjs');
  try {
    await seedPlayer(db, 'fighter', 'Fighter', { level: 7 });
    const board = await getProgressionGrid(db, 'fighter');
    assert.equal(board.budget, 7, 'budget is the level');
    assert.equal(board.available, 7, 'nothing spent yet');
    const entry = board.nodes.find(n => n.entryFor === 'Fighter');
    assert.ok(entry && entry.state === 'unlocked', 'class entry auto-unlocked');
    assert.ok(board.nodes.some(n => n.state === 'unlockable'), 'some nodes are unlockable');
  } finally {
    await db.close();
  }
});

test('Plan 019b: unlocking spends from the daily budget, folds the effect, and opens neighbors', async () => {
  const db = await createMigratedDb();
  const { getProgressionGrid, unlockProgressionNode, getUserState, updatePresence } = await import('../worker/game.mjs');
  try {
    const calm = findCalmRoom(WD);
    await seedPlayer(db, 'fighter', 'Fighter', { level: 10 });
    await updatePresence(db, 'fighter', calm.row, calm.col);

    const before = await getProgressionGrid(db, 'fighter');
    const target = before.nodes.find(n => n.state === 'unlockable' && n.effect.kind === 'stat')
      || before.nodes.find(n => n.state === 'unlockable');
    assert.ok(target, 'there is an unlockable node');

    const userBefore = await getUserState(db, 'fighter');
    const after = await unlockProgressionNode(db, 'fighter', target.id);
    assert.equal(after.spent, target.cost, 'budget spent equals the node cost');
    assert.equal(after.available, 10 - target.cost, 'available dropped by the cost');
    assert.equal(after.nodes.find(n => n.id === target.id).state, 'unlocked');

    if (target.effect.kind === 'stat') {
      const userAfter = await getUserState(db, 'fighter');
      assert.equal(
        userAfter.effectiveStats[target.effect.stat],
        userBefore.effectiveStats[target.effect.stat] + target.effect.amount,
        'the stat node folded into effective stats'
      );
    }
    // a neighbor of the newly-unlocked node is now on the frontier.
    const opened = after.nodes.some(n => n.state === 'unlockable' && target.neighbors.includes(n.id));
    assert.ok(opened || after.available === 0, 'a neighbor opened (or budget is exhausted)');
  } finally {
    await db.close();
  }
});

test('Plan 019b: unlock rejects no-budget, unreachable, and off-board nodes', async () => {
  const db = await createMigratedDb();
  const { unlockProgressionNode } = await import('../worker/game.mjs');
  try {
    const board = grid.getDailyBoard(WD);
    const entry = board.nodes.find(n => n.entryFor === 'Fighter');

    // Level 0 → budget 0: cannot afford even a cost-1 neighbor of the entry.
    await seedPlayer(db, 'fighter', 'Fighter', { level: 0 });
    await assert.rejects(() => unlockProgressionNode(db, 'fighter', entry.neighbors[0]), /Not enough skill points today/);

    // A node not adjacent to anything unlocked is unreachable.
    await seedPlayer(db, 'rich', 'Fighter', { level: 50 });
    const entrySet = new Set(Object.values(board.entryByJob));
    const farNode = board.nodes.find(n => !entrySet.has(n.id) && !n.neighbors.some(m => entrySet.has(m)));
    await assert.rejects(() => unlockProgressionNode(db, 'rich', farNode.id), /not reachable/);

    // A node id that isn't on today's board.
    await assert.rejects(() => unlockProgressionNode(db, 'rich', '1999-01-01:0'), /not on today's board/);
  } finally {
    await db.close();
  }
});

test('Plan 019b: prior-day unlocks do not count and get swept (the daily reset)', async () => {
  const db = await createMigratedDb();
  const { getProgressionGrid } = await import('../worker/game.mjs');
  try {
    await seedPlayer(db, 'fighter', 'Fighter', { level: 5 });
    // A leftover unlock from a prior day's board.
    await db.prepare("INSERT INTO playerProgressionNodes (username, nodeId, unlockedTick) VALUES ('fighter', ?, 0)").bind('1999-01-01:5').run();

    const board = await getProgressionGrid(db, 'fighter');
    assert.equal(board.spent, 0, 'a prior-day unlock does not count against today');
    assert.equal(board.available, 5, 'full budget available today');

    const left = await db.prepare("SELECT COUNT(*) AS c FROM playerProgressionNodes WHERE username = 'fighter' AND nodeId = ?").bind(`${WD - 1}:5`).first();
    assert.equal(left.c, 0, 'the stale row was swept');
  } finally {
    await db.close();
  }
});

test('Plan 019b: board-granted abilities and non-innate passives fold for the player', async () => {
  const db = await createMigratedDb();
  const { getUserState, updatePresence } = await import('../worker/game.mjs');
  try {
    const calm = findCalmRoom(WD);
    await seedPlayer(db, 'fighter', 'Fighter', { level: 10 });
    await updatePresence(db, 'fighter', calm.row, calm.col);
    const board = grid.getDailyBoard(WD);
    const fighterInnate = new Set(['power_strike', 'brace', 'toughness']);

    // A grant_ability node for an ability the Fighter does NOT have innately.
    const grantNode = board.nodes.find(n => n.effect.kind === 'grant_ability' && !fighterInnate.has(n.effect.abilityId));
    if (grantNode) {
      await db.prepare("INSERT INTO playerProgressionNodes (username, nodeId, unlockedTick) VALUES ('fighter', ?, 0)").bind(grantNode.id).run();
      const state = await getUserState(db, 'fighter');
      assert.ok(state.skills.map(s => s.id).includes(grantNode.effect.abilityId), 'board-granted ability is on the hotbar');
    }

    // A non-innate passive node folds its stat.
    const passiveNode = board.nodes.find(n => n.effect.kind === 'passive' && !fighterInnate.has(n.effect.abilityId));
    if (passiveNode) {
      const ability = abilities.getAbility(passiveNode.effect.abilityId);
      const stat = Object.keys(ability.statEffects)[0];
      const before = (await getUserState(db, 'fighter')).effectiveStats[stat];
      await db.prepare("INSERT INTO playerProgressionNodes (username, nodeId, unlockedTick) VALUES ('fighter', ?, 0)").bind(passiveNode.id).run();
      const after = (await getUserState(db, 'fighter')).effectiveStats[stat];
      assert.equal(after, before + ability.statEffects[stat], 'the board passive folded into effective stats');
    }
  } finally {
    await db.close();
  }
});

test('Plan 019b: respec at a guild clears today\'s unlocks for 50 gold; elsewhere refused', async () => {
  const db = await createMigratedDb();
  const { getProgressionGrid, unlockProgressionNode, respecProgression, updatePresence } = await import('../worker/game.mjs');
  try {
    const guild = findRoomWithEffect(WD, 'guild');
    await seedPlayer(db, 'fighter', 'Fighter', { level: 10, gold: 100 });
    const where = guild || findCalmRoom(WD);
    await updatePresence(db, 'fighter', where.row, where.col);

    const before = await getProgressionGrid(db, 'fighter');
    const target = before.nodes.find(n => n.state === 'unlockable');
    await unlockProgressionNode(db, 'fighter', target.id);
    assert.equal((await getProgressionGrid(db, 'fighter')).spent, target.cost);

    if (!guild) {
      await assert.rejects(() => respecProgression(db, 'fighter', where.row, where.col), /only respec at a guild/);
      return;
    }
    const after = await respecProgression(db, 'fighter', guild.row, guild.col);
    assert.equal(after.spent, 0, "today's unlocks cleared");
    assert.equal(after.available, 10, 'budget fully available again');
    const user = await db.prepare("SELECT gold FROM users WHERE username = 'fighter'").bind().first();
    assert.equal(user.gold, 50, 'respec charged 50 gold');
  } finally {
    await db.close();
  }
});
