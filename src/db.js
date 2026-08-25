import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS artists (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  studio_name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  city TEXT NOT NULL DEFAULT '',
  bio TEXT NOT NULL DEFAULT '',
  styles TEXT NOT NULL DEFAULT '[]',
  currency TEXT NOT NULL DEFAULT 'EUR',
  hourly_rate_cents INTEGER NOT NULL DEFAULT 12000,
  minimum_cents INTEGER NOT NULL DEFAULT 8000,
  deposit_percent INTEGER NOT NULL DEFAULT 30,
  cancellation_hours INTEGER NOT NULL DEFAULT 48,
  accepting_requests INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  artist_id INTEGER NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  artist_id INTEGER NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
  public_token TEXT NOT NULL UNIQUE,
  client_name TEXT NOT NULL,
  client_email TEXT NOT NULL,
  client_phone TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL,
  style TEXT NOT NULL DEFAULT '',
  placement TEXT NOT NULL DEFAULT '',
  size_cm INTEGER NOT NULL DEFAULT 10,
  color_mode TEXT NOT NULL DEFAULT 'blackwork',
  detail_level TEXT NOT NULL DEFAULT 'medium',
  cover_up INTEGER NOT NULL DEFAULT 0,
  budget_cents INTEGER,
  reference_urls TEXT NOT NULL DEFAULT '[]',
  availability TEXT NOT NULL DEFAULT '[]',
  is_adult INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'new',
  estimated_hours REAL NOT NULL DEFAULT 0,
  estimate_low_cents INTEGER NOT NULL DEFAULT 0,
  estimate_high_cents INTEGER NOT NULL DEFAULT 0,
  quote_price_cents INTEGER,
  deposit_cents INTEGER,
  deposit_paid_at TEXT,
  quote_expires_at TEXT,
  proposed_start TEXT,
  proposed_end TEXT,
  artist_note TEXT NOT NULL DEFAULT '',
  decline_reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_requests_artist ON requests(artist_id, status);

CREATE TABLE IF NOT EXISTS appointments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  artist_id INTEGER NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
  request_id INTEGER NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  price_cents INTEGER NOT NULL,
  deposit_cents INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_appt_artist ON appointments(artist_id, starts_at);

CREATE TABLE IF NOT EXISTS blocks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  artist_id INTEGER NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT 'Unavailable',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_blocks_artist ON blocks(artist_id, starts_at);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  artist_id INTEGER NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
  request_id INTEGER REFERENCES requests(id) ON DELETE CASCADE,
  appointment_id INTEGER REFERENCES appointments(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT 'email',
  recipient TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  scheduled_for TEXT NOT NULL,
  sent_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_due ON messages(sent_at, scheduled_for);
`;

let DatabaseSync = null;

/**
 * node:sqlite ships from Node 22.5 and is flagless from 22.13. Loading it lazily
 * (instead of a static import) keeps an old runtime from aborting the whole module
 * with an opaque error before anything can report the real requirement.
 */
function sqlite() {
  if (DatabaseSync) return DatabaseSync;
  try {
    ({ DatabaseSync } = createRequire(import.meta.url)('node:sqlite'));
  } catch (err) {
    throw new Error(
      `node:sqlite is unavailable on Node ${process.version} (${err.code ?? err.name}). `
      + 'Inkflow needs Node 22.13 or newer — set the runtime accordingly, '
      + 'or switch src/db.js to a hosted database (see the README).',
    );
  }
  return DatabaseSync;
}

let db = null;

/**
 * Serverless platforms (Vercel, Lambda) mount the deployment read-only and give
 * you a writable /tmp only, so a database next to the code cannot be created there.
 * `/tmp` is per-instance and wiped on cold start — fine for a demo, not for real
 * bookings. See the deployment section of the README for the durable options.
 */
export function databaseFile() {
  if (process.env.INKFLOW_DB) return process.env.INKFLOW_DB;
  if (isServerless()) return join(tmpdir(), 'inkflow.sqlite');
  return resolve(process.cwd(), 'data/inkflow.sqlite');
}

export const isServerless = () => Boolean(
  process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.INKFLOW_SERVERLESS,
);

/** True when bookings will not survive the next cold start. */
export const isEphemeral = () => (resolvedFile ?? databaseFile()).startsWith(tmpdir());

let resolvedFile = null;

export function getDb() {
  if (db) return db;
  let file = databaseFile();
  if (file !== ':memory:') {
    try {
      mkdirSync(dirname(file), { recursive: true });
    } catch (err) {
      // Read-only filesystem: fall back to the one directory we can always write to.
      if (err.code !== 'EROFS' && err.code !== 'EACCES' && err.code !== 'EPERM') throw err;
      file = join(tmpdir(), 'inkflow.sqlite');
      console.warn(`[db] ${dirname(databaseFile())} is not writable, using ${file} (data is ephemeral)`);
    }
  }
  resolvedFile = file;
  db = new (sqlite())(file);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  return db;
}

export function resetDb() {
  if (db) db.close();
  db = null;
  resolvedFile = null;
}

export const nowIso = () => new Date().toISOString();
