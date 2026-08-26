// Every hour this product shows a human is the studio's wall clock. Three layers
// used to disagree — emails on Europe/Paris regardless of the studio, cancellation
// notices on the server's zone (UTC in production), the front end on the reader's
// browser. These tests hold the three together.

import test from 'node:test';
import assert from 'node:assert/strict';
import { formatDateTime, formatDate, zoneLabel, safeZone, zonedToUtc } from '../src/availability.js';

test('an instant reads as the studio wall clock, not the server one', () => {
  const iso = '2025-07-14T13:00:00.000Z'; // 15:00 in Paris in July, 09:00 in Montréal
  assert.match(formatDateTime(iso, 'Europe/Paris'), /15:00/);
  assert.match(formatDateTime(iso, 'America/Montreal'), /09:00/);
  assert.match(formatDateTime(iso, 'Asia/Tokyo'), /22:00/);
});

test('the same instant can fall on different calendar days per studio', () => {
  const iso = '2025-07-14T21:30:00.000Z'; // 23:30 the 14th in Paris, 06:30 the 15th in Tokyo
  assert.match(formatDate(iso, 'Europe/Paris'), /14 juil/);
  assert.match(formatDate(iso, 'Asia/Tokyo'), /15 juil/);
});

test('the offset label follows summer time', () => {
  const winter = Date.UTC(2025, 0, 15);
  const summer = Date.UTC(2025, 6, 15);
  assert.equal(zoneLabel('Europe/Paris', winter), 'UTC+1');
  assert.equal(zoneLabel('Europe/Paris', summer), 'UTC+2');
  assert.equal(zoneLabel('Asia/Kolkata', summer), 'UTC+5:30');
});

test('a broken timezone falls back instead of throwing mid-send', () => {
  assert.equal(safeZone('Mars/Olympus_Mons'), 'Europe/Paris');
  assert.equal(safeZone(''), 'Europe/Paris');
  assert.equal(safeZone('America/Montreal'), 'America/Montreal');
  assert.doesNotThrow(() => formatDateTime('2025-07-14T13:00:00.000Z', 'Mars/Olympus_Mons'));
});

test('an unparseable date renders empty rather than "Invalid Date"', () => {
  assert.equal(formatDateTime('not-a-date', 'Europe/Paris'), '');
  assert.equal(formatDateTime(null, 'Europe/Paris'), '');
  assert.equal(formatDate(undefined, 'Europe/Paris'), '');
});

test('wall clock to instant and back is stable across a clock change', () => {
  // 30 March 2025, 02:00 Paris never existed: the clocks jumped 02:00 -> 03:00.
  const before = zonedToUtc({ year: 2025, month: 3, day: 29, hours: 14 }, 'Europe/Paris');
  const after = zonedToUtc({ year: 2025, month: 3, day: 30, hours: 14 }, 'Europe/Paris');
  assert.match(formatDateTime(new Date(before).toISOString(), 'Europe/Paris'), /14:00/);
  assert.match(formatDateTime(new Date(after).toISOString(), 'Europe/Paris'), /14:00/);
  // 24 wall-clock hours apart, but only 23 real ones.
  assert.equal(after - before, 23 * 3600000);
});

/* ------------------------------------------------- the same hour, end to end */

import { after } from 'node:test';
import { client, shutdown } from './helpers.js';
import { getDb } from '../src/db.js';

after(shutdown);

/** A studio in Montréal, quoting a slot named in Paris-UTC terms. */
async function montrealStudio() {
  const artist = client();
  const n = Math.random().toString(36).slice(2, 8);
  await artist('POST', '/api/auth/signup', {
    email: `tz-${n}@studio.example`, password: 'motdepasse123', studio_name: `Encre ${n}`,
  });
  await artist('PATCH', '/api/me', { timezone: 'America/Montreal', city: 'Montréal', reference_price_cents: 20000 });
  const slug = (await artist('GET', '/api/me')).data.artist.slug;

  const visitor = client();
  const created = await visitor('POST', `/api/public/artists/${slug}/requests`, {
    client_name: 'Léa Fortin', client_email: 'lea@example.com',
    description: 'Chouette lapone sur l\'omoplate, noir et gris.',
    size_cm: 14, color_mode: 'blackgrey', detail_level: 'high', is_adult: true,
  });
  return { artist, visitor, slug, token: created.data.request.public_token };
}

test('the quote email names the studio hour, not the server hour', async () => {
  const { artist, token } = await montrealStudio();
  const start = '2025-07-14T19:00:00.000Z'; // 15:00 in Montréal, 21:00 in Paris, 19:00 UTC
  const request = (await artist('GET', '/api/requests?status=new')).data.requests
    .find((row) => row.public_token === token);

  await artist('POST', `/api/requests/${request.id}/quote`, {
    outside_hours: true, price_cents: 42000, proposed_start: start, duration_hours: 3,
  });

  const db = await getDb();
  const message = await db.get(
    "SELECT * FROM messages WHERE request_id = ? AND kind = 'quote_sent'", [request.id],
  );
  assert.match(message.body, /15:00/, 'the client reads the studio wall clock');
  assert.doesNotMatch(message.body, /21:00/, 'not the Paris hour that used to be hardcoded');
  assert.doesNotMatch(message.body, /19:00/, 'and not the server hour either');
  assert.match(message.body, /heure de Montréal, UTC-4/, 'the zone is spelled out for a client abroad');
});

test('the quote page hands the front end the studio zone to render in', async () => {
  const { artist, visitor, token } = await montrealStudio();
  const request = (await artist('GET', '/api/requests?status=new')).data.requests
    .find((row) => row.public_token === token);
  await artist('POST', `/api/requests/${request.id}/quote`, {
    outside_hours: true, price_cents: 42000, proposed_start: '2025-07-14T19:00:00.000Z', duration_hours: 3,
  });

  const view = await visitor('GET', `/api/public/quotes/${token}`);
  assert.equal(view.data.artist.timezone, 'America/Montreal');
});

test('the public booking page is told the zone its opening hours are in', async () => {
  const { slug } = await montrealStudio();
  const page = await client()('GET', `/api/public/artists/${slug}`);
  assert.equal(page.data.artist.timezone, 'America/Montreal');
  assert.equal(page.data.artist.working_hours.length, 7);
});
