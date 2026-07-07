// Shared test D1 shim. Wraps an in-memory sqlite3 database in the minimal subset
// of the Cloudflare D1 prepared-statement API that the worker under test uses
// (exec / close / prepare -> bind / first / all / run). Extracted verbatim from the
// per-file copies that used to live in ~28 of test/*.test.js (plan adv-002).
//
// CommonJS to match the rest of test/ (the suites run under `node --test` and
// dynamically `await import('../worker/game.mjs')` for the ESM under test).

const fs = require('node:fs');
const path = require('node:path');
const sqlite3 = require('sqlite3').verbose();

function createSqliteD1() {
  const raw = new sqlite3.Database(':memory:');
  return {
    raw,
    exec(sql) { return new Promise((resolve, reject) => raw.exec(sql, err => (err ? reject(err) : resolve()))); },
    close() { return new Promise((resolve, reject) => raw.close(err => (err ? reject(err) : resolve()))); },
    // D1's batch(): run the prepared statements atomically, returning per-statement
    // results in order (SELECTs carry rows in `.results`, like D1).
    async batch(statements) {
      await this.exec('BEGIN');
      try {
        const results = [];
        for (const statement of statements) {
          if (/^\s*SELECT/i.test(statement.sql)) {
            const all = await statement.all();
            results.push({ results: all.results, meta: { changes: 0, last_row_id: null } });
          } else {
            results.push(await statement.run());
          }
        }
        await this.exec('COMMIT');
        return results;
      } catch (err) {
        await this.exec('ROLLBACK').catch(() => {});
        throw err;
      }
    },
    prepare(sql) {
      return {
        sql,
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
  const dir = path.join(__dirname, '../../migrations');
  for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) {
    await db.exec(fs.readFileSync(path.join(dir, file), 'utf8'));
  }
  return db;
}

module.exports = { createSqliteD1, createMigratedDb };
