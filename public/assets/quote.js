import { api, toast, money, dateTime, esc, setStudioZone, zoneNote } from './util.js';

const token = decodeURIComponent(location.pathname.split('/').filter(Boolean)[1] ?? '');
const el = (id) => document.getElementById(id);
let state = null;

load();

async function load({ silent = false } = {}) {
  try {
    state = await api('GET', `/api/public/quotes/${encodeURIComponent(token)}`);
  } catch (err) {
    el('loading').textContent = err.status === 404 ? 'Ce lien de suivi n\'existe pas ou a expiré.' : err.message;
    return;
  }
  setStudioZone(state.artist.timezone);
  el('loading').classList.add('hidden');
  el('view').classList.remove('hidden');
  render();

  // Returning from the hosted payment page.
  if (!silent && new URLSearchParams(location.search).get('paid') === '1'
      && state.request.status !== 'booked') {
    el('subline').textContent = 'Paiement reçu — nous confirmons votre date, un instant…';
    const confirmed = await awaitConfirmation();
    if (!confirmed) {
      el('subline').textContent = 'Paiement reçu. La confirmation prend quelques instants — '
        + 'cette page se mettra à jour, et vous recevrez un email dès que la date est bloquée.';
    }
  }
}

const STEP_INDEX = {
  new: 1, quoted: 2, booked: 3, completed: 3,
  declined: 1, expired: 2, cancelled: 3, no_show: 3,
};

