// Exercises the libSQL/Turso backend end to end.
//
// The client is the same one Turso is driven with; only the URL differs, so this
// covers the async path, the parameter binding, the row shape and the identifiers
// coming back from a write. What it cannot cover is the network itself — there are
// no Turso credentials here, and inventing a passing test for that would be a lie.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'inkflow-turso-'));
process.env.INKFLOW_DATABASE_URL = `file:${join(dir, 'turso.db')}`;
delete process.env.INKFLOW_DB;
process.env.INKFLOW_DEMO = '0';
process.env.INKFLOW_QUIET = '1';
process.env.INKFLOW_SECRET = 'a-long-shared-secret-for-turso-tests';

const { createApp } = await import('../src/server.js');
const { getDb, resetDb, backend, isEphemeral } = await import('../src/db.js');

const server = createApp();
await new Promise((done) => server.listen(0, done));
const base = `http://127.0.0.1:${server.address().port}`;

after(async () => {
  await new Promise((done) => server.close(done));
  await resetDb();
  rmSync(dir, { recursive: true, force: true });
});

function client() {
  const jar = new Map();
  return async function call(method, path, body) {
    const headers = { 'content-type': 'application/json' };
    if (jar.size) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    const res = await fetch(base + path, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const raw of res.headers.getSetCookie?.() ?? []) {
      const [pair] = raw.split(';');
      const idx = pair.indexOf('=');
      jar.set(pair.slice(0, idx), pair.slice(idx + 1));
    }
    const text = await res.text();
    return { status: res.status, data: text ? JSON.parse(text) : null };
  };
}

const inDays = (days, hour = 10) => {
  const date = new Date(Date.now() + days * 86400000);
  date.setUTCHours(hour, 0, 0, 0);
  return date.toISOString();
};

test('the libSQL backend is the one serving, and it is not ephemeral', async () => {
  const res = await fetch(`${base}/api/health`);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.database.backend, 'turso');
  assert.equal(body.database.ephemeral, false, 'a hosted database survives a cold start');
  assert.equal(backend(), 'turso');
  assert.equal(isEphemeral(), false);
});

test('the whole funnel runs on libSQL', async () => {
  const artistCall = client();
  const signup = await artistCall('POST', '/api/auth/signup', {
    email: 'turso@ink.test', password: 'motdepasse123', studio_name: 'Studio libSQL', city: 'Lyon',
  });
  assert.equal(signup.status, 201);
  const { slug } = signup.data.artist;

  await artistCall('PATCH', '/api/me', { reference_price_cents: 18000, minimum_cents: 8000, deposit_percent: 30 });

  const clientCall = client();
  const created = await clientCall('POST', `/api/public/artists/${slug}/requests`, {
    client_name: 'Camille Roy', client_email: 'camille@example.test',
    description: 'Serpent et pivoine sur l\'avant-bras, style japonais traditionnel.',
    style: 'japonais', placement: 'forearm', size_cm: 18, color_mode: 'blackgrey',
    detail_level: 'high', budget_cents: 60000, reference_urls: ['https://example.test/ref.jpg'],
    availability: ['samedi'], is_adult: true,
  });
  assert.equal(created.status, 201);
  assert.ok(created.data.estimate.hours > 0);

  const inbox = await artistCall('GET', '/api/requests?status=new');
  assert.equal(inbox.data.requests.length, 1);
  const request = inbox.data.requests[0];
  // JSON columns and integer ids survive the round trip through the driver.
  assert.deepEqual(request.reference_urls, ['https://example.test/ref.jpg']);
  assert.equal(typeof request.id, 'number');

  const quoted = await artistCall('POST', `/api/requests/${request.id}/quote`, {
    outside_hours: true, price_cents: 55000, proposed_start: inDays(11, 9), duration_hours: 4,
  });
  assert.equal(quoted.status, 200);
  assert.equal(quoted.data.request.deposit_cents, 16500);

  const accepted = await clientCall('POST', `/api/public/quotes/${created.data.request.public_token}/accept`);
  assert.equal(accepted.status, 200);
  assert.equal(accepted.data.payment.amount_cents, 16500);

  // The slot is taken: the conflict check is a query, and it has to work here too.
  const second = client();
  await second('POST', `/api/public/artists/${slug}/requests`, {
    client_name: 'Autre', client_email: 'autre@example.test',
    description: 'Un lettrage discret sur le poignet, trait fin.',
    size_cm: 8, color_mode: 'linework', detail_level: 'simple', is_adult: true,
  });
  const other = (await artistCall('GET', '/api/requests?status=new')).data.requests[0];
  const clash = await artistCall('POST', `/api/requests/${other.id}/quote`, {
    outside_hours: true, price_cents: 20000, proposed_start: inDays(11, 10), duration_hours: 2,
  });
  assert.equal(clash.status, 409);

  const stats = (await artistCall('GET', '/api/stats')).data.stats;
  assert.equal(stats.upcoming.count, 1);
  assert.equal(stats.upcoming.deposits_held_cents, 16500);

  const pending = await artistCall('GET', '/api/messages?pending=true');
  assert.ok(pending.data.messages.some((m) => m.kind === 'reminder_24h'));
});

test('the data is still there after the connection is dropped and reopened', async () => {
  // The point of a hosted database: another instance, or the same one after a cold
  // start, reads what was written. A per-instance /tmp file cannot do this.
  await resetDb();
  const db = await getDb();
  const artist = await db.get('SELECT * FROM artists WHERE email = ?', ['turso@ink.test']);
  assert.equal(artist.studio_name, 'Studio libSQL');

  const appointment = await db.get('SELECT * FROM appointments ORDER BY id DESC');
  assert.equal(appointment.status, 'scheduled');
  assert.equal(appointment.deposit_cents, 16500);

  const { count } = await db.get('SELECT COUNT(*) AS count FROM requests');
  assert.equal(count, 2);
});
