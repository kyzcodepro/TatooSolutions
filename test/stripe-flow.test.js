// The whole point of the two-phase flow: a date is booked by the signed webhook
// and by nothing else. These run against the real HTTP surface, with only
// Stripe's own API faked.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'inkflow-stripe-'));
process.env.INKFLOW_DB = join(dir, 'stripe.sqlite');
process.env.INKFLOW_QUIET = '1';
process.env.INKFLOW_DEMO = '0';
process.env.INKFLOW_SECRET = 'a-long-shared-secret-for-stripe-tests';
process.env.INKFLOW_PAYMENTS = 'stripe';
process.env.STRIPE_SECRET_KEY = 'sk_test_flow';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_flow';

const { createApp } = await import('../src/server.js');
const { signWebhook } = await import('../src/payments.js');
const { getDb, resetDb } = await import('../src/db.js');

// Only Stripe's API is faked; every call to our own server goes over real HTTP.
const realFetch = globalThis.fetch;
let checkoutCalls = 0;
globalThis.fetch = async (url, init) => {
  if (String(url).startsWith('https://api.stripe.com')) {
    checkoutCalls += 1;
    return { ok: true, status: 200, json: async () => ({ id: `cs_${checkoutCalls}`, url: `https://checkout.stripe.com/c/pay/cs_${checkoutCalls}` }) };
  }
  return realFetch(url, init);
};

const server = createApp();
await new Promise((done) => server.listen(0, done));
const base = `http://127.0.0.1:${server.address().port}`;

after(async () => {
  globalThis.fetch = realFetch;
  await new Promise((done) => server.close(done));
  await resetDb();
  rmSync(dir, { recursive: true, force: true });
});

