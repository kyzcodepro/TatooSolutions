// The provider adapters are pure request builders: given a key and a mail, they
// produce one HTTP call. A fake fetch is enough to pin every field down.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTransport, senderFor, splitAddress, renderBody } from '../src/mailer.js';

const message = {
  channel: 'email',
  recipient: 'camille@example.test',
  subject: 'Votre devis',
  body: 'Bonjour,\nSuivi : {{base_url}}/q/abc',
  artist_email: 'contact@atelier-noir.fr',
  studio_name: 'Atelier Noir',
  kind: 'quote_sent',
};

function capture(response = { ok: true, status: 200 }) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return { ...response, text: async () => response.text ?? '' };
  };
  return { calls, fetchImpl };
}

beforeEach(() => {
  process.env.INKFLOW_MAIL_KEY = 'test-key';
  process.env.INKFLOW_MAIL_FROM = 'no-reply@inkflow.app';
  process.env.INKFLOW_BASE_URL = 'https://studio.example';
  delete process.env.INKFLOW_MAIL_PROVIDER;
});

test('an address is split, and the studio name fronts a bare sender', () => {
  assert.deepEqual(splitAddress('"Atelier Noir" <a@b.co>'), { name: 'Atelier Noir', address: 'a@b.co' });
  assert.deepEqual(splitAddress('a@b.co'), { name: '', address: 'a@b.co' });
  // The client should recognise the studio in their inbox, not the platform.
  assert.equal(senderFor('no-reply@inkflow.app', 'Atelier Noir'), '"Atelier Noir" <no-reply@inkflow.app>');
  // An explicit display name is left alone, and a quote cannot break the header.
  assert.equal(senderFor('"Inkflow" <no-reply@inkflow.app>', 'Atelier'), '"Inkflow" <no-reply@inkflow.app>');
  assert.equal(senderFor('no-reply@inkflow.app', 'L"Atelier'), `"L'Atelier" <no-reply@inkflow.app>`);
});

test('the tracking link is resolved before sending, never after', () => {
  assert.equal(renderBody(message), 'Bonjour,\nSuivi : https://studio.example/q/abc');
});

test('resend receives the documented shape', async () => {
  process.env.INKFLOW_MAIL_PROVIDER = 'resend';
  const { calls, fetchImpl } = capture();
  await createTransport({ fetchImpl })(message);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.resend.com/emails');
  assert.equal(calls[0].init.headers.authorization, 'Bearer test-key');
  assert.deepEqual(calls[0].body.to, ['camille@example.test']);
  assert.equal(calls[0].body.from, '"Atelier Noir" <no-reply@inkflow.app>');
  assert.deepEqual(calls[0].body.reply_to, ['contact@atelier-noir.fr']);
  assert.match(calls[0].body.text, /https:\/\/studio\.example\/q\/abc/);
});

test('postmark receives the documented shape', async () => {
  process.env.INKFLOW_MAIL_PROVIDER = 'postmark';
  const { calls, fetchImpl } = capture();
  await createTransport({ fetchImpl })(message);

  assert.equal(calls[0].url, 'https://api.postmarkapp.com/email');
  assert.equal(calls[0].init.headers['X-Postmark-Server-Token'], 'test-key');
  assert.equal(calls[0].body.To, 'camille@example.test');
  assert.equal(calls[0].body.ReplyTo, 'contact@atelier-noir.fr');
  assert.equal(calls[0].body.MessageStream, 'outbound');
});

test('brevo receives the documented shape', async () => {
  process.env.INKFLOW_MAIL_PROVIDER = 'brevo';
  const { calls, fetchImpl } = capture();
  await createTransport({ fetchImpl })(message);

  assert.equal(calls[0].url, 'https://api.brevo.com/v3/smtp/email');
  assert.equal(calls[0].init.headers['api-key'], 'test-key');
  assert.deepEqual(calls[0].body.sender, { name: 'Atelier Noir', email: 'no-reply@inkflow.app' });
  assert.deepEqual(calls[0].body.to, [{ email: 'camille@example.test' }]);
});

test('a provider that refuses the message fails loudly', async () => {
  process.env.INKFLOW_MAIL_PROVIDER = 'resend';
  const { fetchImpl } = capture({ ok: false, status: 422, text: 'domain not verified' });
  await assert.rejects(createTransport({ fetchImpl })(message), /HTTP 422.*domain not verified/);
});

test('a network failure fails loudly too', async () => {
  process.env.INKFLOW_MAIL_PROVIDER = 'resend';
  const fetchImpl = async () => { throw new Error('getaddrinfo ENOTFOUND'); };
  await assert.rejects(createTransport({ fetchImpl })(message), /resend: getaddrinfo ENOTFOUND/);
});

test('missing configuration is refused before anything is sent', async () => {
  process.env.INKFLOW_MAIL_PROVIDER = 'resend';
  delete process.env.INKFLOW_MAIL_KEY;
  const { calls, fetchImpl } = capture();
  await assert.rejects(createTransport({ fetchImpl })(message), /INKFLOW_MAIL_KEY is required/);

  process.env.INKFLOW_MAIL_KEY = 'test-key';
  delete process.env.INKFLOW_MAIL_FROM;
  await assert.rejects(createTransport({ fetchImpl })(message), /INKFLOW_MAIL_FROM is required/);
  assert.equal(calls.length, 0, 'nothing reached the network');

  process.env.INKFLOW_MAIL_PROVIDER = 'pigeon';
  assert.throws(() => createTransport({ fetchImpl }), /Unknown INKFLOW_MAIL_PROVIDER "pigeon"/);
});

test('without a provider nothing leaves the machine', async () => {
  process.env.INKFLOW_QUIET = '1';
  const { calls, fetchImpl } = capture();
  await createTransport({ fetchImpl })(message);
  assert.equal(calls.length, 0);
});
