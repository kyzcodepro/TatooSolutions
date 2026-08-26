// Outbox: every client-facing notification is queued here first, then dispatched by
// the scheduler. Keeping them in a table (instead of firing an email inline) means
// reminders survive a restart and the artist can see exactly what the client received.

import { getDb, nowIso } from './db.js';
import { formatMoney } from './pricing.js';
import { createTransport, isUndeliverable, configuredProvider } from './mailer.js';
import { formatDateTime, zoneLabel } from './availability.js';

const HOUR = 3600000;
const DAY = 24 * HOUR;

export async function queueMessage({
  artistId, requestId = null, appointmentId = null, kind, recipient, replyTo = null,
  subject, body, scheduledFor = nowIso(), channel = 'email',
}) {
  const db = await getDb();
  const info = await db.run(`
    INSERT INTO messages (artist_id, request_id, appointment_id, kind, channel, recipient,
                          reply_to, subject, body, scheduled_for, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [artistId, requestId, appointmentId, kind, channel, recipient, replyTo, subject, body, scheduledFor, nowIso()]);
  return info.lastInsertRowid;
}

/**
 * The artist's own notifications. The promise of this product is that a studio
 * stops living in its DMs — which only holds if the studio is actually told when
 * something needs it. Everything needed to triage is in the message, so a reply
 * can be written from a phone without opening the dashboard.
 */
export async function queueArtistNewRequest(artist, request, estimateResult) {
  const budgetLine = request.budget_cents
    ? `Budget annoncé : ${formatMoney(request.budget_cents, artist.currency)}`
      + (estimateResult.budget_realistic ? '' : ` — ${formatMoney(estimateResult.budget_gap_cents, artist.currency)} sous votre fourchette basse`)
    : 'Budget non précisé';

  await queueMessage({
    artistId: artist.id,
    requestId: request.id,
    kind: 'artist_new_request',
    recipient: artist.email,
    // Replying reaches the client directly.
    replyTo: request.client_email,
    subject: `Nouvelle demande — ${request.client_name}${estimateResult.budget_realistic ? '' : ' (budget à cadrer)'}`,
    body: [
      `${request.client_name} vient de vous envoyer un projet.`,
      '',
      request.description,
      '',
      `${request.size_cm} cm · ${request.placement || 'zone à définir'} · ${request.color_mode} · ${request.detail_level}`,
      `Estimation : ${formatMoney(estimateResult.low_cents, artist.currency)} – ${formatMoney(estimateResult.high_cents, artist.currency)}`,
      budgetLine,
      request.availability?.length ? `Disponibilités : ${request.availability.join(', ')}` : '',
      '',
      `Répondre : {{base_url}}/app`,
    ].filter(Boolean).join('\n'),
  });
}

export async function queueArtistDepositPaid(artist, request, appointment) {
  await queueMessage({
    artistId: artist.id,
    requestId: request.id,
    appointmentId: appointment.id,
    kind: 'artist_deposit_paid',
    recipient: artist.email,
    replyTo: request.client_email,
    subject: `Acompte reçu — ${request.client_name}, ${dateFr(appointment.starts_at, artist)}`,
    body: [
      `${request.client_name} a versé l'acompte : la date est bloquée.`,
      '',
      `Séance : ${dateFr(appointment.starts_at, artist)}`,
      `Acompte encaissé : ${formatMoney(appointment.deposit_cents, artist.currency)}`,
      `Reste à percevoir le jour J : ${formatMoney(appointment.price_cents - appointment.deposit_cents, artist.currency)}`,
      '',
      `Votre agenda : {{base_url}}/app`,
    ].join('\n'),
  });
}

