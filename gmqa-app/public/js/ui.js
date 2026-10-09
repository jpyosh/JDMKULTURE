// Small shared helpers: formatting, dates (local shop time), toast, modal, API client.

export const peso = n => '₱' + Number(n || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const esc = value => String(value ?? '').replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));
export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

// ---------------------------------------------------------------- dates
// Business dates are 'YYYY-MM-DD' in the shop's local time. Never use toISOString() for these:
// it converts to UTC and is a day behind in the Philippines before 8am.
export function todayLocal() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
export function addDays(date, days) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
export function mondayOf(date) {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  return addDays(date, day === 0 ? -6 : 1 - day);
}
// The shop's pay week runs Sunday to Saturday.
export function sundayOf(date) {
  return addDays(date, -new Date(`${date}T00:00:00Z`).getUTCDay());
}
export const weekday = date => new Date(`${date}T00:00:00Z`).toLocaleDateString('en-PH', { weekday: 'short', timeZone: 'UTC' });
export const prettyDate = date => new Date(`${date}T00:00:00Z`).toLocaleDateString('en-PH', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
export const prettyTime = ts => new Date(ts).toLocaleString('en-PH', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

// ---------------------------------------------------------------- toast

let toastTimer;
export function toast(message, type = 'success') {
  const el = $('#app-toast');
  el.textContent = message;
  el.className = `app-toast show ${type === 'error' ? 'error' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = 'app-toast'; }, type === 'error' ? 5000 : 2600);
}

// ---------------------------------------------------------------- modal

export function openModal(html, onReady) {
  const dialog = $('#modal');
  $('#modal-card').innerHTML = html;
  $$('[data-close]', dialog).forEach(btn => btn.addEventListener('click', () => dialog.close()));
  if (!dialog.open) dialog.showModal();
  onReady?.($('#modal-card'));
  return dialog;
}
export const closeModal = () => $('#modal').close();

export function modalHeader(title, subtitle = '', eyebrow = '') {
  return `<div class="modal-header"><div>${eyebrow ? `<span class="eyebrow">${esc(eyebrow)}</span>` : ''}<h2>${esc(title)}</h2>${subtitle ? `<p>${esc(subtitle)}</p>` : ''}</div>
    <button class="icon-btn" type="button" data-close aria-label="Close">✕</button></div>`;
}

// ---------------------------------------------------------------- API

let tokenProvider = async () => null;
export const setTokenProvider = fn => { tokenProvider = fn; };

export class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export async function api(method, path, body, { quiet = false } = {}) {
  const token = await tokenProvider();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const res = await fetch(`/api${path}`, {
      method,
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(res.status, data.error || `Request failed (${res.status})`);
    return data;
  } catch (error) {
    const err = error.name === 'AbortError' ? new ApiError(0, 'The server took too long to respond. Check the connection and try again.')
      : error instanceof ApiError ? error : new ApiError(0, 'Cannot reach the server. Check the internet connection.');
    if (!quiet) toast(err.message, 'error');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// Downloads a file from the API (e.g. a PDF) with the signed-in user's token, under the file name the
// server gives it.
export async function apiDownload(path) {
  const token = await tokenProvider();
  let res;
  try {
    res = await fetch(`/api${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  } catch {
    const err = new ApiError(0, 'Cannot reach the server. Check the internet connection.');
    toast(err.message, 'error');
    throw err;
  }
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    const err = new ApiError(res.status, data.error || `Download failed (${res.status})`);
    toast(err.message, 'error');
    throw err;
  }
  const name = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') || '')?.[1] || 'download';
  const url = URL.createObjectURL(await res.blob());
  const link = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Disables a button while an async action runs (prevents double submits). API errors have
// already been shown as a toast, so they are swallowed here.
export async function busy(button, fn) {
  if (button) button.disabled = true;
  try {
    return await fn();
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    return undefined;
  } finally {
    if (button) button.disabled = false;
  }
}

// Mirrors DEPARTMENTS in lib/calc.js.
export const DEPARTMENTS = [
  { key: 'carwash', label: 'Carwash', running: false, catalog: true },
  { key: 'detailing', label: 'Detailing', running: true, catalog: true },
  { key: 'tint_ppf', label: 'Tint & PPF', running: true, catalog: true },
  { key: 'parts', label: 'Parts counter', running: false, catalog: false },
];
export const departmentOf = key => DEPARTMENTS.find(d => d.key === key) || DEPARTMENTS[0];

export const state = { user: null, catalog: null };
export const isOwner = () => state.user?.role === 'owner';

export async function loadCatalog(force = false) {
  if (!state.catalog || force) {
    const [catalog, parts] = await Promise.all([api('GET', '/catalog'), api('GET', '/parts')]);
    state.catalog = { ...catalog, parts };
  }
  return state.catalog;
}
export const activeClasses = () => state.catalog.classes.filter(c => c.active);
export const classLabel = code => state.catalog?.classes.find(c => c.code === code)?.label || code || '—';
