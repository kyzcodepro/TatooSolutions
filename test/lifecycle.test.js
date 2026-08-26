// How a project ends is data the artist reads every day: the inbox counts, the
// conversion rate, and what the client sees on their tracking page all follow from
// the request's status. A cancelled session used to be filed as a refused project
// and a no-show stayed "booked" forever, so both numbers lied.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { client, shutdown, inDays } from './helpers.js';

after(shutdown);

/** A studio with one paid, booked session. */
async function bookedSession({ price = 48000 } = {}) {
  const artist = client();
  const n = Math.random().toString(36).slice(2, 8);
  await artist('POST', '/api/auth/signup', {
    email: `life-${n}@studio.example`, password: 'motdepasse123', studio_name: `Atelier ${n}`,
  });
  const slug = (await artist('GET', '/api/me')).data.artist.slug;

  const visitor = client();
  const created = await visitor('POST', `/api/public/artists/${slug}/requests`, {
    client_name: 'Sacha Merle', client_email: 'sacha@example.com',
    description: 'Vague japonaise sur le mollet, noir et gris, deux séances.',
    size_cm: 22, color_mode: 'blackgrey', detail_level: 'high', is_adult: true,
  });
  const token = created.data.request.public_token;
  const request = (await artist('GET', '/api/requests?status=new')).data.requests
    .find((row) => row.public_token === token);

  await artist('POST', `/api/requests/${request.id}/quote`, {
    outside_hours: true, price_cents: price, proposed_start: inDays(20, 12), duration_hours: 4,
  });
  await visitor('POST', `/api/public/quotes/${token}/accept`);
  const appointment = (await artist('GET', '/api/appointments')).data.appointments[0];
  assert.ok(appointment, 'the mock provider settles the deposit inline');
  return { artist, visitor, token, appointment, requestId: request.id };
}

test('a cancelled session is cancelled, not refused', async () => {
  const { artist, visitor, token, appointment } = await bookedSession();

  const res = await artist('POST', `/api/appointments/${appointment.id}/cancel`, {
    reason: 'Je suis à l\'hôpital', refund_deposit: true,
  });
  assert.equal(res.status, 200);

  const request = (await artist('GET', '/api/requests')).data.requests[0];
  assert.equal(request.status, 'cancelled');
  assert.equal(request.decline_reason, 'Je suis à l\'hôpital');

  const refused = await artist('GET', '/api/requests?status=declined');
  assert.equal(refused.data.requests.length, 0, 'a cancellation is not a refusal');

  const view = await visitor('GET', `/api/public/quotes/${token}`);
  assert.equal(view.data.request.status, 'cancelled');
  assert.equal(view.data.request.decline_reason, 'Je suis à l\'hôpital', 'the client is told why');
});

test('a no-show stops being an active booking', async () => {
  const { artist, visitor, token, appointment } = await bookedSession();

  await artist('POST', `/api/appointments/${appointment.id}/no-show`);

  const stillBooked = await artist('GET', '/api/requests?status=booked');
  assert.equal(stillBooked.data.requests.length, 0, 'it must leave the booked list');

  const missed = await artist('GET', '/api/requests?status=no_show');
  assert.equal(missed.data.requests.length, 1);

  const view = await visitor('GET', `/api/public/quotes/${token}`);
  assert.equal(view.data.request.status, 'no_show');
});

test('conversion counts every request that ended in a paid deposit', async () => {
  const { artist, appointment } = await bookedSession();
  const before = (await artist('GET', '/api/stats')).data.stats;
  assert.equal(before.conversion_rate, 1, 'one request, one deposit');

  await artist('POST', `/api/appointments/${appointment.id}/cancel`, { reason: 'Studio fermé' });

  const after = (await artist('GET', '/api/stats')).data.stats;
  assert.equal(after.conversion_rate, 1, 'the money still moved — cancelling later does not undo that');
  assert.equal(after.requests.by_status.cancelled, 1);
  assert.equal(after.requests.by_status.declined ?? 0, 0);
});

test('a refused request is still plainly refused', async () => {
  const artist = client();
  const n = Math.random().toString(36).slice(2, 8);
  await artist('POST', '/api/auth/signup', {
    email: `ref-${n}@studio.example`, password: 'motdepasse123', studio_name: `Refus ${n}`,
  });
  const slug = (await artist('GET', '/api/me')).data.artist.slug;
  const visitor = client();
  const created = await visitor('POST', `/api/public/artists/${slug}/requests`, {
    client_name: 'Alex Roy', client_email: 'alex@example.com',
    description: 'Portrait photoréaliste sur la main, en couleur.',
    size_cm: 9, color_mode: 'color', detail_level: 'hyperrealism', is_adult: true,
  });
  const request = (await artist('GET', '/api/requests?status=new')).data.requests[0];
  await artist('POST', `/api/requests/${request.id}/decline`, { reason: 'Pas mon style' });

  const view = await visitor('GET', `/api/public/quotes/${created.data.request.public_token}`);
  assert.equal(view.data.request.status, 'declined');
  assert.equal(view.data.request.decline_reason, 'Pas mon style');

  const stats = (await artist('GET', '/api/stats')).data.stats;
  assert.equal(stats.conversion_rate, 0, 'no deposit, no conversion');
});

test('the status filter refuses a status that does not exist', async () => {
  const { artist } = await bookedSession();
  const res = await artist('GET', '/api/requests?status=ghosted');
  assert.equal(res.status, 400);
});
