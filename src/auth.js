import { createHmac, randomBytes, pbkdf2Sync, timingSafeEqual } from 'node:crypto';
import { getDb } from './db.js';
import { parseCookies, unauthorized } from './http.js';
import { referencePrice, REFERENCE_SIZE_CM } from './pricing.js';

const ITERATIONS = 120000;
const KEYLEN = 32;
const DIGEST = 'sha512';
export const SESSION_COOKIE = 'inkflow_session';
const SESSION_DAYS = 14;

export function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  const hash = pbkdf2Sync(password, salt, ITERATIONS, KEYLEN, DIGEST).toString('hex');
  return { hash, salt };
}

export function verifyPassword(password, hash, salt) {
  const candidate = pbkdf2Sync(password, salt, ITERATIONS, KEYLEN, DIGEST);
  const expected = Buffer.from(hash, 'hex');
  if (candidate.length !== expected.length) return false;
  return timingSafeEqual(candidate, expected);
}

/**
 * Sessions are signed cookies rather than rows in the database.
 *
 * A session row only exists on the instance that wrote it. On a platform that
 * runs several instances — each with its own /tmp database — logging in on one
 * and being served by another means the row is missing and the request is
 * rejected with "Authentication required", at random. A signed token carries its
 * own proof, so any instance holding the same secret accepts it.
 *
 * The secret must therefore be shared and secret. INKFLOW_SECRET provides it; a
 * public value such as the commit SHA would let anyone mint a session. Without
 * it, each instance falls back to a random key of its own — safe, but sessions
 * stop working across instances, so the fallback says so loudly.
 */
let cachedSecret = null;

export function sessionSecret() {
  if (cachedSecret) return cachedSecret;
  const configured = process.env.INKFLOW_SECRET;
  if (configured && configured.length >= 16) {
    cachedSecret = configured;
  } else {
    cachedSecret = randomBytes(32).toString('hex');
    console.warn(
      '[auth] INKFLOW_SECRET is not set (or is shorter than 16 characters): sessions are '
      + 'signed with a key generated for this instance only. On a multi-instance host, '
      + 'users will be logged out at random. Set INKFLOW_SECRET to a long random string.',
    );
  }
  return cachedSecret;
}

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const sign = (payload) => createHmac('sha256', sessionSecret()).update(payload).digest('base64url');

export function createSession(artistId) {
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();
  const payload = b64url(JSON.stringify({ aid: artistId, exp: Date.parse(expiresAt) }));
  return {
    token: `${payload}.${sign(payload)}`,
    expiresAt,
    maxAge: SESSION_DAYS * 86400,
  };
}

/** Stateless sessions have nothing to delete server-side; the caller clears the cookie. */
export function destroySession() {}

export function readSessionToken(token) {
  if (typeof token !== 'string') return null;
  const [payload, signature] = token.split('.');
  if (!payload || !signature) return null;

  const expected = Buffer.from(sign(payload));
  const provided = Buffer.from(signature);
  if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) return null;

  let claims;
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!Number.isInteger(claims?.aid) || !Number.isFinite(claims?.exp)) return null;
  if (claims.exp <= Date.now()) return null;
  return claims;
}

export async function currentArtist(req) {
  const claims = readSessionToken(parseCookies(req)[SESSION_COOKIE]);
  if (!claims) return null;
  const db = await getDb();
  return db.get('SELECT * FROM artists WHERE id = ?', [claims.aid]);
}

export async function requireArtist(req) {
  const artist = await currentArtist(req);
  if (!artist) throw unauthorized();
  return artist;
}

export function publicArtist(artist) {
  return {
    id: artist.id,
    email: artist.email,
    studio_name: artist.studio_name,
    slug: artist.slug,
    city: artist.city,
    bio: artist.bio,
    styles: JSON.parse(artist.styles || '[]'),
    currency: artist.currency,
    reference_price_cents: referencePrice(artist),
    reference_size_cm: REFERENCE_SIZE_CM,
    hourly_rate_cents: artist.hourly_rate_cents,
    minimum_cents: artist.minimum_cents,
    deposit_percent: artist.deposit_percent,
    cancellation_hours: artist.cancellation_hours,
    accepting_requests: !!artist.accepting_requests,
  };
}
