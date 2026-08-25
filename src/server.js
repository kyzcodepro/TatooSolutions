// Library only: nothing here listens. start.js is the server entry point and
// api/index.js the serverless one, so importing this module has no side effects.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HttpError, json } from './http.js';
import { api } from './routes/api.js';
import { getDb, isServerless, isEphemeral } from './db.js';
import { dispatchDue } from './messages.js';
import { seedIfEmpty } from './seed.js';
import { renderDiagnostics } from './diagnostics.js';

const ROOT = resolve(fileURLToPath(new URL('../', import.meta.url)));
const PUBLIC_DIR = join(ROOT, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webmanifest': 'application/manifest+json',
};

// Client-side pages that map onto a single HTML shell.
const PAGES = [
  [/^\/$/, 'index.html'],
  [/^\/login\/?$/, 'login.html'],
  [/^\/app\/?$/, 'app.html'],
  [/^\/b\/[^/]+\/?$/, 'book.html'],
  [/^\/q\/[^/]+\/?$/, 'quote.html'],
];

async function serveFile(res, absolutePath, status = 200) {
  const data = await readFile(absolutePath);
  const type = MIME[extname(absolutePath)] ?? 'application/octet-stream';
  res.writeHead(status, {
    'content-type': type,
    'content-length': data.length,
    'cache-control': type.startsWith('text/html') ? 'no-cache' : 'public, max-age=300',
    'x-content-type-options': 'nosniff',
  });
  res.end(data);
}

async function serveStatic(res, pathname) {
  for (const [pattern, file] of PAGES) {
    if (pattern.test(pathname)) return serveFile(res, join(PUBLIC_DIR, file));
  }
  const safePath = normalize(pathname).replace(/^(\.\.[/\\])+/, '');
  const target = join(PUBLIC_DIR, safePath);
  if (!target.startsWith(PUBLIC_DIR)) throw new HttpError(403, 'Forbidden');
  const info = await stat(target).catch(() => null);
  if (!info?.isFile()) throw new HttpError(404, 'Not found');
  return serveFile(res, target);
}

let booted = false;

/**
 * One-time per-instance setup. On a serverless platform every cold start gets a
 * fresh /tmp database, so the demo studio is recreated to avoid a blank site.
 */
export function bootstrap() {
  if (booted) return;
  // Only mark the instance as booted once this actually succeeded, otherwise the
  // failure is reported on the first request and silently forgotten afterwards —
  // leaving a site that serves pages on top of an application that cannot work.
  getDb();
  const demo = process.env.INKFLOW_DEMO ?? (isServerless() ? '1' : '0');
  if (demo === '1') {
    try {
      seedIfEmpty();
    } catch (err) {
      console.error('[seed]', err);
    }
  }
  if (isEphemeral()) {
    console.warn('[db] running on an ephemeral database: bookings are lost on the next cold start');
  }
  booted = true;
}

// Serverless has no long-running timer, so reminders are flushed opportunistically
// on incoming traffic instead. At most one pass per minute per instance.
let lastDispatch = 0;
function dispatchOnTraffic() {
  if (Date.now() - lastDispatch < 60000) return;
  lastDispatch = Date.now();
  try {
    dispatchDue();
  } catch (err) {
    console.error('[scheduler]', err);
  }
}

/**
 * Node-style handler, shared by the server and the serverless entry point.
 *
 * Bootstrap runs here rather than at construction time, and its failures are
 * rendered instead of thrown. A platform that runs this app as a server reports
 * a process that dies during boot as an empty crash page, so the database is set
 * up on the first request: the listener is already accepting connections and can
 * answer with the reason.
 */
export async function handleRequest(req, res) {
  try {
    bootstrap();
  } catch (err) {
    console.error('[fatal] bootstrap', err);
    return renderDiagnostics(res, err);
  }
  if (isServerless()) dispatchOnTraffic();
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
  try {
    const match = api.match(req.method, url.pathname);
    if (match) return await match.handler(req, res, { params: match.params, url });
    if (url.pathname.startsWith('/api/')) throw new HttpError(404, 'Unknown endpoint');
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed');
    return await serveStatic(res, url.pathname);
  } catch (err) {
    if (err instanceof HttpError) {
      return json(res, err.status, { error: err.message, details: err.details });
    }
    if (err?.code === 'ENOENT') return json(res, 404, { error: 'Not found' });
    console.error('[error]', req.method, url.pathname, err);
    return json(res, 500, { error: 'Internal server error' });
  }
}

/** Builds the HTTP server. Deliberately does no I/O: it must never fail to listen. */
export function createApp() {
  return createServer((req, res) => handleRequest(req, res).catch((err) => {
    console.error('[fatal]', err);
    if (!res.headersSent) json(res, 500, { error: 'Internal server error', detail: err.message });
    else res.end();
  }));
}
