import { randomBytes, pbkdf2Sync, timingSafeEqual } from 'node:crypto';
import { getDb, nowIso } from './db.js';
import { parseCookies, unauthorized } from './http.js';

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

export function createSession(artistId) {
  const token = randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();
  getDb()
    .prepare('INSERT INTO sessions (token, artist_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
    .run(token, artistId, expiresAt, nowIso());
  return { token, expiresAt, maxAge: SESSION_DAYS * 86400 };
}

export function destroySession(token) {
  if (token) getDb().prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

export function currentArtist(req) {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (!token) return null;
  const db = getDb();
  const session = db.prepare('SELECT * FROM sessions WHERE token = ?').get(token);
  if (!session) return null;
  if (session.expires_at <= nowIso()) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return null;
  }
  return db.prepare('SELECT * FROM artists WHERE id = ?').get(session.artist_id) ?? null;
}

export function requireArtist(req) {
  const artist = currentArtist(req);
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
    hourly_rate_cents: artist.hourly_rate_cents,
    minimum_cents: artist.minimum_cents,
    deposit_percent: artist.deposit_percent,
    cancellation_hours: artist.cancellation_hours,
    accepting_requests: !!artist.accepting_requests,
  };
}
