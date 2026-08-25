// Data access. One asynchronous interface, two backends:
//
//   - node:sqlite on a local file — zero dependency, what `npm start` uses;
//   - libSQL/Turso over the network — what a serverless deployment needs, because
//     a function's /tmp is private to one instance and wiped on every cold start.
//
// The interface is async because the network backend cannot be anything else.
// Everything above this file awaits, so switching backends changes no caller.

import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS artists (
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
  )`,
  // No sessions table: sessions are signed cookies (see src/auth.js), so they need
  // no server-side state and survive a request landing on another instance.
  `CREATE TABLE IF NOT EXISTS requests (
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
  )`,
  'CREATE INDEX IF NOT EXISTS idx_requests_artist ON requests(artist_id, status)',
  `CREATE TABLE IF NOT EXISTS appointments (
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
  )`,
  'CREATE INDEX IF NOT EXISTS idx_appt_artist ON appointments(artist_id, starts_at)',
  `CREATE TABLE IF NOT EXISTS blocks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    artist_id INTEGER NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
    starts_at TEXT NOT NULL,
    ends_at TEXT NOT NULL,
    label TEXT NOT NULL DEFAULT 'Unavailable',
    created_at TEXT NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS idx_blocks_artist ON blocks(artist_id, starts_at)',
  `CREATE TABLE IF NOT EXISTS messages (
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
  )`,
  'CREATE INDEX IF NOT EXISTS idx_messages_due ON messages(sent_at, scheduled_for)',
];

let db = null;
let dbPromise = null;
let resolvedFile = null;
let resolvedBackend = null;

export const isTurso = () => Boolean(process.env.INKFLOW_DATABASE_URL);

export const isServerless = () => Boolean(
  process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.INKFLOW_SERVERLESS,
);

/**
 * Serverless platforms mount the deployment read-only and give you a writable
 * /tmp only, per-instance and wiped on cold start. That is fine for a demo and
 * useless for real bookings — which is what the Turso backend is for.
 */
export function databaseFile() {
  if (process.env.INKFLOW_DB) return process.env.INKFLOW_DB;
  if (isServerless()) return join(tmpdir(), 'inkflow.sqlite');
  return resolve(process.cwd(), 'data/inkflow.sqlite');
}

/** True when bookings will not survive the next cold start. */
export const isEphemeral = () => (
  isTurso() ? false : (resolvedFile ?? databaseFile()).startsWith(tmpdir())
);

export const backend = () => resolvedBackend ?? (isTurso() ? 'turso' : 'sqlite');

export function getDb() {
  if (db) return Promise.resolve(db);
  if (!dbPromise) dbPromise = connect().catch((err) => { dbPromise = null; throw err; });
  return dbPromise;
}

async function connect() {
  const adapter = isTurso() ? await openTurso() : openSqlite();
  for (const statement of SCHEMA) await adapter.exec(statement);
  db = adapter;
  return db;
}

/* ------------------------------------------------------- local file backend */

function openSqlite() {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = createRequire(import.meta.url)('node:sqlite'));
  } catch (err) {
    throw new Error(
      `node:sqlite is unavailable on Node ${process.version} (${err.code ?? err.name}). `
      + 'Inkflow needs Node 22.13 or newer — set the runtime accordingly, '
      + 'or point INKFLOW_DATABASE_URL at a Turso database (see the README).',
    );
  }

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

  const handle = new DatabaseSync(file);
  handle.exec('PRAGMA journal_mode = WAL;');
  handle.exec('PRAGMA foreign_keys = ON;');
  resolvedFile = file;
  resolvedBackend = 'sqlite';

  const normalise = (info) => ({
    changes: Number(info.changes ?? 0),
    lastInsertRowid: Number(info.lastInsertRowid ?? 0),
  });

  return {
    kind: 'sqlite',
    async exec(sql) { handle.exec(sql); },
    async all(sql, params = []) { return handle.prepare(sql).all(...params); },
    async get(sql, params = []) { return handle.prepare(sql).get(...params) ?? null; },
    async run(sql, params = []) { return normalise(handle.prepare(sql).run(...params)); },
    async close() { handle.close(); },
  };
}

/* ------------------------------------------------------------ Turso backend */

async function openTurso() {
  const url = process.env.INKFLOW_DATABASE_URL;
  const authToken = process.env.INKFLOW_DATABASE_TOKEN;
  if (!authToken && !url.startsWith('file:')) {
    throw new Error('INKFLOW_DATABASE_URL is set but INKFLOW_DATABASE_TOKEN is missing');
  }

  let createClient;
  try {
    ({ createClient } = await import('@libsql/client'));
  } catch (err) {
    throw new Error(`INKFLOW_DATABASE_URL is set but @libsql/client is not installed (${err.code ?? err.name})`);
  }

  const client = createClient({ url, authToken });
  resolvedBackend = 'turso';
  resolvedFile = url;

  return {
    kind: 'turso',
    async exec(sql) { await client.execute(sql); },
    async all(sql, params = []) {
      const result = await client.execute({ sql, args: params.map(bind) });
      return result.rows.map(plain);
    },
    async get(sql, params = []) {
      const result = await client.execute({ sql, args: params.map(bind) });
      return result.rows.length ? plain(result.rows[0]) : null;
    },
    async run(sql, params = []) {
      const result = await client.execute({ sql, args: params.map(bind) });
      return {
        changes: Number(result.rowsAffected ?? 0),
        lastInsertRowid: Number(result.lastInsertRowid ?? 0),
      };
    },
    async close() { client.close(); },
  };
}

// libSQL rejects undefined and booleans; SQLite has neither.
const bind = (value) => {
  if (value === undefined) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  return value;
};

// Rows come back as array-likes carrying column properties: copy the columns only.
const plain = (row) => Object.fromEntries(Object.entries(row).filter(([key]) => Number.isNaN(Number(key))));

export async function resetDb() {
  if (db) await db.close();
  db = null;
  dbPromise = null;
  resolvedFile = null;
  resolvedBackend = null;
}

export const nowIso = () => new Date().toISOString();
