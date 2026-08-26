// Domain logic. Routes stay thin: they parse input and call in here.
// Every function that touches storage is async — the Turso backend is a network
// call, and pretending otherwise would only hide it from the caller.

import { randomBytes } from 'node:crypto';
import { getDb, nowIso } from './db.js';
import { HttpError, bad, conflict, notFound } from './http.js';
import { estimate, suggestDeposit, MAX_SESSION_HOURS } from './pricing.js';
import {
  availableSlots, parseWorkingHours, withinWorkingHours, DEFAULT_TIMEZONE,
  formatDateTime, zoneLabel,
} from './availability.js';
import { startDeposit, paymentsProvider } from './payments.js';
import {
  queueRequestReceived, queueQuoteSent, queueBookingConfirmed, queueArtistNewRequest,
  queueArtistDepositPaid, queueQuoteExpired, scheduleAppointmentReminders, scheduleAftercare,
  cancelPendingMessages, queueMessage,
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

export async function getArtistBySlug(slug) {
  const db = await getDb();
  return db.get('SELECT * FROM artists WHERE slug = ?', [slug]);
}

export async function getArtist(id) {
  const db = await getDb();
  return db.get('SELECT * FROM artists WHERE id = ?', [id]);
}

/* ------------------------------------------------------------------ requests */

export async function createRequest(artist, brief) {
  if (!artist.accepting_requests) {
    throw conflict('This artist is not taking new projects right now');
  }
  if (!brief.is_adult) {
    throw bad('Tattoo bookings require the client to confirm they are 18 or older');
  }
  const db = await getDb();
  const result = estimate(brief, artist);
  const token = randomBytes(16).toString('hex');
  const now = nowIso();

  const info = await db.run(`
    INSERT INTO requests (
      artist_id, public_token, client_name, client_email, client_phone, description,
      style, placement, size_cm, color_mode, detail_level, cover_up, budget_cents,
      reference_urls, availability, is_adult, status, estimated_hours,
      estimate_low_cents, estimate_high_cents, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?, ?, ?, ?, ?)
  `, [
    artist.id, token, brief.client_name, brief.client_email, brief.client_phone ?? '',
    brief.description, brief.style ?? '', brief.placement ?? '', brief.size_cm,
    brief.color_mode, brief.detail_level, brief.cover_up ? 1 : 0, brief.budget_cents ?? null,
    JSON.stringify(brief.reference_urls ?? []), JSON.stringify(brief.availability ?? []),
    1, result.hours, result.low_cents, result.high_cents, now, now,
  ]);

  const request = await db.get('SELECT * FROM requests WHERE id = ?', [info.lastInsertRowid]);
  const hydrated = hydrateRequest(request, artist);
  await queueRequestReceived(artist, request, result);
  await queueArtistNewRequest(artist, hydrated, result);
  return { request: hydrated, estimate: result };
}

export async function listRequests(artistId, { status = null, limit = 100 } = {}) {
  const db = await getDb();
  const rows = status
    ? await db.all('SELECT * FROM requests WHERE artist_id = ? AND status = ? ORDER BY created_at DESC LIMIT ?',
      [artistId, status, limit])
    : await db.all('SELECT * FROM requests WHERE artist_id = ? ORDER BY created_at DESC LIMIT ?',
      [artistId, limit]);
  return rows.map((row) => hydrateRequest(row));
}

export async function getRequestOwned(artistId, requestId) {
  const db = await getDb();
  const row = await db.get('SELECT * FROM requests WHERE id = ? AND artist_id = ?', [requestId, artistId]);
  if (!row) throw notFound('Request not found');
  return row;
}

export async function getRequestByToken(token) {
  const db = await getDb();
  const row = await db.get('SELECT * FROM requests WHERE public_token = ?', [token]);
  if (!row) throw notFound('Request not found');
  return row;
}

export async function sendQuote(artist, requestId, {
  price_cents, deposit_cents, proposed_start, duration_hours, note = '', expires_in_days = 7,
  outside_hours = false,
}) {
  const db = await getDb();
  const request = await getRequestOwned(artist.id, requestId);
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
    await assertSlotFree(artist.id, start, end);
    // Opening hours protect by default; an artist making a deliberate exception
    // says so rather than being refused.
    if (!outside_hours && !withinWorkingHours(start, end, studioHours(artist))) {
      throw conflict('That slot falls outside your opening hours — confirm the exception to send it anyway');
    }
  }

  const expiresAt = new Date(Date.now() + expires_in_days * 86400000).toISOString();
  await db.run(`
    UPDATE requests SET status = 'quoted', quote_price_cents = ?, deposit_cents = ?,
      proposed_start = ?, proposed_end = ?, artist_note = ?, quote_expires_at = ?, updated_at = ?
    WHERE id = ?
  `, [price_cents, deposit, start, end, note, expiresAt, nowIso(), request.id]);

  const updated = await db.get('SELECT * FROM requests WHERE id = ?', [request.id]);
  await queueQuoteSent(artist, updated);
  return hydrateRequest(updated, artist);
}

