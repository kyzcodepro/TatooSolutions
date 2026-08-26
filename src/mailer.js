// Outbound email.
//
// Providers are thin adapters over one shape — a POST with an API key — so no
// SDK is needed and switching provider is a variable, not a rewrite. A failed
// send throws: the caller must not record a message as delivered when it is not.

const PROVIDERS = {
  /** https://resend.com — POST /emails */
  resend: {
    env: 'INKFLOW_MAIL_KEY',
    request(key, mail) {
      return {
        url: 'https://api.resend.com/emails',
        init: {
          method: 'POST',
          headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            from: mail.from,
            to: [mail.to],
            subject: mail.subject,
            text: mail.text,
            reply_to: mail.replyTo ? [mail.replyTo] : undefined,
          }),
        },
      };
    },
  },

  /** https://postmarkapp.com — POST /email */
  postmark: {
    env: 'INKFLOW_MAIL_KEY',
    request(key, mail) {
      return {
        url: 'https://api.postmarkapp.com/email',
        init: {
          method: 'POST',
          headers: {
            'X-Postmark-Server-Token': key,
            'content-type': 'application/json',
            accept: 'application/json',
          },
          body: JSON.stringify({
            From: mail.from,
            To: mail.to,
            Subject: mail.subject,
            TextBody: mail.text,
            ReplyTo: mail.replyTo || undefined,
            MessageStream: process.env.INKFLOW_MAIL_STREAM || 'outbound',
          }),
        },
      };
    },
  },

  /** https://brevo.com — POST /v3/smtp/email */
  brevo: {
    env: 'INKFLOW_MAIL_KEY',
    request(key, mail) {
      const { name, address } = splitAddress(mail.from);
      return {
        url: 'https://api.brevo.com/v3/smtp/email',
        init: {
          method: 'POST',
          headers: { 'api-key': key, 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({
            sender: name ? { name, email: address } : { email: address },
            to: [{ email: mail.to }],
            subject: mail.subject,
            textContent: mail.text,
            replyTo: mail.replyTo ? { email: mail.replyTo } : undefined,
          }),
        },
      };
    },
  },
};

export const providerNames = () => Object.keys(PROVIDERS);

/** Which provider is configured; `console` means nothing leaves the machine. */
export const configuredProvider = () => (process.env.INKFLOW_MAIL_PROVIDER || 'console').toLowerCase();

/** `"Studio" <a@b.c>` -> parts; a bare address has no name. */
export function splitAddress(value) {
  const match = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(value ?? '');
  if (match) return { name: match[1].trim(), address: match[2].trim() };
  return { name: '', address: (value ?? '').trim() };
}

/** The client should see the studio's name in their inbox, not the platform's. */
export function senderFor(from, studioName) {
  const { name, address } = splitAddress(from);
  if (name || !studioName || !address) return from;
  return `"${studioName.replace(/"/g, "'")}" <${address}>`;
}

// RFC 2606 / RFC 6761 reserve these for documentation and tests: no mail server
// will ever accept them. Sending anyway earns hard bounces, and a young sending
// domain pays for those in deliverability.
const RESERVED_DOMAINS = new Set(['example.com', 'example.net', 'example.org', 'example.edu']);
const RESERVED_TLDS = ['.test', '.example', '.invalid', '.localhost'];

export function isUndeliverable(address) {
  const at = String(address ?? '').lastIndexOf('@');
  if (at === -1) return true;
  const domain = address.slice(at + 1).toLowerCase();
  if (RESERVED_DOMAINS.has(domain)) return true;
  return RESERVED_TLDS.some((tld) => domain === tld.slice(1) || domain.endsWith(tld));
}

export function baseUrl() {
  return process.env.INKFLOW_BASE_URL || 'http://localhost:3000';
}

export const renderBody = (message) => message.body.replaceAll('{{base_url}}', baseUrl());

/**
 * Builds the transport the scheduler hands its due messages to.
 * Without INKFLOW_MAIL_PROVIDER nothing is sent anywhere: messages are logged,
 * which is what local development and the demo deployment want.
 */
export function createTransport({ fetchImpl = globalThis.fetch } = {}) {
  const name = configuredProvider();
  if (name === 'console') return consoleTransport;

  const provider = PROVIDERS[name];
  if (!provider) {
    throw new Error(`Unknown INKFLOW_MAIL_PROVIDER "${name}" — expected one of: ${providerNames().join(', ')}, console`);
  }

  return async function send(message) {
    const key = process.env[provider.env];
    if (!key) throw new Error(`${provider.env} is required to send with ${name}`);
    const from = process.env.INKFLOW_MAIL_FROM;
    if (!from) throw new Error('INKFLOW_MAIL_FROM is required to send email (a sender your provider has verified)');

    const { url, init } = provider.request(key, {
      from: senderFor(from, message.studio_name),
      to: message.recipient,
      // Replying should reach a person: the studio for a client's message, the
      // client for the studio's own notifications.
      replyTo: message.reply_to || message.artist_email || '',
      subject: message.subject,
      text: renderBody(message),
    });

    let res;
    try {
      res = await fetchImpl(url, init);
    } catch (err) {
      throw new Error(`${name}: ${err.message}`);
    }
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 300);
      throw new Error(`${name} refused the message (HTTP ${res.status}) ${detail}`.trim());
    }
  };
}

function consoleTransport(message) {
  if (process.env.INKFLOW_QUIET === '1') return;
  console.log(`[outbox] ${message.channel} → ${message.recipient} | ${message.subject}\n${renderBody(message)}\n`);
}
