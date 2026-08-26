// Studios: several artists under one roof.
//
// What is shared and what is not is the whole design. A studio shares a page, a
// diary and a bill; it does not share an inbox. Each artist keeps their own
// briefs, prices, hours and clients — a colleague reading your negotiation with
// a client would be a feature nobody asked for.

import { randomBytes } from 'node:crypto';
import { getDb, nowIso } from './db.js';
import { bad, conflict, notFound, HttpError } from './http.js';
import { queueMessage } from './messages.js';

/** What the Studio plan sells. Enforced rather than promised. */
export const MAX_STUDIO_MEMBERS = 6;
const INVITE_DAYS = 14;

/**
 * Guarantees the artist has a studio. Accounts can be created outside the signup
 * route — the seed, a migration, a support script — and an artist without a
 * studio would otherwise be an account that cannot open its own dashboard.
 */
export async function ensureStudio(artist) {
  if (artist.studio_id) return artist.studio_id;
  const db = await getDb();
  let slug = artist.slug;
  let n = 2;
  while (await db.get('SELECT id FROM studios WHERE slug = ?', [slug])) slug = `${artist.slug}-${n++}`;
  const info = await db.run('INSERT INTO studios (name, slug, owner_id, created_at) VALUES (?, ?, ?, ?)',
    [artist.studio_name, slug, artist.id, nowIso()]);
  await db.run("UPDATE artists SET studio_id = ?, role = 'owner' WHERE id = ?", [info.lastInsertRowid, artist.id]);
  artist.studio_id = info.lastInsertRowid;
  artist.role = artist.role || 'owner';
  return artist.studio_id;
}

export async function getStudio(studioId) {
  const db = await getDb();
  const studio = await db.get('SELECT * FROM studios WHERE id = ?', [studioId]);
  if (!studio) throw notFound('Studio not found');
  return studio;
}

export async function getStudioBySlug(slug) {
  const db = await getDb();
  return db.get('SELECT * FROM studios WHERE slug = ?', [slug]);
}

export async function listMembers(studioId) {
  const db = await getDb();
  return db.all(
    `SELECT id, studio_name, slug, email, role, city, styles, accepting_requests, created_at
     FROM artists WHERE studio_id = ? ORDER BY CASE role WHEN 'owner' THEN 0 ELSE 1 END, id`,
    [studioId],
  );
}

export const isOwner = (artist) => artist.role === 'owner';

function requireOwner(artist) {
  if (!isOwner(artist)) throw new HttpError(403, 'Only the studio owner can do that');
}

/** The studio as its members see it: who is here, and what is still pending. */
export async function studioView(artist) {
  const db = await getDb();
  const studio = await getStudio(await ensureStudio(artist));
  const members = await listMembers(studio.id);
  const invites = isOwner(artist)
    ? await db.all(
      'SELECT id, email, expires_at, created_at FROM studio_invites WHERE studio_id = ? AND accepted_at IS NULL ORDER BY id DESC',
      [studio.id],
    )
    : [];

  return {
    studio: { id: studio.id, name: studio.name, slug: studio.slug, owner_id: studio.owner_id },
    members: members.map((member) => ({ ...member, styles: JSON.parse(member.styles || '[]'), you: member.id === artist.id })),
    pending_invites: invites,
    seats: { used: members.length + invites.length, max: MAX_STUDIO_MEMBERS },
    is_owner: isOwner(artist),
  };
}

export async function renameStudio(artist, name) {
  requireOwner(artist);
  const db = await getDb();
  await db.run('UPDATE studios SET name = ? WHERE id = ?', [name, artist.studio_id]);
  return getStudio(artist.studio_id);
}

/**
 * Invites are single-use and expire. A seat is counted the moment one is sent:
 * six outstanding invitations would otherwise fill a studio of six.
 */
export async function inviteMember(artist, email) {
  requireOwner(artist);
  const db = await getDb();
  const studio = await getStudio(await ensureStudio(artist));

  const members = await listMembers(studio.id);
  const pending = await db.all(
    'SELECT id, email FROM studio_invites WHERE studio_id = ? AND accepted_at IS NULL AND expires_at > ?',
    [studio.id, nowIso()],
  );
  if (members.length + pending.length >= MAX_STUDIO_MEMBERS) {
    throw conflict(`A studio holds at most ${MAX_STUDIO_MEMBERS} artists — remove someone or cancel an invitation first`);
  }
  if (members.some((member) => member.email === email)) throw conflict('That artist is already in the studio');
  if (pending.some((invite) => invite.email === email)) throw conflict('That address already has an invitation waiting');

  const token = randomBytes(24).toString('hex');
  const expiresAt = new Date(Date.now() + INVITE_DAYS * 86400000).toISOString();
  await db.run(
    'INSERT INTO studio_invites (studio_id, email, token, invited_by, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [studio.id, email, token, artist.id, expiresAt, nowIso()],
  );

  await queueMessage({
    artistId: artist.id,
    kind: 'studio_invite',
    recipient: email,
    replyTo: artist.email,
    subject: `${artist.studio_name} vous invite à rejoindre ${studio.name} sur Inkflow`,
    body: [
      `${artist.studio_name} vous invite à rejoindre le studio ${studio.name}.`,
      '',
      'Vous gardez vos propres tarifs, vos horaires, vos demandes et vos clients :',
      'le studio partage la page publique et l\'agenda, pas votre boîte de demandes.',
      '',
      `Créer votre compte : {{base_url}}/join/${token}`,
      `Cette invitation expire dans ${INVITE_DAYS} jours.`,
    ].join('\n'),
  });

  return { email, expires_at: expiresAt, token };
}

