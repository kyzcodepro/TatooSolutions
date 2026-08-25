// Outbox: every client-facing notification is queued here first, then dispatched by
// the scheduler. Keeping them in a table (instead of firing an email inline) means
// reminders survive a restart and the artist can see exactly what the client received.

import { getDb, nowIso } from './db.js';
import { formatMoney } from './pricing.js';

const HOUR = 3600000;
const DAY = 24 * HOUR;

export function queueMessage({
  artistId, requestId = null, appointmentId = null, kind, recipient,
  subject, body, scheduledFor = nowIso(), channel = 'email',
}) {
  const info = getDb().prepare(`
    INSERT INTO messages (artist_id, request_id, appointment_id, kind, channel, recipient,
                          subject, body, scheduled_for, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(artistId, requestId, appointmentId, kind, channel, recipient, subject, body, scheduledFor, nowIso());
  return Number(info.lastInsertRowid);
}

const dateFr = (iso) => new Date(iso).toLocaleString('fr-FR', {
  weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris',
});

export function queueRequestReceived(artist, request, estimateResult) {
  queueMessage({
    artistId: artist.id,
    requestId: request.id,
    kind: 'request_received',
    recipient: request.client_email,
    subject: `Votre demande chez ${artist.studio_name} est bien reçue`,
    body: [
      `Bonjour ${request.client_name},`,
      '',
      `Merci pour votre projet : ${request.description}`,
      `Estimation indicative : ${formatMoney(estimateResult.low_cents, artist.currency)} – ${formatMoney(estimateResult.high_cents, artist.currency)}`,
      `Durée estimée : ${estimateResult.hours} h (${estimateResult.sessions} séance(s))`,
      '',
      `${artist.studio_name} revient vers vous avec un devis ferme. Suivi de votre demande :`,
      `{{base_url}}/q/${request.public_token}`,
    ].join('\n'),
  });
}

export function queueQuoteSent(artist, request) {
  queueMessage({
    artistId: artist.id,
    requestId: request.id,
    kind: 'quote_sent',
    recipient: request.client_email,
    subject: `Votre devis ${artist.studio_name} : ${formatMoney(request.quote_price_cents, artist.currency)}`,
    body: [
      `Bonjour ${request.client_name},`,
      '',
      `Voici votre devis : ${formatMoney(request.quote_price_cents, artist.currency)}`,
      request.proposed_start ? `Créneau proposé : ${dateFr(request.proposed_start)}` : 'Créneau à définir ensemble.',
      `Acompte pour bloquer la date : ${formatMoney(request.deposit_cents, artist.currency)}`,
      request.artist_note ? `\nNote de l'artiste : ${request.artist_note}` : '',
      '',
      `Confirmer et verser l'acompte : {{base_url}}/q/${request.public_token}`,
      request.quote_expires_at ? `Ce devis expire le ${dateFr(request.quote_expires_at)}.` : '',
    ].filter(Boolean).join('\n'),
  });
}

export function queueBookingConfirmed(artist, request, appointment) {
  queueMessage({
    artistId: artist.id,
    requestId: request.id,
    appointmentId: appointment.id,
    kind: 'booking_confirmed',
    recipient: request.client_email,
    subject: `C'est confirmé : ${dateFr(appointment.starts_at)}`,
    body: [
      `Bonjour ${request.client_name},`,
      '',
      `Votre acompte de ${formatMoney(appointment.deposit_cents, artist.currency)} est enregistré, votre séance est bloquée.`,
      `Rendez-vous : ${dateFr(appointment.starts_at)} chez ${artist.studio_name}${artist.city ? `, ${artist.city}` : ''}.`,
      `Reste à régler sur place : ${formatMoney(appointment.price_cents - appointment.deposit_cents, artist.currency)}`,
      '',
      'Avant la séance : mangez, dormez, pas d\'alcool 24 h avant, apportez une pièce d\'identité.',
      `Annulation ou report gratuit jusqu'à ${artist.cancellation_hours} h avant. Passé ce délai, l'acompte est conservé.`,
    ].join('\n'),
  });
}

