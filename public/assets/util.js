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

export const dateTime = (iso) => (iso ? new Date(iso).toLocaleString('fr-FR', {
  weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
}) : '—');

export const dateShort = (iso) => (iso ? new Date(iso).toLocaleDateString('fr-FR', {
  day: 'numeric', month: 'short', year: 'numeric',
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

/** Turns a datetime-local value into an ISO string, and back. */
export const toIso = (localValue) => (localValue ? new Date(localValue).toISOString() : null);
export function toLocalInput(iso) {
  const date = iso ? new Date(iso) : new Date();
  const offset = date.getTimezoneOffset() * 60000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
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
