import {
  api, toast, money, euros, dateTime, relative, percent, hours as formatHours, esc,
  statusBadge, toIso, toLocalInput, COLOR_LABELS, DETAIL_LABELS, setStudioZone, zoneNote,
} from './util.js';

const el = (id) => document.getElementById(id);
const MAX_SESSION_HOURS = 6;
let artist = null;
let filter = 'open';

const FILTERS = [
  ['open', 'À traiter'], ['new', 'Nouvelles'], ['quoted', 'Devis envoyés'],
  ['booked', 'Réservées'], ['completed', 'Terminées'], ['declined', 'Refusées'], ['', 'Toutes'],
];

boot();

async function boot() {
  const me = await api('GET', '/api/me').catch(() => null);
  if (!me?.artist) { location.href = '/login'; return; }
  artist = me.artist;
  setStudioZone(artist.timezone);
  renderHeader();
  wireCopyLink();
  wireTabs();
  wireSettings();
  wireBlocks();
  el('logout').addEventListener('click', async () => {
    await api('POST', '/api/auth/logout');
    location.href = '/';
  });
  el('dispatch').addEventListener('click', async () => {
    const { dispatched } = await api('POST', '/api/messages/dispatch');
    toast(dispatched ? `${dispatched} message(s) envoyé(s).` : 'Rien à envoyer pour l\'instant.');
    loadMessages();
  });

  el('filters').innerHTML = FILTERS
    .map(([value, label]) => `<button class="filter" data-filter="${value}" aria-pressed="${value === filter}">${label}</button>`)
    .join('');
  el('filters').addEventListener('click', (event) => {
    const button = event.target.closest('.filter');
    if (!button) return;
    filter = button.dataset.filter;
    for (const other of el('filters').children) other.setAttribute('aria-pressed', String(other === button));
    loadRequests();
  });

  // Independently: a panel that fails should cost its own contents, not the page.
  await Promise.all(
    [loadStats, loadRequests, loadAppointments, loadBlocks, loadMessages, loadStudio]
      .map((load) => load().catch((err) => console.error(`[panel] ${load.name}:`, err.message))),
  );
}

function renderHeader() {
  el('hello').textContent = artist.studio_name;
  el('nav-studio').textContent = artist.email;
  const url = `${location.origin}/b/${artist.slug}`;
  el('booking-link').textContent = url;
  el('open-link').href = `/b/${artist.slug}`;

  // Said out loud only when the artist is reading from another zone — on tour, or
  // travelling. Every hour on this screen is the studio's, and silently showing
  // one clock while the artist reads another is how a session gets missed.
  const note = zoneNote(artist.city);
  const banner = el('agenda-zone');
  banner.textContent = note ? `Toutes les heures sont données en ${note}.` : '';
  banner.classList.toggle('hidden', !note);
}

function wireCopyLink() {
  for (const [button, source] of [['copy-link', 'booking-link'], ['copy-studio', 'studio-link']]) {
    el(button).addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(el(source).textContent);
        toast('Lien copié.');
      } catch {
        toast('Copie impossible — sélectionnez le lien à la main.', 'error');
      }
    });
  }
}

// Opening a tab reloads it: a panel filled when the page booted goes stale the
// moment anything happens elsewhere — an invitation sent, a session marked done.
const PANEL_LOADERS = {
  inbox: () => loadRequests(),
  agenda: () => Promise.all([loadAppointments(), loadBlocks()]),
  outbox: () => loadMessages(),
  studio: () => loadStudio(),
};

function wireTabs() {
  const tabs = [...document.querySelectorAll('.tab[data-panel]')];
  for (const tab of tabs) {
    tab.addEventListener('click', () => {
      for (const other of tabs) {
        const active = other === tab;
        other.setAttribute('aria-selected', String(active));
        el(`panel-${other.dataset.panel}`).classList.toggle('hidden', !active);
      }
      PANEL_LOADERS[tab.dataset.panel]?.().catch((err) => toast(err.message, 'error'));
    });
  }
}

/* --------------------------------------------------------------------- stats */

