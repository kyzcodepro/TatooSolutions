import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

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

let db = null;

export function getDb() {
  if (db) return db;
  const file = process.env.INKFLOW_DB || resolve(process.cwd(), 'data/inkflow.sqlite');
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  return db;
}

export function resetDb() {
  if (db) db.close();
  db = null;
}

export const nowIso = () => new Date().toISOString();
