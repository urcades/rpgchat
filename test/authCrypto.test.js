// adv-003: security-critical coverage for worker/auth.mjs.
//
// The crypto primitives (sign / verifyCookieValue / constantTimeEqual / the cookie
// parsers) are MODULE-PRIVATE — auth.mjs exports only the session API. Rather than
// reach past that boundary (or refactor the source, which is out of scope), these
// tests exercise every primitive THROUGH the public seam:
//   createSession  -> sign + makeCookieValue (mints a signed cookie)
//   getSession     -> getCookieValues (parse) + verifyCookieValue + constantTimeEqual
// So a HMAC round-trip, a signature tamper, the constant-time compare, and the
// multi-/malformed-cookie parser are all observable from here, with a real env+DB.
//
// CommonJS + node:test to match the rest of test/. auth.mjs leans on Web Crypto
// globals (crypto.subtle / crypto.randomUUID / btoa / TextEncoder), all present in
// the Node test runtime.

const assert = require('node:assert/strict');
const test = require('node:test');
const { createMigratedDb } = require('./.helpers/d1');

const COOKIE_NAME = 'rpgchat_session';

// A minimal Workers-style request: getSession only ever reads the 'Cookie' header.
function requestWithCookie(cookieHeader) {
  return {
    headers: {
      get(name) {
        return name.toLowerCase() === 'cookie' ? (cookieHeader ?? null) : null;
      }
    }
  };
}

// Pull the raw `name=value` token for our cookie back out of a Set-Cookie string.
function cookieTokenFrom(setCookie) {
  return setCookie.split(';', 1)[0];
}

function cookieValueFrom(setCookie) {
  const token = cookieTokenFrom(setCookie);
  return decodeURIComponent(token.slice(token.indexOf('=') + 1));
}

test('auth: a freshly-minted session cookie round-trips through getSession', async () => {
  const db = await createMigratedDb();
  const env = { DB: db, SESSION_SECRET: 'unit-secret-A' };
  try {
    const session = await createSessionFor(env, { username: 'alice' });
    const got = await getSessionFor(env, requestWithCookie(cookieTokenFrom(session.cookie)));
    assert.ok(got, 'a validly-signed cookie resolves to a session');
    assert.equal(got.id, session.id, 'the same session id comes back');
    assert.equal(got.username, 'alice', 'the bound username is returned');
  } finally {
    await db.close();
  }
});

test('auth: a tampered SIGNATURE is rejected (HMAC verify + constant-time compare)', async () => {
  const db = await createMigratedDb();
  const env = { DB: db, SESSION_SECRET: 'unit-secret-A' };
  try {
    const session = await createSessionFor(env, { username: 'alice' });
    const raw = cookieValueFrom(session.cookie); // "<id>.<sig>"
    const [id, sig] = raw.split('.', 2);

    // Flip the last char of the signature, keeping LENGTH identical so the compare
    // can't short-circuit on length — it must reach the byte-diff path.
    const lastChar = sig.slice(-1);
    const swapped = lastChar === 'A' ? 'B' : 'A';
    const forgedSig = sig.slice(0, -1) + swapped;
    assert.equal(forgedSig.length, sig.length, 'forged signature is the same length');
    assert.notEqual(forgedSig, sig, 'the signature actually changed');

    const forged = `${COOKIE_NAME}=${encodeURIComponent(`${id}.${forgedSig}`)}`;
    const got = await getSessionFor(env, requestWithCookie(forged));
    assert.equal(got, null, 'an equal-length but wrong signature is rejected');
  } finally {
    await db.close();
  }
});

test('auth: a tampered PAYLOAD (session id) invalidates the signature', async () => {
  const db = await createMigratedDb();
  const env = { DB: db, SESSION_SECRET: 'unit-secret-A' };
  try {
    const session = await createSessionFor(env, { username: 'alice' });
    const [, sig] = cookieValueFrom(session.cookie).split('.', 2);

    // Keep the real signature but point it at a DIFFERENT id — the HMAC no longer matches.
    const forged = `${COOKIE_NAME}=${encodeURIComponent(`not-${session.id}.${sig}`)}`;
    const got = await getSessionFor(env, requestWithCookie(forged));
    assert.equal(got, null, 'signature over a different id does not verify');
  } finally {
    await db.close();
  }
});

