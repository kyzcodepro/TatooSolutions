import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { base, client, shutdown, inDays } from './helpers.js';

after(shutdown);

let counter = 0;
async function signUpArtist(overrides = {}) {
  const call = client();
  const n = ++counter;
  const res = await call('POST', '/api/auth/signup', {
    email: `artist${n}@ink.test`,
    password: 'motdepasse123',
    studio_name: `Studio ${n}`,
    city: 'Paris',
    ...overrides,
  });
  assert.equal(res.status, 201);
  await call('PATCH', '/api/me', {
    reference_price_cents: 18000, minimum_cents: 8000, deposit_percent: 30, cancellation_hours: 48,
  });
  return { call, artist: res.data.artist };
}

const brief = (extra = {}) => ({
  client_name: 'Camille Roy',
  client_email: 'camille@example.test',
  client_phone: '+33612345678',
  description: 'Serpent et pivoine sur l\'avant-bras, style japonais traditionnel.',
  style: 'japonais',
  placement: 'forearm',
  size_cm: 18,
  color_mode: 'blackgrey',
  detail_level: 'high',
  budget_cents: 60000,
  reference_urls: ['https://example.test/ref1.jpg'],
  availability: ['samedi matin', 'mercredi'],
  is_adult: true,
  ...extra,
});

test('signup, login and session identity', async () => {
  const { call, artist } = await signUpArtist();
  assert.match(artist.slug, /^studio-/);

  const me = await call('GET', '/api/me');
  assert.equal(me.data.artist.email, artist.email);

  const dup = await client()('POST', '/api/auth/signup', {
    email: artist.email, password: 'motdepasse123', studio_name: 'Autre',
  });
  assert.equal(dup.status, 409);

  const fresh = client();
  const bad = await fresh('POST', '/api/auth/login', { email: artist.email, password: 'wrongwrong' });
  assert.equal(bad.status, 400);
  const good = await fresh('POST', '/api/auth/login', { email: artist.email, password: 'motdepasse123' });
  assert.equal(good.status, 200);

  await call('POST', '/api/auth/logout');
  assert.equal((await call('GET', '/api/requests')).status, 401);
});

test('the dashboard is closed to anonymous callers', async () => {
  const anon = client();
  for (const path of ['/api/requests', '/api/appointments', '/api/stats', '/api/blocks']) {
    assert.equal((await anon('GET', path)).status, 401, path);
  }
});

test('public booking page exposes rates and a live estimate', async () => {
  const { artist } = await signUpArtist();
  const anon = client();
  const page = await anon('GET', `/api/public/artists/${artist.slug}`);
  assert.equal(page.status, 200);
  assert.equal(page.data.artist.reference_price_cents, 18000);
  assert.ok(page.data.options.color_modes.includes('color'));

  const est = await anon('POST', `/api/public/artists/${artist.slug}/estimate`, {
    size_cm: 18, color_mode: 'blackgrey', detail_level: 'high', placement: 'ribs',
  });
  assert.equal(est.status, 200);
  assert.ok(est.data.estimate.low_cents > 0);
  assert.ok(est.data.estimate.deposit_cents > 0);

  assert.equal((await anon('GET', '/api/public/artists/nope-nope')).status, 404);
});

