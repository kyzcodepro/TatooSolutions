// Guards the serverless deployment path: a Vercel function has a read-only
// filesystem and a cold /tmp, which is exactly what used to crash the app.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'inkflow-deploy-'));
process.env.VERCEL = '1';                       // pretend we are on Vercel
process.env.INKFLOW_DB = join(dir, 'fn.sqlite'); // stand-in for the cold /tmp
process.env.INKFLOW_QUIET = '1';
delete process.env.INKFLOW_DEMO;

const { default: handler } = await import('../api/index.js');
const { databaseFile, isEphemeral } = await import('../src/db.js');

const server = createServer(handler);
await new Promise((done) => server.listen(0, done));
const base = `http://127.0.0.1:${server.address().port}`;

after(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

test('the database lands in a writable directory when the deployment is read-only', () => {
  assert.equal(databaseFile(), process.env.INKFLOW_DB);

  const explicit = process.env.INKFLOW_DB;
  delete process.env.INKFLOW_DB;
  assert.ok(databaseFile().startsWith(tmpdir()), 'serverless defaults to the tmp directory');
  process.env.INKFLOW_DB = explicit;
});

test('the serverless handler serves the landing page instead of crashing', async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  assert.match(await res.text(), /Inkflow/);
});

test('static assets are served from the bundled public directory', async () => {
  const res = await fetch(`${base}/assets/app.css`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/css/);
});

test('a cold instance seeds the demo studio so the site is not blank', async () => {
  const res = await fetch(`${base}/api/public/artists/atelier-noir`);
  assert.equal(res.status, 200);
  const { artist } = await res.json();
  assert.equal(artist.studio_name, 'Atelier Noir');

  const page = await fetch(`${base}/b/atelier-noir`);
  assert.equal(page.status, 200);
});

test('client-side routes fall through to the page shell', async () => {
  for (const path of ['/login', '/app', '/q/whatever']) {
    const res = await fetch(base + path);
    assert.equal(res.status, 200, path);
  }
});

test('the API still answers under the function entry point', async () => {
  const res = await fetch(`${base}/api/public/artists/atelier-noir/estimate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ size_cm: 20, color_mode: 'blackgrey', detail_level: 'medium' }),
  });
  assert.equal(res.status, 200);
  const { estimate } = await res.json();
  assert.ok(estimate.low_cents > 0);
  // This run stores its database under /tmp, which is what the warning is for.
  assert.equal(isEphemeral(), true, 'a tmp-backed database is reported as ephemeral');
});

test('unknown endpoints still return JSON, not a crash', async () => {
  const res = await fetch(`${base}/api/nope`);
  assert.equal(res.status, 404);
  assert.equal((await res.json()).error, 'Unknown endpoint');
});

test('/api/health reports how the deployment is wired', async () => {
  const res = await fetch(`${base}/api/health`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'ok');
  assert.equal(body.serverless, true);
  assert.equal(body.database.file, process.env.INKFLOW_DB);
  assert.ok(body.database.artists >= 1, 'the demo studio is present');
});

test('a broken application reports why instead of crashing the function', async () => {
  const { createHandler } = await import('../api/index.js');
  const failing = createHandler(() => {
    const err = new Error('node:sqlite is unavailable on Node v20.0.0');
    err.code = 'ERR_UNKNOWN_BUILTIN_MODULE';
    return Promise.reject(err);
  });
  const broken = createServer(failing);
  await new Promise((done) => broken.listen(0, done));

  const res = await fetch(`http://127.0.0.1:${broken.address().port}/`);
  assert.equal(res.status, 500);
  const report = await res.json();
  assert.match(report.error.message, /node:sqlite is unavailable/);
  assert.equal(report.error.code, 'ERR_UNKNOWN_BUILTIN_MODULE');
  assert.equal(report.checks.node_sqlite, 'ok', 'the probe exercises the real built-in');
  assert.equal(report.checks.tmp_writable, 'ok');
  assert.ok(report.env_set.includes('VERCEL'));
  assert.ok(!JSON.stringify(report).includes(process.env.INKFLOW_DB),
    'the report lists env names, never their values');
  broken.close();
});
