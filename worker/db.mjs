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

export function changes(result) {
  return result?.meta?.changes ?? result?.changes ?? 0;
}

export function lastInsertId(result) {
  return result?.meta?.last_row_id ?? result?.lastID ?? null;
}
