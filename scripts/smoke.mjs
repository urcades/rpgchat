#!/usr/bin/env node
// Live smoke test against a DEPLOYED RPGChat instance.
//
// Why this exists: `npm test` builds a fresh in-memory SQLite, applies ALL
// migrations, then tests the code against it — so the suite stays green even
// when the *remote* D1 schema is stale. That blind spot is exactly what blanked
// the status panel in prod: code referencing `users.stance` (migration 0007) was
// deployed while the remote DB was still at 0003, so every auth-gated query hit
// "no such column" and 500'd. Unit tests structurally cannot see that. This does:
// it signs in against the real running system and asserts the state endpoints
// return populated data.
//
// Usage:
//   node scripts/smoke.mjs                                  # production (default)
//   node scripts/smoke.mjs http://localhost:8787            # local `npm run dev`
//   BASE_URL=https://preview.example.dev node scripts/smoke.mjs
//
// Exits non-zero if any check fails, so it can gate a deploy.

const BASE_URL = (process.argv[2] || process.env.BASE_URL || 'https://rpgchat-worker.organelle.workers.dev').replace(/\/$/, '');
const QA_USER = process.env.SMOKE_USER || 'qa_smoke_bot';
const QA_PASS = process.env.SMOKE_PASS || 'qa-smoke-do-not-reuse';
const ROOM = { row: 8, col: 8 };

let cookie = '';
const results = [];

function form(obj) {
  return Object.entries(obj).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
}

async function req(method, path, { body, json } = {}) {
  const headers = { Accept: json ? 'application/json' : 'text/html' };
  if (body) headers['Content-Type'] = 'application/x-www-form-urlencoded';
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(`${BASE_URL}${path}`, { method, headers, body, redirect: 'manual' });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  return res;
}

function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok });
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`);
}

function finish() {
  const failed = results.filter(r => !r.ok).length;
  console.log('');
  if (failed) {
    console.log(`SMOKE FAILED: ${failed}/${results.length} checks failed against ${BASE_URL}`);
    process.exit(1);
  }
  console.log(`SMOKE PASSED: ${results.length}/${results.length} checks against ${BASE_URL}`);
}

async function main() {
  console.log(`smoke: ${BASE_URL} (room ${ROOM.row},${ROOM.col})\n`);

  // 1. Ensure the QA account exists. Idempotent: a 400 "Username already taken"
  //    on later runs is expected and fine — we just proceed to login.
  await req('POST', '/signup', {
    body: form({
      username: QA_USER, password: QA_PASS, job: 'Fighter',
      health: 2, stamina: 3, speed: 2, strength: 3, intelligence: 2
    })
  });

  // 2. Log in. A live session cookie is required for every check below.
  cookie = '';
  const login = await req('POST', '/login', { body: form({ username: QA_USER, password: QA_PASS }) });
  const loc = login.headers.get('location') || '';
  if (loc.includes('/death') || loc.includes('/you-died')) {
    check('QA account is alive', false, 'account is in the cemetery — reset it (see scripts/README or QA.md)');
    return finish();
  }
  check('login → /success', login.status >= 300 && login.status < 400 && loc.includes('/success'),
    `status ${login.status} → ${loc || '(no Location)'}`);
  if (!cookie) {
    check('session cookie set', false, 'no Set-Cookie on login response');
    return finish();
  }

  // 3. THE regression: /room-state must be 200 with a populated user + room.
  const rs = await req('GET', `/room-state/${ROOM.row}/${ROOM.col}`, { json: true });
  check('/room-state → 200', rs.status === 200, `status ${rs.status}`);
  let state = null;
  try { state = await rs.json(); } catch { /* non-JSON / error body */ }
  check('user.effectiveStats.maxHealth is a number', Number.isFinite(state?.user?.effectiveStats?.maxHealth),
    `maxHealth=${state?.user?.effectiveStats?.maxHealth}`);
  check('user.stance present (migration 0007)', typeof state?.user?.stance === 'string',
    `stance=${state?.user?.stance}`);
  check('user.body present (migration 0005)', Array.isArray(state?.user?.body) && state.user.body.length > 0,
    `parts=${state?.user?.body?.length}`);
  check('room coords echo the request', state?.room?.room?.row === ROOM.row && state?.room?.room?.col === ROOM.col);
  check('messages is an array', Array.isArray(state?.messages));

  // 4. /user-attributes — the exact handler whose SELECT referenced `stance`.
  const ua = await req('GET', '/user-attributes', { json: true });
  check('/user-attributes → 200', ua.status === 200, `status ${ua.status}`);

  // 5. /character — exercises bodyParts + items tables (migrations 0005/0006).
  const ch = await req('GET', '/character');
  check('/character → 200', ch.status === 200, `status ${ch.status}`);

  // 6. /tick — the unauthenticated control. If THIS fails the worker is fully down.
  const tick = await req('GET', '/tick', { json: true });
  check('/tick → 200', tick.status === 200, `status ${tick.status}`);

  finish();
}

main().catch(err => {
  console.error('SMOKE ERROR:', err?.stack || err?.message || err);
  process.exit(1);
});
