import { api, esc } from './util.js';

const slug = decodeURIComponent(location.pathname.split('/').filter(Boolean)[1] ?? '');
const el = (id) => document.getElementById(id);

load();

async function load() {
  let data;
  try {
    data = await api('GET', `/api/public/studios/${encodeURIComponent(slug)}`);
  } catch (err) {
    el('loading').textContent = err.status === 404 ? "Ce studio n'existe pas." : err.message;
    return;
  }

  el('loading').classList.add('hidden');
  el('content').classList.remove('hidden');
  el('studio-name').textContent = data.studio.name;
  el('nav-studio').textContent = data.studio.name;
  document.title = `${data.studio.name} — réserver`;

  el('artists').innerHTML = data.artists.map((artist) => `
    <article class="card feature">
      <h3>${esc(artist.studio_name)}</h3>
      <p class="muted" style="margin:.4rem 0 .8rem;font-size:.9rem">
        ${artist.styles.length ? esc(artist.styles.join(' · ')) : 'Sur rendez-vous'}${artist.city ? ` — ${esc(artist.city)}` : ''}
      </p>
      ${artist.accepting_requests
        ? `<a class="btn btn-block tap" href="/b/${esc(artist.slug)}">Demander un rendez-vous</a>`
        : '<span class="badge">Ne prend pas de nouveaux projets</span>'}
    </article>`).join('');
}
