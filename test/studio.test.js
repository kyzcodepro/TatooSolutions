// What a studio shares and what it does not is the design. It shares a page, a
// diary and a bill; it does not share an inbox.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'inkflow-studio-'));
process.env.INKFLOW_DB = join(dir, 'studio.sqlite');
process.env.INKFLOW_QUIET = '1';
process.env.INKFLOW_DEMO = '0';
process.env.INKFLOW_SECRET = 'a-long-shared-secret-for-studio-tests';

const { createApp } = await import('../src/server.js');
const { getDb, resetDb } = await import('../src/db.js');
const { MAX_STUDIO_MEMBERS } = await import('../src/studio.js');

const server = createApp();
await new Promise((done) => server.listen(0, done));
const base = `http://127.0.0.1:${server.address().port}`;

after(async () => {
  await new Promise((done) => server.close(done));
  await resetDb();
  rmSync(dir, { recursive: true, force: true });
});

function client() {
  const jar = new Map();
  return async function call(method, path, body) {
    const headers = { 'content-type': 'application/json' };
    if (jar.size) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    const res = await fetch(base + path, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const raw of res.headers.getSetCookie?.() ?? []) {
      const [pair] = raw.split(';');
      const idx = pair.indexOf('=');
      jar.set(pair.slice(0, idx), pair.slice(idx + 1));
    }
    const text = await res.text();
    return { status: res.status, data: text ? JSON.parse(text) : null };
  };
}

let seq = 0;
async function newOwner(name = 'Atelier') {
  const call = client();
  const n = ++seq;
  const res = await call('POST', '/api/auth/signup', {
    email: `owner${n}@studio.example`, password: 'motdepasse123', studio_name: `${name} ${n}`, city: 'Lyon',
  });
  assert.equal(res.status, 201);
  return { call, artist: res.data.artist };
}

/** The token only exists in the invitation email, which is where we read it. */
async function inviteToken(ownerCall, email) {
  const sent = await ownerCall('POST', '/api/studio/invites', { email });
  assert.equal(sent.status, 201);
  assert.equal(sent.data.token, undefined, 'the token is not echoed back to the caller');
  const messages = (await ownerCall('GET', '/api/messages')).data.messages;
  const invite = messages.find((m) => m.kind === 'studio_invite' && m.recipient === email);
  assert.ok(invite, 'the invitation was sent by email');
  return invite.body.match(/\/join\/([a-f0-9]+)/)[1];
}

test('signing up founds a studio of one, owned by you', async () => {
  const { call, artist } = await newOwner();
  assert.equal(artist.role, 'owner');

  const view = (await call('GET', '/api/studio')).data;
  assert.equal(view.is_owner, true);
  assert.equal(view.members.length, 1);
  assert.equal(view.members[0].you, true);
  assert.equal(view.seats.max, MAX_STUDIO_MEMBERS);
});

test('an invited artist joins the studio and keeps their own booking page', async () => {
  const owner = await newOwner('Atelier Noir');
  const token = await inviteToken(owner.call, 'joiner@studio.example');

  const invited = client();
  const preview = await invited('GET', `/api/public/invites/${token}`);
  assert.equal(preview.status, 200);
  assert.equal(preview.data.email, 'joiner@studio.example');

  const joined = await invited('POST', '/api/auth/signup', {
    email: 'joiner@studio.example', password: 'motdepasse123', studio_name: 'Nina Ink', invite: token,
  });
  assert.equal(joined.status, 201);
  assert.equal(joined.data.artist.role, 'member');
  assert.equal(joined.data.artist.studio_id, owner.artist.studio_id);
  // Their own page, their own slug: joining a studio is not losing your name.
  assert.notEqual(joined.data.artist.slug, owner.artist.slug);

  const view = (await owner.call('GET', '/api/studio')).data;
  assert.equal(view.members.length, 2);
  assert.equal(view.pending_invites.length, 0, 'the invitation is spent');

  // A single-use token cannot seat a second person.
  const again = await client()('POST', '/api/auth/signup', {
    email: 'someone-else@studio.example', password: 'motdepasse123', studio_name: 'Autre', invite: token,
  });
  assert.equal(again.status, 409);
});