async function loadStats() {
  const { stats } = await api('GET', '/api/stats');
  const tiles = [
    ['À répondre', stats.pending_replies, stats.pending_replies ? 'demandes en attente' : 'boîte vide', stats.pending_replies ? 'var(--accent)' : null],
    ['Séances à venir', stats.upcoming.count, `${stats.upcoming.hours} h réservées`],
    ['Acomptes encaissés', money(stats.upcoming.deposits_held_cents, artist.currency), 'sur les séances à venir'],
    ['CA réalisé (90 j)', money(stats.revenue_completed_cents, artist.currency), `${stats.completed} séance(s)`],
    ['Taux de no-show', percent(stats.no_show_rate), `${stats.no_shows} no-show · ${money(stats.deposits_kept_cents, artist.currency)} conservés`, stats.no_show_rate > 0.1 ? 'var(--danger)' : 'var(--ok)'],
    ['Conversion', percent(stats.conversion_rate), 'demandes → réservations'],
  ];
  el('stats').innerHTML = tiles.map(([label, value, sub, color]) => `
    <div class="stat">
      <div class="label">${esc(label)}</div>
      <div class="value"${color ? ` style="color:${color}"` : ''}>${esc(value)}</div>
      <div class="sub">${esc(sub)}</div>
    </div>`).join('');
}

/* ------------------------------------------------------------------ requests */

async function loadRequests() {
  const query = filter && filter !== 'open' ? `?status=${filter}` : '';
  const { requests } = await api('GET', `/api/requests${query}`);
  const list = filter === 'open' ? requests.filter((r) => r.status === 'new' || r.status === 'quoted') : requests;

  const waiting = requests.filter((r) => r.status === 'new').length;
  el('inbox-count').textContent = waiting || '';
  el('inbox-count').classList.toggle('hidden', waiting === 0);
  el('requests').innerHTML = list.length
    ? list.map(requestCard).join('')
    : '<div class="empty">Rien ici. Partagez votre lien de réservation pour remplir cette boîte.</div>';

  el('requests').querySelectorAll('[data-quote]').forEach((button) => {
    button.addEventListener('click', () => openQuoteModal(list.find((r) => r.id === Number(button.dataset.quote))));
  });
  el('requests').querySelectorAll('[data-decline]').forEach((button) => {
    button.addEventListener('click', () => declineRequest(Number(button.dataset.decline)));
  });
}

function requestCard(request) {
  const currency = artist.currency;
  const budget = request.budget_cents;
  const tooLow = budget && budget < request.estimate_low_cents;
  return `
    <article class="item${request.status === 'new' ? ' item-live' : ''}">
      <div class="row-between">
        <div>
          <div class="item-title">${esc(request.client_name)} — ${esc(request.description.slice(0, 80))}${request.description.length > 80 ? '…' : ''}</div>
          <div class="meta">
            <span>${esc(request.size_cm)} cm · ${esc(request.placement || 'zone à définir')} · ${esc(COLOR_LABELS[request.color_mode] ?? request.color_mode)}</span>
            <span>${esc(DETAIL_LABELS[request.detail_level] ?? request.detail_level)}</span>
            ${request.style ? `<span>Style : <b>${esc(request.style)}</b></span>` : ''}
            ${request.cover_up ? '<span><b>Cover-up</b></span>' : ''}
          </div>
          <div class="meta">
            <span>Estimation : <b>${money(request.estimate_low_cents, currency)} – ${money(request.estimate_high_cents, currency)}</b> (${esc(formatHours(request.estimated_hours))} h)</span>
            <span>Budget client : <b>${budget ? money(budget, currency) : 'non précisé'}</b></span>
            <span>${esc(request.client_email)}</span>
            ${request.client_phone ? `<span>${esc(request.client_phone)}</span>` : ''}
            <span class="faint">reçue ${esc(relative(request.created_at))}</span>
          </div>
          ${request.availability.length ? `<div class="meta"><span>Dispos : ${esc(request.availability.join(', '))}</span></div>` : ''}
          ${request.reference_urls.length ? `<div class="meta refs">${request.reference_urls.map((url, i) => `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">réf. ${i + 1}</a>`).join('')}</div>` : ''}
          ${tooLow ? `<div class="warn-line">Budget ${money(request.estimate_low_cents - budget, currency)} en dessous de votre fourchette basse.</div>` : ''}
          ${request.status === 'quoted' ? `<div class="meta"><span>Devis : <b>${money(request.quote_price_cents, currency)}</b> · acompte ${money(request.deposit_cents, currency)} · ${request.proposed_start ? esc(dateTime(request.proposed_start)) : 'sans date'} · expire ${esc(relative(request.quote_expires_at))}</span></div>` : ''}
          ${request.status === 'booked' ? `<div class="meta"><span>Acompte encaissé le ${esc(dateTime(request.deposit_paid_at))}</span></div>` : ''}
        </div>
        <div class="item-actions">
          ${statusBadge(request.status)}
          ${['new', 'quoted'].includes(request.status) ? `
            <div class="row" style="justify-content:flex-end">
              <button class="btn btn-sm" data-quote="${request.id}">${request.status === 'quoted' ? 'Modifier le devis' : 'Envoyer un devis'}</button>
              <button class="btn btn-sm btn-danger" data-decline="${request.id}">Refuser</button>
            </div>` : ''}
        </div>
      </div>
    </article>`;
}

