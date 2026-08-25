import { Router, json, readJson, setCookie, bad, conflict, notFound } from '../http.js';
import * as v from '../validate.js';
import { getDb, nowIso, databaseFile, isEphemeral, isServerless } from '../db.js';
import {
  hashPassword, verifyPassword, createSession, destroySession, requireArtist,
  currentArtist, publicArtist, SESSION_COOKIE,
} from '../auth.js';
import { estimate, DETAIL_LEVELS, COLOR_MODES } from '../pricing.js';
import { dispatchDue } from '../messages.js';
import * as service from '../service.js';

export const api = new Router();

/* -------------------------------------------------------------------- health */

// Answers "is this deployment actually wired up?" without exposing any data.
api.get('/api/health', async (req, res) => {
  const db = getDb();
  const { count } = db.prepare('SELECT COUNT(*) AS count FROM artists').get();
  json(res, 200, {
    status: 'ok',
    node: process.version,
    serverless: isServerless(),
    database: {
      file: databaseFile(),
      ephemeral: isEphemeral(),
      artists: count,
    },
    pending_messages: db.prepare('SELECT COUNT(*) AS count FROM messages WHERE sent_at IS NULL').get().count,
    time: nowIso(),
  });
});

/* ---------------------------------------------------------------------- auth */

api.post('/api/auth/signup', async (req, res) => {
  const body = await readJson(req);
  const email = v.email(body.email);
  const password = v.str(body.password, 'password', { min: 8, max: 200 });
  const studioName = v.str(body.studio_name, 'studio_name', { max: 80 });
  const city = v.str(body.city, 'city', { required: false, max: 80 });
  const db = getDb();

  if (db.prepare('SELECT id FROM artists WHERE email = ?').get(email)) {
    throw conflict('An account already exists with this email');
  }
  const { hash, salt } = hashPassword(password);
  const slug = uniqueSlug(v.slugify(studioName) || 'studio');
  const info = db.prepare(`
    INSERT INTO artists (email, password_hash, password_salt, studio_name, slug, city, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(email, hash, salt, studioName, slug, city, nowIso());

  const artist = db.prepare('SELECT * FROM artists WHERE id = ?').get(Number(info.lastInsertRowid));
  const session = createSession(artist.id);
  setCookie(res, SESSION_COOKIE, session.token, { maxAge: session.maxAge });
  json(res, 201, { artist: publicArtist(artist) });
});

function uniqueSlug(base) {
  const db = getDb();
  let slug = base;
  let n = 2;
  while (db.prepare('SELECT id FROM artists WHERE slug = ?').get(slug)) slug = `${base}-${n++}`;
  return slug;
}

api.post('/api/auth/login', async (req, res) => {
  const body = await readJson(req);
  const email = v.email(body.email);
  const password = v.str(body.password, 'password', { max: 200 });
  const artist = getDb().prepare('SELECT * FROM artists WHERE email = ?').get(email);
  if (!artist || !verifyPassword(password, artist.password_hash, artist.password_salt)) {
    throw bad('Wrong email or password');
  }
  const session = createSession(artist.id);
  setCookie(res, SESSION_COOKIE, session.token, { maxAge: session.maxAge });
  json(res, 200, { artist: publicArtist(artist) });
});

api.post('/api/auth/logout', async (req, res) => {
  const token = (req.headers.cookie || '').match(/inkflow_session=([^;]+)/)?.[1];
  destroySession(token ? decodeURIComponent(token) : null);
  setCookie(res, SESSION_COOKIE, '', { maxAge: 0 });
  json(res, 200, { ok: true });
});

api.get('/api/me', async (req, res) => {
  const artist = currentArtist(req);
  json(res, 200, { artist: artist ? publicArtist(artist) : null });
});

api.patch('/api/me', async (req, res) => {
  const artist = requireArtist(req);
  const body = await readJson(req);
  const fields = {
    studio_name: body.studio_name !== undefined ? v.str(body.studio_name, 'studio_name', { max: 80 }) : undefined,
    city: body.city !== undefined ? v.str(body.city, 'city', { required: false, max: 80 }) : undefined,
    bio: body.bio !== undefined ? v.str(body.bio, 'bio', { required: false, max: 1000 }) : undefined,
    styles: body.styles !== undefined ? JSON.stringify(v.stringList(body.styles, 'styles', { max: 12, itemMax: 40 })) : undefined,
    currency: body.currency !== undefined ? v.oneOf(body.currency, 'currency', ['EUR', 'CHF', 'GBP', 'USD', 'CAD']) : undefined,
    hourly_rate_cents: body.hourly_rate_cents !== undefined ? v.int(body.hourly_rate_cents, 'hourly_rate_cents', { min: 1000, max: 10000000 }) : undefined,
    minimum_cents: body.minimum_cents !== undefined ? v.int(body.minimum_cents, 'minimum_cents', { min: 0, max: 10000000 }) : undefined,
    deposit_percent: body.deposit_percent !== undefined ? v.int(body.deposit_percent, 'deposit_percent', { min: 0, max: 100 }) : undefined,
    cancellation_hours: body.cancellation_hours !== undefined ? v.int(body.cancellation_hours, 'cancellation_hours', { min: 0, max: 336 }) : undefined,
    accepting_requests: body.accepting_requests !== undefined ? (v.bool(body.accepting_requests) ? 1 : 0) : undefined,
  };
  const entries = Object.entries(fields).filter(([, value]) => value !== undefined);
  if (entries.length) {
    getDb().prepare(`UPDATE artists SET ${entries.map(([k]) => `${k} = ?`).join(', ')} WHERE id = ?`)
      .run(...entries.map(([, value]) => value), artist.id);
  }
  json(res, 200, { artist: publicArtist(service.getArtist(artist.id)) });
});

/* -------------------------------------------------------------------- public */

api.get('/api/public/artists/:slug', async (req, res, { params }) => {
  const artist = service.getArtistBySlug(params.slug);
  if (!artist) throw notFound('Artist not found');
  json(res, 200, {
    artist: {
      studio_name: artist.studio_name, slug: artist.slug, city: artist.city, bio: artist.bio,
      styles: JSON.parse(artist.styles || '[]'), currency: artist.currency,
      hourly_rate_cents: artist.hourly_rate_cents, minimum_cents: artist.minimum_cents,
      deposit_percent: artist.deposit_percent, cancellation_hours: artist.cancellation_hours,
      accepting_requests: !!artist.accepting_requests,
    },
    options: { detail_levels: DETAIL_LEVELS, color_modes: COLOR_MODES },
  });
});

function parseBrief(body) {
  return {
    client_name: v.str(body.client_name, 'client_name', { max: 80 }),
    client_email: v.email(body.client_email, 'client_email'),
    client_phone: v.str(body.client_phone, 'client_phone', { required: false, max: 30 }),
    description: v.str(body.description, 'description', { min: 10, max: 2000 }),
    style: v.str(body.style, 'style', { required: false, max: 60 }),
    placement: v.str(body.placement, 'placement', { required: false, max: 60 }),
    size_cm: v.int(body.size_cm, 'size_cm', { min: 1, max: 200 }),
    color_mode: v.oneOf(body.color_mode, 'color_mode', COLOR_MODES, 'blackwork'),
    detail_level: v.oneOf(body.detail_level, 'detail_level', DETAIL_LEVELS, 'medium'),
    cover_up: v.bool(body.cover_up),
    budget_cents: v.int(body.budget_cents, 'budget_cents', { required: false, min: 0, max: 10000000 }),
    reference_urls: v.stringList(body.reference_urls, 'reference_urls', { max: 8, itemMax: 500 }),
    availability: v.stringList(body.availability, 'availability', { max: 14, itemMax: 60 }),
    is_adult: v.bool(body.is_adult),
  };
}

// Instant bracket while the client is still typing — no account, no persistence.
api.post('/api/public/artists/:slug/estimate', async (req, res, { params }) => {
  const artist = service.getArtistBySlug(params.slug);
  if (!artist) throw notFound('Artist not found');
  const body = await readJson(req);
  const brief = {
    size_cm: v.int(body.size_cm, 'size_cm', { min: 1, max: 200 }),
    color_mode: v.oneOf(body.color_mode, 'color_mode', COLOR_MODES, 'blackwork'),
    detail_level: v.oneOf(body.detail_level, 'detail_level', DETAIL_LEVELS, 'medium'),
    placement: v.str(body.placement, 'placement', { required: false, max: 60 }),
    cover_up: v.bool(body.cover_up),
    budget_cents: v.int(body.budget_cents, 'budget_cents', { required: false, min: 0, max: 10000000 }),
  };
  json(res, 200, { estimate: estimate(brief, artist), currency: artist.currency });
});

api.post('/api/public/artists/:slug/requests', async (req, res, { params }) => {
  const artist = service.getArtistBySlug(params.slug);
  if (!artist) throw notFound('Artist not found');
  const brief = parseBrief(await readJson(req));
  const { request, estimate: result } = service.createRequest(artist, brief);
  json(res, 201, {
    request: { public_token: request.public_token, status: request.status },
    estimate: result,
    currency: artist.currency,
    track_url: `/q/${request.public_token}`,
  });
});

api.get('/api/public/quotes/:token', async (req, res, { params }) => {
  json(res, 200, service.quoteView(params.token));
});

api.post('/api/public/quotes/:token/accept', async (req, res, { params }) => {
  json(res, 200, service.acceptQuote(params.token));
});

/* ------------------------------------------------------------ artist inboxes */

api.get('/api/requests', async (req, res, { url }) => {
  const artist = requireArtist(req);
  const status = url.searchParams.get('status');
  if (status && !service.REQUEST_STATUSES.includes(status)) throw bad('Unknown status filter');
  json(res, 200, { requests: service.listRequests(artist.id, { status }) });
});

api.get('/api/requests/:id', async (req, res, { params }) => {
  const artist = requireArtist(req);
  const row = service.getRequestOwned(artist.id, v.int(params.id, 'id'));
  json(res, 200, { request: service.hydrateRequest(row, artist) });
});

api.post('/api/requests/:id/quote', async (req, res, { params }) => {
  const artist = requireArtist(req);
  const body = await readJson(req);
  const request = service.sendQuote(artist, v.int(params.id, 'id'), {
    price_cents: v.int(body.price_cents, 'price_cents', { min: 500, max: 10000000 }),
    deposit_cents: body.deposit_cents !== undefined
      ? v.int(body.deposit_cents, 'deposit_cents', { min: 0, max: 10000000 }) : undefined,
    proposed_start: v.isoDate(body.proposed_start, 'proposed_start', { required: false }),
    duration_hours: body.duration_hours !== undefined
      ? Math.max(0.5, Number(body.duration_hours)) : undefined,
    note: v.str(body.note, 'note', { required: false, max: 1000 }),
    expires_in_days: v.int(body.expires_in_days, 'expires_in_days', { required: false, min: 1, max: 60, fallback: 7 }) ?? 7,
  });
  json(res, 200, { request });
});

api.post('/api/requests/:id/decline', async (req, res, { params }) => {
  const artist = requireArtist(req);
  const body = await readJson(req);
  const reason = v.str(body.reason, 'reason', { required: false, max: 300 });
  json(res, 200, { request: service.declineRequest(artist, v.int(params.id, 'id'), reason) });
});

/* -------------------------------------------------------------- appointments */

api.get('/api/appointments', async (req, res, { url }) => {
  const artist = requireArtist(req);
  json(res, 200, {
    appointments: service.listAppointments(artist.id, {
      from: url.searchParams.get('from'),
      to: url.searchParams.get('to'),
      status: url.searchParams.get('status'),
    }),
  });
});

api.post('/api/appointments/:id/complete', async (req, res, { params }) => {
  const artist = requireArtist(req);
  json(res, 200, { appointment: service.completeAppointment(artist, v.int(params.id, 'id')) });
});

api.post('/api/appointments/:id/no-show', async (req, res, { params }) => {
  const artist = requireArtist(req);
  json(res, 200, { appointment: service.markNoShow(artist, v.int(params.id, 'id')) });
});

api.post('/api/appointments/:id/reschedule', async (req, res, { params }) => {
  const artist = requireArtist(req);
  const body = await readJson(req);
  const startsAt = v.isoDate(body.starts_at, 'starts_at');
  const hours = body.duration_hours !== undefined ? Math.max(0.5, Number(body.duration_hours)) : null;
  json(res, 200, { appointment: service.rescheduleAppointment(artist, v.int(params.id, 'id'), startsAt, hours) });
});

api.post('/api/appointments/:id/cancel', async (req, res, { params }) => {
  const artist = requireArtist(req);
  const body = await readJson(req);
  json(res, 200, {
    appointment: service.cancelAppointment(artist, v.int(params.id, 'id'), {
      refundDeposit: v.bool(body.refund_deposit),
      reason: v.str(body.reason, 'reason', { required: false, max: 300 }),
    }),
  });
});

/* -------------------------------------------------------------------- blocks */

api.get('/api/blocks', async (req, res) => {
  const artist = requireArtist(req);
  json(res, 200, { blocks: service.listBlocks(artist.id) });
});

api.post('/api/blocks', async (req, res) => {
  const artist = requireArtist(req);
  const body = await readJson(req);
  const block = service.createBlock(
    artist,
    v.isoDate(body.starts_at, 'starts_at'),
    v.isoDate(body.ends_at, 'ends_at'),
    v.str(body.label, 'label', { required: false, max: 80 }) || 'Indisponible',
  );
  json(res, 201, { block });
});

api.delete('/api/blocks/:id', async (req, res, { params }) => {
  const artist = requireArtist(req);
  json(res, 200, service.deleteBlock(artist, v.int(params.id, 'id')));
});

/* ------------------------------------------------------------ outbox & stats */

api.get('/api/messages', async (req, res, { url }) => {
  const artist = requireArtist(req);
  const pending = url.searchParams.get('pending') === 'true';
  const rows = getDb().prepare(`
    SELECT * FROM messages WHERE artist_id = ? ${pending ? 'AND sent_at IS NULL' : ''}
    ORDER BY scheduled_for DESC LIMIT 100
  `).all(artist.id);
  json(res, 200, { messages: rows });
});

api.post('/api/messages/dispatch', async (req, res) => {
  requireArtist(req);
  json(res, 200, { dispatched: dispatchDue() });
});

api.get('/api/stats', async (req, res, { url }) => {
  const artist = requireArtist(req);
  const days = v.int(url.searchParams.get('days'), 'days', { required: false, min: 1, max: 730, fallback: 90 }) ?? 90;
  json(res, 200, { stats: service.stats(artist.id, { days }) });
});
