// Payment seam. Deposits are the whole anti-no-show mechanism, so the rest of the
// app talks to this interface only: swapping in Stripe means implementing the same
// two functions against PaymentIntents and keeping the returned shape.
import { randomBytes } from 'node:crypto';

export function createDepositIntent({ amountCents, currency, reference, clientEmail }) {
  if (!Number.isFinite(amountCents) || amountCents <= 0) {
    throw new Error('Deposit amount must be positive');
  }
  return {
    provider: process.env.INKFLOW_PAYMENTS || 'mock',
    intent_id: `dep_${randomBytes(10).toString('hex')}`,
    amount_cents: Math.round(amountCents),
    currency,
    reference,
    client_email: clientEmail,
    status: 'requires_confirmation',
  };
}

export function confirmDeposit(intent) {
  // The mock provider always succeeds; a real one would verify the webhook signature
  // and the amount before the caller marks the slot as booked.
  return { ...intent, status: 'succeeded', confirmed_at: new Date().toISOString() };
}