test('a studio does not share its inbox', async () => {
  const owner = await newOwner();
  const token = await inviteToken(owner.call, 'member@studio.example');
  const member = client();
  await member('POST', '/api/auth/signup', {
    email: 'member@studio.example', password: 'motdepasse123', studio_name: 'Membre', invite: token,
  });

  // A client writes to the owner.
  const anon = client();
  await anon('POST', `/api/public/artists/${owner.artist.slug}/requests`, {
    client_name: 'Camille Roy', client_email: 'camille@studio.example',
    description: 'Un serpent enroulé autour d\'une pivoine, avant-bras.',
    size_cm: 18, color_mode: 'blackgrey', detail_level: 'high', is_adult: true,
  });

  assert.equal((await owner.call('GET', '/api/requests')).data.requests.length, 1);
  assert.equal((await member('GET', '/api/requests')).data.requests.length, 0,
    'a colleague cannot read your negotiation with a client');
});

test('only the owner runs the studio', async () => {
  const owner = await newOwner();
  const token = await inviteToken(owner.call, 'member2@studio.example');
  const member = client();
  const joined = await member('POST', '/api/auth/signup', {
    email: 'member2@studio.example', password: 'motdepasse123', studio_name: 'Membre 2', invite: token,
  });

  const invited = await member('POST', '/api/studio/invites', { email: 'someone@studio.example' });
  assert.equal(invited.status, 403);
  const renamed = await member('PATCH', '/api/studio', { name: 'Chez moi' });
  assert.equal(renamed.status, 403);
  const removed = await member('DELETE', `/api/studio/members/${owner.artist.id}`);
  assert.equal(removed.status, 403);

  // And the owner cannot remove themselves and leave the studio headless.
  const self = await owner.call('DELETE', `/api/studio/members/${owner.artist.id}`);
  assert.equal(self.status, 400);
  assert.ok(joined.data.artist.id);
});

test('the seat count includes invitations still outstanding', async () => {
  const owner = await newOwner();
  for (let i = 0; i < MAX_STUDIO_MEMBERS - 1; i++) {
    const res = await owner.call('POST', '/api/studio/invites', { email: `seat${i}@studio.example` });
    assert.equal(res.status, 201, `seat ${i}`);
  }
  // One owner plus five invitations fills a studio of six.
  const full = await owner.call('POST', '/api/studio/invites', { email: 'one-too-many@studio.example' });
  assert.equal(full.status, 409);
  assert.match(full.data.error, /at most 6 artists/);

  const view = (await owner.call('GET', '/api/studio')).data;
  assert.equal(view.seats.used, MAX_STUDIO_MEMBERS);

  // Cancelling one frees the seat.
  await owner.call('DELETE', `/api/studio/invites/${view.pending_invites[0].id}`);
  const room = await owner.call('POST', '/api/studio/invites', { email: 'now-there-is-room@studio.example' });
  assert.equal(room.status, 201);

  const duplicate = await owner.call('POST', '/api/studio/invites', { email: 'now-there-is-room@studio.example' });
  assert.equal(duplicate.status, 409, 'the same address is not invited twice');
});

test('a removed artist leaves with their work and a studio of their own', async () => {
  const owner = await newOwner();
  const token = await inviteToken(owner.call, 'leaving@studio.example');
  const member = client();
  const joined = await member('POST', '/api/auth/signup', {
    email: 'leaving@studio.example', password: 'motdepasse123', studio_name: 'Partant', invite: token,
  });
  const memberId = joined.data.artist.id;

  const anon = client();
  await anon('POST', `/api/public/artists/${joined.data.artist.slug}/requests`, {
    client_name: 'Client Fidèle', client_email: 'fidele@studio.example',
    description: 'Une phalène sur l\'omoplate, trait fin, environ 12 cm.',
    size_cm: 12, color_mode: 'blackwork', detail_level: 'medium', is_adult: true,
  });

  assert.equal((await owner.call('DELETE', `/api/studio/members/${memberId}`)).status, 200);

  const after = (await member('GET', '/api/me')).data.artist;
  assert.equal(after.role, 'owner', 'they own their own studio now');
  assert.notEqual(after.studio_id, owner.artist.studio_id);
  // Nothing of theirs was deleted along the way.
  assert.equal((await member('GET', '/api/requests')).data.requests.length, 1);
  assert.equal((await owner.call('GET', '/api/studio')).data.members.length, 1);
});

