import { dbFirst, dbRun } from './db.mjs';

const COOKIE_NAME = 'rpgchat_session';
const DEFAULT_SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;

function getSecret(env) {
  return env.SESSION_SECRET || 'local-dev-session-secret';
}

function encodeBase64Url(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function parseCookie(header = '') {
  return header
    .split(';')
    .map(part => part.trim())
    .filter(Boolean)
    .reduce((cookies, part) => {
      const separator = part.indexOf('=');
      if (separator === -1) {
        return cookies;
      }
      cookies[part.slice(0, separator)] = decodeURIComponent(part.slice(separator + 1));
      return cookies;
    }, {});
}

function constantTimeEqual(left, right) {
  if (left.length !== right.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < left.length; i += 1) {
    diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
  }
  return diff === 0;
}

async function sign(value, secret) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value));
  return encodeBase64Url(signature);
}

async function makeCookieValue(sessionId, secret) {
  return `${sessionId}.${await sign(sessionId, secret)}`;
}

async function verifyCookieValue(value, secret) {
  if (!value || !value.includes('.')) {
    return null;
  }
  const [sessionId, signature] = value.split('.', 2);
  if (!sessionId || !signature) {
    return null;
  }
  const expected = await sign(sessionId, secret);
  return constantTimeEqual(signature, expected) ? sessionId : null;
}

function cookieHeader(value, maxAge) {
  const pieces = [
    `${COOKIE_NAME}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAge}`
  ];
  return pieces.join('; ');
}

export function clearSessionCookieHeader() {
  return cookieHeader('', 0);
}

export async function createSession(env, { username = null, deadUsername = null }) {
  const sessionId = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + DEFAULT_SESSION_TTL_SECONDS * 1000).toISOString();
  await dbRun(
    env.DB,
    `INSERT INTO sessions (id, username, deadUsername, expiresAt)
     VALUES (?, ?, ?, ?)`,
    [sessionId, username, deadUsername, expiresAt]
  );
  const value = await makeCookieValue(sessionId, getSecret(env));
  return {
    id: sessionId,
    cookie: cookieHeader(value, DEFAULT_SESSION_TTL_SECONDS)
  };
}

export async function destroySession(env, request) {
  const session = await getSession(env, request);
  if (session) {
    await dbRun(env.DB, 'DELETE FROM sessions WHERE id = ?', [session.id]);
  }
}

export async function getSession(env, request) {
  const cookies = parseCookie(request.headers.get('Cookie') || '');
  const sessionId = await verifyCookieValue(cookies[COOKIE_NAME], getSecret(env));
  if (!sessionId) {
    return null;
  }
  const session = await dbFirst(
    env.DB,
    `SELECT id, username, deadUsername, expiresAt
     FROM sessions
     WHERE id = ?
       AND expiresAt > CURRENT_TIMESTAMP`,
    [sessionId]
  );
  return session || null;
}

export async function getLiveSessionUser(env, request) {
  const session = await getSession(env, request);
  if (!session?.username) {
    return { session, user: null };
  }
  const user = await dbFirst(env.DB, 'SELECT * FROM users WHERE username = ?', [session.username]);
  return { session, user };
}

export async function requireLiveUser(env, request) {
  const { session, user } = await getLiveSessionUser(env, request);
  if (user) {
    return { session, user };
  }

  if (session?.deadUsername) {
    return { session, user: null, dead: true };
  }

  if (session?.username) {
    const grave = await dbFirst(
      env.DB,
      `SELECT username
       FROM cemetery
       WHERE username = ?
       ORDER BY diedAt DESC, id DESC
       LIMIT 1`,
      [session.username]
    );
    if (grave) {
      await dbRun(
        env.DB,
        'UPDATE sessions SET username = NULL, deadUsername = ? WHERE id = ?',
        [session.username, session.id]
      );
      return {
        session: { ...session, username: null, deadUsername: session.username },
        user: null,
        dead: true
      };
    }
  }

  return { session, user: null };
}
