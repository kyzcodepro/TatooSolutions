// Vercel serverless entry point. Every route (pages, static assets and the JSON
// API) goes through the same handler the local server uses, so there is one code
// path to reason about.
//
// Nothing from the application is imported at module scope on purpose: if the app
// fails to load — a missing built-in, an unwritable filesystem, a bad bundle — a
// static import would abort the function before it can say why, which is exactly
// the FUNCTION_INVOCATION_FAILED page with no explanation. Loading it inside the
// handler turns that into a readable diagnostics response.
//
// Caveat that matters: a serverless instance only has a writable /tmp, which is
// per-instance and wiped on cold start. This deployment is a working demo, not a
// place to take real bookings — see "Déployer" in the README for durable storage.

import { access, constants, writeFile, unlink } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const loadApp = () => import('../src/server.js');

/** `load` is injectable so the failure path can be exercised in tests. */
export function createHandler(load = loadApp) {
  let appPromise = null;
  return async function handler(req, res) {
    try {
      const { handleRequest } = await (appPromise ??= load());
      return await handleRequest(req, res);
    } catch (err) {
      appPromise = null; // a transient failure should not poison the instance
      console.error('[fatal]', err);
      return await diagnostics(req, res, err);
    }
  };
}

export default createHandler();

/** Last-resort page: says what broke and what the runtime actually looks like. */
export async function diagnostics(req, res, err) {
  const report = {
    error: {
      name: err?.name ?? 'Error',
      message: err?.message ?? String(err),
      code: err?.code,
      stack: String(err?.stack ?? '').split('\n').slice(0, 12),
    },
    runtime: {
      node: process.version,
      platform: `${process.platform}/${process.arch}`,
      cwd: process.cwd(),
      region: process.env.VERCEL_REGION ?? null,
      commit: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? null,
    },
    checks: {
      // node:sqlite only exists from Node 22.5 and is flagless from 22.13.
      node_sqlite: probeSqlite(),
      tmp_writable: await probeWritable(tmpdir()),
      cwd_writable: await probeWritable(process.cwd()),
      public_readable: await probeReadable(join(process.cwd(), 'public/index.html')),
    },
    // Names only — never the values.
    env_set: ['INKFLOW_DB', 'INKFLOW_BASE_URL', 'INKFLOW_DEMO', 'VERCEL']
      .filter((name) => process.env[name] !== undefined),
  };

  const body = JSON.stringify(report, null, 2);
  res.writeHead(500, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

function probeSqlite() {
  try {
    const require = createRequire(import.meta.url);
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE probe (id INTEGER)');
    db.close();
    return 'ok';
  } catch (err) {
    return `unavailable: ${err.code ?? err.name}: ${err.message}`;
  }
}

async function probeWritable(dir) {
  const probe = join(dir, `.inkflow-probe-${process.pid}`);
  try {
    await writeFile(probe, 'x');
    await unlink(probe);
    return 'ok';
  } catch (err) {
    return `no: ${err.code ?? err.message}`;
  }
}

async function probeReadable(file) {
  try {
    await access(file, constants.R_OK);
    return 'ok';
  } catch (err) {
    return `no: ${err.code ?? err.message}`;
  }
}