export async function declineRequest(artist, requestId, reason = '') {
  const db = await getDb();
  const request = await getRequestOwned(artist.id, requestId);
  if (request.status === 'booked') throw conflict('Cancel the appointment before declining the request');
  await db.run("UPDATE requests SET status = 'declined', decline_reason = ?, updated_at = ? WHERE id = ?",
    [reason, nowIso(), request.id]);
  await queueMessage({
    artistId: artist.id,
    requestId: request.id,
    kind: 'request_declined',
    recipient: request.client_email,
    subject: `Votre projet chez ${artist.studio_name}`,
    body: `Bonjour ${request.client_name},\n\nMerci pour votre demande. ${artist.studio_name} ne peut pas prendre ce projet.${reason ? `\nRaison : ${reason}` : ''}\n\nBonne recherche pour votre tatouage !`,
  });
  return hydrateRequest(await db.get('SELECT * FROM requests WHERE id = ?', [request.id]), artist);
}

/* --------------------------------------------------------- client-side quote */

export async function quoteView(token) {
  const db = await getDb();
  const request = await getRequestByToken(token);
  const artist = await getArtist(request.artist_id);
  const appointment = await db.get(
    "SELECT * FROM appointments WHERE request_id = ? AND status != 'cancelled' ORDER BY id DESC",
    [request.id],
  );
  return {
    artist: {
      studio_name: artist.studio_name, city: artist.city, slug: artist.slug,
      currency: artist.currency, cancellation_hours: artist.cancellation_hours,
      timezone: artist.timezone || DEFAULT_TIMEZONE,
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

/**
 * The client accepts the quote. With a real payment provider this only opens a
 * checkout: the slot is still free afterwards, and stays free until the provider
 * says the money moved. Booking on the browser's return would let anyone claim a
 * date by forging a URL.
 */
export async function acceptQuote(token, { baseUrl = '', fetchImpl } = {}) {
  const db = await getDb();
  const request = await getRequestByToken(token);
  const artist = await getArtist(request.artist_id);

  if (request.status === 'booked') throw conflict('This appointment is already confirmed');
  if (request.status !== 'quoted') throw conflict('This request has no quote waiting for you');
  if (request.quote_expires_at && request.quote_expires_at <= nowIso()) {
    await db.run("UPDATE requests SET status = 'expired', updated_at = ? WHERE id = ?", [nowIso(), request.id]);
    throw conflict('This quote has expired — ask the artist for a new one');
  }
  if (!request.proposed_start) throw conflict('The artist has not proposed a date yet');
  await assertSlotFree(artist.id, request.proposed_start, request.proposed_end);

  const payment = await startDeposit({ request, artist, baseUrl, fetchImpl });
  await db.run('UPDATE requests SET payment_ref = ?, payment_provider = ?, updated_at = ? WHERE id = ?',
    [payment.reference, payment.provider, nowIso(), request.id]);

  if (!payment.settled) {
    // Off to the provider's page. Nothing is booked yet, on purpose.
    return { redirect_url: payment.redirect_url, provider: payment.provider };
  }

  const booked = await bookPaidRequest({ request, artist, reference: payment.reference });
  return { appointment: booked.appointment, payment: { intent_id: payment.reference, amount_cents: payment.amount_cents } };
}

/**
 * The provider confirmed the deposit. This is the only path that turns a quote
 * into a booking, and it must tolerate being called twice: providers replay a
 * webhook they did not see acknowledged.
 */
export async function confirmDepositPaid({ token, reference, amountCents }) {
  const db = await getDb();
  const request = await getRequestByToken(token);
  const artist = await getArtist(request.artist_id);

  const existing = await db.get(
    "SELECT * FROM appointments WHERE request_id = ? AND status != 'cancelled' ORDER BY id DESC",
    [request.id],
  );
  if (existing) return { appointment: existing, already: true };

  if (Number.isFinite(amountCents) && amountCents !== request.deposit_cents) {
    throw bad(`Deposit amount mismatch: expected ${request.deposit_cents}, received ${amountCents}`);
  }

  // The money arrived, so the client is owed an answer either way — but a slot
  // taken in the meantime must never be double-booked.
  try {
    await assertSlotFree(artist.id, request.proposed_start, request.proposed_end);
  } catch {
    await db.run('UPDATE requests SET payment_ref = ?, updated_at = ? WHERE id = ?',
      [reference, nowIso(), request.id]);
    await queueMessage({
      artistId: artist.id, requestId: request.id, kind: 'deposit_slot_taken',
      recipient: artist.email,
      subject: `Acompte reçu mais créneau déjà pris — ${request.client_name}`,
      body: `L'acompte de ${request.deposit_cents / 100} € a été encaissé (${reference}) alors que le créneau du ${request.proposed_start} venait d'être réservé.\n\nProposez une autre date à ${request.client_name} (${request.client_email}) ou remboursez l'acompte.`,
    });
    await queueMessage({
      artistId: artist.id, requestId: request.id, kind: 'deposit_slot_taken_client',
      recipient: request.client_email,
      subject: `Votre acompte est bien reçu — nous revenons vers vous pour la date`,
      body: `Bonjour ${request.client_name},\n\nVotre acompte est bien enregistré, mais le créneau proposé vient d'être pris. ${artist.studio_name} vous recontacte très vite pour convenir d'une autre date — ou vous rembourse si aucune ne convient.`,
    });
    return { conflict: true };
  }

  return bookPaidRequest({ request, artist, reference });
}

async function bookPaidRequest({ request, artist, reference }) {
  const db = await getDb();
  const now = nowIso();
  const info = await db.run(`
    INSERT INTO appointments (artist_id, request_id, starts_at, ends_at, price_cents, deposit_cents, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'scheduled', ?, ?)
  `, [artist.id, request.id, request.proposed_start, request.proposed_end,
    request.quote_price_cents, request.deposit_cents, now, now]);

  await db.run("UPDATE requests SET status = 'booked', deposit_paid_at = ?, payment_ref = ?, updated_at = ? WHERE id = ?",
    [now, reference, now, request.id]);

  const appointment = await db.get('SELECT * FROM appointments WHERE id = ?', [info.lastInsertRowid]);
  const updatedRequest = await db.get('SELECT * FROM requests WHERE id = ?', [request.id]);
  await queueBookingConfirmed(artist, updatedRequest, appointment);
  await queueArtistDepositPaid(artist, updatedRequest, appointment);
  await scheduleAppointmentReminders(artist, updatedRequest, appointment);
  return { appointment, already: false };
}

/* ------------------------------------------------------------- availability */

const studioHours = (artist) => ({
  workingHours: parseWorkingHours(artist.working_hours),
  timeZone: artist.timezone || DEFAULT_TIMEZONE,
  leadHours: artist.lead_hours ?? 48,
});

/** Everything already spoken for: booked sessions and closed periods. */
async function busyPeriods(artistId) {
  const db = await getDb();
  const appointments = await db.all(
    "SELECT starts_at, ends_at FROM appointments WHERE artist_id = ? AND status = 'scheduled'",
    [artistId],
  );
  const blocks = await db.all('SELECT starts_at, ends_at FROM blocks WHERE artist_id = ?', [artistId]);
  return [...appointments, ...blocks];
}

/**
 * The next slots a piece of this length fits into. Proposing a date used to mean
 * typing one blind and finding out afterwards whether it clashed.
 */
export async function nextSlots(artist, { durationHours = 2, days = 28, limit = 12, from } = {}) {
  return availableSlots(studioHours(artist), {
    durationHours, days, limit, from, busy: await busyPeriods(artist.id),
  });
}

/* -------------------------------------------------------------- appointments */

export async function assertSlotFree(artistId, startsAt, endsAt, ignoreAppointmentId = null) {
  const db = await getDb();
  const clash = await db.get(`
    SELECT id FROM appointments
    WHERE artist_id = ? AND status = 'scheduled' AND id != ? AND starts_at < ? AND ends_at > ?
  `, [artistId, ignoreAppointmentId ?? -1, endsAt, startsAt]);
  if (clash) throw conflict('That slot overlaps another appointment');

  const blocked = await db.get(
    'SELECT id, label FROM blocks WHERE artist_id = ? AND starts_at < ? AND ends_at > ?',
    [artistId, endsAt, startsAt],
  );
  if (blocked) throw conflict(`That slot falls inside a blocked period (${blocked.label})`);
}

export async function listAppointments(artistId, { from = null, to = null, status = null } = {}) {
  const db = await getDb();
  const clauses = ['a.artist_id = ?'];
  const params = [artistId];
  if (from) { clauses.push('a.ends_at >= ?'); params.push(from); }
  if (to) { clauses.push('a.starts_at <= ?'); params.push(to); }
  if (status) { clauses.push('a.status = ?'); params.push(status); }
  return db.all(`
    SELECT a.*, r.client_name, r.client_email, r.client_phone, r.description, r.placement,
           r.style, r.public_token
    FROM appointments a JOIN requests r ON r.id = a.request_id
    WHERE ${clauses.join(' AND ')} ORDER BY a.starts_at ASC
  `, params);
}

async function getAppointmentOwned(artistId, appointmentId) {
  const db = await getDb();
  const row = await db.get('SELECT * FROM appointments WHERE id = ? AND artist_id = ?', [appointmentId, artistId]);
  if (!row) throw notFound('Appointment not found');
  return row;
}

export async function completeAppointment(artist, appointmentId) {
  const db = await getDb();
  const appointment = await getAppointmentOwned(artist.id, appointmentId);
  if (appointment.status !== 'scheduled') throw conflict(`Appointment is already "${appointment.status}"`);
  await db.run("UPDATE appointments SET status = 'completed', updated_at = ? WHERE id = ?", [nowIso(), appointment.id]);
  await db.run("UPDATE requests SET status = 'completed', updated_at = ? WHERE id = ?", [nowIso(), appointment.request_id]);
  await cancelPendingMessages(appointment.id, ['reminder_7d', 'reminder_cutoff', 'reminder_24h']);
  const request = await db.get('SELECT * FROM requests WHERE id = ?', [appointment.request_id]);
  await scheduleAftercare(artist, request, appointment);
  return db.get('SELECT * FROM appointments WHERE id = ?', [appointment.id]);
}

export async function markNoShow(artist, appointmentId) {
  const db = await getDb();
  const appointment = await getAppointmentOwned(artist.id, appointmentId);
  if (appointment.status !== 'scheduled') throw conflict(`Appointment is already "${appointment.status}"`);
  await db.run("UPDATE appointments SET status = 'no_show', updated_at = ? WHERE id = ?", [nowIso(), appointment.id]);
  await cancelPendingMessages(appointment.id);
  const request = await db.get('SELECT * FROM requests WHERE id = ?', [appointment.request_id]);
  await queueMessage({
    artistId: artist.id, requestId: request.id, appointmentId: appointment.id,
    kind: 'no_show', recipient: request.client_email,
    subject: 'Séance manquée',
    body: `Bonjour ${request.client_name},\n\nVous n'êtes pas venu(e) à la séance du ${formatDateTime(appointment.starts_at, artist.timezone)}. L'acompte est conservé, comme prévu dans les conditions. Pour reprendre rendez-vous : {{base_url}}/b/${artist.slug}`,
  });
  return db.get('SELECT * FROM appointments WHERE id = ?', [appointment.id]);
}

export async function rescheduleAppointment(artist, appointmentId, startsAt, durationHours = null) {
  const db = await getDb();
  const appointment = await getAppointmentOwned(artist.id, appointmentId);
  if (appointment.status !== 'scheduled') throw conflict('Only a scheduled appointment can be moved');
  const hours = durationHours
    ?? (new Date(appointment.ends_at) - new Date(appointment.starts_at)) / 3600000;
  const endsAt = new Date(new Date(startsAt).getTime() + hours * 3600000).toISOString();
  await assertSlotFree(artist.id, startsAt, endsAt, appointment.id);

  await db.run('UPDATE appointments SET starts_at = ?, ends_at = ?, updated_at = ? WHERE id = ?',
    [startsAt, endsAt, nowIso(), appointment.id]);
  await db.run('UPDATE requests SET proposed_start = ?, proposed_end = ?, updated_at = ? WHERE id = ?',
    [startsAt, endsAt, nowIso(), appointment.request_id]);

  await cancelPendingMessages(appointment.id, ['reminder_7d', 'reminder_cutoff', 'reminder_24h']);
  const updated = await db.get('SELECT * FROM appointments WHERE id = ?', [appointment.id]);
  const request = await db.get('SELECT * FROM requests WHERE id = ?', [appointment.request_id]);
  await scheduleAppointmentReminders(artist, request, updated);
  await queueMessage({
    artistId: artist.id, requestId: request.id, appointmentId: updated.id,
    kind: 'rescheduled', recipient: request.client_email,
    subject: 'Votre séance a été déplacée',
    body: `Bonjour ${request.client_name},\n\nNouvelle date : ${formatDateTime(updated.starts_at, artist.timezone)} (${zoneLabel(artist.timezone)}). Votre acompte reste acquis à cette séance.`,
  });
  return updated;
}

export async function cancelAppointment(artist, appointmentId, { refundDeposit = false, reason = '' } = {}) {
  const db = await getDb();
  const appointment = await getAppointmentOwned(artist.id, appointmentId);
  if (appointment.status !== 'scheduled') throw conflict('Only a scheduled appointment can be cancelled');
  await db.run("UPDATE appointments SET status = 'cancelled', updated_at = ? WHERE id = ?", [nowIso(), appointment.id]);
  await db.run("UPDATE requests SET status = 'declined', decline_reason = ?, updated_at = ? WHERE id = ?",
    [reason || 'Séance annulée', nowIso(), appointment.request_id]);
  await cancelPendingMessages(appointment.id);
  const request = await db.get('SELECT * FROM requests WHERE id = ?', [appointment.request_id]);
  await queueMessage({
    artistId: artist.id, requestId: request.id, appointmentId: appointment.id,
    kind: 'cancelled', recipient: request.client_email,
    subject: 'Votre séance a été annulée',
    body: `Bonjour ${request.client_name},\n\nLa séance du ${formatDateTime(appointment.starts_at, artist.timezone)} est annulée.${reason ? `\nRaison : ${reason}` : ''}\n${refundDeposit ? 'Votre acompte vous est remboursé.' : 'Votre acompte reste acquis au studio.'}`,
  });
  return db.get('SELECT * FROM appointments WHERE id = ?', [appointment.id]);
}

/* --------------------------------------------------------------- time blocks */

export async function createBlock(artist, startsAt, endsAt, label) {
  if (endsAt <= startsAt) throw bad('The block must end after it starts');
  const db = await getDb();
  const clash = await db.get(
    "SELECT id FROM appointments WHERE artist_id = ? AND status = 'scheduled' AND starts_at < ? AND ends_at > ?",
    [artist.id, endsAt, startsAt],
  );
  if (clash) throw conflict('An appointment already sits in that period');
  const info = await db.run(
    'INSERT INTO blocks (artist_id, starts_at, ends_at, label, created_at) VALUES (?, ?, ?, ?, ?)',
    [artist.id, startsAt, endsAt, label, nowIso()],
  );
  return db.get('SELECT * FROM blocks WHERE id = ?', [info.lastInsertRowid]);
}

export async function listBlocks(artistId) {
  const db = await getDb();
  return db.all('SELECT * FROM blocks WHERE artist_id = ? ORDER BY starts_at', [artistId]);
}

export async function deleteBlock(artist, blockId) {
  const db = await getDb();
  const info = await db.run('DELETE FROM blocks WHERE id = ? AND artist_id = ?', [blockId, artist.id]);
  if (!info.changes) throw notFound('Block not found');
  return { deleted: true };
}

/* ------------------------------------------------------------ expiring quotes */

/**
 * A quote that lapsed was only noticed if the client happened to try to accept
 * it. Until then it sat in the inbox as if it were live, held a slot informally
 * and counted as a pending reply. This sweeps them, and tells both sides — the
 * client because the date they were considering is gone, the artist because a
 * quote going cold is exactly what a follow-up is for.
 */
export async function expireStaleQuotes(now = nowIso()) {
  const db = await getDb();
  const stale = await db.all(
    "SELECT * FROM requests WHERE status = 'quoted' AND quote_expires_at IS NOT NULL AND quote_expires_at <= ?",
    [now],
  );

  let expired = 0;
  for (const request of stale) {
    const artist = await getArtist(request.artist_id);
    if (!artist) continue;
    await db.run("UPDATE requests SET status = 'expired', updated_at = ? WHERE id = ?", [nowIso(), request.id]);
    await queueQuoteExpired(artist, request);
    expired += 1;
  }
  return expired;
}

/* --------------------------------------------------------------------- stats */

export async function stats(artistId, { days = 90 } = {}) {
  const db = await getDb();
  const since = new Date(Date.now() - days * 86400000).toISOString();

  const funnel = await db.all(
    'SELECT status, COUNT(*) AS count FROM requests WHERE artist_id = ? AND created_at >= ? GROUP BY status',
    [artistId, since],
  );
  const byStatus = Object.fromEntries(funnel.map((row) => [row.status, row.count]));
  const totalRequests = funnel.reduce((sum, row) => sum + row.count, 0);

  const appts = await db.all(`
    SELECT status, COUNT(*) AS count, COALESCE(SUM(price_cents), 0) AS revenue,
           COALESCE(SUM(deposit_cents), 0) AS deposits
    FROM appointments WHERE artist_id = ? AND starts_at >= ? GROUP BY status
  `, [artistId, since]);
  const apptByStatus = Object.fromEntries(appts.map((row) => [row.status, row]));
  const count = (s) => apptByStatus[s]?.count ?? 0;
  const finished = count('completed') + count('no_show');

  const upcoming = await db.get(`
    SELECT COUNT(*) AS count, COALESCE(SUM(price_cents), 0) AS revenue,
           COALESCE(SUM(deposit_cents), 0) AS deposits,
           COALESCE(SUM((julianday(ends_at) - julianday(starts_at)) * 24), 0) AS hours
    FROM appointments WHERE artist_id = ? AND status = 'scheduled' AND starts_at >= ?
  `, [artistId, nowIso()]);

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
