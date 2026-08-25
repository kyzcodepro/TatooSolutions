// Deposits.
//
// The deposit is the whole anti-no-show mechanism, so this file holds the only
// code that knows how money moves. Two providers:
//
//   - `mock` (default): confirms instantly, for local work, tests and the demo;
//   - `stripe`: a hosted Checkout page. The browser's return URL is NOT proof of
//     payment — it can be forged or simply never loaded. Only the signed webhook
//     books the slot.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const STRIPE_API = 'https://api.stripe.com/v1';
// Stripe replays a webhook it did not see acknowledged; five minutes is its own
// recommended tolerance against replay of a captured request.
const SIGNATURE_TOLERANCE_SECONDS = 300;

export const paymentsProvider = () => (process.env.INKFLOW_PAYMENTS || 'mock').toLowerCase();

export class PaymentError extends Error {}

/**
 * Opens a deposit. Returns either a payment already settled (mock), or somewhere
 * to send the client (stripe). Never books anything itself.
 */
export async function startDeposit({ request, artist, baseUrl, fetchImpl = globalThis.fetch }) {
  const amount = Math.round(Number(request.deposit_cents) || 0);
  if (amount <= 0) {
    // Nothing to collect: the artist asks for no deposit on this quote.
    return { provider: 'none', settled: true, reference: `free-${request.id}`, amount_cents: 0 };
  }

  if (paymentsProvider() !== 'stripe') {
    return {
      provider: 'mock',
      settled: true,
      reference: `dep_${randomBytes(10).toString('hex')}`,
      amount_cents: amount,
    };
  }

  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new PaymentError('STRIPE_SECRET_KEY is required to collect deposits with Stripe');

  const currency = (artist.currency || 'EUR').toLowerCase();
  const form = new URLSearchParams({
    mode: 'payment',
    // Stripe returns the client here; the page waits for the webhook before
    // claiming anything is booked.
    success_url: `${baseUrl}/q/${request.public_token}?paid=1`,
    cancel_url: `${baseUrl}/q/${request.public_token}`,
    client_reference_id: request.public_token,
    'metadata[public_token]': request.public_token,
    'metadata[request_id]': String(request.id),
    'line_items[0][quantity]': '1',
    'line_items[0][price_data][currency]': currency,
    'line_items[0][price_data][unit_amount]': String(amount),
    'line_items[0][price_data][product_data][name]': `Acompte — ${artist.studio_name}`,
    'line_items[0][price_data][product_data][description]':
      truncate(`${request.description}`, 200),
    'payment_intent_data[description]': `Acompte réservation ${artist.studio_name} (#${request.id})`,
    customer_email: request.client_email,
  });

  let res;
  try {
    res = await fetchImpl(`${STRIPE_API}/checkout/sessions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${key}`,
        'content-type': 'application/x-www-form-urlencoded',
        // Re-opening the same quote must not create a second charge.
        'idempotency-key': `deposit-${request.public_token}-${amount}`,
      },
      body: form.toString(),
    });
  } catch (err) {
    throw new PaymentError(`stripe: ${err.message}`);
  }

  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new PaymentError(`stripe refused the checkout (HTTP ${res.status}) ${payload?.error?.message ?? ''}`.trim());
  }
  return {
    provider: 'stripe',
    settled: false,
    redirect_url: payload.url,
    reference: payload.id,
    amount_cents: amount,
  };
}

const truncate = (value, max) => (value.length > max ? `${value.slice(0, max - 1)}…` : value);

/**
 * Verifies Stripe's signature over the RAW body and returns the event.
 * A parsed-then-restringified body will not match: JSON.stringify is not
 * byte-identical to what was signed.
 */
export function verifyWebhook(rawBody, signatureHeader, secret = process.env.STRIPE_WEBHOOK_SECRET) {
  if (!secret) throw new PaymentError('STRIPE_WEBHOOK_SECRET is required to accept Stripe webhooks');

  const parts = Object.fromEntries(
    String(signatureHeader ?? '').split(',').map((piece) => {
      const idx = piece.indexOf('=');
      return idx === -1 ? ['', ''] : [piece.slice(0, idx).trim(), piece.slice(idx + 1).trim()];
    }),
  );
  const timestamp = Number(parts.t);
  if (!Number.isFinite(timestamp) || !parts.v1) throw new PaymentError('Malformed Stripe signature header');

  const age = Math.abs(Math.floor(Date.now() / 1000) - timestamp);
  if (age > SIGNATURE_TOLERANCE_SECONDS) throw new PaymentError('Stripe signature is outside the tolerance window');

  const expected = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(parts.v1);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new PaymentError('Stripe signature does not match');

  try {
    return JSON.parse(rawBody);
  } catch {
    throw new PaymentError('Stripe webhook body is not JSON');
  }
}

/** Test helper and documentation of the scheme in one place. */
export function signWebhook(rawBody, secret, timestamp = Math.floor(Date.now() / 1000)) {
  const signature = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
  return `t=${timestamp},v1=${signature}`;
}
