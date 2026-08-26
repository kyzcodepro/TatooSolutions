import { Router, json, readJson, readRaw, setCookie, bad, conflict, notFound, HttpError } from '../http.js';
import * as v from '../validate.js';
import { getDb, nowIso, databaseFile, isEphemeral, isServerless, backend } from '../db.js';
import {
  hashPassword, verifyPassword, createSession, destroySession, requireArtist,
  currentArtist, publicArtist, SESSION_COOKIE,
} from '../auth.js';
import { estimate, referencePrice, REFERENCE_SIZE_CM, DETAIL_LEVELS, COLOR_MODES } from '../pricing.js';
import { providerNames, splitAddress, baseUrl } from '../mailer.js';
import { paymentsProvider, verifyWebhook, PaymentError } from '../payments.js';
import { isTime, parseWorkingHours, DEFAULT_WORKING_HOURS } from '../availability.js';
import * as studio from '../studio.js';
import { dispatchDue, MAX_SEND_ATTEMPTS } from '../messages.js';
import * as service from '../service.js';

export const api = new Router();

/* -------------------------------------------------------------------- health */

// Counterpart of api/ping.js. Whichever one answers tells you how the deployment
// is serving traffic: "function" means Vercel routes through api/, "app" means the
// request reached the application router itself.
api.get('/api/ping', async (req, res) => {
  json(res, 200, {
    probe: 'app',
    node: process.version,
    commit: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? null,
    time: nowIso(),
  });
});