async function declineRequest(id) {
  const reason = prompt('Motif du refus (visible par le client, facultatif) :', '');
  if (reason === null) return;
  try {
    await api('POST', `/api/requests/${id}/decline`, { reason });
    toast('Demande refusée, le client est prévenu.');
    await Promise.all([loadRequests(), loadStats(), loadMessages()]);
  } catch (err) {
    toast(err.message, 'error');
  }
}

/* -------------------------------------------------------------- quote modal */

function openQuoteModal(request) {
  const currency = artist.currency;
  const suggestedPrice = euros(Math.round((request.estimate_low_cents + request.estimate_high_cents) / 2));
  const price = request.quote_price_cents ? euros(request.quote_price_cents) : suggestedPrice;
  // What gets booked is the first session, not the whole project: the server caps
  // a slot at six hours, so proposing twenty would search for a day that does not
  // exist and offer nothing.
  const hours = Math.min(request.estimated_hours || 2, MAX_SESSION_HOURS);

  const host = el('modal-host');
  host.innerHTML = `
    <div class="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="quote-title">
      <div class="modal">
        <h3 id="quote-title">Devis pour ${esc(request.client_name)}</h3>
        <p class="muted" style="font-size:0.9rem">
          Estimation automatique : ${money(request.estimate_low_cents, currency)} – ${money(request.estimate_high_cents, currency)}
          sur ${esc(formatHours(request.estimated_hours))} h.
        </p>
        <div class="field-row">
          <div><label for="q-price">Prix ferme (€)</label><input id="q-price" type="number" min="5" step="5" value="${price}"></div>
          <div><label for="q-deposit">Acompte (€)</label><input id="q-deposit" type="number" min="0" step="5" value="${Math.round(price * artist.deposit_percent / 100 / 5) * 5}"></div>
        </div>
        <div class="field">
          <label>Prochaines disponibilités</label>
          <div class="slot-list" id="q-slots"><span class="faint" style="font-size:.85rem">Recherche…</span></div>
        </div>
        <div class="field-row">
          <div><label for="q-start">Créneau proposé</label><input id="q-start" type="datetime-local" value="${toLocalInput(request.proposed_start ?? nextWeek())}"></div>
          <div><label for="q-hours">Durée de la séance (h)</label><input id="q-hours" type="number" min="0.5" step="0.5" value="${hours}">
            <p class="hint">Durée de cette séance — plafonnée à 6 h ; au-delà, prévoyez-en une seconde.</p></div>
        </div>
        <div class="field"><label for="q-note">Mot pour le client</label>
          <textarea id="q-note" maxlength="1000" style="min-height:80px" placeholder="On commence par la ligne, une seconde séance pour l'ombrage.">${esc(request.artist_note ?? '')}</textarea></div>
        <div class="field"><label for="q-expires">Validité du devis (jours)</label>
          <input id="q-expires" type="number" min="1" max="60" value="7"></div>
        <div class="row" style="justify-content:flex-end;margin-top:1.2rem">
          <button class="btn btn-ghost" id="q-cancel">Annuler</button>
          <button class="btn" id="q-send">Envoyer le devis</button>
        </div>
      </div>
    </div>`;

  const close = () => { host.innerHTML = ''; };
  el('q-cancel').addEventListener('click', close);
  host.querySelector('.modal-backdrop').addEventListener('click', (event) => {
    if (event.target === event.currentTarget) close();
  });
  // Keep the deposit aligned with the artist's percentage while the price is edited.
  el('q-price').addEventListener('input', (event) => {
    const value = Number(event.target.value) || 0;
    el('q-deposit').value = Math.round(value * artist.deposit_percent / 100 / 5) * 5;
  });

  loadSlots(Number(el('q-hours').value));
  el('q-hours').addEventListener('change', (event) => loadSlots(Number(event.target.value)));

  el('q-send').addEventListener('click', async () => {
    const button = el('q-send');
    button.disabled = true;
    try {
      await sendQuote(request, false);
      close();
      toast('Devis envoyé. Le créneau se bloque à la réception de l\'acompte.');
      await Promise.all([loadRequests(), loadStats(), loadMessages()]);
    } catch (err) {
      toast(err.message, 'error');
      button.disabled = false;
    }
  });
}

