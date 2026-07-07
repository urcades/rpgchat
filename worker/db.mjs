export async function dbFirst(db, sql, params = []) {
  return db.prepare(sql).bind(...params).first();
}

export async function dbAll(db, sql, params = []) {
  const result = await db.prepare(sql).bind(...params).all();
  return result.results || [];
}

export async function dbRun(db, sql, params = []) {
  return db.prepare(sql).bind(...params).run();
}

// Run several statements in ONE D1 round trip (atomic — D1 wraps the batch in an
// implicit transaction). `statements` is an array of [sql, params?] pairs; returns
// the per-statement results in order (SELECTs carry `.results`). Falls back to
// sequential execution on adapters without .batch (loses atomicity, keeps shape).
export async function dbBatch(db, statements) {
  const prepared = statements.map(([sql, params = []]) => db.prepare(sql).bind(...params));
  if (typeof db.batch === 'function') {
    return db.batch(prepared);
  }
  const results = [];
  for (const statement of prepared) {
    results.push(await statement.run());
  }
  return results;
}

export function batchRows(result) {
  return result?.results || [];
}

export function changes(result) {
  return result?.meta?.changes ?? result?.changes ?? 0;
}

export function lastInsertId(result) {
  return result?.meta?.last_row_id ?? result?.lastID ?? null;
}
