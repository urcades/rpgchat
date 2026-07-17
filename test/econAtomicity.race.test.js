// adv-017/018 — economy/status atomicity under concurrency. Each test drives the
// race the production code faces (concurrent HTTP/alarm/cron with NO D1 transaction):
// two operations whose read-decide phase overlaps, both observing the SAME precondition
// before either writes. The fixes make the WRITE the claim (DELETE / INSERT ON CONFLICT
// / conditional-relative UPDATE), so only ONE operation's effect lands. These tests
// assert the single-effect outcome that the pre-fix read-decide-write would have doubled.
//
// The shared D1 shim serializes statements on one in-memory connection, so the race is
// reproduced by INTERLEAVING the read phase explicitly: a gated db proxy pauses the first
// operation at its claiming write, lets the second operation read the same precondition
// and complete, then releases the first. That is exactly the interleave two concurrent
// requests hit in production. CommonJS + node:test to match the rest of test/.

const assert = require('node:assert/strict');
const test = require('node:test');
const { createMigratedDb } = require('./.helpers/d1');
const { getWorldDay, generateRoomFeatures, calculateInnFee } = require('../utils/roomEcology');

// ---------------------------------------------------------------------------
// Interleave harness. Wraps a db so that the FIRST run() whose SQL matches `gateOn`
// is paused at the point of writing: prepare/bind/first/all pass straight through, but
// that one run() blocks on a release latch the test controls. This lets op A reach its
// claiming write and stop, op B run end-to-end (reading the same precondition A saw),
// then A resume — the precise read/read/write/write interleave of two racing requests.

function makeGate(db, gateOn) {
  let gatedReached;
  let release;
  const reached = new Promise(resolve => { gatedReached = resolve; });
  const released = new Promise(resolve => { release = resolve; });
  let armed = true;

  const proxy = {
    raw: db.raw,
    exec: (...a) => db.exec(...a),
    close: () => db.close(),
    prepare(sql) {
      const stmt = db.prepare(sql);
      const shouldGate = armed && sql.includes(gateOn);
      return {
        bind(...params) { stmt.bind(...params); return this; },
        first() { return stmt.first(); },
        all() { return stmt.all(); },
        async run() {
          if (shouldGate) {
            armed = false;       // gate only the FIRST matching write
            gatedReached();      // signal op A has reached its claim write
            await released;      // hold until the test releases (after op B finishes)
          }
          return stmt.run();
        }
      };
    }
  };

  return { proxy, reached, release: () => release() };
}

// ---------------------------------------------------------------------------
// Room/seed helpers (mirror the conventions in the existing suites).