// Answers "is this deployment actually wired up?" without exposing any data.
api.get('/api/health', async (req, res) => {
  const db = await getDb();
  const { count } = await db.get('SELECT COUNT(*) AS count FROM artists');
  // "Pending" has to mean "still going to be tried". Counting abandoned messages
  // as pending leaves a number that can never come down.
  const queue = await db.get(`
    SELECT
      COALESCE(SUM(CASE WHEN sent_at IS NULL AND attempts < ? THEN 1 ELSE 0 END), 0) AS pending,
      COALESCE(SUM(CASE WHEN sent_at IS NULL AND attempts >= ? THEN 1 ELSE 0 END), 0) AS abandoned,
      COALESCE(SUM(CASE WHEN sent_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS sent
    FROM messages
  `, [MAX_SEND_ATTEMPTS, MAX_SEND_ATTEMPTS]);
  json(res, 200, {
    status: 'ok',
    node: process.version,
    serverless: isServerless(),
    database: {
      backend: backend(),
      location: backend() === 'turso' ? 'turso' : databaseFile(),
      ephemeral: isEphemeral(),
      artists: count,
    },
    // Without a shared signing key each instance signs sessions with its own, and
    // the dashboard logs people out at random. Report whether one is configured —
    // never its value.
    sessions: { signing_key_configured: (process.env.INKFLOW_SECRET ?? '').length >= 16 },
    payments: {
      provider: paymentsProvider(),
      key_configured: Boolean(process.env.STRIPE_SECRET_KEY),
      webhook_secret_configured: Boolean(process.env.STRIPE_WEBHOOK_SECRET),
    },
    mail: {
      provider: (process.env.INKFLOW_MAIL_PROVIDER || 'console').toLowerCase(),
      sender_configured: Boolean(process.env.INKFLOW_MAIL_FROM),
      // The domain, not the address: it is on every message this app sends, and
      // "which domain did I configure" is the first question a refused send raises.
      sender_domain: splitAddress(process.env.INKFLOW_MAIL_FROM ?? '').address.split('@')[1] ?? null,
      key_configured: Boolean(process.env.INKFLOW_MAIL_KEY),
    },
    outbox: { pending: queue.pending, abandoned: queue.abandoned, sent: queue.sent },
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
  const invite = v.str(body.invite, 'invite', { required: false, max: 100 }) || null;
  if (invite) await studio.readInvite(invite); // fail before creating an orphan account
  const db = await getDb();

  if (await db.get('SELECT id FROM artists WHERE email = ?', [email])) {
    throw conflict('An account already exists with this email');
  }
  const { hash, salt } = hashPassword(password);
  const slug = await uniqueSlug(v.slugify(studioName) || 'studio');
  const info = await db.run(`
    INSERT INTO artists (email, password_hash, password_salt, studio_name, slug, city, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `, [email, hash, salt, studioName, slug, city, nowIso()]);

  const artistId = info.lastInsertRowid;
  if (invite) {
    await studio.consumeInvite(invite, artistId);
  } else {
    // Every account owns a studio, even a studio of one.
    const studioSlug = await uniqueStudioSlug(slug);
    const created = await db.run('INSERT INTO studios (name, slug, owner_id, created_at) VALUES (?, ?, ?, ?)',
      [studioName, studioSlug, artistId, nowIso()]);
    await db.run("UPDATE artists SET studio_id = ?, role = 'owner' WHERE id = ?", [created.lastInsertRowid, artistId]);
  }

  const artist = await db.get('SELECT * FROM artists WHERE id = ?', [artistId]);
  const session = createSession(artist.id);
  setCookie(res, SESSION_COOKIE, session.token, { maxAge: session.maxAge });
  json(res, 201, { artist: publicArtist(artist) });
});

async function uniqueStudioSlug(base) {
  const db = await getDb();
  let slug = base;
  let n = 2;
  while (await db.get('SELECT id FROM studios WHERE slug = ?', [slug])) slug = `${base}-${n++}`;
  return slug;
}

async function uniqueSlug(base) {
  const db = await getDb();
  let slug = base;
  let n = 2;
  while (await db.get('SELECT id FROM artists WHERE slug = ?', [slug])) slug = `${base}-${n++}`;
  return slug;
}

api.post('/api/auth/login', async (req, res) => {
  const body = await readJson(req);
  const email = v.email(body.email);
  const password = v.str(body.password, 'password', { max: 200 });
  const db = await getDb();
  const artist = await db.get('SELECT * FROM artists WHERE email = ?', [email]);
  if (!artist || !verifyPassword(password, artist.password_hash, artist.password_salt)) {
    throw bad('Wrong email or password');
  }
  const session = createSession(artist.id);
  setCookie(res, SESSION_COOKIE, session.token, { maxAge: session.maxAge });
  json(res, 200, { artist: publicArtist(artist) });
});

api.post('/api/auth/logout', async (req, res) => {
  destroySession();
  setCookie(res, SESSION_COOKIE, '', { maxAge: 0 });
  json(res, 200, { ok: true });
});

api.get('/api/me', async (req, res) => {
  const artist = await currentArtist(req);
  json(res, 200, { artist: artist ? publicArtist(artist) : null });
});

api.patch('/api/me', async (req, res) => {
  const artist = await requireArtist(req);
  const body = await readJson(req);
  const fields = {
    studio_name: body.studio_name !== undefined ? v.str(body.studio_name, 'studio_name', { max: 80 }) : undefined,
    city: body.city !== undefined ? v.str(body.city, 'city', { required: false, max: 80 }) : undefined,
    bio: body.bio !== undefined ? v.str(body.bio, 'bio', { required: false, max: 1000 }) : undefined,
    styles: body.styles !== undefined ? JSON.stringify(v.stringList(body.styles, 'styles', { max: 12, itemMax: 40 })) : undefined,
    currency: body.currency !== undefined ? v.oneOf(body.currency, 'currency', ['EUR', 'CHF', 'GBP', 'USD', 'CAD']) : undefined,
    reference_price_cents: body.reference_price_cents !== undefined ? v.int(body.reference_price_cents, 'reference_price_cents', { min: 1000, max: 10000000 }) : undefined,
    hourly_rate_cents: body.hourly_rate_cents !== undefined ? v.int(body.hourly_rate_cents, 'hourly_rate_cents', { min: 1000, max: 10000000 }) : undefined,
    minimum_cents: body.minimum_cents !== undefined ? v.int(body.minimum_cents, 'minimum_cents', { min: 0, max: 10000000 }) : undefined,
    deposit_percent: body.deposit_percent !== undefined ? v.int(body.deposit_percent, 'deposit_percent', { min: 0, max: 100 }) : undefined,
    cancellation_hours: body.cancellation_hours !== undefined ? v.int(body.cancellation_hours, 'cancellation_hours', { min: 0, max: 336 }) : undefined,
    working_hours: body.working_hours !== undefined ? JSON.stringify(parseHoursInput(body.working_hours)) : undefined,
    timezone: body.timezone !== undefined ? validTimezone(body.timezone) : undefined,
    lead_hours: body.lead_hours !== undefined ? v.int(body.lead_hours, 'lead_hours', { min: 0, max: 720 }) : undefined,
    accepting_requests: body.accepting_requests !== undefined ? (v.bool(body.accepting_requests) ? 1 : 0) : undefined,
  };
  const entries = Object.entries(fields).filter(([, value]) => value !== undefined);
  if (entries.length) {
    const db = await getDb();
    await db.run(
      `UPDATE artists SET ${entries.map(([k]) => `${k} = ?`).join(', ')} WHERE id = ?`,
      [...entries.map(([, value]) => value), artist.id],
    );
  }
  json(res, 200, { artist: publicArtist(await service.getArtist(artist.id)) });
});

/** Seven days, each open or closed with a window; anything else is refused. */
function parseHoursInput(value) {
  if (!Array.isArray(value) || value.length !== 7) throw bad('"working_hours" must list the seven days');
  return value.map((day, index) => {
    const from = isTime(day?.from) ? day.from : DEFAULT_WORKING_HOURS[index].from;
    const to = isTime(day?.to) ? day.to : DEFAULT_WORKING_HOURS[index].to;
    if (to <= from) throw bad(`"working_hours" day ${index}: closing time must be after opening time`);
    return { open: Boolean(day?.open), from, to };
  });
}

function validTimezone(value) {
  const zone = v.str(value, 'timezone', { max: 64 });
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
  } catch {
    throw bad(`"timezone" is not a known time zone (${zone})`);
  }
  return zone;
}

/* -------------------------------------------------------------------- public */

api.get('/api/public/artists/:slug', async (req, res, { params }) => {
  const artist = await service.getArtistBySlug(params.slug);
  if (!artist) throw notFound('Artist not found');
  json(res, 200, {
    artist: {
      studio_name: artist.studio_name, slug: artist.slug, city: artist.city, bio: artist.bio,
      styles: JSON.parse(artist.styles || '[]'), currency: artist.currency,
      reference_price_cents: referencePrice(artist), reference_size_cm: REFERENCE_SIZE_CM,
      minimum_cents: artist.minimum_cents,
      working_hours: parseWorkingHours(artist.working_hours), timezone: artist.timezone || 'Europe/Paris',
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
  const artist = await service.getArtistBySlug(params.slug);
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
  const artist = await service.getArtistBySlug(params.slug);
  if (!artist) throw notFound('Artist not found');
  const brief = parseBrief(await readJson(req));
  const { request, estimate: result } = await service.createRequest(artist, brief);
  json(res, 201, {
    request: { public_token: request.public_token, status: request.status },
    estimate: result,
    currency: artist.currency,
    track_url: `/q/${request.public_token}`,
  });
});

api.get('/api/public/artists/:slug/slots', async (req, res, { params, url }) => {
  const artist = await service.getArtistBySlug(params.slug);
  if (!artist) throw notFound('Artist not found');
  const hours = Number(url.searchParams.get('hours')) || 2;
  // A few, not the whole calendar: this is "roughly when", not a booking grid.
  const slots = await service.nextSlots(artist, { durationHours: hours, limit: 3 });
  json(res, 200, { slots, timezone: artist.timezone || 'Europe/Paris' });
});

api.get('/api/public/quotes/:token', async (req, res, { params }) => {
  json(res, 200, await service.quoteView(params.token));
});

api.post('/api/public/quotes/:token/accept', async (req, res, { params }) => {
  json(res, 200, await service.acceptQuote(params.token, { baseUrl: baseUrl() }));
});

/**
 * The provider's word that the money moved. Signed, so it is the only input
 * trusted to book a date — the client's return URL is not proof of anything.
 */
api.post('/api/webhooks/stripe', async (req, res) => {
  const raw = await readRaw(req);
  let event;
  try {
    event = verifyWebhook(raw, req.headers['stripe-signature']);
  } catch (err) {
    console.error('[stripe] rejected webhook:', err.message);
    throw new HttpError(400, err instanceof PaymentError ? err.message : 'Invalid webhook');
  }

  if (event.type !== 'checkout.session.completed') {
    // Acknowledged, deliberately ignored: retrying it would change nothing.
    return json(res, 200, { received: true, ignored: event.type });
  }

  const session = event.data?.object ?? {};
  if (session.payment_status !== 'paid') {
    return json(res, 200, { received: true, ignored: `payment_status=${session.payment_status}` });
  }

  const token = session.metadata?.public_token || session.client_reference_id;
  if (!token) return json(res, 200, { received: true, ignored: 'no request reference' });

  try {
    const result = await service.confirmDepositPaid({
      token,
      reference: session.id,
      amountCents: Number(session.amount_total),
    });
    json(res, 200, { received: true, booked: !result.conflict, already: Boolean(result.already) });
  } catch (err) {
    // A 4xx would have Stripe retry forever on something a retry cannot fix.
    console.error('[stripe] could not honour a paid deposit:', err.message);
    json(res, 200, { received: true, booked: false, error: err.message });
  }
});

/* ------------------------------------------------------------ artist inboxes */

api.get('/api/requests', async (req, res, { url }) => {
  const artist = await requireArtist(req);
  const status = url.searchParams.get('status');
  if (status && !service.REQUEST_STATUSES.includes(status)) throw bad('Unknown status filter');
  json(res, 200, { requests: await service.listRequests(artist.id, { status }) });
});

api.get('/api/requests/:id', async (req, res, { params }) => {
  const artist = await requireArtist(req);
  const row = await service.getRequestOwned(artist.id, v.int(params.id, 'id'));
  json(res, 200, { request: service.hydrateRequest(row, artist) });
});

api.post('/api/requests/:id/quote', async (req, res, { params }) => {
  const artist = await requireArtist(req);
  const body = await readJson(req);
  const request = await service.sendQuote(artist, v.int(params.id, 'id'), {
    price_cents: v.int(body.price_cents, 'price_cents', { min: 500, max: 10000000 }),
    deposit_cents: body.deposit_cents !== undefined
      ? v.int(body.deposit_cents, 'deposit_cents', { min: 0, max: 10000000 }) : undefined,
    proposed_start: v.isoDate(body.proposed_start, 'proposed_start', { required: false }),
    duration_hours: body.duration_hours !== undefined
      ? Math.max(0.5, Number(body.duration_hours)) : undefined,
    note: v.str(body.note, 'note', { required: false, max: 1000 }),
    expires_in_days: v.int(body.expires_in_days, 'expires_in_days', { required: false, min: 1, max: 60, fallback: 7 }) ?? 7,
    outside_hours: v.bool(body.outside_hours),
  });
  json(res, 200, { request });
});

api.post('/api/requests/:id/decline', async (req, res, { params }) => {
  const artist = await requireArtist(req);
  const body = await readJson(req);
  const reason = v.str(body.reason, 'reason', { required: false, max: 300 });
  json(res, 200, { request: await service.declineRequest(artist, v.int(params.id, 'id'), reason) });
});

/* -------------------------------------------------------------------- studio */

api.get('/api/studio', async (req, res) => {
  const artist = await requireArtist(req);
  json(res, 200, await studio.studioView(artist));
});

api.patch('/api/studio', async (req, res) => {
  const artist = await requireArtist(req);
  const body = await readJson(req);
  const name = v.str(body.name, 'name', { max: 80 });
  json(res, 200, { studio: await studio.renameStudio(artist, name) });
});

api.post('/api/studio/invites', async (req, res) => {
  const artist = await requireArtist(req);
  const body = await readJson(req);
  const invite = await studio.inviteMember(artist, v.email(body.email));
  // The token travels by email; echoing it to the caller would let an owner
  // bypass the invitee's mailbox entirely.
  json(res, 201, { email: invite.email, expires_at: invite.expires_at });
});

api.delete('/api/studio/invites/:id', async (req, res, { params }) => {
  const artist = await requireArtist(req);
  json(res, 200, await studio.cancelInvite(artist, v.int(params.id, 'id')));
});

api.delete('/api/studio/members/:id', async (req, res, { params }) => {
  const artist = await requireArtist(req);
  json(res, 200, await studio.removeMember(artist, v.int(params.id, 'id')));
});

api.get('/api/studio/agenda', async (req, res, { url }) => {
  const artist = await requireArtist(req);
  json(res, 200, {
    appointments: await studio.studioAgenda(artist.studio_id, {
      from: url.searchParams.get('from'),
      to: url.searchParams.get('to'),
    }),
  });
});

api.get('/api/studio/stats', async (req, res, { url }) => {
  const artist = await requireArtist(req);
  const days = url.searchParams.get('days');
  json(res, 200, await studio.studioStats(artist, {
    days: days ? v.int(days, 'days', { min: 1, max: 730 }) : 90,
  }));
});

api.get('/api/public/studios/:slug', async (req, res, { params }) => {
  json(res, 200, await studio.publicStudio(params.slug));
});

api.get('/api/public/invites/:token', async (req, res, { params }) => {
  const { invite, studio: found } = await studio.readInvite(params.token);
  json(res, 200, { studio_name: found.name, email: invite.email, expires_at: invite.expires_at });
});

/* -------------------------------------------------------------- appointments */

api.get('/api/slots', async (req, res, { url }) => {
  const artist = await requireArtist(req);
  const hours = Number(url.searchParams.get('hours')) || 2;
  const days = v.int(url.searchParams.get('days'), 'days', { required: false, min: 1, max: 120, fallback: 28 }) ?? 28;
  const limit = v.int(url.searchParams.get('limit'), 'limit', { required: false, min: 1, max: 40, fallback: 12 }) ?? 12;
  json(res, 200, { slots: await service.nextSlots(artist, { durationHours: hours, days, limit }) });
});

api.get('/api/appointments', async (req, res, { url }) => {
  const artist = await requireArtist(req);
  json(res, 200, {
    appointments: await service.listAppointments(artist.id, {
      from: url.searchParams.get('from'),
      to: url.searchParams.get('to'),
      status: url.searchParams.get('status'),
    }),
  });
});

api.post('/api/appointments/:id/complete', async (req, res, { params }) => {
  const artist = await requireArtist(req);
  json(res, 200, { appointment: await service.completeAppointment(artist, v.int(params.id, 'id')) });
});

api.post('/api/appointments/:id/no-show', async (req, res, { params }) => {
  const artist = await requireArtist(req);
  json(res, 200, { appointment: await service.markNoShow(artist, v.int(params.id, 'id')) });
});

api.post('/api/appointments/:id/reschedule', async (req, res, { params }) => {
  const artist = await requireArtist(req);
  const body = await readJson(req);
  const startsAt = v.isoDate(body.starts_at, 'starts_at');
  const hours = body.duration_hours !== undefined ? Math.max(0.5, Number(body.duration_hours)) : null;
  json(res, 200, { appointment: await service.rescheduleAppointment(artist, v.int(params.id, 'id'), startsAt, hours) });
});

api.post('/api/appointments/:id/cancel', async (req, res, { params }) => {
  const artist = await requireArtist(req);
  const body = await readJson(req);
  json(res, 200, {
    appointment: await service.cancelAppointment(artist, v.int(params.id, 'id'), {
      refundDeposit: v.bool(body.refund_deposit),
      reason: v.str(body.reason, 'reason', { required: false, max: 300 }),
    }),
  });
});

/* -------------------------------------------------------------------- blocks */

api.get('/api/blocks', async (req, res) => {
  const artist = await requireArtist(req);
  json(res, 200, { blocks: await service.listBlocks(artist.id) });
});

api.post('/api/blocks', async (req, res) => {
  const artist = await requireArtist(req);
  const body = await readJson(req);
  const block = await service.createBlock(
    artist,
    v.isoDate(body.starts_at, 'starts_at'),
    v.isoDate(body.ends_at, 'ends_at'),
    v.str(body.label, 'label', { required: false, max: 80 }) || 'Indisponible',
  );
  json(res, 201, { block });
});

api.delete('/api/blocks/:id', async (req, res, { params }) => {
  const artist = await requireArtist(req);
  json(res, 200, await service.deleteBlock(artist, v.int(params.id, 'id')));
});

/* ------------------------------------------------------------ outbox & stats */

api.get('/api/messages', async (req, res, { url }) => {
  const artist = await requireArtist(req);
  const pending = url.searchParams.get('pending') === 'true';
  const db = await getDb();
  const rows = await db.all(`
    SELECT * FROM messages WHERE artist_id = ? ${pending ? 'AND sent_at IS NULL' : ''}
    ORDER BY scheduled_for DESC LIMIT 100
  `, [artist.id]);
  json(res, 200, { messages: rows });
});

api.post('/api/messages/dispatch', async (req, res) => {
  await requireArtist(req);
  json(res, 200, { dispatched: await dispatchDue() });
});

// Called by a scheduler (Vercel Cron), so it authenticates with a shared secret
// rather than a session. Without traffic nothing would ever flush the outbox.
api.get('/api/cron/dispatch', async (req, res) => {
  const secret = process.env.CRON_SECRET || process.env.INKFLOW_CRON_SECRET;
  if (secret) {
    const offered = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    if (offered !== secret) throw new HttpError(401, 'Bad cron credentials');
  }
  // Sweep first: an expiry queues messages this same pass will send.
  const expired = await service.expireStaleQuotes();
  const dispatched = await dispatchDue();
  json(res, 200, { expired, dispatched, max_attempts: MAX_SEND_ATTEMPTS });
});

api.get('/api/stats', async (req, res, { url }) => {
  const artist = await requireArtist(req);
  const days = v.int(url.searchParams.get('days'), 'days', { required: false, min: 1, max: 730, fallback: 90 }) ?? 90;
  json(res, 200, { stats: await service.stats(artist.id, { days }) });
});