export async function cancelInvite(artist, inviteId) {
  requireOwner(artist);
  const db = await getDb();
  const info = await db.run(
    'DELETE FROM studio_invites WHERE id = ? AND studio_id = ? AND accepted_at IS NULL',
    [inviteId, artist.studio_id],
  );
  if (!info.changes) throw notFound('Invitation not found');
  return { cancelled: true };
}

export async function readInvite(token) {
  const db = await getDb();
  const invite = await db.get('SELECT * FROM studio_invites WHERE token = ?', [token]);
  if (!invite) throw notFound('Invitation not found');
  if (invite.accepted_at) throw conflict('This invitation has already been used');
  if (invite.expires_at <= nowIso()) throw conflict('This invitation has expired — ask the studio for a new one');
  const studio = await getStudio(invite.studio_id);
  return { invite, studio };
}

/** Marks the invitation used. The account itself is created by the signup route. */
export async function consumeInvite(token, artistId) {
  const db = await getDb();
  const { invite } = await readInvite(token);
  const members = await listMembers(invite.studio_id);
  if (members.length >= MAX_STUDIO_MEMBERS) throw conflict('That studio is full');

  await db.run('UPDATE studio_invites SET accepted_at = ? WHERE id = ?', [nowIso(), invite.id]);
  await db.run("UPDATE artists SET studio_id = ?, role = 'member' WHERE id = ?", [invite.studio_id, artistId]);
  return getStudio(invite.studio_id);
}

/**
 * Removing an artist never deletes their work: their bookings, their clients and
 * their history stay theirs. They leave with a studio of their own.
 */
export async function removeMember(artist, memberId) {
  requireOwner(artist);
  if (memberId === artist.id) throw bad('The owner cannot remove themselves — transfer the studio first');
  const db = await getDb();
  const member = await db.get('SELECT * FROM artists WHERE id = ? AND studio_id = ?', [memberId, artist.studio_id]);
  if (!member) throw notFound('That artist is not in your studio');

  let slug = member.slug;
  let n = 2;
  while (await db.get('SELECT id FROM studios WHERE slug = ?', [slug])) slug = `${member.slug}-${n++}`;
  const info = await db.run('INSERT INTO studios (name, slug, owner_id, created_at) VALUES (?, ?, ?, ?)',
    [member.studio_name, slug, member.id, nowIso()]);
  await db.run("UPDATE artists SET studio_id = ?, role = 'owner' WHERE id = ?", [info.lastInsertRowid, member.id]);

  await queueMessage({
    artistId: member.id,
    kind: 'studio_removed',
    recipient: member.email,
    replyTo: artist.email,
    subject: `Vous ne faites plus partie du studio`,
    body: [
      `Bonjour ${member.studio_name},`,
      '',
      'Votre compte a été détaché du studio. Rien n\'est perdu : vos demandes, vos',
      'séances, vos clients et vos tarifs restent les vôtres, et votre lien de',
      'réservation ne change pas.',
      '',
      'Votre espace : {{base_url}}/app',
    ].join('\n'),
  });
  return { removed: true };
}

/** The shared diary: who is tattooing what, and when — across the whole studio. */
export async function studioAgenda(studioId, { from = null, to = null } = {}) {
  const db = await getDb();
  const clauses = ['a.studio_id = ?', "ap.status = 'scheduled'"];
  const params = [studioId];
  if (from) { clauses.push('ap.ends_at >= ?'); params.push(from); }
  if (to) { clauses.push('ap.starts_at <= ?'); params.push(to); }

  return db.all(`
    SELECT ap.id, ap.starts_at, ap.ends_at, ap.status, ap.price_cents, ap.deposit_cents,
           a.id AS artist_id, a.studio_name AS artist_name,
           r.client_name, r.description, r.placement
    FROM appointments ap
    JOIN artists a ON a.id = ap.artist_id
    JOIN requests r ON r.id = ap.request_id
    WHERE ${clauses.join(' AND ')}
    ORDER BY ap.starts_at ASC
  `, params);
}

/**
 * The board every member sees: who is filling their week, and who is not.
 *
 * Volume is shared, because the diary already is — a studio that cannot see its
 * own load cannot plan a week. Money per artist is the owner's view only, plus
 * each artist's own row: the owner pays the bill, and nobody else needs to read
 * a colleague's takings.
 */
