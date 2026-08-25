// Domain logic. Routes stay thin: they parse input and call in here.

import { randomBytes } from 'node:crypto';
import { getDb, nowIso } from './db.js';
import { HttpError, bad, conflict, notFound } from './http.js';
import { estimate, suggestDeposit, MAX_SESSION_HOURS } from './pricing.js';
import { createDepositIntent, confirmDeposit } from './payments.js';
import {
  queueRequestReceived, queueQuoteSent, queueBookingConfirmed,
  scheduleAppointmentReminders, scheduleAftercare, cancelPendingMessages, queueMessage,
} from './messages.js';

export const REQUEST_STATUSES = ['new', 'quoted', 'booked', 'completed', 'declined', 'expired'];
const OPEN_STATUSES = ['new', 'quoted'];

export function hydrateRequest(row, artist = null) {
  if (!row) return null;
  const out = {
    ...row,
    reference_urls: JSON.parse(row.reference_urls || '[]'),
    availability: JSON.parse(row.availability || '[]'),
    cover_up: !!row.cover_up,
    is_adult: !!row.is_adult,
  };
  if (artist) out.currency = artist.currency;
  return out;
}

export function getArtistBySlug(slug) {
  return getDb().prepare('SELECT * FROM artists WHERE slug = ?').get(slug) ?? null;
}

export function getArtist(id) {
  return getDb().prepare('SELECT * FROM artists WHERE id = ?').get(id) ?? null;
}

/* ------------------------------------------------------------------ requests */

export function createRequest(artist, brief) {
  if (!artist.accepting_requests) {
    throw conflict('This artist is not taking new projects right now');
  }
  if (!brief.is_adult) {
    throw bad('Tattoo bookings require the client to confirm they are 18 or older');
  }
  const db = getDb();
  const result = estimate(brief, artist);
  const token = randomBytes(16).toString('hex');
  const now = nowIso();

  const info = db.prepare(`
    INSERT INTO requests (
      artist_id, public_token, client_name, client_email, client_phone, description,
      style, placement, size_cm, color_mode, detail_level, cover_up, budget_cents,
      reference_urls, availability, is_adult, status, estimated_hours,
      estimate_low_cents, estimate_high_cents, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?, ?, ?, ?, ?)
  `).run(
    artist.id, token, brief.client_name, brief.client_email, brief.client_phone ?? '',
    brief.description, brief.style ?? '', brief.placement ?? '', brief.size_cm,
    brief.color_mode, brief.detail_level, brief.cover_up ? 1 : 0, brief.budget_cents ?? null,
    JSON.stringify(brief.reference_urls ?? []), JSON.stringify(brief.availability ?? []),
    1, result.hours, result.low_cents, result.high_cents, now, now,
  );

  const request = db.prepare('SELECT * FROM requests WHERE id = ?').get(Number(info.lastInsertRowid));
  queueRequestReceived(artist, request, result);
  return { request: hydrateRequest(request, artist), estimate: result };
}

export function listRequests(artistId, { status = null, limit = 100 } = {}) {
  const db = getDb();
  const rows = status
    ? db.prepare('SELECT * FROM requests WHERE artist_id = ? AND status = ? ORDER BY created_at DESC LIMIT ?')
      .all(artistId, status, limit)
    : db.prepare('SELECT * FROM requests WHERE artist_id = ? ORDER BY created_at DESC LIMIT ?')
      .all(artistId, limit);
  return rows.map((row) => hydrateRequest(row));
}

export function getRequestOwned(artistId, requestId) {
  const row = getDb().prepare('SELECT * FROM requests WHERE id = ? AND artist_id = ?').get(requestId, artistId);
  if (!row) throw notFound('Request not found');
  return row;
}

export function getRequestByToken(token) {
  const row = getDb().prepare('SELECT * FROM requests WHERE public_token = ?').get(token);
  if (!row) throw notFound('Request not found');
  return row;
}