test('the shared diary spans the studio, the public page lists it', async () => {
  const owner = await newOwner('Atelier Partagé');
  const token = await inviteToken(owner.call, 'diary@studio.example');
  const member = client();
  const joined = await member('POST', '/api/auth/signup', {
    email: 'diary@studio.example', password: 'motdepasse123', studio_name: 'Nina Diary', invite: token,
  });

  // The member books a session of their own.
  const anon = client();
  const created = await anon('POST', `/api/public/artists/${joined.data.artist.slug}/requests`, {
    client_name: 'Yanis', client_email: 'yanis@studio.example',
    description: 'Lettrage fin sur l\'avant-bras, environ 8 cm.',
    size_cm: 8, color_mode: 'linework', detail_level: 'simple', is_adult: true,
  });
  const request = (await member('GET', '/api/requests')).data.requests[0];
  const start = new Date(Date.now() + 9 * 86400000);
  start.setUTCHours(10, 0, 0, 0);
  await member('POST', `/api/requests/${request.id}/quote`, {
    outside_hours: true, price_cents: 20000, proposed_start: start.toISOString(), duration_hours: 2,
  });
  await anon('POST', `/api/public/quotes/${created.data.request.public_token}/accept`);

  // The owner sees it in the studio diary without seeing the brief thread.
  const agenda = (await owner.call('GET', '/api/studio/agenda')).data.appointments;
  assert.equal(agenda.length, 1);
  assert.equal(agenda[0].artist_name, 'Nina Diary');
  assert.equal(agenda[0].client_name, 'Yanis');

  const studioSlug = (await owner.call('GET', '/api/studio')).data.studio.slug;
  const page = await client()('GET', `/api/public/studios/${studioSlug}`);
  assert.equal(page.status, 200);
  assert.equal(page.data.artists.length, 2);
  assert.ok(page.data.artists.some((a) => a.slug === joined.data.artist.slug));
});

test('an expired or unknown invitation is refused', async () => {
  const owner = await newOwner();
  const token = await inviteToken(owner.call, 'slow@studio.example');
  const db = await getDb();
  await db.run('UPDATE studio_invites SET expires_at = ? WHERE token = ?',
    [new Date(Date.now() - 1000).toISOString(), token]);

  const anon = client();
  assert.equal((await anon('GET', `/api/public/invites/${token}`)).status, 409);
  assert.equal((await anon('GET', '/api/public/invites/nope')).status, 404);

  const refused = await anon('POST', '/api/auth/signup', {
    email: 'slow@studio.example', password: 'motdepasse123', studio_name: 'Trop tard', invite: token,
  });
  assert.equal(refused.status, 409);
  // The account was not created on the way to being refused.
  const login = await anon('POST', '/api/auth/login', { email: 'slow@studio.example', password: 'motdepasse123' });
  assert.equal(login.status, 400);
});

test('an artist without a studio gets one instead of a broken dashboard', async () => {
  // Rows can be created outside the signup route — a seed, a migration, a script.
  const { getDb } = await import('../src/db.js');
  const { ensureStudio, studioView } = await import('../src/studio.js');
  const db = await getDb();
  const { nowIso } = await import('../src/db.js');

  await db.run(`
    INSERT INTO artists (email, password_hash, password_salt, studio_name, slug, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `, ['orphan@studio.example', 'x', 'y', 'Orpheline', 'orpheline', nowIso()]);
  const artist = await db.get('SELECT * FROM artists WHERE email = ?', ['orphan@studio.example']);
  assert.equal(artist.studio_id, null);

  const studioId = await ensureStudio(artist);
  assert.ok(studioId, 'a studio is founded on demand');

  const fresh = await db.get('SELECT * FROM artists WHERE id = ?', [artist.id]);
  assert.equal(fresh.studio_id, studioId);
  assert.equal(fresh.role, 'owner');

  const view = await studioView(fresh);
  assert.equal(view.members.length, 1);
  assert.equal(await ensureStudio(fresh), studioId, 'and not founded twice');
});