export async function studioStats(viewer, { days = 90 } = {}) {
  const db = await getDb();
  const studioId = await ensureStudio(viewer);
  const studio = await getStudio(studioId);
  const members = await listMembers(studioId);
  const ids = members.map((member) => member.id);
  if (!ids.length) return { studio, window_days: days, artists: [], totals: emptyTotals() };

  const holes = ids.map(() => '?').join(',');
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const now = nowIso();

  const requestRows = await db.all(
    `SELECT artist_id, status, COUNT(*) AS count FROM requests
     WHERE artist_id IN (${holes}) AND created_at >= ? GROUP BY artist_id, status`,
    [...ids, since],
  );
  const sessionRows = await db.all(
    `SELECT artist_id, status, COUNT(*) AS count,
            COALESCE(SUM(price_cents), 0) AS revenue,
            COALESCE(SUM(deposit_cents), 0) AS deposits
     FROM appointments WHERE artist_id IN (${holes}) AND starts_at >= ? GROUP BY artist_id, status`,
    [...ids, since],
  );
  const upcomingRows = await db.all(
    `SELECT artist_id, COUNT(*) AS count,
            COALESCE(SUM(price_cents), 0) AS revenue,
            COALESCE(SUM(deposit_cents), 0) AS deposits,
            COALESCE(SUM((julianday(ends_at) - julianday(starts_at)) * 24), 0) AS hours
     FROM appointments WHERE artist_id IN (${holes}) AND status = 'scheduled' AND starts_at >= ?
     GROUP BY artist_id`,
    [...ids, now],
  );

  const index = (rows) => {
    const out = new Map();
    for (const row of rows) {
      if (!out.has(row.artist_id)) out.set(row.artist_id, {});
      out.get(row.artist_id)[row.status] = row;
    }
    return out;
  };
  const byRequest = index(requestRows);
  const bySession = index(sessionRows);
  const byUpcoming = new Map(upcomingRows.map((row) => [row.artist_id, row]));

  const owner = isOwner(viewer);
  const totals = emptyTotals();
  const artists = members.map((member) => {
    const requests = byRequest.get(member.id) ?? {};
    const sessions = bySession.get(member.id) ?? {};
    const upcoming = byUpcoming.get(member.id) ?? { count: 0, revenue: 0, deposits: 0, hours: 0 };

    const requestCount = (status) => requests[status]?.count ?? 0;
    const sessionCount = (status) => sessions[status]?.count ?? 0;
    const totalRequests = Object.values(requests).reduce((sum, row) => sum + row.count, 0);
    const converted = CONVERTED_REQUEST_STATUSES.reduce((sum, status) => sum + requestCount(status), 0);
    const finished = sessionCount('completed') + sessionCount('no_show');

    const row = {
      artist_id: member.id,
      name: member.studio_name,
      slug: member.slug,
      role: member.role,
      you: member.id === viewer.id,
      accepting_requests: !!member.accepting_requests,
      requests: totalRequests,
      pending: requestCount('new'),
      quoted: requestCount('quoted'),
      conversion_rate: totalRequests ? converted / totalRequests : 0,
      completed: sessionCount('completed'),
      no_shows: sessionCount('no_show'),
      cancelled: sessionCount('cancelled'),
      no_show_rate: finished ? sessionCount('no_show') / finished : 0,
      upcoming: upcoming.count,
      upcoming_hours: Math.round((upcoming.hours ?? 0) * 10) / 10,
    };

    // Totals stay whole even when a row is redacted: the studio's own figure is
    // not a colleague's takings, and the owner sees it on the bill anyway.
    totals.requests += totalRequests;
    totals.completed += row.completed;
    totals.no_shows += row.no_shows;
    totals.upcoming += row.upcoming;
    totals.upcoming_hours += row.upcoming_hours;
    totals.revenue_cents += sessions.completed?.revenue ?? 0;
    totals.deposits_held_cents += upcoming.deposits ?? 0;

    if (owner || row.you) {
      row.revenue_cents = sessions.completed?.revenue ?? 0;
      row.deposits_held_cents = upcoming.deposits ?? 0;
      row.deposits_kept_cents = sessions.no_show?.deposits ?? 0;
    }
    return row;
  });

  totals.upcoming_hours = Math.round(totals.upcoming_hours * 10) / 10;
  return {
    studio: { id: studio.id, name: studio.name, slug: studio.slug },
    window_days: days,
    money_visible: owner,
    artists,
    totals,
  };
}

const CONVERTED_REQUEST_STATUSES = ['booked', 'completed', 'cancelled', 'no_show'];

const emptyTotals = () => ({
  requests: 0, completed: 0, no_shows: 0, upcoming: 0, upcoming_hours: 0,
  revenue_cents: 0, deposits_held_cents: 0,
});

/** The studio's public face: its artists and where to book each of them. */
export async function publicStudio(slug) {
  const studio = await getStudioBySlug(slug);
  if (!studio) throw notFound('Studio not found');
  const members = await listMembers(studio.id);
  return {
    studio: { name: studio.name, slug: studio.slug },
    artists: members.map((member) => ({
      studio_name: member.studio_name,
      slug: member.slug,
      city: member.city,
      styles: JSON.parse(member.styles || '[]'),
      accepting_requests: !!member.accepting_requests,
    })),
  };
}
