import { ActionError } from './game.mjs';

// Stripe replays a webhook within this many seconds of the signed timestamp; older
// payloads are rejected to blunt replay attacks. Matches Stripe's default tolerance.
export const STRIPE_WEBHOOK_TOLERANCE_SECONDS = 300;

// Constant-time string comparison so a signature check can't be timed byte-by-byte.
// Lengths must match first (a length mismatch is already a non-match).
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

function bytesToHex(buffer) {
  return Array.from(new Uint8Array(buffer))
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('');
}

// Parse a `Stripe-Signature` header into its timestamp and the list of v1 signatures.
// A header may carry several `v1=` entries (during a secret rotation); any one match
// is sufficient. Schemes other than `v1` (e.g. the legacy `v0`) are ignored.
export function parseStripeSignature(header = '') {
  const pieces = header.split(',').map(piece => piece.trim()).filter(Boolean);
  const timestamp = pieces.find(piece => piece.startsWith('t='))?.slice(2);
  const signatures = pieces
    .filter(piece => piece.startsWith('v1='))
    .map(piece => piece.slice(3));
  return { timestamp, signatures };
}

// HMAC-SHA256 over `${timestamp}.${payload}` with the webhook signing secret, hex-encoded.
export async function computeStripeSignature(payload, timestamp, secret) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signedPayload = `${timestamp}.${payload}`;
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signedPayload));
  return bytesToHex(signature);
}

// Verify a Stripe webhook payload against its signature header. Returns true only when
// the timestamp is within tolerance AND at least one v1 signature matches the HMAC we
// compute from the secret. Throws (500) if the secret isn't configured; returns false
// for any malformed/expired/forged signature so the caller can reply 400.
export async function verifyStripeWebhook(payload, signatureHeader, secret) {
  if (!secret) {
    throw new ActionError('Stripe webhook secret is not configured.', 500);
  }
  const { timestamp, signatures } = parseStripeSignature(signatureHeader);
  if (!timestamp || signatures.length === 0) {
    return false;
  }
  const timestampNumber = Number(timestamp);
  if (!Number.isFinite(timestampNumber)) {
    return false;
  }
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestampNumber) > STRIPE_WEBHOOK_TOLERANCE_SECONDS) {
    return false;
  }
  const expected = await computeStripeSignature(payload, timestamp, secret);
  return signatures.some(signature => constantTimeEqual(signature, expected));
}