/* ------------------------------------------------------- statistics per artist */

const inDays = (days, hour = 12) => {
  const date = new Date(Date.now() + days * 86400000);
  date.setUTCHours(hour, 0, 0, 0);
  return date.toISOString();
};

/** Two artists under one roof, one of them with a paid session on the books. */
async function studioWithOneBooking() {
  const owner = await newOwner('Atelier Chiffres');
  const token = await inviteToken(owner.call, `member${seq}@studio.example`);
  const member = client();
  await member('POST', '/api/auth/signup', {
    email: `member${seq}@studio.example`, password: 'motdepasse123',
    studio_name: `Membre ${seq}`, invite: token,
  });

  const slug = owner.artist.slug;
  const visitor = client();
  const created = await visitor('POST', `/api/public/artists/${slug}/requests`, {
    client_name: 'Yann Le Goff', client_email: 'yann@example.com',
    description: "Poulpe sur l'épaule, blackwork dense, une séance.",
    size_cm: 20, color_mode: 'blackwork', detail_level: 'high', is_adult: true,
  });
  const publicToken = created.data.request.public_token;
  const request = (await owner.call('GET', '/api/requests?status=new')).data.requests
    .find((row) => row.public_token === publicToken);
  await owner.call('POST', `/api/requests/${request.id}/quote`, {
    outside_hours: true, price_cents: 60000, proposed_start: inDays(9), duration_hours: 4,
  });
  await visitor('POST', `/api/public/quotes/${publicToken}/accept`);
  return { owner: owner.call, member };
}

test('the studio board counts each artist separately', async () => {
  const { owner } = await studioWithOneBooking();

  const board = (await owner('GET', '/api/studio/stats')).data;
  assert.equal(board.artists.length, 2);
  assert.equal(board.money_visible, true);

  const ownerRow = board.artists.find((row) => row.you);
  const memberRow = board.artists.find((row) => !row.you);
  assert.equal(ownerRow.requests, 1);
  assert.equal(ownerRow.upcoming, 1);
  assert.equal(ownerRow.conversion_rate, 1);
  assert.equal(ownerRow.upcoming_hours, 4);
  assert.equal(memberRow.requests, 0, "a colleague's inbox is not mixed into yours");
  assert.equal(memberRow.upcoming, 0);
  assert.equal(board.totals.upcoming, 1);
  assert.ok(board.totals.deposits_held_cents > 0, 'the studio sees its own held deposits');
});

test('volume is shared with the studio, takings are not', async () => {
  const { member } = await studioWithOneBooking();

  const board = (await member('GET', '/api/studio/stats')).data;
  assert.equal(board.money_visible, false);

  const colleague = board.artists.find((row) => !row.you);
  assert.equal(colleague.upcoming, 1, 'volume is shared, like the diary');
  assert.equal(colleague.revenue_cents, undefined, 'takings are not');
  assert.equal(colleague.deposits_held_cents, undefined);

  const own = board.artists.find((row) => row.you);
  assert.equal(own.revenue_cents, 0, 'you always see your own row in full');
});

test('the board window is configurable and validated', async () => {
  const { call } = await newOwner('Fenêtre');
  assert.equal((await call('GET', '/api/studio/stats?days=30')).data.window_days, 30);
  assert.equal((await call('GET', '/api/studio/stats')).data.window_days, 90);
  assert.equal((await call('GET', '/api/studio/stats?days=0')).status, 400);
  assert.equal((await call('GET', '/api/studio/stats?days=nope')).status, 400);
});

test('the board is behind a session', async () => {
  assert.equal((await client()('GET', '/api/studio/stats')).status, 401);
});