/**
 * The slots this piece actually fits into: open days, free of sessions and
 * closed periods, past the studio's lead time. Proposing a date used to mean
 * typing one blind and discovering the clash afterwards.
 */
async function loadSlots(hours) {
  const host = el('q-slots');
  if (!host) return;
  try {
    const wanted = Math.min(Math.max(Number(hours) || 2, 0.5), MAX_SESSION_HOURS);
    // Six is enough to choose from; a wall of dates is not a decision aid.
    const { slots } = await api('GET', `/api/slots?hours=${encodeURIComponent(wanted)}&limit=6`);
    if (!slots.length) {
      host.innerHTML = '<span class="faint" style="font-size:.85rem">Aucun créneau libre sur les 4 prochaines semaines — '
        + 'élargissez vos horaires ou proposez une date à la main.</span>';
      return;
    }
    host.innerHTML = slots.map((slot) => `<button type="button" class="slot" data-start="${esc(slot.starts_at)}">${esc(dateTime(slot.starts_at))}</button>`).join('');
    host.querySelectorAll('.slot').forEach((button) => {
      button.addEventListener('click', () => {
        el('q-start').value = toLocalInput(button.dataset.start);
        host.querySelectorAll('.slot').forEach((other) => other.setAttribute('aria-pressed', String(other === button)));
      });
    });
  } catch (err) {
    host.innerHTML = `<span class="faint" style="font-size:.85rem">${esc(err.message)}</span>`;
  }
}

/** An out-of-hours slot is allowed, but only as a deliberate exception. */
async function sendQuote(request, outsideHours) {
  try {
    return await api('POST', `/api/requests/${request.id}/quote`, {
        price_cents: Math.round(Number(el('q-price').value) * 100),
        deposit_cents: Math.round(Number(el('q-deposit').value) * 100),
        proposed_start: toIso(el('q-start').value),
        duration_hours: Number(el('q-hours').value),
      note: el('q-note').value,
      expires_in_days: Number(el('q-expires').value),
      outside_hours: outsideHours,
    });
  } catch (err) {
    if (!outsideHours && /opening hours/.test(err.message)) {
      if (!confirm('Ce créneau est en dehors de vos horaires d\'ouverture. L\'envoyer quand même ?')) throw err;
      return sendQuote(request, true);
    }
    throw err;
  }
}

function nextWeek() {
  const date = new Date(Date.now() + 7 * 86400000);
  date.setHours(10, 0, 0, 0);
  return date.toISOString();
}

/* -------------------------------------------------------------- appointments */

async function loadAppointments() {
  const { appointments } = await api('GET', '/api/appointments');
  const upcoming = appointments.filter((a) => a.status === 'scheduled');
  const past = appointments.filter((a) => a.status !== 'scheduled');

  el('appointments').innerHTML = upcoming.length
    ? upcoming.map((appointment, index) => appointmentCard(appointment, index === 0)).join('')
    : '<div class="empty">Aucune séance programmée.</div>';
  el('appointments-past').innerHTML = past.length
    ? past.map((appointment) => appointmentCard(appointment)).join('')
    : '<div class="empty">L\'historique se remplira après vos premières séances.</div>';

  document.querySelectorAll('[data-appt-action]').forEach((button) => {
    button.addEventListener('click', () => appointmentAction(button.dataset.apptAction, Number(button.dataset.apptId)));
  });
}

