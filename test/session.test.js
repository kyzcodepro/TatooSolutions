// Sessions must be verifiable from the secret alone: on a multi-instance host the
// instance that checks a cookie is rarely the one that issued it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.INKFLOW_DB = join(mkdtempSync(join(tmpdir(), 'inkflow-session-')), 'db.sqlite');
process.env.INKFLOW_SECRET = 'a-long-shared-secret-for-tests';
process.env.INKFLOW_QUIET = '1';

const { createSession, readSessionToken, sessionSecret } = await import('../src/auth.js');

test('a token issued anywhere validates against the shared secret', () => {
  const { token } = createSession(42);
  const claims = readSessionToken(token);
  assert.equal(claims.aid, 42);

  // Rebuilt from scratch the way another instance would, with no shared state.
  const [payload] = token.split('.');
  const signature = createHmac('sha256', sessionSecret()).update(payload).digest('base64url');
  assert.equal(readSessionToken(`${payload}.${signature}`).aid, 42);
});

test('a token signed with another secret is refused', () => {
  const { token } = createSession(42);
  const [payload] = token.split('.');
  const forged = createHmac('sha256', 'not-the-secret').update(payload).digest('base64url');
  assert.equal(readSessionToken(`${payload}.${forged}`), null);
});

test('tampering with the claims invalidates the token', () => {
  const { token } = createSession(1);
  const [, signature] = token.split('.');
  const swapped = Buffer.from(JSON.stringify({ aid: 999, exp: Date.now() + 60000 })).toString('base64url');
  assert.equal(readSessionToken(`${swapped}.${signature}`), null);
});

test('an expired token is refused even when correctly signed', () => {
  const payload = Buffer.from(JSON.stringify({ aid: 1, exp: Date.now() - 1000 })).toString('base64url');
  const signature = createHmac('sha256', sessionSecret()).update(payload).digest('base64url');
  assert.equal(readSessionToken(`${payload}.${signature}`), null);
});

test('malformed cookies are refused without throwing', () => {
  for (const value of [undefined, '', 'nonsense', 'a.b', '..', {}, 42]) {
    assert.equal(readSessionToken(value), null, String(value));
  }
});
