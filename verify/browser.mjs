/**
 * What the tests cannot see.
 *
 * The unit and integration suites hold the data honest; they say nothing about
 * what a person actually looks at. This walks the real pages in a real browser
 * and asserts three things a server-side test structurally cannot: that no page
 * runs off the side of a phone, that nothing throws in the console, and that the
 * hours on screen are the studio's rather than the reader's.
 *
 * It found the dashboard overflowing every tab by 58px at 390px wide, and a
 * December session labelled with August's UTC offset. Neither had failed a test.
 *
 * Needs a running server and Playwright:
 *   npm start &
 *   npm run verify:browser
 *
 * INKFLOW_VERIFY_URL overrides the target (default http://127.0.0.1:3000).
 */
import { createRequire } from 'node:module';

const BASE = process.env.INKFLOW_VERIFY_URL ?? 'http://127.0.0.1:3000';
const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  console.error('Playwright introuvable. `npm i -D playwright` puis relancez.');
  process.exit(2);
}

const problems = [];
const say = console.log;
const complain = (line) => problems.push(line);

/* -------------------------------------------------------------- fresh data */

function session() {
  const jar = new Map();
  return async (method, path, body) => {
    const headers = { 'content-type': 'application/json' };
    if (jar.size) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    const res = await fetch(BASE + path, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const raw of res.headers.getSetCookie?.() ?? []) {
      const [pair] = raw.split(';');
      const i = pair.indexOf('=');
      jar.set(pair.slice(0, i), pair.slice(i + 1));
    }
    const textBody = await res.text();
    let data = null;
    try { data = textBody ? JSON.parse(textBody) : null; } catch { data = textBody; }
    return { status: res.status, data };
  };
}

const stamp = Date.now().toString(36);
const EMAIL = `verify-${stamp}@studio.example`;
const PASSWORD = 'motdepasse123';
// Deliberately a studio whose clock is neither the server's nor the reader's.
const TIMEZONE = 'America/Montreal';

const artist = session();
{
  const created = await artist('POST', '/api/auth/signup', {
    email: EMAIL, password: PASSWORD, studio_name: `Vérification ${stamp}`, city: 'Montréal',
  });
  if (created.status !== 201) {
    console.error(`Impossible de créer le studio de test : ${JSON.stringify(created.data)}`);
    process.exit(2);
  }
  await artist('PATCH', '/api/me', {
    timezone: TIMEZONE, currency: 'CAD', reference_price_cents: 22000, deposit_percent: 30,
  });
}
const slug = (await artist('GET', '/api/me')).data.artist.slug;

/** One request, quoted at a known hour, paid for. */
const visitor = session();
const START = '2026-09-15T18:00:00.000Z'; // 14:00 in Montréal, 20:00 in Paris
const token = (await visitor('POST', `/api/public/artists/${slug}/requests`, {
  client_name: 'Léa Fortin', client_email: 'lea@example.com',
  description: "Chouette lapone sur l'omoplate, noir et gris, beaucoup de texture.",
  size_cm: 18, color_mode: 'blackgrey', detail_level: 'high', is_adult: true,
})).data.request.public_token;
{
  const request = (await artist('GET', '/api/requests?status=new')).data.requests
    .find((row) => row.public_token === token);
  await artist('POST', `/api/requests/${request.id}/quote`, {
    outside_hours: true, price_cents: 68000, proposed_start: START, duration_hours: 4,
  });
  await visitor('POST', `/api/public/quotes/${token}/accept`);
}

/* ------------------------------------------------------------- the browser */

const browser = await chromium.launch();
// A reader in Paris looking at a studio in Montréal: the two clocks must never
// be mixed on screen without saying which is which.
const context = await browser.newContext({ timezoneId: 'Europe/Paris', locale: 'fr-FR' });

const watch = (page, where) => {
  page.on('console', (msg) => { if (msg.type() === 'error') complain(`${where} — console : ${msg.text()}`); });
  page.on('pageerror', (err) => complain(`${where} — exception : ${err.message}`));
  return page;
};
const read = async (page, selector) =>
  (await page.locator(selector).first().innerText()).replace(/\s+/g, ' ').trim();

const page = watch(await context.newPage(), '/app');
await page.goto(`${BASE}/login`);
await page.fill('#login-email', EMAIL);
await page.fill('#login-password', PASSWORD);
await page.click('#panel-login button[type=submit]');
await page.waitForURL('**/app');
await page.waitForSelector('#stats .stat');

say(`entête          : ${await read(page, '#hello')}`);
say(`tuiles          : ${await page.locator('#stats .stat').count()}`);

const zoneBanner = page.locator('#agenda-zone');
if (!(await zoneBanner.isVisible())) {
  complain('le bandeau de fuseau devrait apparaître pour un lecteur hors du fuseau du studio');
} else {
  say(`bandeau fuseau  : ${await read(page, '#agenda-zone')}`);
}