export function sendQuote(artist, requestId, {
  price_cents, deposit_cents, proposed_start, duration_hours, note = '', expires_in_days = 7,
}) {
  const db = getDb();
  const request = getRequestOwned(artist.id, requestId);
  if (!OPEN_STATUSES.includes(request.status)) {
    throw conflict(`A quote can only be sent on a new or quoted request (this one is "${request.status}")`);
  }

  const hours = duration_hours ?? request.estimated_hours ?? 1;
  const deposit = deposit_cents ?? suggestDeposit(price_cents, artist.deposit_percent);
  if (deposit > price_cents) throw bad('Deposit cannot exceed the quoted price');

  let start = null;
  let end = null;
  if (proposed_start) {
    // Long pieces run over several sessions; the slot booked now is the first one.
    start = proposed_start;
    end = new Date(new Date(start).getTime() + Math.min(hours, MAX_SESSION_HOURS) * 3600000).toISOString();
    assertSlotFree(artist.id, start, end);
  }

  const expiresAt = new Date(Date.now() + expires_in_days * 86400000).toISOString();
  db.prepare(`
    UPDATE requests SET status = 'quoted', quote_price_cents = ?, deposit_cents = ?,
      proposed_start = ?, proposed_end = ?, artist_note = ?, quote_expires_at = ?, updated_at = ?
    WHERE id = ?
  `).run(price_cents, deposit, start, end, note, expiresAt, nowIso(), request.id);

  const updated = db.prepare('SELECT * FROM requests WHERE id = ?').get(request.id);
  queueQuoteSent(artist, updated);
  return hydrateRequest(updated, artist);
}

export function declineRequest(artist, requestId, reason = '') {
  const db = getDb();
  const request = getRequestOwned(artist.id, requestId);
  if (request.status === 'booked') throw conflict('Cancel the appointment before declining the request');
  db.prepare("UPDATE requests SET status = 'declined', decline_reason = ?, updated_at = ? WHERE id = ?")
    .run(reason, nowIso(), request.id);
  queueMessage({
    artistId: artist.id,
    requestId: request.id,
    kind: 'request_declined',
    recipient: request.client_email,
    subject: `Votre projet chez ${artist.studio_name}`,
    body: `Bonjour ${request.client_name},\n\nMerci pour votre demande. ${artist.studio_name} ne peut pas prendre ce projet.${reason ? `\nRaison : ${reason}` : ''}\n\nBonne recherche pour votre tatouage !`,
  });
  return hydrateRequest(db.prepare('SELECT * FROM requests WHERE id = ?').get(request.id), artist);
}

/* --------------------------------------------------------- client-side quote */

export function quoteView(token) {
  const request = getRequestByToken(token);
  const artist = getArtist(request.artist_id);
  const appointment = getDb()
    .prepare("SELECT * FROM appointments WHERE request_id = ? AND status != 'cancelled' ORDER BY id DESC")
    .get(request.id) ?? null;
  return {
    artist: {
      studio_name: artist.studio_name, city: artist.city, slug: artist.slug,
      currency: artist.currency, cancellation_hours: artist.cancellation_hours,
    },
    request: {
      status: request.status,
      client_name: request.client_name,
      description: request.description,
      style: request.style,
      placement: request.placement,
      size_cm: request.size_cm,
      estimated_hours: request.estimated_hours,
      estimate_low_cents: request.estimate_low_cents,
      estimate_high_cents: request.estimate_high_cents,
      quote_price_cents: request.quote_price_cents,
      deposit_cents: request.deposit_cents,
      proposed_start: request.proposed_start,
      proposed_end: request.proposed_end,
      artist_note: request.artist_note,
      quote_expires_at: request.quote_expires_at,
      deposit_paid_at: request.deposit_paid_at,
    },
    appointment,
  };
}

