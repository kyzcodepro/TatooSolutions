// Minimal routing + request/response helpers on top of node:http.

export class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export const bad = (msg, details) => new HttpError(400, msg, details);
export const unauthorized = (msg = 'Authentication required') => new HttpError(401, msg);
export const notFound = (msg = 'Not found') => new HttpError(404, msg);
export const conflict = (msg) => new HttpError(409, msg);

export function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

const MAX_BODY = 256 * 1024;

export async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw bad('Request body too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw bad('Request body must be a JSON object');
    }
    return parsed;
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw bad('Invalid JSON body');
  }
}

/**
 * The exact bytes received. A webhook signature covers the raw body, so parsing
 * and re-serialising it would never match — JSON.stringify is not byte-faithful.
 */
export async function readRaw(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw bad('Request body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function parseCookies(req) {
  const header = req.headers.cookie;
  if (!header) return {};
  const out = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

export function setCookie(res, name, value, { maxAge, httpOnly = true } = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'SameSite=Lax'];
  if (httpOnly) parts.push('HttpOnly');
  if (maxAge !== undefined) parts.push(`Max-Age=${maxAge}`);
  const existing = res.getHeader('set-cookie');
  const cookie = parts.join('; ');
  res.setHeader('set-cookie', existing ? [].concat(existing, cookie) : [cookie]);
}

// Routes are declared as `GET /api/requests/:id` and matched in declaration order.
export class Router {
  constructor() {
    this.routes = [];
  }

  add(method, pattern, handler) {
    const segments = pattern.split('/').filter(Boolean);
    this.routes.push({ method, segments, handler });
    return this;
  }

  get(p, h) { return this.add('GET', p, h); }
  post(p, h) { return this.add('POST', p, h); }
  patch(p, h) { return this.add('PATCH', p, h); }
  delete(p, h) { return this.add('DELETE', p, h); }

  match(method, pathname) {
    const parts = pathname.split('/').filter(Boolean);
    for (const route of this.routes) {
      if (route.method !== method) continue;
      if (route.segments.length !== parts.length) continue;
      const params = {};
      let ok = true;
      for (let i = 0; i < route.segments.length; i++) {
        const seg = route.segments[i];
        if (seg.startsWith(':')) params[seg.slice(1)] = decodeURIComponent(parts[i]);
        else if (seg !== parts[i]) { ok = false; break; }
      }
      if (ok) return { handler: route.handler, params };
    }
    return null;
  }
}