function appointmentCard(appointment, isNext = false) {
  const currency = artist.currency;
  const hours = (new Date(appointment.ends_at) - new Date(appointment.starts_at)) / 3600000;
  return `
    <article class="item${isNext ? ' item-next' : ''}">
      <div class="row-between">
        <div>
          <div class="item-title">${esc(dateTime(appointment.starts_at))} · ${esc(appointment.client_name)}</div>
          <div class="meta">
            <span>${esc(appointment.description.slice(0, 70))}${appointment.description.length > 70 ? '…' : ''}</span>
            <span>${hours} h</span>
            <span>${money(appointment.price_cents, currency)} dont <b>${money(appointment.deposit_cents, currency)}</b> d'acompte</span>
            <span class="faint">${esc(relative(appointment.starts_at))}</span>
          </div>
          <div class="meta"><span>${esc(appointment.client_email)}</span>${appointment.client_phone ? `<span>${esc(appointment.client_phone)}</span>` : ''}</div>
        </div>
        <div class="item-actions">
          ${statusBadge(appointment.status)}
          ${appointment.status === 'scheduled' ? `
            <div class="row" style="justify-content:flex-end">
              <button class="btn btn-sm" data-appt-action="complete" data-appt-id="${appointment.id}">Terminée</button>
              <button class="btn btn-sm btn-ghost" data-appt-action="reschedule" data-appt-id="${appointment.id}">Reporter</button>
              <button class="btn btn-sm btn-danger" data-appt-action="no-show" data-appt-id="${appointment.id}">No-show</button>
              <button class="btn btn-sm btn-quiet" data-appt-action="cancel" data-appt-id="${appointment.id}">Annuler</button>
            </div>` : ''}
        </div>
      </div>
    </article>`;
}

async function appointmentAction(action, id) {
  try {
    if (action === 'reschedule') {
      const value = prompt('Nouvelle date et heure (AAAA-MM-JJ HH:MM) :', toLocalInput(nextWeek()).replace('T', ' '));
      if (!value) return;
      const date = new Date(value.replace(' ', 'T'));
      if (Number.isNaN(date.getTime())) { toast('Date illisible.', 'error'); return; }
      await api('POST', `/api/appointments/${id}/reschedule`, { starts_at: date.toISOString() });
      toast('Séance déplacée, les rappels ont suivi.');
    } else if (action === 'cancel') {
      const reason = prompt('Motif de l\'annulation (visible par le client) :', '');
      if (reason === null) return;
      const refund = confirm('Rembourser l\'acompte ?');
      await api('POST', `/api/appointments/${id}/cancel`, { reason, refund_deposit: refund });
      toast('Séance annulée.');
    } else if (action === 'no-show') {
      if (!confirm('Marquer ce client comme absent ? L\'acompte reste acquis au studio.')) return;
      await api('POST', `/api/appointments/${id}/no-show`);
      toast('No-show enregistré, acompte conservé.');
    } else {
      await api('POST', `/api/appointments/${id}/complete`);
      toast('Séance terminée — le suivi de cicatrisation est programmé.');
    }
    await Promise.all([loadAppointments(), loadRequests(), loadStats(), loadMessages()]);
  } catch (err) {
    toast(err.message, 'error');
  }
}

/* -------------------------------------------------------------------- blocks */

function wireBlocks() {
  el('block-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      await api('POST', '/api/blocks', {
        starts_at: toIso(el('block-start').value),
        ends_at: toIso(el('block-end').value),
        label: el('block-label').value,
      });
      event.target.reset();
      toast('Période bloquée.');
      loadBlocks();
    } catch (err) {
      toast(err.message, 'error');
    }
  });
}

async function loadBlocks() {
  const { blocks } = await api('GET', '/api/blocks');
  el('blocks').innerHTML = blocks.length ? blocks.map((block) => `
    <div class="row-between" style="padding:0.4rem 0;border-bottom:1px solid var(--line)">
      <div><b>${esc(block.label)}</b><div class="faint" style="font-size:0.82rem">${esc(dateTime(block.starts_at))} → ${esc(dateTime(block.ends_at))}</div></div>
      <button class="btn btn-sm btn-quiet" data-block="${block.id}">✕</button>
    </div>`).join('')
    : '<p class="faint" style="font-size:0.86rem">Aucune période bloquée.</p>';

  el('blocks').querySelectorAll('[data-block]').forEach((button) => {
    button.addEventListener('click', async () => {
      await api('DELETE', `/api/blocks/${button.dataset.block}`);
      loadBlocks();
    });
  });
}

/* ------------------------------------------------------------------- outbox */