/** Client accepts the quote and pays the deposit — the moment the slot becomes real. */
export function acceptQuote(token) {
  const db = getDb();
  const request = getRequestByToken(token);
  const artist = getArtist(request.artist_id);

  if (request.status === 'booked') throw conflict('This appointment is already confirmed');
  if (request.status !== 'quoted') throw conflict('This request has no quote waiting for you');
  if (request.quote_expires_at && request.quote_expires_at <= nowIso()) {
    db.prepare("UPDATE requests SET status = 'expired', updated_at = ? WHERE id = ?").run(nowIso(), request.id);
    throw conflict('This quote has expired — ask the artist for a new one');
  }
  if (!request.proposed_start) throw conflict('The artist has not proposed a date yet');
  assertSlotFree(artist.id, request.proposed_start, request.proposed_end);

  const intent = createDepositIntent({
    amountCents: request.deposit_cents,
    currency: artist.currency,
    reference: `request-${request.id}`,
    clientEmail: request.client_email,
  });
  const payment = confirmDeposit(intent);
  if (payment.status !== 'succeeded') throw new HttpError(402, 'Deposit payment failed');

  const now = nowIso();
  const info = db.prepare(`
    INSERT INTO appointments (artist_id, request_id, starts_at, ends_at, price_cents, deposit_cents, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'scheduled', ?, ?)
  `).run(artist.id, request.id, request.proposed_start, request.proposed_end,
    request.quote_price_cents, request.deposit_cents, now, now);

  db.prepare("UPDATE requests SET status = 'booked', deposit_paid_at = ?, updated_at = ? WHERE id = ?")
    .run(now, now, request.id);

  const appointment = db.prepare('SELECT * FROM appointments WHERE id = ?').get(Number(info.lastInsertRowid));
  const updatedRequest = db.prepare('SELECT * FROM requests WHERE id = ?').get(request.id);
  queueBookingConfirmed(artist, updatedRequest, appointment);
  scheduleAppointmentReminders(artist, updatedRequest, appointment);
  return { appointment, payment: { intent_id: payment.intent_id, amount_cents: payment.amount_cents } };
}

/* -------------------------------------------------------------- appointments */

export function assertSlotFree(artistId, startsAt, endsAt, ignoreAppointmentId = null) {
  const db = getDb();
  const clash = db.prepare(`
    SELECT id FROM appointments
    WHERE artist_id = ? AND status = 'scheduled' AND id != ? AND starts_at < ? AND ends_at > ?
  `).get(artistId, ignoreAppointmentId ?? -1, endsAt, startsAt);
  if (clash) throw conflict('That slot overlaps another appointment');

  const blocked = db.prepare(`
    SELECT id, label FROM blocks WHERE artist_id = ? AND starts_at < ? AND ends_at > ?
  `).get(artistId, endsAt, startsAt);
  if (blocked) throw conflict(`That slot falls inside a blocked period (${blocked.label})`);
}

export function listAppointments(artistId, { from = null, to = null, status = null } = {}) {
  const db = getDb();
  const clauses = ['a.artist_id = ?'];
  const params = [artistId];
  if (from) { clauses.push('a.ends_at >= ?'); params.push(from); }
  if (to) { clauses.push('a.starts_at <= ?'); params.push(to); }
  if (status) { clauses.push('a.status = ?'); params.push(status); }
  return db.prepare(`
    SELECT a.*, r.client_name, r.client_email, r.client_phone, r.description, r.placement,
           r.style, r.public_token
    FROM appointments a JOIN requests r ON r.id = a.request_id
    WHERE ${clauses.join(' AND ')} ORDER BY a.starts_at ASC
  `).all(...params);
}

function getAppointmentOwned(artistId, appointmentId) {
  const row = getDb().prepare('SELECT * FROM appointments WHERE id = ? AND artist_id = ?')
    .get(appointmentId, artistId);
  if (!row) throw notFound('Appointment not found');
  return row;
}

export function completeAppointment(artist, appointmentId) {
  const db = getDb();
  const appointment = getAppointmentOwned(artist.id, appointmentId);
  if (appointment.status !== 'scheduled') throw conflict(`Appointment is already "${appointment.status}"`);
  db.prepare("UPDATE appointments SET status = 'completed', updated_at = ? WHERE id = ?")
    .run(nowIso(), appointment.id);
  db.prepare("UPDATE requests SET status = 'completed', updated_at = ? WHERE id = ?")
    .run(nowIso(), appointment.request_id);
  cancelPendingMessages(appointment.id, ['reminder_7d', 'reminder_cutoff', 'reminder_24h']);
  const request = db.prepare('SELECT * FROM requests WHERE id = ?').get(appointment.request_id);
  scheduleAftercare(artist, request, appointment);
  return db.prepare('SELECT * FROM appointments WHERE id = ?').get(appointment.id);
}

