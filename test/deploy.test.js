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
  assert.equal(body.database.backend, 'sqlite');
  assert.equal(body.database.location, process.env.INKFLOW_DB);
  assert.ok(body.database.artists >= 1, 'the demo studio is present');
  assert.equal(typeof body.sessions.signing_key_configured, 'boolean');
  assert.ok(!JSON.stringify(body).includes(process.env.INKFLOW_SECRET ?? 'nothing-set'),
    'health never echoes the signing key');
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

test('the inert probe answers without touching the application', async () => {
  const { default: ping } = await import('../api/ping.js');
  const probe = createServer(ping);
  await new Promise((done) => probe.listen(0, done));

  const res = await fetch(`http://127.0.0.1:${probe.address().port}/api/ping`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.probe, 'function');
  assert.equal(body.node, process.version);
  probe.close();
});

test('the application router answers the same probe with its own marker', async () => {
  const res = await fetch(`${base}/api/ping`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).probe, 'app');
});

test('a server whose database cannot open still listens and says why', async () => {
  // The failure this reproduces: the process used to open the database during
  // boot, so any storage problem killed it before it could listen and the
  // platform reported an empty crash page.
  const { spawn } = await import('node:child_process');
  const port = 3400 + Math.floor(Math.random() * 500);
  const child = spawn(process.execPath, ['start.js'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: {
      ...process.env,
      PORT: String(port),
      INKFLOW_DB: '/dev/null/inkflow/db.sqlite', // cannot be created: ENOTDIR
      INKFLOW_QUIET: '1',
    },
    stdio: 'ignore',
  });

  try {
    let res = null;
    for (let attempt = 0; attempt < 40 && !res; attempt++) {
      res = await fetch(`http://127.0.0.1:${port}/`).catch(() => null);
      if (!res) await new Promise((done) => setTimeout(done, 100));
    }
    assert.ok(res, 'the server accepted a connection despite the broken database');
    assert.equal(res.status, 500);

    const report = await res.json();
    assert.equal(report.error.code, 'ENOTDIR');
    assert.equal(report.runtime.node, process.version);
    assert.equal(report.checks.node_sqlite, 'ok');

    // Still reported on the next request, not swallowed after the first one.
    const again = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(again.status, 500);
    assert.equal(child.exitCode, null, 'the process stayed alive');
  } finally {
    child.kill();
  }
});

test('a rewritten path is recovered from the platform destination', async () => {
  // vercel.json rewrites /api/x to /api/index?__path=/api/x; the router must see
  // the original path, not the rewrite destination.
  const res = await fetch(`${base}/api/index?__path=/api/ping`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).probe, 'app');

  const health = await fetch(`${base}/api/index?__path=/api/health`);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).status, 'ok');
});

test('the module exports a default handler, as hosting platforms require', async () => {
  // Vercel imports src/server.js and rejects it without a default export:
  // "Invalid export found in module ... The default export must be a function or
  // server", then exits status 1 on every request. Regression guard.
  const mod = await import('../src/server.js');
  assert.equal(typeof mod.default, 'function', 'src/server.js has a default export');
  assert.equal(mod.default, mod.handleRequest, 'and it is the request handler');

  // start.js listens as a side effect, so give it an ephemeral port and close it.
  process.env.PORT = '0';
  const entry = await import('../start.js');
  try {
    assert.equal(typeof entry.default, 'function', 'start.js exports a handler too');
  } finally {
    entry.server.close();
    delete process.env.PORT;
  }
});
