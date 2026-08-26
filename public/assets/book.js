import { api, toast, money, hours as formatHours, dateTime, esc, DETAIL_LABELS, COLOR_LABELS, setStudioZone } from './util.js';

const slug = decodeURIComponent(location.pathname.split('/').filter(Boolean)[1] ?? '');
const el = (id) => document.getElementById(id);
let artist = null;
let currency = 'EUR';

const DAY_NAMES = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];

/**
 * The days offered are the studio's own.
 *
 * This used to be a fixed list of weekdays, so a client could tick "lundi" at a
 * studio closed on Mondays — and the artist got a brief whose stated availability
 * was impossible before it was even read. The studio already publishes its week;
 * the form asks against it.
 */
function availabilityChoices(workingHours) {
  const open = (workingHours ?? []).map((day, index) => ({ ...day, index })).filter((day) => day.open);
  if (!open.length) return ['je suis flexible'];
  const choices = [];
  for (const day of open) {
    const from = Number(String(day.from).slice(0, 2));
    const to = Number(String(day.to).slice(0, 2));
    if (from < 13) choices.push(`${DAY_NAMES[day.index]} matin`);
    if (to > 13) choices.push(`${DAY_NAMES[day.index]} après-midi`);
  }
  choices.push('je suis flexible');
  return choices;
}

init();

async function init() {
  try {
    const data = await api('GET', `/api/public/artists/${encodeURIComponent(slug)}`);
    artist = data.artist;
    setStudioZone(artist.timezone);
    currency = artist.currency;
    renderArtist(data.options);
  } catch (err) {
    el('loading').textContent = err.status === 404
      ? 'Cette page de réservation n\'existe pas.'
      : err.message;
    return;
  }
  el('loading').classList.add('hidden');
  if (!artist.accepting_requests) {
    el('closed').classList.remove('hidden');
    el('closed-text').textContent = `${artist.studio_name} ne prend pas de nouveaux projets pour le moment. Revenez bientôt.`;
    return;
  }
  el('content').classList.remove('hidden');
  el('content-foot').classList.remove('hidden');
  wireForm();
  refreshEstimate();
}

function renderArtist(options) {
  document.title = `Réserver chez ${artist.studio_name} — Inkflow`;
  el('nav-studio').textContent = artist.city ? `${artist.studio_name} · ${artist.city}` : artist.studio_name;
  el('artist-name').textContent = artist.studio_name;
  el('artist-bio').textContent = artist.bio || 'Décrivez votre projet, vous recevez une estimation immédiate et un devis ferme sous peu.';
  el('artist-styles').textContent = artist.styles.length ? artist.styles.join(' · ') : 'Réservation en ligne';
  el('artist-minimum').textContent = money(artist.minimum_cents, currency);
  el('artist-cancel').textContent = `${artist.cancellation_hours} h avant`;

  el('styles').innerHTML = artist.styles.map((s) => `<option value="${esc(s)}">`).join('');
  el('color_mode').innerHTML = options.color_modes
    .map((v) => `<option value="${v}"${v === 'blackwork' ? ' selected' : ''}>${esc(COLOR_LABELS[v] ?? v)}</option>`).join('');
  el('detail_level').innerHTML = options.detail_levels
    .map((v) => `<option value="${v}"${v === 'medium' ? ' selected' : ''}>${esc(DETAIL_LABELS[v] ?? v)}</option>`).join('');
  el('availability').innerHTML = availabilityChoices(artist.working_hours)
    .map((day) => `<label class="chip"><input type="checkbox" value="${esc(day)}">${esc(day)}</label>`).join('');
  renderOpeningHours();
}

/** The studio's week, written out, so nobody has to guess which days exist. */
function renderOpeningHours() {
  const week = artist.working_hours ?? [];
  const open = week.map((day, index) => ({ ...day, index })).filter((day) => day.open);
  const host = el('opening-hours');
  if (!host) return;
  host.textContent = open.length
    ? `Ouvert ${open.map((day) => `${DAY_NAMES[day.index]} ${day.from}–${day.to}`).join(', ')}.`
    : '';
}

/**
 * The next few slots a piece this size would actually fit into. Not a booking
 * grid — the artist still chooses — but "roughly when" beats a client picking a
 * date out of the air and being told no.
 */
async function refreshSlots(durationHours) {
  const host = el('next-slots');
  if (!host) return;
  try {
    const { slots } = await api('GET',
      `/api/public/artists/${encodeURIComponent(slug)}/slots?hours=${encodeURIComponent(durationHours)}`);
    host.textContent = slots.length
      ? `Prochaines disponibilités pour ${durationHours} h : ${slots.map((slot) => dateTime(slot.starts_at)).join(' · ')}.`
      : 'Aucun créneau libre dans les quatre prochaines semaines — le studio vous proposera une date.';
  } catch {
    host.textContent = ''; // a missing hint must never block the form
  }
}

function wireForm() {
  const size = el('size');
  const sizeNumber = el('size-number');
  const syncSize = (value) => {
    const n = Math.min(200, Math.max(1, Number(value) || 1));
    sizeNumber.value = n;
    size.value = Math.min(60, Math.max(2, n));
    el('size-label').textContent = `${n} cm`;
    refreshEstimate();
  };
  size.addEventListener('input', (e) => syncSize(e.target.value));
  sizeNumber.addEventListener('input', (e) => syncSize(e.target.value));

  for (const id of ['color_mode', 'detail_level', 'placement', 'cover_up', 'budget']) {
    el(id).addEventListener('input', refreshEstimate);
  }
  el('brief-form').addEventListener('submit', submitBrief);
}