export async function queueQuoteExpired(artist, request) {
  await queueMessage({
    artistId: artist.id,
    requestId: request.id,
    kind: 'quote_expired_client',
    recipient: request.client_email,
    subject: `Votre devis chez ${artist.studio_name} a expiré`,
    body: [
      `Bonjour ${request.client_name},`,
      '',
      `Le devis de ${formatMoney(request.quote_price_cents, artist.currency)} n'a pas été confirmé dans le délai, `
      + `et le créneau${request.proposed_start ? ` du ${dateFr(request.proposed_start, artist)}` : ''} est de nouveau ouvert.`,
      '',
      `Votre projet vous intéresse toujours ? Renvoyez une demande, c'est deux minutes : {{base_url}}/b/${artist.slug}`,
    ].join('\n'),
  });

  await queueMessage({
    artistId: artist.id,
    requestId: request.id,
    kind: 'artist_quote_expired',
    recipient: artist.email,
    replyTo: request.client_email,
    subject: `Devis expiré sans réponse — ${request.client_name}`,
    body: [
      `Le devis de ${formatMoney(request.quote_price_cents, artist.currency)} envoyé à ${request.client_name} a expiré sans acompte.`,
      request.proposed_start ? `Le créneau du ${dateFr(request.proposed_start, artist)} est libéré.` : '',
      '',
      `Relancer ou refuser : {{base_url}}/app`,
    ].filter(Boolean).join('\n'),
  });
}

// Every date a client reads is the studio's wall clock, never the server's.
const dateFr = (iso, artist) => formatDateTime(iso, artist?.timezone);

// Spelled out wherever the client has to be somewhere at that hour: they may well
// be reading this from another country.
const localZone = (artist) => `heure de ${artist?.city || 'l\'atelier'}, ${zoneLabel(artist?.timezone)}`;