test('auth: a cookie signed with a different secret does not verify', async () => {
  const db = await createMigratedDb();
  try {
    // Mint under secret A...
    const minted = await createSessionFor({ DB: db, SESSION_SECRET: 'secret-A' }, { username: 'alice' });
    // ...verify under secret B. The session row exists, but the MAC won't match,
    // so getSession never even runs the DB lookup.
    const got = await getSessionFor(
      { DB: db, SESSION_SECRET: 'secret-B' },
      requestWithCookie(cookieTokenFrom(minted.cookie))
    );
    assert.equal(got, null, 'a valid MAC under one key is invalid under another');
  } finally {
    await db.close();
  }
});

test('auth: malformed cookie values are rejected, not crashed on', async () => {
  const db = await createMigratedDb();
  const env = { DB: db, SESSION_SECRET: 'unit-secret-A' };
  try {
    const cases = [
      ['no header at all', null],
      ['our cookie empty', `${COOKIE_NAME}=`],
      ['no dot separator', `${COOKIE_NAME}=justanid`],
      ['empty id', `${COOKIE_NAME}=.somesignature`],
      ['empty signature', `${COOKIE_NAME}=someid.`],
      ['a foreign cookie only', 'other=value'],
      ['junk', `${COOKIE_NAME}=...`]
    ];
    for (const [label, header] of cases) {
      const got = await getSessionFor(env, requestWithCookie(header));
      assert.equal(got, null, `malformed input rejected without throwing: ${label}`);
    }
  } finally {
    await db.close();
  }
});

test('auth: getCookieValues picks our cookie out of a multi-cookie header', async () => {
  const db = await createMigratedDb();
  const env = { DB: db, SESSION_SECRET: 'unit-secret-A' };
  try {
    const session = await createSessionFor(env, { username: 'alice' });
    const ours = cookieTokenFrom(session.cookie);

    // A realistic browser header: our session cookie wedged between others, with the
    // usual "; " separators. The parser must isolate ours and ignore the neighbors.
    const header = `theme=dark; ${ours}; analytics=xyz%20123`;
    const got = await getSessionFor(env, requestWithCookie(header));
    assert.ok(got, 'the session cookie is found among other cookies');
    assert.equal(got.username, 'alice');
  } finally {
    await db.close();
  }
});

test('auth: with two session cookies present, a valid one still authenticates', async () => {
  const db = await createMigratedDb();
  const env = { DB: db, SESSION_SECRET: 'unit-secret-A' };
  try {
    const session = await createSessionFor(env, { username: 'alice' });
    const valid = cookieTokenFrom(session.cookie);
    // Some proxies/path-scoping send the cookie name twice. A garbage duplicate must
    // not shadow the good one — getSession collects every value and verifies each.
    const garbage = `${COOKIE_NAME}=deadbeef.deadbeef`;
    const header = `${garbage}; ${valid}`;
    const got = await getSessionFor(env, requestWithCookie(header));
    assert.ok(got, 'a valid duplicate cookie is honored despite a bogus sibling');
    assert.equal(got.id, session.id);
  } finally {
    await db.close();
  }
});

test('auth: an expired session does not authenticate even with a valid signature', async () => {
  const db = await createMigratedDb();
  const env = { DB: db, SESSION_SECRET: 'unit-secret-A' };
  const { dbRun } = await import('../worker/db.mjs');
  try {
    const session = await createSessionFor(env, { username: 'alice' });
    // The signature is genuine; only the row is stale. getSession's WHERE clause
    // (expiresAt > CURRENT_TIMESTAMP) must drop it.
    await dbRun(db, 'UPDATE sessions SET expiresAt = ? WHERE id = ?', ['2000-01-01T00:00:00.000Z', session.id]);
    const got = await getSessionFor(env, requestWithCookie(cookieTokenFrom(session.cookie)));
    assert.equal(got, null, 'a correctly-signed but expired session is refused');
  } finally {
    await db.close();
  }
});

test('auth: clearSessionCookieHeader emits an immediately-expiring cookie', async () => {
  const { clearSessionCookieHeader } = await import('../worker/auth.mjs');
  const header = clearSessionCookieHeader();
  assert.match(header, new RegExp(`^${COOKIE_NAME}=`), 'targets the session cookie');
  assert.match(header, /Max-Age=0/, 'expires the cookie now');
  assert.match(header, /HttpOnly/, 'stays HttpOnly while clearing');
});

// --- thin async wrappers so each test reads top-to-bottom ----------------------

async function createSessionFor(env, claims) {
  const { createSession } = await import('../worker/auth.mjs');
  return createSession(env, claims);
}

async function getSessionFor(env, request) {
  const { getSession } = await import('../worker/auth.mjs');
  return getSession(env, request);
}
