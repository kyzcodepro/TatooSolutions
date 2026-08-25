// The signature check is the security boundary of the whole payment flow: it is
// the only thing standing between a forged HTTP request and a booked date.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { startDeposit, verifyWebhook, signWebhook, PaymentError } from '../src/payments.js';

const SECRET = 'whsec_test_secret';
const body = JSON.stringify({ type: 'checkout.session.completed', data: { object: { id: 'cs_1' } } });

const request = {
  id: 7, public_token: 'tok123', deposit_cents: 16500,
  description: 'Serpent et pivoine sur l\'avant-bras', client_email: 'camille@studio.example',
};
const artist = { studio_name: 'Atelier Noir', currency: 'EUR' };

test('a correctly signed webhook is accepted and parsed', () => {
  const event = verifyWebhook(body, signWebhook(body, SECRET), SECRET);
  assert.equal(event.type, 'checkout.session.completed');
});

test('a body altered after signing is refused', () => {
  const header = signWebhook(body, SECRET);
  const tampered = body.replace('cs_1', 'cs_attacker');
  assert.throws(() => verifyWebhook(tampered, header, SECRET), /does not match/);
});

test('a signature from another secret is refused', () => {
  assert.throws(() => verifyWebhook(body, signWebhook(body, 'whsec_someone_else'), SECRET), /does not match/);
});

test('a captured signature cannot be replayed later', () => {
  const stale = Math.floor(Date.now() / 1000) - 3600;
  assert.throws(() => verifyWebhook(body, signWebhook(body, SECRET, stale), SECRET), /tolerance window/);
});

test('malformed headers and a missing secret are refused, not guessed at', () => {
  assert.throws(() => verifyWebhook(body, 'nonsense', SECRET), /Malformed/);
  assert.throws(() => verifyWebhook(body, 't=abc,v1=zz', SECRET), /Malformed/);
  assert.throws(() => verifyWebhook(body, signWebhook(body, SECRET), ''), /STRIPE_WEBHOOK_SECRET is required/);
});

test('the signature covers the raw bytes, not a re-serialised object', () => {
  // Round-tripping through JSON reorders nothing here but adds no spaces either;
  // a body with different whitespace must fail, which is why the route reads raw.
  const spaced = JSON.stringify(JSON.parse(body), null, 2);
  assert.throws(() => verifyWebhook(spaced, signWebhook(body, SECRET), SECRET), /does not match/);
});

test('a checkout session carries the amount, the reference and an idempotency key', async () => {
  process.env.INKFLOW_PAYMENTS = 'stripe';
  process.env.STRIPE_SECRET_KEY = 'sk_test_123';
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, form: new URLSearchParams(init.body) });
    return { ok: true, status: 200, json: async () => ({ id: 'cs_live', url: 'https://checkout.stripe.com/c/pay/cs_live' }) };
  };

  try {
    const result = await startDeposit({ request, artist, baseUrl: 'https://studio.example', fetchImpl });
    assert.equal(result.settled, false, 'nothing is settled by opening a checkout');
    assert.equal(result.redirect_url, 'https://checkout.stripe.com/c/pay/cs_live');
    assert.equal(result.reference, 'cs_live');

    const { url, init, form } = calls[0];
    assert.equal(url, 'https://api.stripe.com/v1/checkout/sessions');
    assert.equal(init.headers.authorization, 'Bearer sk_test_123');
    assert.equal(form.get('line_items[0][price_data][unit_amount]'), '16500');
    assert.equal(form.get('line_items[0][price_data][currency]'), 'eur');
    assert.equal(form.get('client_reference_id'), 'tok123');
    assert.equal(form.get('metadata[public_token]'), 'tok123');
    assert.equal(form.get('success_url'), 'https://studio.example/q/tok123?paid=1');
    // Re-opening the same quote must not create a second charge.
    assert.equal(init.headers['idempotency-key'], 'deposit-tok123-16500');
  } finally {
    delete process.env.INKFLOW_PAYMENTS;
    delete process.env.STRIPE_SECRET_KEY;
  }
});

test('a refusal from Stripe surfaces as a payment error', async () => {
  process.env.INKFLOW_PAYMENTS = 'stripe';
  process.env.STRIPE_SECRET_KEY = 'sk_test_123';
  const fetchImpl = async () => ({ ok: false, status: 400, json: async () => ({ error: { message: 'Invalid API Key' } }) });
  try {
    await assert.rejects(
      startDeposit({ request, artist, baseUrl: 'https://studio.example', fetchImpl }),
      (err) => err instanceof PaymentError && /Invalid API Key/.test(err.message),
    );
  } finally {
    delete process.env.INKFLOW_PAYMENTS;
    delete process.env.STRIPE_SECRET_KEY;
  }
});

test('a quote with no deposit needs no payment page at all', async () => {
  process.env.INKFLOW_PAYMENTS = 'stripe';
  const fetchImpl = async () => { throw new Error('should not be called'); };
  try {
    const result = await startDeposit({ request: { ...request, deposit_cents: 0 }, artist, baseUrl: '', fetchImpl });
    assert.equal(result.settled, true);
    assert.equal(result.amount_cents, 0);
  } finally {
    delete process.env.INKFLOW_PAYMENTS;
  }
});

test('without Stripe configured the mock settles immediately', async () => {
  const result = await startDeposit({ request, artist, baseUrl: '' });
  assert.equal(result.provider, 'mock');
  assert.equal(result.settled, true);
  assert.equal(result.amount_cents, 16500);
});
