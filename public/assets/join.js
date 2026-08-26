import { api, toast, esc } from './util.js';

const token = decodeURIComponent(location.pathname.split('/').filter(Boolean)[1] ?? '');
const el = (id) => document.getElementById(id);

load();

async function load() {
  try {
    const invite = await api('GET', `/api/public/invites/${encodeURIComponent(token)}`);
    el('loading').classList.add('hidden');
    el('join-form').classList.remove('hidden');
    el('studio-name').textContent = `Invitation — ${invite.studio_name}`;
    el('join-email').value = invite.email;
    document.title = `Rejoindre ${invite.studio_name} — Inkflow`;
  } catch (err) {
    el('loading').classList.add('hidden');
    el('refused').classList.remove('hidden');
    el('refused-text').textContent = err.status === 404
      ? "Ce lien d'invitation n'existe pas."
      : err.message;
  }
}

el('join-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = event.target.querySelector('button[type=submit]');
  button.disabled = true;
  try {
    await api('POST', '/api/auth/signup', {
      email: el('join-email').value,
      password: el('join-password').value,
      studio_name: el('join-studio').value,
      city: el('join-city').value,
      invite: token,
    });
    location.href = '/app';
  } catch (err) {
    toast(err.message, 'error');
    button.disabled = false;
  }
});