export function markNoShow(artist, appointmentId) {
  const db = getDb();
  const appointment = getAppointmentOwned(artist.id, appointmentId);
  if (appointment.status !== 'scheduled') throw conflict(`Appointment is already "${appointment.status}"`);
  db.prepare("UPDATE appointments SET status = 'no_show', updated_at = ? WHERE id = ?")
    .run(nowIso(), appointment.id);
  cancelPendingMessages(appointment.id);
  const request = db.prepare('SELECT * FROM requests WHERE id = ?').get(appointment.request_id);
  queueMessage({
    artistId: artist.id, requestId: request.id, appointmentId: appointment.id,
    kind: 'no_show', recipient: request.client_email,
    subject: 'Séance manquée',
    body: `Bonjour ${request.client_name},\n\nVous n'êtes pas venu(e) à la séance du ${new Date(appointment.starts_at).toLocaleString('fr-FR')}. L'acompte est conservé, comme prévu dans les conditions. Pour reprendre rendez-vous : {{base_url}}/b/${artist.slug}`,
  });
  return db.prepare('SELECT * FROM appointments WHERE id = ?').get(appointment.id);
}

export function rescheduleAppointment(artist, appointmentId, startsAt, durationHours = null) {
  const db = getDb();
  const appointment = getAppointmentOwned(artist.id, appointmentId);
  if (appointment.status !== 'scheduled') throw conflict('Only a scheduled appointment can be moved');
  const hours = durationHours
    ?? (new Date(appointment.ends_at) - new Date(appointment.starts_at)) / 3600000;
  const endsAt = new Date(new Date(startsAt).getTime() + hours * 3600000).toISOString();
  assertSlotFree(artist.id, startsAt, endsAt, appointment.id);

  db.prepare('UPDATE appointments SET starts_at = ?, ends_at = ?, updated_at = ? WHERE id = ?')
    .run(startsAt, endsAt, nowIso(), appointment.id);
  db.prepare('UPDATE requests SET proposed_start = ?, proposed_end = ?, updated_at = ? WHERE id = ?')
    .run(startsAt, endsAt, nowIso(), appointment.request_id);

  cancelPendingMessages(appointment.id, ['reminder_7d', 'reminder_cutoff', 'reminder_24h']);
  const updated = db.prepare('SELECT * FROM appointments WHERE id = ?').get(appointment.id);
  const request = db.prepare('SELECT * FROM requests WHERE id = ?').get(appointment.request_id);
  scheduleAppointmentReminders(artist, request, updated);
  queueMessage({
    artistId: artist.id, requestId: request.id, appointmentId: updated.id,
    kind: 'rescheduled', recipient: request.client_email,
    subject: 'Votre séance a été déplacée',
    body: `Bonjour ${request.client_name},\n\nNouvelle date : ${new Date(updated.starts_at).toLocaleString('fr-FR')}. Votre acompte reste acquis à cette séance.`,
  });
  return updated;
}

export function cancelAppointment(artist, appointmentId, { refundDeposit = false, reason = '' } = {}) {
  const db = getDb();
  const appointment = getAppointmentOwned(artist.id, appointmentId);
  if (appointment.status !== 'scheduled') throw conflict('Only a scheduled appointment can be cancelled');
  db.prepare("UPDATE appointments SET status = 'cancelled', updated_at = ? WHERE id = ?")
    .run(nowIso(), appointment.id);
  db.prepare("UPDATE requests SET status = 'declined', decline_reason = ?, updated_at = ? WHERE id = ?")
    .run(reason || 'Séance annulée', nowIso(), appointment.request_id);
  cancelPendingMessages(appointment.id);
  const request = db.prepare('SELECT * FROM requests WHERE id = ?').get(appointment.request_id);
  queueMessage({
    artistId: artist.id, requestId: request.id, appointmentId: appointment.id,
    kind: 'cancelled', recipient: request.client_email,
    subject: 'Votre séance a été annulée',
    body: `Bonjour ${request.client_name},\n\nLa séance du ${new Date(appointment.starts_at).toLocaleString('fr-FR')} est annulée.${reason ? `\nRaison : ${reason}` : ''}\n${refundDeposit ? 'Votre acompte vous est remboursé.' : 'Votre acompte reste acquis au studio.'}`,
  });
  return db.prepare('SELECT * FROM appointments WHERE id = ?').get(appointment.id);
}

