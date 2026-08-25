import { api, toast } from './util.js';

const tabs = {
  login: { tab: document.getElementById('tab-login'), panel: document.getElementById('panel-login') },
  signup: { tab: document.getElementById('tab-signup'), panel: document.getElementById('panel-signup') },
};

function show(which) {
  for (const [name, { tab, panel }] of Object.entries(tabs)) {
    const active = name === which;
    tab.setAttribute('aria-selected', String(active));
    panel.classList.toggle('hidden', !active);
  }
}
tabs.login.tab.addEventListener('click', () => show('login'));
tabs.signup.tab.addEventListener('click', () => show('signup'));
if (location.hash === '#signup') show('signup');

async function submit(form, path, payload, button) {
  button.disabled = true;
  try {
    await api('POST', path, payload);
    location.href = '/app';
  } catch (err) {
    toast(err.message, 'error');
    button.disabled = false;
  }
}

tabs.login.panel.addEventListener('submit', (event) => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(event.target));
  submit(event.target, '/api/auth/login', data, event.submitter ?? event.target.querySelector('button'));
});

tabs.signup.panel.addEventListener('submit', (event) => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(event.target));
  submit(event.target, '/api/auth/signup', data, event.submitter ?? event.target.querySelector('button'));
});

// Already signed in? Skip the form.
api('GET', '/api/me').then((data) => {
  if (data?.artist) location.href = '/app';
}).catch(() => {});