function findCalmRoom(worldDay) {
  const hazardous = ['poison_marsh', 'moon_room', 'echo_chamber', 'pub', 'inn', 'sun_room', 'cold_room', 'guild', 'gambling_den'];
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

async function seedUser(db, username, overrides = {}) {
  const s = {
    job: 'Novice', health: 30, maxHealth: 30, stamina: 100, maxStamina: 100,
    speed: 1, strength: 1, intelligence: 1, level: 0, gold: 0,
    experience: 0, attributePoints: 0, skillPoints: 0, ...overrides
  };
  await db.prepare(
    `INSERT INTO users
      (username, password, job, health, maxHealth, stamina, maxStamina, speed, strength,
       intelligence, level, gold, experience, attributePoints, skillPoints)
     VALUES (?, 'pw', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    username, s.job, s.health, s.maxHealth, s.stamina, s.maxStamina, s.speed,
    s.strength, s.intelligence, s.level, s.gold, s.experience, s.attributePoints, s.skillPoints
  ).run();
}

// ===========================================================================
// FIX 1 — ward/mark consumption (combat.mjs). The DELETE is the claim: two hits
// that both SELECT one ward must NOT both subtract its magnitude.

test('adv-018 race: a single ward absorbs ONE concurrent hit, not two', async () => {
  const db = await createMigratedDb();
  const { handleAttack, addStatusEffect, getCurrentTickValue, updatePresence } = await import('../worker/game.mjs');
  try {
    const calm = findCalmRoom(getWorldDay());
    // Two attackers, one victim. strength 4 => base hit damage = 1 + floor(4/4) = 2.
    // High attacker speed vs the victim's 1 pins the speed contest at the 0.95 ceiling,
    // so a roll of 0.5 always lands (keeps the test about ward consumption, not dodging).
    await seedUser(db, 'striker1', { speed: 20, strength: 4 });
    await seedUser(db, 'striker2', { speed: 20, strength: 4 });
    await seedUser(db, 'victim', { speed: 1, strength: 1, health: 30, maxHealth: 30 });
    for (const n of ['striker1', 'striker2', 'victim']) await updatePresence(db, n, calm.row, calm.col);

    const tick = await getCurrentTickValue(db);
    // ONE ward, magnitude 5, on the victim — big enough that double-consumption would be
    // unmistakable in the health delta.
    await addStatusEffect(db, { username: 'victim', source: 'victim', effectType: 'ward', magnitude: 5, currentTick: tick, duration: 10, row: calm.row, col: calm.col });

    const before = (await db.prepare('SELECT health FROM users WHERE username = ?').bind('victim').first()).health;

    // Force both blows to LAND but neither to crit: speed contest roll 0.5 (< 0.95 hit),
    // crit gate 0.99 (>= 0.01 → no crit). Two reads per attack (contest, crit). The
    // victim is unbodied-free here? No — players are bodied; applyBodyDamage draws a part
    // pick too, so pad the mocked sequence with a steady 0.5 tail.
    const seq = [0.5, 0.99, 0.5, 0.5, 0.99, 0.5, 0.5, 0.5, 0.5, 0.5];
    const realRandom = Math.random;
    let i = 0;
    Math.random = () => seq[Math.min(i++, seq.length - 1)];

    // Gate striker1's ward DELETE so striker2 reads the SAME ward before it is removed —
    // the exact two-reads-then-two-deletes interleave the pre-fix code mishandled.
    const gate = makeGate(db, 'DELETE FROM statusEffects WHERE id = ?');
    try {
      const a = handleAttack(gate.proxy, 'striker1', '@victim', calm.row, calm.col);
      await gate.reached;                 // striker1 paused at its ward DELETE
      await handleAttack(db, 'striker2', '@victim', calm.row, calm.col); // striker2 runs fully
      gate.release();                     // striker1 resumes; its DELETE now no-ops (row gone)
      await a;
    } finally {
      Math.random = realRandom;
    }

    const after = (await db.prepare('SELECT health FROM users WHERE username = ?').bind('victim').first()).health;
    // Both blows base damage 2. Exactly ONE is warded (−5, floored at 0 → that blow deals
    // max(0, 2−5)=0); the other deals its full 2. Total = 2, NOT 4 (no ward) and NOT
    // 0 (ward wrongly consumed twice). And the ward row is gone.
    assert.equal(before - after, 2, 'one ward absorbed exactly one of the two concurrent blows');
    const wards = await db.prepare("SELECT COUNT(*) AS c FROM statusEffects WHERE username = 'victim' AND effectType = 'ward'").first();
    assert.equal(wards.c, 0, 'the single ward was consumed exactly once and removed');
  } finally {
    await db.close();
  }
});

test('adv-018 race: a single mark double-counts at most ONCE across concurrent power strikes', async () => {
  const db = await createMigratedDb();
  const { runAbility, addStatusEffect, getCurrentTickValue, getEffectiveUser, getUser, updatePresence } = await import('../worker/game.mjs');
  try {
    const calm = findCalmRoom(getWorldDay());
    await seedUser(db, 'fighterA', { job: 'Fighter', speed: 20, strength: 4 });
    await seedUser(db, 'fighterB', { job: 'Fighter', speed: 20, strength: 4 });
    await seedUser(db, 'mark_victim', { speed: 1, health: 60, maxHealth: 60 });
    for (const n of ['fighterA', 'fighterB', 'mark_victim']) await updatePresence(db, n, calm.row, calm.col);

    const tick = await getCurrentTickValue(db);
    // ONE mark, magnitude 5, on the victim. power_strike base damage = 1 + floor(STR/2);
    // a Fighter's job bonus lifts effective STR from 4 to 7, so base = 1 + floor(7/2) = 4.
    // A consumed mark adds its magnitude (→ 9). Pre-fix, BOTH casts read and consumed the
    // same mark, so both dealt 9 (total 18); fixed, only one cast claims it (total 13).
    await addStatusEffect(db, { username: 'mark_victim', source: 'fighterA', effectType: 'marked', magnitude: 5, currentTick: tick, duration: 20, row: calm.row, col: calm.col });

    const before = (await db.prepare('SELECT health FROM users WHERE username = ?').bind('mark_victim').first()).health;

    // power_strike's lone RNG read is its speed contest (tryHarmfulSkillHit). 0.5 lands
    // (attacker speed 20 vs 1 → 0.95 ceiling). Both casts hit.
    const realRandom = Math.random;
    Math.random = () => 0.5;

    const fA = await getUser(db, 'fighterA');
    const fB = await getUser(db, 'fighterB');
    const castA = { username: 'fighterA', effectiveActor: getEffectiveUser(fA), target: 'mark_victim', row: calm.row, col: calm.col, currentTick: tick, phase: 'Day', isPlayerCast: true };
    const castB = { username: 'fighterB', effectiveActor: getEffectiveUser(fB), target: 'mark_victim', row: calm.row, col: calm.col, currentTick: tick, phase: 'Day', isPlayerCast: true };

    // Gate fighterA's mark DELETE so fighterB reads the SAME mark first.
    const gate = makeGate(db, 'DELETE FROM statusEffects WHERE id = ?');
    let resA;
    try {
      const a = runAbility(gate.proxy, 'power_strike', castA).then(r => { resA = r; });
      await gate.reached;
      const resB = await runAbility(db, 'power_strike', castB);
      gate.release();
      await a;

      // Exactly ONE cast got the +5 mark bonus (damage 9); the other got base 4.
      const damages = [resA.damage, resB.damage].sort((x, y) => x - y);
      assert.deepEqual(damages, [4, 9], 'the mark bonus applied to exactly one of the two concurrent strikes');
    } finally {
      Math.random = realRandom;
    }

    const after = (await db.prepare('SELECT health FROM users WHERE username = ?').bind('mark_victim').first()).health;
    assert.equal(before - after, 13, 'total damage = 4 (unmarked) + 9 (marked once), not 18 (mark counted twice)');
    const marks = await db.prepare("SELECT COUNT(*) AS c FROM statusEffects WHERE username = 'mark_victim' AND effectType = 'marked'").first();
    assert.equal(marks.c, 0, 'the single mark was consumed exactly once');
  } finally {
    await db.close();
  }
});

// ===========================================================================
// FIX 2 — gambling double-round (combat.mjs). Two first-rollers in one den/tick must
// converge on ONE open round, not create two that each pay a winner.

test('adv-018 race: two concurrent first /roll-ers in a den converge on ONE open round', async () => {
  const db = await createMigratedDb();
  const { handleRollCommand, getCurrentTickValue, updatePresence } = await import('../worker/game.mjs');
  try {
    const worldDay = getWorldDay();
    const den = findRoomWithEffect(worldDay, 'gambling_den');
    assert.ok(den, 'today has a gambling den');
    await seedUser(db, 'gambler1', { gold: 100 });
    await seedUser(db, 'gambler2', { gold: 100 });
    for (const n of ['gambler1', 'gambler2']) await updatePresence(db, n, den.row, den.col);

    const tick = await getCurrentTickValue(db);
    assert.equal(tick, 0, 'fresh DB sits at tick 0 (round open window is generous)');

    // /roll reads a d20 (Math.random); fix both rolls to keep the test deterministic.
    const realRandom = Math.random;
    Math.random = () => 0.5; // floor(0.5*20)+1 = 11

    let r1;
    try {
      // Gate gambler1 at the round INSERT, so gambler2 ALSO sees "no open round" and
      // INSERTs — the exact interleave that pre-fix produced two open rounds. The
      // INSERT-then-RESELECT fix makes both join the earliest surviving round.
      const gate = makeGate(db, 'INSERT INTO gamblingRounds');
      const a = handleRollCommand(gate.proxy, 'gambler1', den.row, den.col, '/roll 10').then(r => { r1 = r; });
      await gate.reached;
      const r2 = await handleRollCommand(db, 'gambler2', den.row, den.col, '/roll 10');
      gate.release();
      await a;

      // Both rollers landed on the SAME round id.
      assert.equal(r1.roundId, r2.roundId, 'both first-rollers joined ONE round');
    } finally {
      Math.random = realRandom;
    }

    // At most one round may carry entries; that round's pool is the sum of both wagers.
    const rounds = await db.prepare(
      "SELECT id, pool FROM gamblingRounds WHERE roomRow = ? AND roomCol = ? AND worldDay = ? AND status = 'open' ORDER BY id ASC"
    ).bind(den.row, den.col, worldDay).all();
    const entriesPerRound = [];
    for (const round of rounds.results) {
      const e = await db.prepare('SELECT COUNT(*) AS c FROM gamblingEntries WHERE roundId = ?').bind(round.id).first();
      entriesPerRound.push({ id: round.id, pool: round.pool, entries: e.c });
    }
    const withEntries = entriesPerRound.filter(r => r.entries > 0);
    assert.equal(withEntries.length, 1, 'exactly ONE round holds entries (the pool is never split across two)');
    assert.equal(withEntries[0].entries, 2, 'both wagers entered the one round');
    assert.equal(withEntries[0].pool, 20, 'the pool holds both wagers (10 + 10)');

    // Both wagers were charged exactly once each (gold spent is honest).
    const g1 = (await db.prepare('SELECT gold FROM users WHERE username = ?').bind('gambler1').first()).gold;
    const g2 = (await db.prepare('SELECT gold FROM users WHERE username = ?').bind('gambler2').first()).gold;
    assert.equal(g1, 90, 'gambler1 charged exactly one 10-gold wager');
    assert.equal(g2, 90, 'gambler2 charged exactly one 10-gold wager');
  } finally {
    await db.close();
  }
});

test('adv-018 race: only ONE winner is paid when both rollers race the first /roll then the round resolves', async () => {
  const db = await createMigratedDb();
  const { handleRollCommand, resolveExpiredGamblingRounds, getCurrentTickValue, updatePresence } = await import('../worker/game.mjs');
  try {
    const worldDay = getWorldDay();
    const den = findRoomWithEffect(worldDay, 'gambling_den');
    assert.ok(den, 'today has a gambling den');
    await seedUser(db, 'punterA', { gold: 100 });
    await seedUser(db, 'punterB', { gold: 100 });
    for (const n of ['punterA', 'punterB']) await updatePresence(db, n, den.row, den.col);

    const tick = await getCurrentTickValue(db);
    const realRandom = Math.random;
    // Two distinct rolls (11 and 20) so there is one unambiguous high roller. The gate
    // pauses punterA BEFORE its own roll, so the two d20 draws interleave — whichever
    // ends up higher wins. The point under test is single-round / single-payout, not who
    // wins, so the assertions below are order-independent.
    const seq = [0.5, 0.97];
    let i = 0;
    Math.random = () => seq[Math.min(i++, seq.length - 1)];

    try {
      const gate = makeGate(db, 'INSERT INTO gamblingRounds');
      const a = handleRollCommand(gate.proxy, 'punterA', den.row, den.col, '/roll 10');
      await gate.reached;
      await handleRollCommand(db, 'punterB', den.row, den.col, '/roll 10');
      gate.release();
      await a;
    } finally {
      Math.random = realRandom;
    }

    // Resolve every round past its window. With the bug this paid TWO winners (one per
    // duplicate round) out of two split pools; fixed, exactly one round has both entries
    // and pays one winner the full pool.
    await resolveExpiredGamblingRounds(db, tick + 100);

    const resolved = await db.prepare(
      "SELECT winner, pool FROM gamblingRounds WHERE roomRow = ? AND roomCol = ? AND worldDay = ? AND winner IS NOT NULL"
    ).bind(den.row, den.col, worldDay).all();
    assert.equal(resolved.results.length, 1, 'exactly ONE round paid out a winner (not two split pools)');
    assert.ok(['punterA', 'punterB'].includes(resolved.results[0].winner), 'the winner is one of the two rollers');
    assert.equal(resolved.results[0].pool, 20, 'the winner took the whole undivided pool (10 + 10)');

    // Net gold across the table is conserved: both staked 10; the single winner gets the
    // 20 pool back (net +10), the loser is down their one wager (net −10). No double payout.
    const a = (await db.prepare('SELECT gold FROM users WHERE username = ?').bind('punterA').first()).gold;
    const b = (await db.prepare('SELECT gold FROM users WHERE username = ?').bind('punterB').first()).gold;
    const winnerGold = resolved.results[0].winner === 'punterA' ? a : b;
    const loserGold = resolved.results[0].winner === 'punterA' ? b : a;
    assert.equal(winnerGold, 110, 'winner net +10 (staked 10, won the 20 pool) — paid exactly once');
    assert.equal(loserGold, 90, 'loser is down exactly their one wager');
    assert.equal(a + b, 200, 'total gold conserved — no money minted by a duplicate round');
  } finally {
    await db.close();
  }
});

// ===========================================================================
// FIX 3 — payInnAccess (world.mjs). The access row is the idempotency anchor: two
// concurrent pays must charge the fee ONCE.

test('adv-018 race: two concurrent inn pays charge the fee exactly ONCE', async () => {
  const db = await createMigratedDb();
  const { payInnAccess, getRoomAccessState, updatePresence } = await import('../worker/game.mjs');
  try {
    const worldDay = getWorldDay();
    const inn = findRoomWithEffect(worldDay, 'inn');
    assert.ok(inn, 'today has an inn room');
    const fee = calculateInnFee(inn.row, inn.col, worldDay);
    assert.ok(fee > 0, 'the inn charges a positive fee');

    await seedUser(db, 'lodger', { gold: 100 });
    await updatePresence(db, 'lodger', inn.row, inn.col);

    // Gate the FIRST pay at its access-row write (the substring matches both the pre-fix
    // INSERT OR REPLACE and the fixed INSERT ... ON CONFLICT, so the gate fires either
    // way), so the second pay also reads "unpaid" and proceeds. Pre-fix this is the
    // spend-then-write interleave that charged twice; the fixed ON CONFLICT anchor lets
    // exactly one pay spend gold — the other conflicts and is treated as already-paid.
    const gate = makeGate(db, 'INTO roomAccess');
    const r1Promise = payInnAccess(gate.proxy, 'lodger', inn.row, inn.col);
    await gate.reached;
    const r2 = await payInnAccess(db, 'lodger', inn.row, inn.col);
    gate.release();
    const r1 = await r1Promise;

    const goldAfter = (await db.prepare('SELECT gold FROM users WHERE username = ?').bind('lodger').first()).gold;
    assert.equal(goldAfter, 100 - fee, 'the fee was deducted exactly once across two concurrent pays');

    // Both calls report paid; exactly one access row exists.
    assert.equal(r1.paid, true, 'first pay reports paid');
    assert.equal(r2.paid, true, 'second (racing) pay also reports paid');
    const rows = await db.prepare(
      "SELECT COUNT(*) AS c FROM roomAccess WHERE username = 'lodger' AND roomRow = ? AND roomCol = ? AND worldDay = ?"
    ).bind(inn.row, inn.col, worldDay).first();
    assert.equal(rows.c, 1, 'exactly one access row anchors the paid state');

    const state = await getRoomAccessState(db, 'lodger', inn.row, inn.col);
    assert.equal(state.paid, true, 'access is granted');
    assert.equal(state.costPaid, fee, 'the recorded cost is the single fee');
  } finally {
    await db.close();
  }
});

test('adv-018: a broke player still cannot pay inn access (402) and loses no gold', async () => {
  // Guards the rollback path of the new ON-CONFLICT anchor: winning the access claim but
  // failing the gold check must NOT leave the player let-in-for-free, and must still 402.
  const db = await createMigratedDb();
  const { payInnAccess, getRoomAccessState, updatePresence } = await import('../worker/game.mjs');
  try {
    const worldDay = getWorldDay();
    const inn = findRoomWithEffect(worldDay, 'inn');
    assert.ok(inn, 'today has an inn room');
    const fee = calculateInnFee(inn.row, inn.col, worldDay);

    await seedUser(db, 'pauper', { gold: Math.max(0, fee - 1) });
    await updatePresence(db, 'pauper', inn.row, inn.col);

    await assert.rejects(() => payInnAccess(db, 'pauper', inn.row, inn.col), /Not enough gold/);

    const goldAfter = (await db.prepare('SELECT gold FROM users WHERE username = ?').bind('pauper').first()).gold;
    assert.equal(goldAfter, Math.max(0, fee - 1), 'the broke player lost no gold');
    const rows = await db.prepare(
      "SELECT COUNT(*) AS c FROM roomAccess WHERE username = 'pauper' AND roomRow = ? AND roomCol = ? AND worldDay = ?"
    ).bind(inn.row, inn.col, worldDay).first();
    assert.equal(rows.c, 0, 'no access row lingers — the anchor was rolled back, the fee gate stays honest');
    const state = await getRoomAccessState(db, 'pauper', inn.row, inn.col);
    assert.equal(state.paid, false, 'the broke player is still gated out');
  } finally {
    await db.close();
  }
});

// ===========================================================================
// FIX 4 — awardExperience (progression.mjs). Relative write + claim-then-act level
// reconcile: two concurrent awards must sum (none lost) and grant level/AP/SP once.

test('adv-018 race: two concurrent XP awards sum to E + both amounts (none lost)', async () => {
  const db = await createMigratedDb();
  // awardExperience is an internal progression helper (the public surface calls it via
  // updateLevel), so import the seam directly — same pattern other seam tests use.
  const { awardExperience } = await import('../worker/game/progression.mjs');
  try {
    // Start mid-level (50 XP, level 0) so neither small award crosses a threshold —
    // isolates the lost-update on experience itself.
    await seedUser(db, 'grinderX', { experience: 50, level: 0, attributePoints: 0, skillPoints: 0 });

    // Gate the FIRST award at its experience UPDATE (the substring matches both the
    // pre-fix absolute write and the fixed relative write, so this gate fires either
    // way), so the second award reads the SAME starting experience. A pre-fix ABSOLUTE
    // write (experience = read + amount) drops one award under this interleave; the
    // fixed relative write (experience = experience + amount) sums both.
    const gate = makeGate(db, 'UPDATE users SET experience');
    const a = awardExperience(gate.proxy, 'grinderX', 10);
    await gate.reached;
    await awardExperience(db, 'grinderX', 25);
    gate.release();
    await a;

    const row = await db.prepare('SELECT experience, level FROM users WHERE username = ?').bind('grinderX').first();
    assert.equal(row.experience, 85, 'both awards landed: 50 + 10 + 25, none lost');
    assert.equal(row.level, 0, 'still under the level-1 threshold (100 XP)');
  } finally {
    await db.close();
  }
});

test('adv-018 race: a level-up grants its 10 AP + 1 SP exactly once across racing awards', async () => {
  const db = await createMigratedDb();
  // awardExperience is an internal progression helper (the public surface calls it via
  // updateLevel), so import the seam directly — same pattern other seam tests use.
  const { awardExperience } = await import('../worker/game/progression.mjs');
  try {
    // 95 XP, level 0. Each award is +10 XP → the SUM (115) crosses 100 to level 1 once.
    // The race must not (a) lose an award, nor (b) grant the level-1 reward twice.
    await seedUser(db, 'grinderY', { experience: 95, level: 0, attributePoints: 0, skillPoints: 0 });

    const gate = makeGate(db, 'UPDATE users SET experience');
    const a = awardExperience(gate.proxy, 'grinderY', 10);
    await gate.reached;
    await awardExperience(db, 'grinderY', 10);
    gate.release();
    await a;

    const row = await db.prepare(
      'SELECT experience, level, attributePoints, skillPoints FROM users WHERE username = ?'
    ).bind('grinderY').first();
    assert.equal(row.experience, 115, 'both awards summed (95 + 10 + 10), none lost');
    assert.equal(row.level, 1, 'crossed exactly one threshold to level 1');
    assert.equal(row.attributePoints, 10, 'the single level gained 10 attribute points (not 20)');
    assert.equal(row.skillPoints, 1, 'the single level gained 1 skill point (not 2)');
  } finally {
    await db.close();
  }
});

test('adv-018: a single uncontended XP award is byte-identical to the prior behavior', async () => {
  // Regression guard for the rewrite: one call that crosses two levels at once must
  // report leveled/level and grant 2×(10 AP + 1 SP) exactly as the absolute-write code did.
  const db = await createMigratedDb();
  // awardExperience is an internal progression helper (the public surface calls it via
  // updateLevel), so import the seam directly — same pattern other seam tests use.
  const { awardExperience } = await import('../worker/game/progression.mjs');
  try {
    await seedUser(db, 'soloist', { experience: 0, level: 0, attributePoints: 0, skillPoints: 0 });
    const result = await awardExperience(db, 'soloist', 250); // 250/100 = level 2
    assert.equal(result.experience, 250, 'returned fresh experience');
    assert.equal(result.level, 2, 'reached level 2');
    assert.equal(result.leveled, true, 'reports a level-up');
    const row = await db.prepare(
      'SELECT experience, level, attributePoints, skillPoints FROM users WHERE username = ?'
    ).bind('soloist').first();
    assert.equal(row.level, 2, 'persisted level 2');
    assert.equal(row.attributePoints, 20, 'two levels × 10 AP');
    assert.equal(row.skillPoints, 2, 'two levels × 1 SP');
  } finally {
    await db.close();
  }
});

// ===========================================================================
// adv DUR-06 — the wager debit rides IN the entry batch (all-or-nothing). An
// unaffordable wager must leave zero traces: no debit, no entry, no pool bump,
// no table-talk message. (Pre-fix the debit was a separate round trip; a crash
// between it and the batch lost the stake.)

test('adv DUR-06: an unaffordable /roll leaves NO partial writes (debit/entry/pool/message)', async () => {
  const db = await createMigratedDb();
  const { handleRollCommand, updatePresence } = await import('../worker/game.mjs');
  try {
    const worldDay = getWorldDay();
    const den = findRoomWithEffect(worldDay, 'gambling_den');
    assert.ok(den, 'today has a gambling den');
    await seedUser(db, 'pauper', { gold: 5 });
    await updatePresence(db, 'pauper', den.row, den.col);

    await assert.rejects(
      handleRollCommand(db, 'pauper', den.row, den.col, '/roll 10'),
      /Not enough gold/,
      'the wager is refused'
    );

    const gold = (await db.prepare('SELECT gold FROM users WHERE username = ?').bind('pauper').first()).gold;
    assert.equal(gold, 5, 'gold untouched');
    const entries = await db.prepare("SELECT COUNT(*) AS c FROM gamblingEntries WHERE username = 'pauper'").first();
    assert.equal(entries.c, 0, 'no gambling entry recorded');
    const pools = await db.prepare(
      'SELECT COALESCE(SUM(pool), 0) AS p FROM gamblingRounds WHERE roomRow = ? AND roomCol = ?'
    ).bind(den.row, den.col).first();
    assert.equal(pools.p, 0, 'no pool credit');
    const chatter = await db.prepare(
      "SELECT COUNT(*) AS c FROM messages WHERE kind = 'dice' AND message LIKE 'pauper%'"
    ).first();
    assert.equal(chatter.c, 0, 'no table-talk line for the refused wager');
  } finally {
    await db.close();
  }
});

test('adv DUR-06: an affordable /roll lands debit + entry + pool + message together', async () => {
  const db = await createMigratedDb();
  const { handleRollCommand, updatePresence } = await import('../worker/game.mjs');
  try {
    const worldDay = getWorldDay();
    const den = findRoomWithEffect(worldDay, 'gambling_den');
    await seedUser(db, 'highroller', { gold: 50 });
    await updatePresence(db, 'highroller', den.row, den.col);

    const result = await handleRollCommand(db, 'highroller', den.row, den.col, '/roll 20');
    assert.ok(result.roundId, 'joined a round');

    const gold = (await db.prepare('SELECT gold FROM users WHERE username = ?').bind('highroller').first()).gold;
    assert.equal(gold, 30, 'wager debited once');
    const entry = await db.prepare("SELECT wager FROM gamblingEntries WHERE username = 'highroller'").first();
    assert.equal(entry.wager, 20, 'entry recorded');
    const round = await db.prepare('SELECT pool FROM gamblingRounds WHERE id = ?').bind(result.roundId).first();
    assert.equal(round.pool, 20, 'pool credited');
    const chatter = await db.prepare(
      "SELECT COUNT(*) AS c FROM messages WHERE kind = 'dice' AND message LIKE 'highroller enters%'"
    ).first();
    assert.equal(chatter.c, 1, 'table talk landed');
  } finally {
    await db.close();
  }
});
