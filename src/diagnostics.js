// Failure reporting, shared by both entry points.
//
// A deployment that cannot boot must still be able to say why. This module is a
// leaf on purpose: it imports nothing but Node built-ins, so it stays loadable
// exactly when the rest of the application is not.

import { access, constants, writeFile, unlink } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Writes a JSON report describing the failure and the runtime it happened on. */
export async function renderDiagnostics(res, err) {
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
  if (!res.headersSent) {
    res.writeHead(500, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    });
  }
  res.end(body);
  return report;
}

export function probeSqlite() {
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

export async function probeWritable(dir) {
  const probe = join(dir, `.inkflow-probe-${process.pid}`);
  try {
    await writeFile(probe, 'x');
    await unlink(probe);
    return 'ok';
  } catch (err) {
    return `no: ${err.code ?? err.message}`;
  }
}

export async function probeReadable(file) {
  try {
    await access(file, constants.R_OK);
    return 'ok';
  } catch (err) {
    return `no: ${err.code ?? err.message}`;
  }
}
