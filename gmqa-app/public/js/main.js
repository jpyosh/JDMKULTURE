import { $, api, esc, state, setTokenProvider, toast, ApiError } from './ui.js';
import carwash from './views/carwash.js';
import { detailing, tintPpf } from './views/running.js';
import parts from './views/parts.js';
import eod from './views/eod.js';
import pricing from './views/pricing.js';
import reports from './views/reports.js';
import finance from './views/finance.js';
import cashFund from './views/cash-fund.js';
import payroll from './views/payroll.js';
import settings from './views/settings.js';

const VIEWS = [
  { key: 'carwash', label: 'Carwash', module: carwash, roles: ['owner', 'staff'] },
  { key: 'detailing', label: 'Detailing', module: detailing, roles: ['owner', 'staff'] },
  { key: 'tint_ppf', label: 'Tint & PPF', module: tintPpf, roles: ['owner', 'staff'] },
  { key: 'parts', label: 'Parts & Inventory', module: parts, roles: ['owner', 'staff'] },
  { key: 'eod', label: 'EOD Closing', module: eod, roles: ['owner', 'staff'] },
  { key: 'pricing', label: 'Pricing Matrix', module: pricing, roles: ['owner', 'staff'] },
  { key: 'reports', label: 'Sales Reports', module: reports, roles: ['owner'] },
  { key: 'finance', label: 'Finance', module: finance, roles: ['owner'] },
  { key: 'cash_fund', label: 'Cash fund', module: cashFund, roles: ['owner'] },
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

// Line icons for the sidebar, drawn on a 24px grid in the text colour.
const ICONS = {
  carwash: '<path d="M12 3.5l5.2 5.6a7 7 0 1 1-10.4 0z"/>',
  detailing: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 16l.7 1.8 1.8.7-1.8.7L19 21l-.7-1.8-1.8-.7 1.8-.7z"/>',
  tint_ppf: '<path d="M12 21s7.5-3.6 7.5-9.5V5.8L12 3 4.5 5.8v5.7C4.5 17.4 12 21 12 21z"/>',
  parts: '<path d="M20.5 16.2V7.8L12 3 3.5 7.8v8.4L12 21z"/><path d="M3.8 8L12 12.6 20.2 8M12 21v-8.4"/>',
  eod: '<circle cx="12" cy="12" r="8.5"/><path d="M8.3 12.2l2.5 2.5 5-5.4"/>',
  pricing: '<path d="M20.3 13.3l-7 7a1.8 1.8 0 0 1-2.6 0L3.5 13V3.5H13l7.3 7.2a1.8 1.8 0 0 1 0 2.6z"/><circle cx="8" cy="8" r="1.4"/>',
  reports: '<path d="M3.5 20.5h17M7 16.5v-5M12 16.5V6.5M17 16.5v-8"/>',
  finance: '<rect x="3.5" y="6" width="17" height="13" rx="2.5"/><path d="M3.5 10h17M15.5 15h2"/>',
  cash_fund: '<path d="M4.5 8.5h15v11h-15z"/><path d="M7.5 8.5V6.5a2 2 0 0 1 2-2h5a2 2 0 0 1 2 2v2"/><circle cx="12" cy="14" r="2.2"/>',
  payroll: '<circle cx="9" cy="8.5" r="3.3"/><path d="M3 19.5a6 6 0 0 1 12 0M15.5 5.3a3.3 3.3 0 0 1 0 6.4M17.5 14a5.6 5.6 0 0 1 3.5 5.5"/>',
  settings: '<path d="M4 7h9M17 7h3M4 12h3M11 12h9M4 17h11M19 17h1"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="17" r="2"/>',
};
const icon = key => `<svg class="nav-icon" viewBox="0 0 24 24" aria-hidden="true">${ICONS[key] || ''}</svg>`;

function renderNav() {
  $('#nav').innerHTML = allowedViews().map(v =>
    `<button type="button" data-view="${v.key}">${icon(v.key)}<span>${esc(v.label)}</span></button>`).join('');
  $('#nav').querySelectorAll('button').forEach(btn => btn.addEventListener('click', () => { location.hash = btn.dataset.view; }));
}

async function route() {
  const views = allowedViews();
  const view = views.find(v => v.key === location.hash.slice(1)) || views[0];
  document.querySelectorAll('.view').forEach(el => el.classList.toggle('active', el.id === `view-${view.key}`));
  document.querySelectorAll('#nav button').forEach(el => {
    el.classList.toggle('active', el.dataset.view === view.key);
    if (el.dataset.view === view.key) el.setAttribute('aria-current', 'page'); else el.removeAttribute('aria-current');
  });
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