// Reminder cadence tuned against no-shows: one far out to let people reschedule while
// it is still free, one right at the cancellation cutoff, one the day before.
export function scheduleAppointmentReminders(artist, request, appointment) {
  const start = new Date(appointment.starts_at).getTime();
  const cutoff = start - artist.cancellation_hours * HOUR;
  const plan = [
    { kind: 'reminder_7d', at: start - 7 * DAY, subject: `Votre séance approche — ${dateFr(appointment.starts_at)}`,
      body: `Rappel : séance chez ${artist.studio_name} le ${dateFr(appointment.starts_at)}. Besoin de décaler ? C'est encore gratuit, répondez à ce message.` },
    { kind: 'reminder_cutoff', at: cutoff - 2 * HOUR, subject: `Dernier moment pour décaler sans frais`,
      body: `Passé ${artist.cancellation_hours} h avant la séance, l'acompte de ${formatMoney(appointment.deposit_cents, artist.currency)} est conservé. Si la date ne tient plus, dites-le maintenant.` },
    { kind: 'reminder_24h', at: start - DAY, subject: `Demain : ${dateFr(appointment.starts_at)}`,
      body: `À demain chez ${artist.studio_name} ! ${dateFr(appointment.starts_at)}. Mangez avant de venir et apportez une pièce d'identité.` },
  ];
  for (const item of plan) {
    if (item.at <= Date.now()) continue; // in the past: pointless noise
    queueMessage({
      artistId: artist.id, requestId: request.id, appointmentId: appointment.id,
      kind: item.kind, recipient: request.client_email, subject: item.subject,
      body: `Bonjour ${request.client_name},\n\n${item.body}`,
      scheduledFor: new Date(item.at).toISOString(),
    });
  }
}

// Healing follow-up: the artist's portfolio depends on healed results, and D+30
// is when clients decide whether to book the next piece.
export function scheduleAftercare(artist, request, appointment) {
  const end = new Date(appointment.ends_at).getTime();
  const plan = [
    { kind: 'aftercare_d1', at: end + DAY, subject: 'Jour 1 : soins de votre tatouage',
      body: 'Retirez le film selon les consignes, lavez à l\'eau tiède et au savon doux, séchez en tamponnant, puis une couche fine de crème. Pas de piscine, pas de soleil direct.' },
    { kind: 'aftercare_d7', at: end + 7 * DAY, subject: 'Jour 7 : ça pèle, c\'est normal',
      body: 'Ne grattez pas les croûtes. Continuez la crème 2 fois par jour. Une zone plus claire à ce stade est normale, la couleur remonte.' },
    { kind: 'aftercare_d30', at: end + 30 * DAY, subject: 'Un mois déjà — on voit le résultat cicatrisé ?',
      body: `Envoyez une photo cicatrisée à ${artist.studio_name} : retouche offerte si besoin, et votre tatouage rejoint le portfolio (avec votre accord). Envie du prochain projet ? {{base_url}}/b/${artist.slug}` },
  ];
  for (const item of plan) {
    queueMessage({
      artistId: artist.id, requestId: request.id, appointmentId: appointment.id,
      kind: item.kind, recipient: request.client_email, subject: item.subject,
      body: `Bonjour ${request.client_name},\n\n${item.body}`,
      scheduledFor: new Date(item.at).toISOString(),
    });
  }
}

export function cancelPendingMessages(appointmentId, kinds = null) {
  const db = getDb();
  if (kinds) {
    const placeholders = kinds.map(() => '?').join(',');
    return db.prepare(
      `DELETE FROM messages WHERE appointment_id = ? AND sent_at IS NULL AND kind IN (${placeholders})`,
    ).run(appointmentId, ...kinds).changes;
  }
  return db.prepare('DELETE FROM messages WHERE appointment_id = ? AND sent_at IS NULL').run(appointmentId).changes;
}

/**
 * Marks every due message as sent and hands it to the transport.
 * The transport is a seam: swap the console logger for Postmark/Brevo/Twilio in one place.
 */
export function dispatchDue(now = nowIso(), transport = defaultTransport) {
  const db = getDb();
  const due = db.prepare(
    'SELECT * FROM messages WHERE sent_at IS NULL AND scheduled_for <= ? ORDER BY scheduled_for LIMIT 200',
  ).all(now);
  const mark = db.prepare('UPDATE messages SET sent_at = ? WHERE id = ?');
  for (const message of due) {
    transport(message);
    mark.run(nowIso(), message.id);
  }
  return due.length;
}

function defaultTransport(message) {
  if (process.env.INKFLOW_QUIET === '1') return;
  const baseUrl = process.env.INKFLOW_BASE_URL || 'http://localhost:3000';
  const body = message.body.replaceAll('{{base_url}}', baseUrl);
  console.log(`[outbox] ${message.channel} → ${message.recipient} | ${message.subject}\n${body}\n`);
}