test('full funnel: brief -> quote -> deposit -> booked -> completed -> aftercare', async () => {
  const { call, artist } = await signUpArtist();
  const clientCall = client();

  const created = await clientCall('POST', `/api/public/artists/${artist.slug}/requests`, brief());
  assert.equal(created.status, 201);
  const token = created.data.request.public_token;
  assert.ok(created.data.estimate.hours > 0);

  const inbox = await call('GET', '/api/requests?status=new');
  assert.equal(inbox.data.requests.length, 1);
  const requestId = inbox.data.requests[0].id;
  assert.equal(inbox.data.requests[0].client_name, 'Camille Roy');

  const start = inDays(10, 9);
  const quoted = await call('POST', `/api/requests/${requestId}/quote`, {
    price_cents: 55000, proposed_start: start, duration_hours: 4, note: 'Prévoir 4 h, on fait la ligne d\'abord.',
  });
  assert.equal(quoted.status, 200);
  assert.equal(quoted.data.request.status, 'quoted');
  assert.equal(quoted.data.request.deposit_cents, 16500); // 30 % rounded to 5 €

  const view = await clientCall('GET', `/api/public/quotes/${token}`);
  assert.equal(view.data.request.quote_price_cents, 55000);
  assert.equal(view.data.artist.studio_name, artist.studio_name);

  const accepted = await clientCall('POST', `/api/public/quotes/${token}/accept`);
  assert.equal(accepted.status, 200);
  assert.equal(accepted.data.payment.amount_cents, 16500);
  const appointmentId = accepted.data.appointment.id;

  // Accepting twice must not create a second slot.
  assert.equal((await clientCall('POST', `/api/public/quotes/${token}/accept`)).status, 409);

  const appts = await call('GET', '/api/appointments');
  assert.equal(appts.data.appointments.length, 1);
  assert.equal(appts.data.appointments[0].status, 'scheduled');

  const pending = await call('GET', '/api/messages?pending=true');
  const kinds = pending.data.messages.map((m) => m.kind);
  assert.ok(kinds.includes('reminder_24h'), 'a day-before reminder is queued');
  assert.ok(kinds.includes('reminder_cutoff'), 'the free-cancellation cutoff is announced');

  const done = await call('POST', `/api/appointments/${appointmentId}/complete`);
  assert.equal(done.data.appointment.status, 'completed');

  const after = await call('GET', '/api/messages?pending=true');
  const afterKinds = after.data.messages.map((m) => m.kind);
  assert.ok(afterKinds.includes('aftercare_d1'));
  assert.ok(afterKinds.includes('aftercare_d30'));
  assert.ok(!afterKinds.includes('reminder_24h'), 'reminders are dropped once the session happened');

  const stats = await call('GET', '/api/stats');
  assert.equal(stats.data.stats.completed, 1);
  assert.equal(stats.data.stats.revenue_completed_cents, 55000);
  assert.equal(stats.data.stats.conversion_rate, 1);
});

test('a no-show keeps the deposit and shows up in the stats', async () => {
  const { call, artist } = await signUpArtist();
  const clientCall = client();
  const created = await clientCall('POST', `/api/public/artists/${artist.slug}/requests`, brief());
  const token = created.data.request.public_token;
  const requestId = (await call('GET', '/api/requests')).data.requests[0].id;
  await call('POST', `/api/requests/${requestId}/quote`, {
    price_cents: 40000, proposed_start: inDays(3, 14), duration_hours: 3,
  });
  const { data } = await clientCall('POST', `/api/public/quotes/${token}/accept`);

  const noShow = await call('POST', `/api/appointments/${data.appointment.id}/no-show`);
  assert.equal(noShow.data.appointment.status, 'no_show');

  const stats = (await call('GET', '/api/stats')).data.stats;
  assert.equal(stats.no_shows, 1);
  assert.equal(stats.no_show_rate, 1);
  assert.equal(stats.deposits_kept_cents, 12000);
});

