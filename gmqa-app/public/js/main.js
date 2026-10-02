import { $, api, esc, state, setTokenProvider, toast, ApiError } from './ui.js';
import carwash from './views/carwash.js';
import { detailing, tintPpf } from './views/running.js';
import eod from './views/eod.js';
import pricing from './views/pricing.js';
import reports from './views/reports.js';
import finance from './views/finance.js';
import payroll from './views/payroll.js';
import settings from './views/settings.js';

const VIEWS = [
  { key: 'carwash', label: 'Carwash', module: carwash, roles: ['owner', 'staff'] },
  { key: 'detailing', label: 'Detailing', module: detailing, roles: ['owner', 'staff'] },
  { key: 'tint_ppf', label: 'Tint & PPF', module: tintPpf, roles: ['owner', 'staff'] },
  { key: 'eod', label: 'EOD Closing', module: eod, roles: ['owner', 'staff'] },
  { key: 'pricing', label: 'Pricing Matrix', module: pricing, roles: ['owner', 'staff'] },
  { key: 'reports', label: 'Sales Reports', module: reports, roles: ['owner'] },
  { key: 'finance', label: 'Finance', module: finance, roles: ['owner'] },
  { key: 'payroll', label: 'Payroll', module: payroll, roles: ['owner'] },
  { key: 'settings', label: 'Settings', module: settings, roles: ['owner'] },
];

let supabase = null;
let sandboxHint = '';
const mounted = new Set();

function showGate({ login = false, message = '', signout = false } = {}) {
  $('#app').hidden = true;
  $('#gate').hidden = false;
  $('#login-form').hidden = !login;
  $('#gate-message').textContent = message || (login ? sandboxHint : '');
  $('#gate-signout').hidden = !signout;
}

function allowedViews() {
  return VIEWS.filter(v => v.roles.includes(state.user.role));
}

function renderNav() {
  $('#nav').innerHTML = allowedViews().map((v, i) =>
    `<button type="button" data-view="${v.key}"><span class="nav-icon">${String(i + 1).padStart(2, '0')}</span>${esc(v.label)}</button>`).join('');
  $('#nav').querySelectorAll('button').forEach(btn => btn.addEventListener('click', () => { location.hash = btn.dataset.view; }));
}

async function route() {
  const views = allowedViews();
  const view = views.find(v => v.key === location.hash.slice(1)) || views[0];
  document.querySelectorAll('.view').forEach(el => el.classList.toggle('active', el.id === `view-${view.key}`));
  document.querySelectorAll('#nav button').forEach(el => el.classList.toggle('active', el.dataset.view === view.key));
  const root = $(`#view-${view.key}`);
  if (!mounted.has(view.key)) {
    view.module.mount(root);
    mounted.add(view.key);
  }
  await view.module.show?.(root);
}

async function enterApp() {
  try {
    state.user = await api('GET', '/me', undefined, { quiet: true });
  } catch (error) {
    if (error instanceof ApiError && error.status === 403) return showGate({ message: error.message, signout: true });
    if (error instanceof ApiError && error.status === 401) return showGate({ login: true, message: error.message });
    return showGate({ message: error.message, signout: true });
  }
  $('#user-email').textContent = state.user.email;
  $('#user-role').textContent = state.user.role === 'owner' ? 'Owner' : 'Staff';
  document.body.dataset.role = state.user.role;
  $('#gate').hidden = true;
  $('#app').hidden = false;
  renderNav();
  await route();
}

// Stand-in for supabase.auth used only by `npm run sandbox`: any password works and the
// "token" is the email, which the sandbox server accepts.
function sandboxClient() {
  const listeners = [];
  const read = () => { try { return JSON.parse(sessionStorage.getItem('sandbox-session')); } catch { return null; } };
  return {
    auth: {
      getSession: async () => ({ data: { session: read() } }),
      onAuthStateChange: fn => listeners.push(fn),
      signInWithPassword: async ({ email }) => {
        sessionStorage.setItem('sandbox-session', JSON.stringify({ access_token: email.toLowerCase(), user: { email } }));
        return { error: null };
      },
      signOut: async () => { sessionStorage.removeItem('sandbox-session'); listeners.forEach(fn => fn('SIGNED_OUT', null)); },
    },
  };
}

async function init() {
  const config = await fetch('/api/auth/config').then(r => r.json()).catch(() => ({}));
  if (config.sandbox) {
    supabase = sandboxClient();
    document.title = `[SANDBOX] ${document.title}`;
    sandboxHint = 'Sandbox: sign in as owner@sandbox or staff@sandbox with any password.';
  } else if (!config.url || !config.anonKey || !window.supabase) {
    return showGate({ message: 'Sign-in is not configured on the server. Set SUPABASE_URL and SUPABASE_ANON_KEY.' });
  } else {
    supabase = window.supabase.createClient(config.url, config.anonKey);
  }
  // supabase-js refreshes the token automatically; always hand the API the current one.
  setTokenProvider(async () => (await supabase.auth.getSession()).data.session?.access_token || null);

  supabase.auth.onAuthStateChange((event) => {
    if (event === 'SIGNED_OUT') {
      // Wipe every screen so the next person to sign in never sees the previous user's data.
      state.user = null;
      state.catalog = null;
      mounted.clear();
      document.querySelectorAll('main .view').forEach(view => { view.innerHTML = ''; view.classList.remove('active'); });
      showGate({ login: true });
    }
  });

  const { data } = await supabase.auth.getSession();
  if (data.session) await enterApp();
  else showGate({ login: true });
}

$('#login-form').addEventListener('submit', async event => {
  event.preventDefault();
  const button = event.submitter;
  button.disabled = true;
  $('#gate-message').textContent = '';
  const { error } = await supabase.auth.signInWithPassword({
    email: $('#login-email').value.trim(),
    password: $('#login-password').value,
  });
  button.disabled = false;
  if (error) {
    $('#gate-message').textContent = error.message;
    return;
  }
  $('#login-password').value = '';
  await enterApp();
});

const signOut = () => supabase?.auth.signOut();
$('#signout-btn').addEventListener('click', signOut);
$('#gate-signout').addEventListener('click', signOut);
window.addEventListener('hashchange', () => { if (state.user) route(); });
window.addEventListener('unhandledrejection', event => {
  // API errors were already shown to the user by api(); anything else is unexpected.
  if (event.reason instanceof ApiError) event.preventDefault();
  else toast(event.reason?.message || 'Something went wrong', 'error');
});

init();