let debounce = null;
function refreshEstimate() {
  clearTimeout(debounce);
  debounce = setTimeout(runEstimate, 220);
}

async function runEstimate() {
  const payload = {
    size_cm: Number(el('size-number').value) || 1,
    color_mode: el('color_mode').value,
    detail_level: el('detail_level').value,
    placement: el('placement').value,
    cover_up: el('cover_up').checked,
    budget_cents: budgetCents(),
  };
  try {
    const { estimate } = await api('POST', `/api/public/artists/${encodeURIComponent(slug)}/estimate`, payload);
    el('estimate-range').textContent = `${money(estimate.low_cents, currency)} – ${money(estimate.high_cents, currency)}`;
    el('estimate-detail').textContent =
      `≈ ${formatHours(estimate.hours)} h de travail · ${estimate.sessions} séance${estimate.sessions > 1 ? 's' : ''}`
      + (estimate.spread_percent >= 18 ? ' · fourchette large sur un projet de cette taille' : '');
    el('estimate-deposit').textContent = money(estimate.deposit_cents, currency);
    renderFactors(estimate);
    pulseEstimate();
    // The first session, not the whole project: a nine-hour piece is booked in
    // instalments, and asking for a nine-hour slot finds nothing.
    refreshSlots(Math.min(estimate.hours, 6));

    const warning = el('budget-warning');
    if (!estimate.budget_realistic) {
      warning.classList.remove('hidden');
      warning.textContent = `Votre budget est ${money(estimate.budget_gap_cents, currency)} en dessous de la fourchette. `
        + 'Vous pouvez réduire la taille ou le niveau de détail — ou envoyer quand même, l\'artiste vous dira ce qui est faisable.';
    } else {
      warning.classList.add('hidden');
    }
  } catch (err) {
    el('estimate-detail').textContent = err.message;
  }
}

/**
 * The price is built from the tattoo's properties, so the client sees them —
 * a number with no explanation is a number nobody argues with or trusts.
 */
function renderFactors(estimate) {
  const rows = [
    `<div><span>Pièce de référence (${artist.reference_size_cm} cm)</span><b>${esc(money(estimate.reference_price_cents, currency))}</b></div>`,
    ...estimate.factors.map(({ label, factor }) => {
      const sign = factor > 1 ? '+' : '';
      const delta = `${sign}${Math.round((factor - 1) * 100)} %`;
      const tone = factor > 1 ? 'var(--warn)' : (factor < 1 ? 'var(--ok)' : 'var(--muted)');
      return `<div><span>${esc(label)}</span><b style="color:${tone}">${factor === 1 ? '—' : esc(delta)}</b></div>`;
    }),
  ];
  if (estimate.floored_by_minimum) {
    rows.push('<div><span>Minimum studio appliqué</span><b>—</b></div>');
  }
  el('estimate-factors').innerHTML = rows.join('');
}

// A brief sweep when the amount is recomputed: enough to notice, not enough to distract.
let pulseTimer = null;
function pulseEstimate() {
  const card = document.querySelector('.estimate-card');
  if (!card) return;
  card.classList.remove('refreshing');
  void card.offsetWidth; // restart the animation
  card.classList.add('refreshing');
  clearTimeout(pulseTimer);
  pulseTimer = setTimeout(() => card.classList.remove('refreshing'), 1000);
}

const budgetCents = () => {
  const value = Number(el('budget').value);
  return Number.isFinite(value) && value > 0 ? Math.round(value * 100) : null;
};

async function submitBrief(event) {
  event.preventDefault();
  const form = event.target;
  if (!form.reportValidity()) return;
  const button = form.querySelector('button[type=submit]');
  button.disabled = true;

  const payload = {
    client_name: el('client_name').value,
    client_email: el('client_email').value,
    client_phone: el('client_phone').value,
    description: el('description').value,
    style: el('style').value,
    placement: el('placement').value,
    size_cm: Number(el('size-number').value) || 1,
    color_mode: el('color_mode').value,
    detail_level: el('detail_level').value,
    cover_up: el('cover_up').checked,
    budget_cents: budgetCents(),
    reference_urls: el('references').value.split('\n').map((s) => s.trim()).filter(Boolean),
    availability: [...document.querySelectorAll('#availability input:checked')].map((input) => input.value),
    is_adult: el('is_adult').checked,
  };

  try {
    const data = await api('POST', `/api/public/artists/${encodeURIComponent(slug)}/requests`, payload);
    el('content').classList.add('hidden');
    el('content-foot').classList.add('hidden');
    el('sent').classList.remove('hidden');
    el('sent-text').textContent =
      `${artist.studio_name} a reçu votre projet. Estimation retenue : `
      + `${money(data.estimate.low_cents, currency)} – ${money(data.estimate.high_cents, currency)}. `
      + 'Vous recevrez le devis ferme par email.';
    el('sent-link').href = data.track_url;
    window.scrollTo({ top: 0, behavior: 'smooth' });
  } catch (err) {
    toast(err.message, 'error');
    button.disabled = false;
  }
}