test('double booking and blocked periods are refused', async () => {
  const { call, artist } = await signUpArtist();
  const start = inDays(20, 9);

  const first = client();
  const c1 = await first('POST', `/api/public/artists/${artist.slug}/requests`, brief());
  const id1 = (await call('GET', '/api/requests?status=new')).data.requests[0].id;
  await call('POST', `/api/requests/${id1}/quote`, { price_cents: 30000, proposed_start: start, duration_hours: 3 });
  await first('POST', `/api/public/quotes/${c1.data.request.public_token}/accept`);

  // Same slot, another client: the artist cannot even send the quote.
  const second = client();
  await second('POST', `/api/public/artists/${artist.slug}/requests`, brief({ client_email: 'b@example.test' }));
  const id2 = (await call('GET', '/api/requests?status=new')).data.requests[0].id;
  const clash = await call('POST', `/api/requests/${id2}/quote`, {
    price_cents: 30000, proposed_start: start, duration_hours: 2,
  });
  assert.equal(clash.status, 409);

  // Holidays block the calendar too.
  const block = await call('POST', '/api/blocks', {
    starts_at: inDays(30), ends_at: inDays(37), label: 'Vacances',
  });
  assert.equal(block.status, 201);
  const blocked = await call('POST', `/api/requests/${id2}/quote`, {
    price_cents: 30000, proposed_start: inDays(32, 11), duration_hours: 2,
  });
  assert.equal(blocked.status, 409);
  assert.match(blocked.data.error, /Vacances/);

  const free = await call('POST', `/api/requests/${id2}/quote`, {
    price_cents: 30000, proposed_start: inDays(21, 9), duration_hours: 2,
  });
  assert.equal(free.status, 200);
});

test('rescheduling moves the slot and re-arms the reminders', async () => {
  const { call, artist } = await signUpArtist();
  const clientCall = client();
  const created = await clientCall('POST', `/api/public/artists/${artist.slug}/requests`, brief());
  const requestId = (await call('GET', '/api/requests')).data.requests[0].id;
  await call('POST', `/api/requests/${requestId}/quote`, {
    price_cents: 30000, proposed_start: inDays(12, 9), duration_hours: 2,
  });
  const { data } = await clientCall('POST', `/api/public/quotes/${created.data.request.public_token}/accept`);

  const moved = await call('POST', `/api/appointments/${data.appointment.id}/reschedule`, {
    starts_at: inDays(15, 14),
  });
  assert.equal(moved.status, 200);
  assert.equal(new Date(moved.data.appointment.starts_at).toISOString(), inDays(15, 14));
  // Duration is preserved when it is not given again.
  const hours = (new Date(moved.data.appointment.ends_at) - new Date(moved.data.appointment.starts_at)) / 3600000;
  assert.equal(hours, 2);

  const kinds = (await call('GET', '/api/messages?pending=true')).data.messages
    .filter((m) => m.appointment_id === data.appointment.id).map((m) => m.kind);
  assert.equal(kinds.filter((k) => k === 'reminder_24h').length, 1, 'reminders are not duplicated');
  assert.ok(kinds.includes('rescheduled'));
});

test('expired quotes cannot be accepted', async () => {
  const { call, artist } = await signUpArtist();
  const clientCall = client();
  const created = await clientCall('POST', `/api/public/artists/${artist.slug}/requests`, brief());
  const requestId = (await call('GET', '/api/requests')).data.requests[0].id;
  await call('POST', `/api/requests/${requestId}/quote`, {
    price_cents: 30000, proposed_start: inDays(9, 9), duration_hours: 2, expires_in_days: 1,
  });
  // Push the deadline into the past the way a stale quote would age out.
  const { getDb } = await import('../src/db.js');
  const db = await getDb();
  await db.run('UPDATE requests SET quote_expires_at = ? WHERE id = ?',
    [new Date(Date.now() - 1000).toISOString(), requestId]);

  const accepted = await clientCall('POST', `/api/public/quotes/${created.data.request.public_token}/accept`);
  assert.equal(accepted.status, 409);
  assert.match(accepted.data.error, /expired/i);
});

test('input is validated and tenants are isolated', async () => {
  const { call: callA, artist: artistA } = await signUpArtist();
  const { call: callB } = await signUpArtist();
  const anon = client();

  const short = await anon('POST', `/api/public/artists/${artistA.slug}/requests`, brief({ description: 'court' }));
  assert.equal(short.status, 400);

  const minor = await anon('POST', `/api/public/artists/${artistA.slug}/requests`, brief({ is_adult: false }));
  assert.equal(minor.status, 400);
  assert.match(minor.data.error, /18/);

  const badEmail = await anon('POST', `/api/public/artists/${artistA.slug}/requests`, brief({ client_email: 'nope' }));
  assert.equal(badEmail.status, 400);

  await anon('POST', `/api/public/artists/${artistA.slug}/requests`, brief());
  const requestId = (await callA('GET', '/api/requests')).data.requests[0].id;
  assert.equal((await callB('GET', `/api/requests/${requestId}`)).status, 404);
  assert.equal((await callB('POST', `/api/requests/${requestId}/decline`, {})).status, 404);
  assert.equal((await callB('GET', '/api/requests')).data.requests.length, 0);
});