await page.click('.tab[data-panel=agenda]');
await page.waitForTimeout(500);
const agenda = await read(page, '#appointments');
say(`agenda          : ${agenda.slice(0, 80)}`);
if (!/14:00/.test(agenda)) complain(`l'agenda n'affiche pas l'heure du studio : ${agenda.slice(0, 120)}`);
if (/20:00/.test(agenda)) complain("l'agenda affiche l'heure du navigateur");

// A wall clock typed into a datetime-local must come back as the same wall clock.
await page.fill('#block-start', '2026-11-02T09:00');
await page.fill('#block-end', '2026-11-02T18:00');
await page.fill('#block-label', 'Vérification fuseau');
await page.click('#block-form button[type=submit]');
await page.waitForTimeout(700);
const blocks = await read(page, '#blocks');
say(`congés          : ${blocks.slice(0, 80)}`);
if (!/09:00/.test(blocks)) complain(`un créneau bloqué ne se relit pas tel qu'il a été saisi : ${blocks.slice(0, 120)}`);

await page.click('.tab[data-panel=studio]');
await page.waitForSelector('#studio-stats .item');
const board = await read(page, '#studio-stats');
say(`par artiste     : ${board.slice(0, 110)}`);
for (const needle of ['Demandes', 'Conversion', 'No-show', 'Tout le studio']) {
  if (!board.includes(needle)) complain(`le tableau par artiste ne montre pas « ${needle} »`);
}

const track = watch(await context.newPage(), '/q/:token');
await track.goto(`${BASE}/q/${token}`);
await track.waitForSelector('#view:not(.hidden)');
say(`page client     : ${await read(track, '#headline')}`);
const detail = await read(track, '#panel');
if (!/14:00/.test(detail)) complain(`la page client n'affiche pas l'heure du studio : ${detail.slice(0, 120)}`);
if (!/Montréal/.test(detail)) complain('la page client ne nomme pas le fuseau à un lecteur qui est ailleurs');

const book = watch(await context.newPage(), '/b/:slug');
await book.goto(`${BASE}/b/${slug}`);
await book.waitForSelector('#brief-form');
await book.fill('#size-number', '18');
await book.locator('#size-number').dispatchEvent('input');
await book.waitForTimeout(800);
say(`estimation      : ${await read(book, '#estimate-range')} — ${await read(book, '#estimate-detail')}`);

/* ------------------------------------------------------------------ mobile */

/**
 * The worst overflow over a window, not a single reading.
 *
 * A sweep animation on the estimate card pushed the booking page 388px sideways
 * for about a second after every keystroke, and settled before and after. One
 * measurement at an arbitrary moment saw nothing. Anything that moves has to be
 * watched while it moves.
 */
async function worstOverflow(target, { samples = 12, everyMs = 150 } = {}) {
  let worst = 0;
  for (let i = 0; i < samples; i += 1) {
    const over = await target.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    if (over > worst) worst = over;
    await target.waitForTimeout(everyMs);
  }
  return worst;
}

// Logged out, so /login is really /login rather than a redirect to /app.
const phone = watch(await (await browser.newContext({ locale: 'fr-FR' })).newPage(), 'mobile');
await phone.setViewportSize({ width: 390, height: 844 });
for (const path of ['/', `/b/${slug}`, `/q/${token}`, '/login', `/s/${slug}`]) {
  await phone.goto(BASE + path);
  // Typing is what triggers the estimate to redraw, and the redraw is what used
  // to overflow. Measuring a page at rest would miss it.
  if (path.startsWith('/b/')) {
    await phone.waitForSelector('#size-number');
    await phone.fill('#size-number', '27');
    await phone.locator('#size-number').dispatchEvent('input');
  }
  await phone.waitForTimeout(300);
  const over = await worstOverflow(phone);
  say(`débord 390px ${path.slice(0, 20).padEnd(22)} : ${over}px`);
  if (over > 0) complain(`${path} déborde de ${over}px sur mobile`);
}

// The dashboard is the widest thing here, and the one an artist opens between
// two sessions with a phone in one hand.
const appPhone = watch(await context.newPage(), 'mobile /app');
await appPhone.setViewportSize({ width: 390, height: 844 });
await appPhone.goto(`${BASE}/app`);
await appPhone.waitForSelector('#stats .stat');
for (const panel of ['inbox', 'agenda', 'outbox', 'studio', 'settings']) {
  await appPhone.click(`.tab[data-panel=${panel}]`);
  await appPhone.waitForTimeout(300);
  const over = await worstOverflow(appPhone, { samples: 8 });
  say(`débord 390px /app ${panel.padEnd(17)} : ${over}px`);
  if (over > 0) complain(`/app onglet ${panel} déborde de ${over}px sur mobile`);
}

await browser.close();
console.log(problems.length
  ? `\nPROBLÈMES :\n- ${problems.join('\n- ')}`
  : '\nAucun problème détecté.');
process.exit(problems.length ? 1 : 0);