export async function queueRequestReceived(artist, request, estimateResult) {
  await queueMessage({
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

export async function queueQuoteSent(artist, request) {
  await queueMessage({
    artistId: artist.id,
    requestId: request.id,
    kind: 'quote_sent',
    recipient: request.client_email,
    subject: `Votre devis ${artist.studio_name} : ${formatMoney(request.quote_price_cents, artist.currency)}`,
    body: [
      `Bonjour ${request.client_name},`,
      '',
      `Voici votre devis : ${formatMoney(request.quote_price_cents, artist.currency)}`,
      request.proposed_start ? `Créneau proposé : ${dateFr(request.proposed_start, artist)} (${localZone(artist)})` : 'Créneau à définir ensemble.',
      `Acompte pour bloquer la date : ${formatMoney(request.deposit_cents, artist.currency)}`,
      request.artist_note ? `\nNote de l'artiste : ${request.artist_note}` : '',
      '',
      `Confirmer et verser l'acompte : {{base_url}}/q/${request.public_token}`,
      request.quote_expires_at ? `Ce devis expire le ${dateFr(request.quote_expires_at, artist)}.` : '',
    ].filter(Boolean).join('\n'),
  });
}

export async function queueBookingConfirmed(artist, request, appointment) {
  await queueMessage({
    artistId: artist.id,
    requestId: request.id,
    appointmentId: appointment.id,
    kind: 'booking_confirmed',
    recipient: request.client_email,
    subject: `C'est confirmé : ${dateFr(appointment.starts_at, artist)}`,
    body: [
      `Bonjour ${request.client_name},`,
      '',
      `Votre acompte de ${formatMoney(appointment.deposit_cents, artist.currency)} est enregistré, votre séance est bloquée.`,
      `Rendez-vous : ${dateFr(appointment.starts_at, artist)} (${localZone(artist)}) chez ${artist.studio_name}${artist.city ? `, ${artist.city}` : ''}.`,
      `Reste à régler sur place : ${formatMoney(appointment.price_cents - appointment.deposit_cents, artist.currency)}`,
      '',
      'Avant la séance : mangez, dormez, pas d\'alcool 24 h avant, apportez une pièce d\'identité.',
      `Annulation ou report gratuit jusqu'à ${artist.cancellation_hours} h avant. Passé ce délai, l'acompte est conservé.`,
    ].join('\n'),
  });
}

// Reminder cadence tuned against no-shows: one far out to let people reschedule while
// it is still free, one right at the cancellation cutoff, one the day before.
export async function scheduleAppointmentReminders(artist, request, appointment) {
  const start = new Date(appointment.starts_at).getTime();
  const cutoff = start - artist.cancellation_hours * HOUR;
  const plan = [
    { kind: 'reminder_7d', at: start - 7 * DAY, subject: `Votre séance approche — ${dateFr(appointment.starts_at, artist)}`,
      body: `Rappel : séance chez ${artist.studio_name} le ${dateFr(appointment.starts_at, artist)}. Besoin de décaler ? C'est encore gratuit, répondez à ce message.` },
    { kind: 'reminder_cutoff', at: cutoff - 2 * HOUR, subject: `Dernier moment pour décaler sans frais`,
      body: `Passé ${artist.cancellation_hours} h avant la séance, l'acompte de ${formatMoney(appointment.deposit_cents, artist.currency)} est conservé. Si la date ne tient plus, dites-le maintenant.` },
    { kind: 'reminder_24h', at: start - DAY, subject: `Demain : ${dateFr(appointment.starts_at, artist)}`,
      body: `À demain chez ${artist.studio_name} ! ${dateFr(appointment.starts_at, artist)}. Mangez avant de venir et apportez une pièce d'identité.` },
  ];
  for (const item of plan) {
    if (item.at <= Date.now()) continue; // in the past: pointless noise
    await queueMessage({
      artistId: artist.id, requestId: request.id, appointmentId: appointment.id,
      kind: item.kind, recipient: request.client_email, subject: item.subject,
      body: `Bonjour ${request.client_name},\n\n${item.body}`,
      scheduledFor: new Date(item.at).toISOString(),
    });
  }
}

// Healing follow-up: the artist's portfolio depends on healed results, and D+30
// is when clients decide whether to book the next piece.
export async function scheduleAftercare(artist, request, appointment) {
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
    await queueMessage({
      artistId: artist.id, requestId: request.id, appointmentId: appointment.id,
      kind: item.kind, recipient: request.client_email, subject: item.subject,
      body: `Bonjour ${request.client_name},\n\n${item.body}`,
      scheduledFor: new Date(item.at).toISOString(),
    });
  }
}

export async function cancelPendingMessages(appointmentId, kinds = null) {
  const db = await getDb();
  if (kinds) {
    const placeholders = kinds.map(() => '?').join(',');
    const info = await db.run(
      `DELETE FROM messages WHERE appointment_id = ? AND sent_at IS NULL AND kind IN (${placeholders})`,
      [appointmentId, ...kinds],
    );
    return info.changes;
  }
  const info = await db.run('DELETE FROM messages WHERE appointment_id = ? AND sent_at IS NULL', [appointmentId]);
  return info.changes;
}

/** Enough retries to ride out a provider hiccup, few enough to stop chasing a dead address. */
export const MAX_SEND_ATTEMPTS = 5;

/**
 * Hands every due message to the transport and records what happened.
 *
 * A message is marked sent only once the transport accepted it. A failure is
 * counted and kept for the next pass — recording a delivery that did not happen
 * would silently drop the reminder that stops a no-show.
 */
export async function dispatchDue(now = nowIso(), transport = null) {
  const db = await getDb();
  const send = transport ?? createTransport();
  const due = await db.all(`
    SELECT m.*, a.email AS artist_email, a.studio_name
    FROM messages m JOIN artists a ON a.id = m.artist_id
    WHERE m.sent_at IS NULL AND m.attempts < ? AND m.scheduled_for <= ?
    ORDER BY m.scheduled_for LIMIT 200
  `, [MAX_SEND_ATTEMPTS, now]);

  // Reserved demo addresses matter only once a real provider is wired: bounces
  // cost a young sending domain its reputation. In console mode they are exactly
  // what local work and the demo want to see logged.
  const sendingForReal = configuredProvider() !== 'console';

  let sent = 0;
  for (const message of due) {
    if (sendingForReal && isUndeliverable(message.recipient)) {
      await db.run('UPDATE messages SET attempts = ?, last_error = ? WHERE id = ?',
        [MAX_SEND_ATTEMPTS, 'Adresse de démonstration (domaine réservé) — aucun envoi tenté', message.id]);
      continue;
    }
    try {
      await send(message);
      await db.run('UPDATE messages SET sent_at = ?, attempts = attempts + 1, last_error = NULL WHERE id = ?',
        [nowIso(), message.id]);
      sent += 1;
    } catch (err) {
      const reason = String(err?.message ?? err).slice(0, 300);
      await db.run('UPDATE messages SET attempts = attempts + 1, last_error = ? WHERE id = ?',
        [reason, message.id]);
      console.error(`[outbox] ${message.kind} → ${message.recipient} failed: ${reason}`);
    }
  }
  return sent;
}
