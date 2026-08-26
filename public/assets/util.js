// Shared front-end helpers: one fetch wrapper, one toast host, a few formatters.

export async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!res.ok) {
    const error = new Error(data?.error || `Erreur ${res.status}`);
    error.status = res.status;
    throw error;
  }
  return data;
}

let toastHost = null;
export function toast(message, kind = 'ok') {
  if (!toastHost) {
    toastHost = document.createElement('div');
    toastHost.className = 'toast-host';
    document.body.appendChild(toastHost);
  }
  const el = document.createElement('div');
  el.className = `toast toast-${kind}`;
  el.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  el.textContent = message;
  toastHost.appendChild(el);
  setTimeout(() => el.remove(), 5200);
}

export const money = (cents, currency = 'EUR') => new Intl.NumberFormat('fr-FR', {
  style: 'currency', currency, minimumFractionDigits: 0, maximumFractionDigits: 0,
}).format((Number(cents) || 0) / 100);

export const euros = (cents) => Math.round((Number(cents) || 0) / 100);

/**
 * Dates belong to the studio, not to the reader.
 *
 * A session happens at a place, on that place's clock. Rendering it in the
 * browser's zone means an artist on tour, or a client abroad, reads an hour that
 * does not exist in the studio's day. Every page sets this once, as soon as it
 * knows whose studio it is showing.
 */
let studioZone = null;

export function setStudioZone(timeZone) {
  if (!timeZone) return;
  try {
    new Intl.DateTimeFormat('fr-FR', { timeZone }).format(0);
    studioZone = timeZone;
  } catch {
    studioZone = null; // unknown zone: fall back to the browser rather than throw
  }
}

export const studioTimeZone = () => studioZone;

const browserZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

/** True only when the reader is somewhere else — the only time a label helps. */
export function zoneDiffers() {
  return Boolean(studioZone) && studioZone !== browserZone();
}

/** "heure de Paris (UTC+2)", for when it differs. */
export function zoneNote(city = '') {
  if (!zoneDiffers()) return '';
  const parts = new Intl.DateTimeFormat('fr-FR', { timeZone: studioZone, timeZoneName: 'shortOffset' })
    .formatToParts(new Date());
  const offset = parts.find((part) => part.type === 'timeZoneName')?.value ?? studioZone;
  return `heure de ${city || studioZone.split('/').pop().replace(/_/g, ' ')} (${offset})`;
}

export const dateTime = (iso, timeZone = studioZone) => (iso ? new Date(iso).toLocaleString('fr-FR', {
  weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  ...(timeZone ? { timeZone } : {}),
}) : '—');

export const dateShort = (iso, timeZone = studioZone) => (iso ? new Date(iso).toLocaleDateString('fr-FR', {
  day: 'numeric', month: 'short', year: 'numeric',
  ...(timeZone ? { timeZone } : {}),
}) : '—');

export function relative(iso) {
  if (!iso) return '';
  const diff = new Date(iso).getTime() - Date.now();
  if (Math.abs(diff) < 60000) return 'à l\'instant';
  const days = Math.round(diff / 86400000);
  const fmt = new Intl.RelativeTimeFormat('fr', { numeric: 'auto' });
  if (Math.abs(days) >= 1) return fmt.format(days, 'day');
  const hours = Math.round(diff / 3600000);
  if (Math.abs(hours) >= 1) return fmt.format(hours, 'hour');
  return fmt.format(Math.round(diff / 60000), 'minute');
}

export const hours = (value) => new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 2 }).format(Number(value) || 0);

export const percent = (value) => `${Math.round((Number(value) || 0) * 100)} %`;

export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

export const STATUS_LABELS = {
  new: 'Nouvelle', quoted: 'Devis envoyé', booked: 'Réservé', completed: 'Terminé',
  declined: 'Refusé', expired: 'Expiré', scheduled: 'Programmé', no_show: 'No-show', cancelled: 'Annulé',
};

export const statusBadge = (status) => `<span class="badge badge-${esc(status)}">${esc(STATUS_LABELS[status] ?? status)}</span>`;

/**
 * <input type="datetime-local"> speaks wall clock with no zone attached, and the
 * browser assumes its own. An artist away from the studio would then block, or
 * move, a slot several hours off. These two convert against the studio's zone —
 * the same two-pass offset lookup the server uses, so a clock-change day lands
 * on the instant the artist actually meant.
 */
function offsetAt(utcMs, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(utcMs)).map((part) => [part.type, part.value]));
  return Date.UTC(
    Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    Number(parts.hour) % 24, Number(parts.minute), Number(parts.second),
  ) - utcMs;
}

export const toIso = (localValue) => {
  if (!localValue) return null;
  if (!studioZone) return new Date(localValue).toISOString();
  const [date, time = '00:00'] = String(localValue).split('T');
  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const firstPass = guess - offsetAt(guess, studioZone);
  return new Date(guess - offsetAt(firstPass, studioZone)).toISOString();
};

export function toLocalInput(iso) {
  const date = iso ? new Date(iso) : new Date();
  if (!studioZone) {
    return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  }
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: studioZone, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(date).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${String(Number(parts.hour) % 24).padStart(2, '0')}:${parts.minute}`;
}

export const DETAIL_LABELS = {
  simple: 'Simple (lignes, peu de détails)',
  medium: 'Moyen (ombrage classique)',
  high: 'Détaillé (textures, dégradés)',
  hyperrealism: 'Hyperréalisme / micro-détails',
};

export const COLOR_LABELS = {
  linework: 'Ligne seule',
  blackwork: 'Noir plein',
  blackgrey: 'Noir & gris',
  color: 'Couleur',
};
