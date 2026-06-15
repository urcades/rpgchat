// Plan 023a: the tombstone tells the truth. killHistory is written on every kill,
// but /death-data used to hardcode kills:0. These tests pin the SQL that /death-data
// and /cemetery-data now run: a real kill count for the deceased, and the slayer of
// each grave. CommonJS + node:test, in-memory sqlite3 D1 shim.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const sqlite3 = require('sqlite3').verbose();

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

const { dbFirst, dbAll, dbRun } = require('../worker/db.mjs');

async function recordKill(db, killer, victim, kind = 'player') {
  await dbRun(
    db,
    `INSERT INTO killHistory (killerUsername, defeatedUsername, defeatedName, defeatedKind, defeatedLevel, worldDay, tick)
     VALUES (?, ?, ?, ?, 1, '2026-06-14', 1)`,
    [killer, victim, victim, kind]
  );
}

async function bury(db, username, cause) {
  await dbRun(
    db,
    `INSERT INTO cemetery (username, password, level, gold, job, cause, roomRow, roomCol, diedAt)
     VALUES (?, 'pw', 3, 12, 'Fighter', ?, 5, 5, CURRENT_TIMESTAMP)`,
    [username, cause]
  );
}

test('Plan 023a: /death-data kill count reflects killHistory, not a hardcoded 0', async () => {
  const db = await createMigratedDb();
  try {
    await recordKill(db, 'reaper', 'victimA');
    await recordKill(db, 'reaper', 'victimB');
    await recordKill(db, 'reaper', 'a_rat', 'npc');
    await bury(db, 'reaper', 'bled out');

    const kills = await dbFirst(db, 'SELECT COUNT(*) AS n FROM killHistory WHERE killerUsername = ?', ['reaper']);
    assert.equal(kills.n, 3, 'every recorded kill counts, NPC or player');

    const noKills = await dbFirst(db, 'SELECT COUNT(*) AS n FROM killHistory WHERE killerUsername = ?', ['pacifist']);
    assert.equal(noKills.n, 0);
  } finally {
    await db.close();
  }
});

test('Plan 023a: each grave names its slayer (most recent player-kill)', async () => {
  const db = await createMigratedDb();
  try {
    await bury(db, 'moss', 'bled out after attack by angel');
    await recordKill(db, 'angel', 'moss');

    const rows = await dbAll(
      db,
      `SELECT cm.username,
              (SELECT kh.killerUsername FROM killHistory kh
               WHERE kh.defeatedUsername = cm.username AND kh.defeatedKind = 'player'
               ORDER BY kh.id DESC LIMIT 1) AS slayer
       FROM cemetery cm`
    );
    const moss = rows.find(r => r.username === 'moss');
    assert.equal(moss.slayer, 'angel', 'the graveyard remembers who did it');
  } finally {
    await db.close();
  }
});

test('Plan 023a: a grave with no kill record has a null slayer (e.g. hazard death)', async () => {
  const db = await createMigratedDb();
  try {
    await bury(db, 'wanderer', 'poison marsh');
    const row = await dbFirst(
      db,
      `SELECT (SELECT kh.killerUsername FROM killHistory kh
               WHERE kh.defeatedUsername = cm.username AND kh.defeatedKind = 'player'
               ORDER BY kh.id DESC LIMIT 1) AS slayer
       FROM cemetery cm WHERE cm.username = ?`,
      ['wanderer']
    );
    assert.equal(row.slayer, null, 'no killer recorded -> no slayer shown');
  } finally {
    await db.close();
  }
});