function render() {
  const { artist, request, appointment } = state;
  const currency = artist.currency;
  el('nav-studio').textContent = artist.city ? `${artist.studio_name} · ${artist.city}` : artist.studio_name;

  const reached = STEP_INDEX[request.status] ?? 1;
  const stepNames = ['Demande reçue', 'Devis de l\'artiste', 'Acompte et date bloquée'];
  el('steps').innerHTML = stepNames
    .map((name, i) => {
      // Only the current step is "on": on a phone it is the one that keeps its label.
      const state = i === reached - 1 ? 'on' : (i < reached ? 'done' : '');
      const step = `<div class="step ${state}"><span class="num">${i + 1}</span><span class="lbl">${esc(name)}</span></div>`;
      // The connector fills only up to the step actually reached.
      return i < stepNames.length - 1
        ? `${step}<div class="step-link ${i < reached - 1 ? 'fill' : ''}"></div>`
        : step;
    })
    .join('');

  const panel = el('panel');
  const brief = `
    <div class="card">
      <h3>Votre projet</h3>
      <p class="muted" style="margin:0.4rem 0 0.8rem">${esc(request.description)}</p>
      <div class="meta">
        ${request.style ? `<span>Style : <b>${esc(request.style)}</b></span>` : ''}
        ${request.placement ? `<span>Zone : <b>${esc(request.placement)}</b></span>` : ''}
        <span>Taille : <b>${esc(request.size_cm)} cm</b></span>
        <span>Estimation initiale : <b>${money(request.estimate_low_cents, currency)} – ${money(request.estimate_high_cents, currency)}</b></span>
      </div>
    </div>`;

  if (request.status === 'new') {
    el('headline').textContent = 'Demande bien reçue';
    el('subline').textContent = `${artist.studio_name} étudie votre projet et vous envoie un devis ferme. Vous recevrez un email — cette page se mettra à jour toute seule.`;
    panel.innerHTML = brief;
    return;
  }

  if (request.status === 'declined') {
    el('headline').textContent = 'Projet non retenu';
    el('subline').textContent = `${artist.studio_name} ne peut pas prendre ce projet.`
      + (request.decline_reason ? ` Motif : ${request.decline_reason}` : '');
    panel.innerHTML = brief;
    return;
  }

  if (request.status === 'expired') {
    el('headline').textContent = 'Devis expiré';
    el('subline').textContent = 'Ce devis a dépassé sa date de validité. Contactez le studio pour en obtenir un nouveau.';
    panel.innerHTML = brief;
    return;
  }

  if (request.status === 'quoted') {
    el('headline').textContent = 'Votre devis est prêt';
    el('subline').textContent = 'La date est réservée dès que l\'acompte est versé. Sans acompte, le créneau reste ouvert aux autres clients.';
    const remaining = request.quote_price_cents - request.deposit_cents;
    const sessionHours = request.proposed_start && request.proposed_end
      ? (new Date(request.proposed_end) - new Date(request.proposed_start)) / 3600000
      : request.estimated_hours;
    // A long piece is booked one session at a time: say so instead of showing a 9 h slot.
    const multiSession = request.estimated_hours > sessionHours + 0.01;
    panel.innerHTML = `
      <div class="card card-pad-lg">
        ${request.artist_note ? `<p class="muted" style="border-left:2px solid var(--accent);padding-left:0.8rem">${esc(request.artist_note)}</p>` : ''}
        <div class="price-line"><span class="muted">Créneau proposé</span><b>${request.proposed_start ? esc(dateTime(request.proposed_start)) : 'à définir'}</b></div>
        ${request.proposed_start && zoneNote(artist.city) ? `<p class="hint center">Horaire donné en ${esc(zoneNote(artist.city))}.</p>` : ''}
        <div class="price-line"><span class="muted">${multiSession ? 'Première séance' : 'Durée prévue'}</span><b>${esc(sessionHours)} h</b></div>
        ${multiSession ? `<div class="price-line"><span class="muted">Travail total estimé</span><b>${esc(request.estimated_hours)} h — séances suivantes à caler ensemble</b></div>` : ''}
        <div class="price-line"><span class="muted">Prix du tatouage</span><span class="price-total">${money(request.quote_price_cents, currency)}</span></div>
        <div class="price-line"><span class="muted">Acompte à verser maintenant</span><b style="color:var(--accent)">${money(request.deposit_cents, currency)}</b></div>
        <div class="price-line"><span class="muted">Reste à régler le jour J</span><b>${money(remaining, currency)}</b></div>
        <button class="btn btn-block tap" id="accept" style="margin-top:1.3rem;min-height:52px;font-size:1rem" ${request.proposed_start ? '' : 'disabled'}>
          Accepter et verser l'acompte
        </button>
        <p class="hint center" style="margin-top:0.6rem">
          Annulation ou report sans frais jusqu'à ${esc(artist.cancellation_hours)} h avant la séance.
          Au-delà, l'acompte reste acquis au studio.
        </p>
        ${request.quote_expires_at ? `<p class="hint center">Devis valable jusqu'au ${esc(dateTime(request.quote_expires_at))}.</p>` : ''}
        <hr class="divider">
        <div class="assur" style="flex-direction:column;gap:0.7rem">
          <div><svg width="17" height="17" viewBox="0 0 19 19" aria-hidden="true"><path d="M4 10l4 4 7-8"></path></svg>Acompte encaissé via un paiement sécurisé</div>
          <div><svg width="17" height="17" viewBox="0 0 19 19" aria-hidden="true"><path d="M4 10l4 4 7-8"></path></svg>Report sans frais jusqu'au délai du studio</div>
          <div><svg width="17" height="17" viewBox="0 0 19 19" aria-hidden="true"><path d="M4 10l4 4 7-8"></path></svg>Le reste se règle sur place, le jour J</div>
        </div>
      </div>
      ${brief}`;
    el('accept').addEventListener('click', accept);
    return;
  }

  // A cancelled or missed session used to fall through to the booked branch, so the
  // page cheerfully announced a rendez-vous that no longer existed.
  if (request.status === 'cancelled') {
    el('headline').textContent = 'Séance annulée';
    el('subline').textContent = `${artist.studio_name} a annulé cette séance.`
      + (request.decline_reason ? ` Motif : ${request.decline_reason}` : '')
      + ' Écrivez au studio pour reprendre une date.';
    panel.innerHTML = brief;
    return;
  }

  if (request.status === 'no_show') {
    el('headline').textContent = 'Séance manquée';
    el('subline').textContent = `La séance n'a pas eu lieu et l'acompte est resté acquis au studio, `
      + `comme prévu dans les conditions. Pour reprendre rendez-vous, passez par la page de ${artist.studio_name}.`;
    panel.innerHTML = brief;
    return;
  }

  // booked / completed
  const start = appointment?.starts_at ?? request.proposed_start;
  el('headline').textContent = request.status === 'completed' ? 'Séance terminée' : 'C\'est bloqué !';
  el('subline').textContent = request.status === 'completed'
    ? 'Merci ! Suivez bien les conseils de cicatrisation reçus par email.'
    : `Rendez-vous le ${dateTime(start)} chez ${artist.studio_name}.`;
  panel.innerHTML = `
    <div class="card card-pad-lg">
      <div class="price-line"><span class="muted">Date</span><b>${esc(dateTime(start))}</b>${zoneNote(artist.city) ? `<span class="muted"> ${esc(zoneNote(artist.city))}</span>` : ''}</div>
      <div class="price-line"><span class="muted">Prix total</span><b>${money(request.quote_price_cents, currency)}</b></div>
      <div class="price-line"><span class="muted">Acompte versé</span><b style="color:var(--ok)">${money(request.deposit_cents, currency)}</b></div>
      <div class="price-line"><span class="muted">Reste à régler sur place</span><b>${money(request.quote_price_cents - request.deposit_cents, currency)}</b></div>
      <hr class="divider">
      <h3>Avant la séance</h3>
      <p class="muted" style="margin:0.5rem 0 0">
        Dormez et mangez avant de venir, pas d'alcool dans les 24 h, portez des vêtements qui dégagent la zone,
        et apportez une pièce d'identité.
      </p>
    </div>
    ${brief}`;
}

async function accept() {
  const button = el('accept');
  button.disabled = true;
  button.textContent = 'Paiement en cours…';
  try {
    const result = await api('POST', `/api/public/quotes/${encodeURIComponent(token)}/accept`);
    if (result?.redirect_url) {
      // Hosted payment page: the card details never touch this site.
      location.href = result.redirect_url;
      return;
    }
    toast('Acompte enregistré, votre date est bloquée.');
    await load();
  } catch (err) {
    toast(err.message, 'error');
    button.disabled = false;
    button.textContent = 'Accepter et verser l\'acompte';
  }
}

/**
 * Back from the payment page. The booking is confirmed by the provider's webhook,
 * which may land a moment later — so the page waits for it rather than claiming
 * a date the server has not recorded.
 */
async function awaitConfirmation() {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (state?.request?.status === 'booked') return true;
    await new Promise((done) => setTimeout(done, 1500));
    await load({ silent: true });
  }
  return state?.request?.status === 'booked';
}