test('an artist can close the books and decline a project', async () => {
  const { call, artist } = await signUpArtist();
  const anon = client();

  await anon('POST', `/api/public/artists/${artist.slug}/requests`, brief());
  const requestId = (await call('GET', '/api/requests')).data.requests[0].id;
  const declined = await call('POST', `/api/requests/${requestId}/decline`, { reason: 'Pas mon style' });
  assert.equal(declined.data.request.status, 'declined');
  assert.equal((await call('POST', `/api/requests/${requestId}/quote`, { price_cents: 20000 })).status, 409);

  await call('PATCH', '/api/me', { accepting_requests: false });
  const closed = await anon('POST', `/api/public/artists/${artist.slug}/requests`, brief());
  assert.equal(closed.status, 409);
});

test('due messages are dispatched once', async () => {
  const { call, artist } = await signUpArtist();
  const anon = client();
  await anon('POST', `/api/public/artists/${artist.slug}/requests`, brief());

  const first = await call('POST', '/api/messages/dispatch');
  assert.ok(first.data.dispatched >= 1);
  const second = await call('POST', '/api/messages/dispatch');
  assert.equal(second.data.dispatched, 0);
});

test('static pages and unknown endpoints behave', async () => {
  const anon = client();
  assert.equal((await anon('GET', '/api/nope')).status, 404);
  const home = await fetch(`${base}/`);
  assert.equal(home.status, 200);
  assert.match(home.headers.get('content-type'), /text\/html/);
});

test('the cron endpoint flushes the outbox and can be locked with a secret', async () => {
  const anon = client();
  const open = await anon('GET', '/api/cron/dispatch');
  assert.equal(open.status, 200, 'without a secret configured the scheduler can call in');
  assert.equal(typeof open.data.dispatched, 'number');

  process.env.CRON_SECRET = 'a-scheduler-secret';
  try {
    const refused = await anon('GET', '/api/cron/dispatch');
    assert.equal(refused.status, 401);

    const res = await fetch(`${base}/api/cron/dispatch`, {
      headers: { authorization: 'Bearer a-scheduler-secret' },
    });
    assert.equal(res.status, 200);
  } finally {
    delete process.env.CRON_SECRET;
  }
});

test('health reports how mail is configured, without leaking the key', async () => {
  process.env.INKFLOW_MAIL_PROVIDER = 'resend';
  process.env.INKFLOW_MAIL_KEY = 'super-secret-key';
  try {
    const res = await fetch(`${base}/api/health`);
    const body = await res.json();
    assert.equal(body.mail.provider, 'resend');
    assert.equal(body.mail.key_configured, true);
    assert.ok(!JSON.stringify(body).includes('super-secret-key'));

    process.env.INKFLOW_MAIL_FROM = '"Atelier" <no-reply@studio.example>';
    const withSender = await (await fetch(`${base}/api/health`)).json();
    assert.equal(withSender.mail.sender_domain, 'studio.example');
    // The local part is not published: only the domain is needed to diagnose.
    assert.ok(!JSON.stringify(withSender).includes('no-reply@'));
  } finally {
    delete process.env.INKFLOW_MAIL_PROVIDER;
    delete process.env.INKFLOW_MAIL_KEY;
  }
});