function client() {
  const jar = new Map();
  return async function call(method, path, body) {
    const headers = { 'content-type': 'application/json' };
    if (jar.size) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    const res = await realFetch(base + path, {
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

async function postWebhook(payload, { secret = 'whsec_flow', header = null } = {}) {
  const raw = JSON.stringify(payload);
  return realFetch(`${base}/api/webhooks/stripe`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'stripe-signature': header ?? signWebhook(raw, secret) },
    body: raw,
  });
}

const paidEvent = (token, { session = 'cs_1', amount = 16500 } = {}) => ({
  type: 'checkout.session.completed',
  data: { object: { id: session, payment_status: 'paid', amount_total: amount, metadata: { public_token: token } } },
});

/** A studio with one quote out, waiting on a deposit. */
async function quotedRequest({ email = 'camille@studio.example', start = inDays(12, 9) } = {}) {
  const artistCall = client();
  const n = Math.random().toString(36).slice(2, 8);
  await artistCall('POST', '/api/auth/signup', {
    email: `artist-${n}@studio.example`, password: 'motdepasse123', studio_name: `Studio ${n}`,
  });
  const me = await artistCall('GET', '/api/me');
  const slug = me.data.artist.slug;
  await artistCall('PATCH', '/api/me', { reference_price_cents: 18000, minimum_cents: 8000, deposit_percent: 30 });

  const clientCall = client();
  const created = await clientCall('POST', `/api/public/artists/${slug}/requests`, {
    client_name: 'Camille Roy', client_email: email,
    description: 'Serpent et pivoine sur l\'avant-bras, japonais traditionnel.',
    size_cm: 18, color_mode: 'blackgrey', detail_level: 'high', is_adult: true,
  });
  const request = (await artistCall('GET', '/api/requests?status=new')).data.requests[0];
  await artistCall('POST', `/api/requests/${request.id}/quote`, {
    price_cents: 55000, proposed_start: start, duration_hours: 4,
  });
  return { artistCall, clientCall, token: created.data.request.public_token, slug, start };
}

test('accepting a quote opens a checkout and books nothing', async () => {
  const { artistCall, clientCall, token } = await quotedRequest();

  const accepted = await clientCall('POST', `/api/public/quotes/${token}/accept`);
  assert.equal(accepted.status, 200);
  assert.match(accepted.data.redirect_url, /^https:\/\/checkout\.stripe\.com\//);
  assert.equal(accepted.data.appointment, undefined, 'no appointment before the money moves');

  const appointments = await artistCall('GET', '/api/appointments');
  assert.equal(appointments.data.appointments.length, 0);
  const view = await clientCall('GET', `/api/public/quotes/${token}`);
  assert.equal(view.data.request.status, 'quoted', 'still merely quoted');
});

test('a forged webhook books nothing', async () => {
  const { artistCall, clientCall, token } = await quotedRequest();
  await clientCall('POST', `/api/public/quotes/${token}/accept`);

  const wrongSecret = await postWebhook(paidEvent(token), { secret: 'whsec_attacker' });
  assert.equal(wrongSecret.status, 400);

  const noSignature = await postWebhook(paidEvent(token), { header: '' });
  assert.equal(noSignature.status, 400);

  assert.equal((await artistCall('GET', '/api/appointments')).data.appointments.length, 0);
});

test('a signed webhook is what books the date', async () => {
  const { artistCall, clientCall, token, start } = await quotedRequest();
  await clientCall('POST', `/api/public/quotes/${token}/accept`);

  const res = await postWebhook(paidEvent(token));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { received: true, booked: true, already: false });

  const appointments = (await artistCall('GET', '/api/appointments')).data.appointments;
  assert.equal(appointments.length, 1);
  assert.equal(new Date(appointments[0].starts_at).toISOString(), start);
  assert.equal(appointments[0].deposit_cents, 16500);

  const view = await clientCall('GET', `/api/public/quotes/${token}`);
  assert.equal(view.data.request.status, 'booked');

  const queued = (await artistCall('GET', '/api/messages?pending=true')).data.messages.map((m) => m.kind);
  assert.ok(queued.includes('reminder_24h'), 'the anti-no-show cadence is armed');
});

test('a replayed webhook does not book a second time', async () => {
  const { artistCall, clientCall, token } = await quotedRequest();
  await clientCall('POST', `/api/public/quotes/${token}/accept`);

  await postWebhook(paidEvent(token));
  const replay = await postWebhook(paidEvent(token));
  assert.equal(replay.status, 200);
  assert.deepEqual(await replay.json(), { received: true, booked: true, already: true });

  assert.equal((await artistCall('GET', '/api/appointments')).data.appointments.length, 1);
});

test('a webhook whose amount does not match the quote is refused', async () => {
  const { artistCall, clientCall, token } = await quotedRequest();
  await clientCall('POST', `/api/public/quotes/${token}/accept`);

  const res = await postWebhook(paidEvent(token, { amount: 500 }));
  // Acknowledged so Stripe stops retrying, but nothing was booked.
  assert.equal(res.status, 200);
  const payload = await res.json();
  assert.equal(payload.booked, false);
  assert.match(payload.error, /amount mismatch/i);
  assert.equal((await artistCall('GET', '/api/appointments')).data.appointments.length, 0);
});

test('a slot taken while the client was paying is never double-booked', async () => {
  const start = inDays(30, 9);
  const first = await quotedRequest({ start });
  const second = await quotedRequest({ start, email: 'autre@studio.example' });

  // Both clients head to checkout for what is, for each artist, their own slot —
  // so take the first artist's slot with a booking of their own instead.
  await first.clientCall('POST', `/api/public/quotes/${first.token}/accept`);
  await postWebhook(paidEvent(first.token));

  // A second request from the same studio, quoted onto the very same slot before
  // the appointment existed, then paid.
  const clash = await quotedRequest({ start: inDays(31, 9) });
  await clash.clientCall('POST', `/api/public/quotes/${clash.token}/accept`);
  const db = await getDb();
  const clashRow = await db.get('SELECT * FROM requests WHERE public_token = ?', [clash.token]);
  const booked = await db.get('SELECT * FROM appointments ORDER BY id DESC');
  await db.run('UPDATE requests SET artist_id = ?, proposed_start = ?, proposed_end = ? WHERE id = ?',
    [booked.artist_id, booked.starts_at, booked.ends_at, clashRow.id]);

  const res = await postWebhook(paidEvent(clash.token));
  assert.equal(res.status, 200);
  const payload = await res.json();
  assert.equal(payload.booked, false, 'the slot was not handed to two clients');

  const messages = await db.all('SELECT * FROM messages WHERE request_id = ?', [clashRow.id]);
  const kinds = messages.map((m) => m.kind);
  assert.ok(kinds.includes('deposit_slot_taken'), 'the artist is told the money arrived');
  assert.ok(kinds.includes('deposit_slot_taken_client'), 'and so is the client');
  assert.ok(second.token);
});

test('health reports the payment provider without leaking the key', async () => {
  const res = await realFetch(`${base}/api/health`);
  const body = await res.json();
  assert.equal(body.payments.provider, 'stripe');
  assert.equal(body.payments.key_configured, true);
  assert.equal(body.payments.webhook_secret_configured, true);
  assert.ok(!JSON.stringify(body).includes('sk_test_flow'));
  assert.ok(!JSON.stringify(body).includes('whsec_flow'));
});