async function loadMessages() {
  const { messages } = await api('GET', '/api/messages');
  el('messages').innerHTML = messages.length ? messages.map((message) => `
    <div class="outbox-item">
      <div class="row-between">
        <b>${esc(message.subject)}</b>
        ${outboxState(message)}
      </div>
      <div class="faint" style="font-size:0.82rem">${esc(message.recipient)} · ${esc(message.kind)}</div>
      ${message.last_error ? `<div class="warn-line">Échec d'envoi (${esc(message.attempts)} tentative${message.attempts > 1 ? 's' : ''}) : ${esc(message.last_error)}</div>` : ''}
      <div class="outbox-body">${esc(message.body.replaceAll('{{base_url}}', location.origin))}</div>
    </div>`).join('')
    : '<div class="empty">Les messages partiront dès votre première demande.</div>';
}

// Sent, still waiting, or given up on — the artist should not have to guess which.
function outboxState(message) {
  if (message.sent_at) return `<span class="badge badge-booked">envoyé ${esc(relative(message.sent_at))}</span>`;
  if (message.attempts >= 5) return '<span class="badge badge-declined">abandonné après 5 tentatives</span>';
  if (message.last_error) return '<span class="badge badge-quoted">nouvel essai au prochain passage</span>';
  return `<span class="badge">prévu ${esc(relative(message.scheduled_for))}</span>`;
}

/* ------------------------------------------------------------------- studio */

let studioState = null;

async function loadStudio() {
  studioState = await api('GET', '/api/studio');
  const { studio, members, pending_invites: invites, seats, is_owner: isOwner } = studioState;

  el('studio-title').textContent = studio.name;
  const url = `${location.origin}/s/${studio.slug}`;
  el('studio-link').textContent = url;
  el('open-studio').href = `/s/${studio.slug}`;

  el('members').innerHTML = members.map((member) => `
    <article class="item">
      <div class="row-between">
        <div>
          <div class="item-title">${esc(member.studio_name)}${member.you ? ' <span class="badge">vous</span>' : ''}</div>
          <div class="meta">
            <span>${esc(member.email)}</span>
            <span>${member.role === 'owner' ? 'Propriétaire' : 'Artiste'}</span>
            <span>${member.accepting_requests ? 'Prend des demandes' : 'Fermé aux demandes'}</span>
            <span><a href="/b/${esc(member.slug)}" target="_blank" rel="noopener">sa page</a></span>
          </div>
        </div>
        ${isOwner && !member.you
          ? `<button class="btn btn-sm btn-danger" data-remove="${member.id}">Retirer</button>`
          : ''}
      </div>
    </article>`).join('');

  el('members').querySelectorAll('[data-remove]').forEach((button) => {
    button.addEventListener('click', () => removeMember(Number(button.dataset.remove)));
  });

  el('studio-side').innerHTML = isOwner ? `
    <div class="card">
      <h3>Inviter un artiste</h3>
      <p class="muted" style="font-size:.88rem">
        ${seats.used} / ${seats.max} places occupées, invitations en attente comprises.
      </p>
      <form id="invite-form" class="stack" style="margin-top:.8rem">
        <div><label for="invite-email">Email</label>
          <input id="invite-email" type="email" required placeholder="nina@studio.fr"></div>
        <button class="btn btn-block" type="submit" ${seats.used >= seats.max ? 'disabled' : ''}>Envoyer l'invitation</button>
      </form>
      ${invites.length ? `<hr class="divider"><div class="faint" style="font-size:.8rem;text-transform:uppercase;letter-spacing:.08em">En attente</div>` : ''}
      ${invites.map((invite) => `
        <div class="row-between" style="padding:.5rem 0;border-bottom:1px solid var(--line)">
          <div><b>${esc(invite.email)}</b>
            <div class="faint" style="font-size:.82rem">expire ${esc(relative(invite.expires_at))}</div></div>
          <button class="btn btn-sm btn-quiet" data-invite="${invite.id}">✕</button>
        </div>`).join('')}
    </div>` : `
    <div class="card">
      <h3>Votre studio</h3>
      <p class="muted" style="font-size:.88rem">
        Vous faites partie de ${esc(studio.name)}. Vos demandes, vos tarifs et vos
        horaires ne sont visibles que par vous.
      </p>
    </div>`;

  if (isOwner) {
    el('invite-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      try {
        await api('POST', '/api/studio/invites', { email: el('invite-email').value });
        toast('Invitation envoyée.');
        await loadStudio();
      } catch (err) {
        toast(err.message, 'error');
      }
    });
    el('studio-side').querySelectorAll('[data-invite]').forEach((button) => {
      button.addEventListener('click', async () => {
        await api('DELETE', `/api/studio/invites/${button.dataset.invite}`);
        await loadStudio();
      });
    });
  }

  const { appointments } = await api('GET', '/api/studio/agenda');
  el('studio-agenda').innerHTML = appointments.length ? appointments.map((appointment) => `
    <article class="item">
      <div class="row-between">
        <div>
          <div class="item-title">${esc(dateTime(appointment.starts_at))} · ${esc(appointment.artist_name)}</div>
          <div class="meta">
            <span>${esc(appointment.client_name)}</span>
            <span>${esc(appointment.description.slice(0, 60))}${appointment.description.length > 60 ? '…' : ''}</span>
            <span>${money(appointment.price_cents, artist.currency)}</span>
          </div>
        </div>
      </div>
    </article>`).join('')
    : '<div class="empty">Aucune séance programmée dans le studio.</div>';
}

async function removeMember(memberId) {
  if (!confirm('Retirer cet artiste du studio ? Ses demandes, ses séances et ses clients restent les siens.')) return;
  try {
    await api('DELETE', `/api/studio/members/${memberId}`);
    toast('Artiste retiré du studio.');
    await loadStudio();
  } catch (err) {
    toast(err.message, 'error');
  }
}

/* ----------------------------------------------------------------- settings */

const DAY_NAMES = ['Dimanche', 'Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi'];

function renderHoursEditor(workingHours) {
  el('hours-editor').innerHTML = workingHours.map((day, index) => `
    <div class="hours-row${day.open ? '' : ' closed'}" data-day="${index}">
      <label class="check"><input type="checkbox" data-hours="open" ${day.open ? 'checked' : ''}>
        <span>${DAY_NAMES[index]}</span></label>
      <input type="time" data-hours="from" value="${esc(day.from)}" aria-label="Ouverture ${DAY_NAMES[index]}">
      <input type="time" data-hours="to" value="${esc(day.to)}" aria-label="Fermeture ${DAY_NAMES[index]}">
    </div>`).join('');

  el('hours-editor').addEventListener('change', (event) => {
    const row = event.target.closest('.hours-row');
    if (row) row.classList.toggle('closed', !row.querySelector('[data-hours="open"]').checked);
  });
}

const collectHours = () => [...document.querySelectorAll('#hours-editor .hours-row')].map((row) => ({
  open: row.querySelector('[data-hours="open"]').checked,
  from: row.querySelector('[data-hours="from"]').value || '11:00',
  to: row.querySelector('[data-hours="to"]').value || '19:00',
}));

function wireSettings() {
  el('set-studio').value = artist.studio_name;
  el('set-city').value = artist.city;
  el('set-bio').value = artist.bio;
  el('set-styles').value = artist.styles.join(', ');
  el('set-reference').value = euros(artist.reference_price_cents);
  el('set-minimum').value = euros(artist.minimum_cents);
  el('set-deposit').value = artist.deposit_percent;
  el('set-cancel').value = artist.cancellation_hours;
  el('set-accepting').checked = artist.accepting_requests;
  el('set-timezone').value = artist.timezone;
  el('set-lead').value = artist.lead_hours;
  renderHoursEditor(artist.working_hours);

  el('settings-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      const { artist: updated } = await api('PATCH', '/api/me', {
        studio_name: el('set-studio').value,
        city: el('set-city').value,
        bio: el('set-bio').value,
        styles: el('set-styles').value.split(',').map((s) => s.trim()).filter(Boolean),
        reference_price_cents: Math.round(Number(el('set-reference').value) * 100),
        minimum_cents: Math.round(Number(el('set-minimum').value) * 100),
        deposit_percent: Number(el('set-deposit').value),
        cancellation_hours: Number(el('set-cancel').value),
        accepting_requests: el('set-accepting').checked,
        working_hours: collectHours(),
        timezone: el('set-timezone').value.trim() || 'Europe/Paris',
        lead_hours: Number(el('set-lead').value),
      });
      artist = updated;
      setStudioZone(artist.timezone);
      renderHeader();
      toast('Réglages enregistrés.');
    } catch (err) {
      toast(err.message, 'error');
    }
  });
}
