import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'inkflow-test-'));
process.env.INKFLOW_DB = join(dir, 'test.sqlite');
process.env.INKFLOW_BASE_URL = 'http://localhost';
process.env.INKFLOW_QUIET = '1';

const { createApp } = await import('../src/server.js');

export const server = createApp();
await new Promise((done) => server.listen(0, done));
export const base = `http://127.0.0.1:${server.address().port}`;

export async function shutdown() {
  await new Promise((done) => server.close(done));
  rmSync(dir, { recursive: true, force: true });
}

/** Tiny fetch wrapper that remembers cookies, like a browser session would. */
export function client() {
  const jar = new Map();
  return async function call(method, path, body) {
    const headers = { 'content-type': 'application/json' };
    if (jar.size) headers.cookie = [...jar].map(([k, val]) => `${k}=${val}`).join('; ');
    const res = await fetch(base + path, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const raw of res.headers.getSetCookie?.() ?? []) {
      const [pair] = raw.split(';');
      const idx = pair.indexOf('=');
      jar.set(pair.slice(0, idx), pair.slice(idx + 1));
    }
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    return { status: res.status, data };
  };
}

export const inDays = (days, hour = 10) => {
  const date = new Date(Date.now() + days * 86400000);
  date.setUTCHours(hour, 0, 0, 0);
  return date.toISOString();
};