/* --------------------------------------------------------------- time blocks */

export function createBlock(artist, startsAt, endsAt, label) {
  if (endsAt <= startsAt) throw bad('The block must end after it starts');
  const clash = getDb().prepare(`
    SELECT id FROM appointments WHERE artist_id = ? AND status = 'scheduled' AND starts_at < ? AND ends_at > ?
  `).get(artist.id, endsAt, startsAt);
  if (clash) throw conflict('An appointment already sits in that period');
  const info = getDb().prepare('INSERT INTO blocks (artist_id, starts_at, ends_at, label, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(artist.id, startsAt, endsAt, label, nowIso());
  return getDb().prepare('SELECT * FROM blocks WHERE id = ?').get(Number(info.lastInsertRowid));
}

export function listBlocks(artistId) {
  return getDb().prepare('SELECT * FROM blocks WHERE artist_id = ? ORDER BY starts_at').all(artistId);
}

export function deleteBlock(artist, blockId) {
  const changes = getDb().prepare('DELETE FROM blocks WHERE id = ? AND artist_id = ?').run(blockId, artist.id).changes;
  if (!changes) throw notFound('Block not found');
  return { deleted: true };
}

/* --------------------------------------------------------------------- stats */

export function stats(artistId, { days = 90 } = {}) {
  const db = getDb();
  const since = new Date(Date.now() - days * 86400000).toISOString();

  const funnel = db.prepare(`
    SELECT status, COUNT(*) AS count FROM requests WHERE artist_id = ? AND created_at >= ? GROUP BY status
  `).all(artistId, since);
  const byStatus = Object.fromEntries(funnel.map((row) => [row.status, row.count]));
  const totalRequests = funnel.reduce((sum, row) => sum + row.count, 0);

  const appts = db.prepare(`
    SELECT status, COUNT(*) AS count, COALESCE(SUM(price_cents), 0) AS revenue,
           COALESCE(SUM(deposit_cents), 0) AS deposits
    FROM appointments WHERE artist_id = ? AND starts_at >= ? GROUP BY status
  `).all(artistId, since);
  const apptByStatus = Object.fromEntries(appts.map((row) => [row.status, row]));
  const count = (s) => apptByStatus[s]?.count ?? 0;
  const finished = count('completed') + count('no_show');

  const upcoming = db.prepare(`
    SELECT COUNT(*) AS count, COALESCE(SUM(price_cents), 0) AS revenue,
           COALESCE(SUM(deposit_cents), 0) AS deposits,
           COALESCE(SUM((julianday(ends_at) - julianday(starts_at)) * 24), 0) AS hours
    FROM appointments WHERE artist_id = ? AND status = 'scheduled' AND starts_at >= ?
  `).get(artistId, nowIso());

  const noShowRate = finished ? count('no_show') / finished : 0;
  const bookedRequests = (byStatus.booked ?? 0) + (byStatus.completed ?? 0);

  return {
    window_days: days,
    requests: { total: totalRequests, by_status: byStatus },
    conversion_rate: totalRequests ? bookedRequests / totalRequests : 0,
    no_show_rate: noShowRate,
    no_shows: count('no_show'),
    completed: count('completed'),
    revenue_completed_cents: apptByStatus.completed?.revenue ?? 0,
    deposits_kept_cents: apptByStatus.no_show?.deposits ?? 0,
    upcoming: {
      count: upcoming.count,
      revenue_cents: upcoming.revenue,
      deposits_held_cents: upcoming.deposits,
      hours: Math.round((upcoming.hours ?? 0) * 10) / 10,
    },
    pending_replies: (byStatus.new ?? 0),
  };
}
