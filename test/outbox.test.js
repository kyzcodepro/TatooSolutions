// What happens when a send fails is the part that matters: a reminder recorded
// as delivered but never sent is a no-show nobody saw coming.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'inkflow-outbox-'));
process.env.INKFLOW_DB = join(dir, 'outbox.sqlite');
process.env.INKFLOW_QUIET = '1';
delete process.env.INKFLOW_MAIL_PROVIDER;

const { getDb, resetDb, nowIso } = await import('../src/db.js');
const { queueMessage, dispatchDue, MAX_SEND_ATTEMPTS } = await import('../src/messages.js');

const db = await getDb();
await db.run(`
  INSERT INTO artists (email, password_hash, password_salt, studio_name, slug, created_at)
  VALUES (?, ?, ?, ?, ?, ?)
`, ['contact@atelier-noir.fr', 'x', 'y', 'Atelier Noir', 'atelier-noir', nowIso()]);
const artist = await db.get('SELECT * FROM artists WHERE slug = ?', ['atelier-noir']);

after(async () => {
  await resetDb();
  rmSync(dir, { recursive: true, force: true });
});

const queue = (kind) => queueMessage({
  artistId: artist.id, kind, recipient: 'camille@example.test',
  subject: 'Demain, 10:00', body: 'Rappel — {{base_url}}/q/abc',
});

const load = (id) => db.get('SELECT * FROM messages WHERE id = ?', [id]);

test('a message the provider refused stays pending, with the reason kept', async () => {
  const id = await queue('reminder_24h');
  const failing = async () => { throw new Error('resend refused the message (HTTP 422) domain not verified'); };

  const sent = await dispatchDue(nowIso(), failing);
  assert.equal(sent, 0, 'nothing was reported as sent');

  const row = await load(id);
  assert.equal(row.sent_at, null, 'a failed send is never recorded as delivered');
  assert.equal(row.attempts, 1);
  assert.match(row.last_error, /domain not verified/);
});

test('the next pass picks it up again and clears the error', async () => {
  const seen = [];
  const sent = await dispatchDue(nowIso(), async (message) => { seen.push(message); });
  assert.equal(sent, 1);

  const row = await load(seen[0].id);
  assert.ok(row.sent_at, 'now recorded as delivered');
  assert.equal(row.last_error, null);
  assert.equal(row.attempts, 2, 'the failed attempt still counts');

  // The transport is handed what it needs to address the studio properly.
  assert.equal(seen[0].artist_email, 'contact@atelier-noir.fr');
  assert.equal(seen[0].studio_name, 'Atelier Noir');
});

test('a message already sent is never sent twice', async () => {
  assert.equal(await dispatchDue(nowIso(), async () => {}), 0);
});

test('a hopeless message is abandoned instead of retried forever', async () => {
  const id = await queue('reminder_7d');
  const failing = async () => { throw new Error('mailbox does not exist'); };

  for (let pass = 0; pass < MAX_SEND_ATTEMPTS + 2; pass++) {
    await dispatchDue(nowIso(), failing);
  }
  const row = await load(id);
  assert.equal(row.attempts, MAX_SEND_ATTEMPTS, 'it stops at the cap, it does not keep counting');
  assert.equal(row.sent_at, null);

  // And it no longer occupies the queue, even for a transport that would work.
  const seen = [];
  await dispatchDue(nowIso(), async (m) => { seen.push(m.id); });
  assert.ok(!seen.includes(id));
});

test('a message scheduled for later is left alone', async () => {
  const later = new Date(Date.now() + 3 * 86400000).toISOString();
  const id = await queueMessage({
    artistId: artist.id, kind: 'aftercare_d7', recipient: 'camille@example.test',
    subject: 'Jour 7', body: 'Ça pèle, c\'est normal.', scheduledFor: later,
  });
  const seen = [];
  await dispatchDue(nowIso(), async (m) => { seen.push(m.id); });
  assert.ok(!seen.includes(id), 'the schedule is respected');

  await dispatchDue(later, async (m) => { seen.push(m.id); });
  assert.ok(seen.includes(id), 'and honoured when its time comes');
});