test('a new brief reaches the artist, ready to triage from a phone', async () => {
  const { call, artist } = await signUpArtist();
  const anon = client();
  // A budget well under the work: the artist should see that in the subject line.
  await anon('POST', `/api/public/artists/${artist.slug}/requests`, brief({ budget_cents: 5000 }));

  const messages = (await call('GET', '/api/messages')).data.messages;
  const notice = messages.find((m) => m.kind === 'artist_new_request');
  assert.ok(notice, 'the studio is told a brief arrived');
  assert.equal(notice.recipient, artist.email);
  // Hitting reply must reach the client, not the studio's own inbox.
  assert.equal(notice.reply_to, 'camille@example.test');
  assert.match(notice.subject, /budget à cadrer/);
  assert.match(notice.body, /sous votre fourchette basse/);
  assert.match(notice.body, /18 cm/);
});

test('a paid deposit reaches the artist too', async () => {
  const { call, artist } = await signUpArtist();
  const clientCall = client();
  const created = await clientCall('POST', `/api/public/artists/${artist.slug}/requests`, brief());
  const requestId = (await call('GET', '/api/requests')).data.requests[0].id;
  await call('POST', `/api/requests/${requestId}/quote`, {
    price_cents: 40000, proposed_start: inDays(14, 10), duration_hours: 3,
  });
  await clientCall('POST', `/api/public/quotes/${created.data.request.public_token}/accept`);

  const messages = (await call('GET', '/api/messages')).data.messages;
  const notice = messages.find((m) => m.kind === 'artist_deposit_paid');
  assert.ok(notice, 'the studio learns the date is blocked');
  assert.equal(notice.recipient, artist.email);
  assert.match(notice.body, /Reste à percevoir/);
});

test('a quote that lapsed is swept, and both sides are told', async () => {
  const { call, artist } = await signUpArtist();
  const clientCall = client();
  await clientCall('POST', `/api/public/artists/${artist.slug}/requests`, brief());
  const requestId = (await call('GET', '/api/requests?status=new')).data.requests[0].id;
  await call('POST', `/api/requests/${requestId}/quote`, {
    price_cents: 30000, proposed_start: inDays(20, 10), duration_hours: 2,
  });

  const { getDb } = await import('../src/db.js');
  const db = await getDb();
  await db.run('UPDATE requests SET quote_expires_at = ? WHERE id = ?',
    [new Date(Date.now() - 1000).toISOString(), requestId]);

  const { expireStaleQuotes } = await import('../src/service.js');
  assert.equal(await expireStaleQuotes(), 1);

  const request = (await call('GET', `/api/requests/${requestId}`)).data.request;
  assert.equal(request.status, 'expired', 'it no longer sits in the inbox as if it were live');

  const kinds = (await call('GET', '/api/messages')).data.messages.map((m) => m.kind);
  assert.ok(kinds.includes('quote_expired_client'));
  assert.ok(kinds.includes('artist_quote_expired'));

  // Sweeping again finds nothing: no duplicate messages on every pass.
  assert.equal(await expireStaleQuotes(), 0);
});

test('a live quote and a booked one are left alone by the sweep', async () => {
  const { call, artist } = await signUpArtist();
  const clientCall = client();
  const created = await clientCall('POST', `/api/public/artists/${artist.slug}/requests`, brief());
  const requestId = (await call('GET', '/api/requests?status=new')).data.requests[0].id;
  await call('POST', `/api/requests/${requestId}/quote`, {
    price_cents: 30000, proposed_start: inDays(25, 10), duration_hours: 2, expires_in_days: 30,
  });
  await clientCall('POST', `/api/public/quotes/${created.data.request.public_token}/accept`);

  const { expireStaleQuotes } = await import('../src/service.js');
  assert.equal(await expireStaleQuotes(), 0);
  assert.equal((await call('GET', `/api/requests/${requestId}`)).data.request.status, 'booked');
});

test('the scheduler sweeps before it sends', async () => {
  const anon = client();
  const res = await anon('GET', '/api/cron/dispatch');
  assert.equal(res.status, 200);
  assert.equal(typeof res.data.expired, 'number');
  assert.equal(typeof res.data.dispatched, 'number');
});
