import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HttpError, json } from './http.js';
import { api } from './routes/api.js';
import { getDb } from './db.js';
import { dispatchDue } from './messages.js';

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

export function createApp() {
  getDb();
  return createServer(async (req, res) => {
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
  });
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const port = Number(process.env.PORT) || 3000;
  const server = createApp();
  server.listen(port, () => {
    console.log(`Inkflow running on http://localhost:${port}`);
  });
  // Reminders and aftercare go out from here; one tick a minute is plenty.
  const timer = setInterval(() => {
    try {
      dispatchDue();
    } catch (err) {
      console.error('[scheduler]', err);
    }
  }, 60000);
  timer.unref();
}
