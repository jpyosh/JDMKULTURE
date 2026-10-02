import { $, $$, api, esc, toast, busy, state, loadCatalog, prettyTime } from '../ui.js';

let root;

function mount(el) {
  root = el;
  root.innerHTML = `
    <div class="view-header"><div><h1>Settings</h1><div class="desc">Who can sign in, vehicle classes, and the history of every change.</div></div></div>
    <div class="two-col">
      <div class="card">
        <h2>Users &amp; access</h2>
        <p class="hint">Add someone's email here, then create their login in Supabase → Authentication → Users (or they reset a password).
          Owner: everything. Staff: Daily Log, EOD and viewing prices only; cannot edit a day after it's closed.</p>
        <div data-users></div>
        <div class="inline-form">
          <input type="text" data-u="email" placeholder="email@example.com">
          <input type="text" data-u="display_name" placeholder="Name (optional)">
          <select data-u="role"><option value="staff">Staff</option><option value="owner">Owner</option></select>
          <button class="btn ghost" type="button" data-add-user>+ Add</button>
        </div>
      </div>
      <div class="card">
        <h2>Vehicle classes</h2>
        <p class="hint">Add a class (e.g. VAN), then set its prices in the Pricing Matrix. Hidden classes stay on old jobs but can't be picked for new ones.</p>
        <div data-classes></div>
        <div class="inline-form">
          <input type="text" data-c="code" placeholder="Code, e.g. VAN" maxlength="16">
          <input type="text" data-c="label" placeholder="Label, e.g. Van" maxlength="40">
          <button class="btn ghost" type="button" data-add-class>+ Add</button>
        </div>
      </div>
    </div>
    <div class="card">
      <div class="section-header"><h2>Change history</h2>
        <select data-audit-table><option value="">All records</option><option value="jobs">Jobs</option><option value="job_items">Job items</option>
          <option value="expenses">Expenses</option><option value="daily_meta">EOD</option><option value="catalog_prices">Prices</option>
          <option value="catalog_items">Services / add-ons</option><option value="employees">Employees</option><option value="payroll_entries">Payroll</option>
          <option value="app_users">Users</option><option value="vehicle_classes">Vehicle classes</option></select></div>
      <div class="history-list" data-audit></div>
    </div>`;
  $('[data-add-user]', root).addEventListener('click', e => busy(e.currentTarget, addUser));
  $('[data-add-class]', root).addEventListener('click', e => busy(e.currentTarget, addClass));
  $('[data-audit-table]', root).addEventListener('change', loadAudit);
}

async function show() {
  await Promise.all([loadUsers(), loadClasses(), loadAudit()]);
}

async function loadUsers() {
  const users = await api('GET', '/users');
  $('[data-users]', root).innerHTML = `<table class="simple-table"><tbody>${users.map(u => `
    <tr data-email="${esc(u.email)}" class="${u.active ? '' : 'inactive'}">
      <td><div>${esc(u.display_name || u.email)}</div><div class="muted small">${esc(u.email)}${u.has_signed_in ? '' : ' · not signed in yet'}</div></td>
      <td><select data-role ${u.email === state.user.email ? 'disabled' : ''}>
        <option value="staff" ${u.role === 'staff' ? 'selected' : ''}>Staff</option><option value="owner" ${u.role === 'owner' ? 'selected' : ''}>Owner</option></select></td>
      <td>${u.email === state.user.email ? '<span class="muted small">you</span>'
        : `<button class="btn ghost small" type="button" data-toggle>${u.active ? 'Disable' : 'Enable'}</button>`}</td>
    </tr>`).join('')}</tbody></table>`;
  $$('[data-role]', root).forEach(s => s.addEventListener('change', () => updateUser(s.closest('tr').dataset.email, { role: s.value })));
  $$('[data-toggle]', root).forEach(b => b.addEventListener('click', () => {
    const tr = b.closest('tr');
    updateUser(tr.dataset.email, { active: tr.classList.contains('inactive') });
  }));
}

async function updateUser(email, body) {
  try {
    await api('PATCH', `/users/${encodeURIComponent(email)}`, body);
    toast('User updated');
  } finally {
    await loadUsers();
  }
}

async function addUser() {
  const get = k => $(`[data-u="${k}"]`, root);
  await api('POST', '/users', { email: get('email').value.trim(), display_name: get('display_name').value.trim(), role: get('role').value });
  get('email').value = '';
  get('display_name').value = '';
  toast('User added. Create their login in Supabase if they do not have one.');
  await loadUsers();
}

async function loadClasses() {
  const { classes } = await loadCatalog(true);
  $('[data-classes]', root).innerHTML = `<table class="simple-table"><tbody>${classes.map(c => `
    <tr data-code="${esc(c.code)}" class="${c.active ? '' : 'inactive'}">
      <td class="mono">${esc(c.code)}</td>
      <td><input type="text" data-label value="${esc(c.label)}" maxlength="40"></td>
      <td><input type="number" data-sort value="${c.sort_order}" class="mini-input" title="Order"></td>
      <td><button class="btn ghost small" type="button" data-toggle-class>${c.active ? 'Hide' : 'Show'}</button></td>
    </tr>`).join('')}</tbody></table>`;
  $$('[data-label], [data-sort]', root).forEach(input => input.addEventListener('change', () => {
    const tr = input.closest('tr');
    patchClass(tr.dataset.code, { label: $('[data-label]', tr).value, sort_order: Number($('[data-sort]', tr).value || 0) });
  }));
  $$('[data-toggle-class]', root).forEach(b => b.addEventListener('click', () => {
    const tr = b.closest('tr');
    patchClass(tr.dataset.code, { active: tr.classList.contains('inactive') });
  }));
}

async function patchClass(code, body) {
  try {
    await api('PATCH', `/classes/${encodeURIComponent(code)}`, body);
    toast('Vehicle class saved');
  } finally {
    await loadClasses();
  }
}

async function addClass() {
  const code = $('[data-c="code"]', root);
  const label = $('[data-c="label"]', root);
  await api('POST', '/classes', { code: code.value, label: label.value });
  code.value = '';
  label.value = '';
  toast('Class added. Set its prices in the Pricing Matrix.');
  await loadClasses();
}

async function loadAudit() {
  const table = $('[data-audit-table]', root).value;
  const entries = await api('GET', `/audit?limit=150${table ? `&table=${table}` : ''}`);
  $('[data-audit]', root).innerHTML = entries.map(describeChange).join('') || '<div class="empty-state small">No changes recorded yet.</div>';
}

// ---------------------------------------------------------------- readable audit entries

const TABLE_LABEL = { jobs: 'Job', job_items: 'Job item', expenses: 'Expense', daily_meta: 'EOD', catalog_items: 'Item',
  catalog_prices: 'Price', vehicle_classes: 'Vehicle class', employees: 'Employee', payroll_entries: 'Payroll', app_users: 'User' };
const HIDDEN = new Set(['updated_at', 'created_at', 'id']);

function rowName(entry) {
  const r = entry.new_row || entry.old_row || {};
  return r.jo_number || r.name || r.description || r.email || r.code || (r.job_date && `${r.job_date}`)
    || (r.period_start && `week of ${r.period_start}`) || (r.vehicle_class && `class ${r.vehicle_class}`) || `#${entry.row_pk}`;
}

const show_ = v => (v === null || v === undefined || v === '' ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v));

export function describeChange(entry) {
  const verb = { INSERT: 'added', UPDATE: 'changed', DELETE: 'deleted' }[entry.action];
  let details = '';
  if (entry.action === 'UPDATE') {
    const changes = Object.keys(entry.new_row || {})
      .filter(k => !HIDDEN.has(k) && JSON.stringify(entry.old_row?.[k]) !== JSON.stringify(entry.new_row[k]))
      .map(k => `<span class="change"><b>${esc(k)}</b> ${esc(show_(entry.old_row?.[k]))} → ${esc(show_(entry.new_row[k]))}</span>`);
    details = changes.join('');
  } else if (entry.table_name === 'job_items') {
    const r = entry.new_row || entry.old_row;
    details = `<span class="change">${esc(r.name)} · ₱${esc(r.price)} (comm ₱${esc(r.commission)})</span>`;
  }
  return `<div class="history-entry">
    <div class="history-meta"><span>${esc(prettyTime(entry.at))}</span><span>${esc(entry.actor || 'system')}</span></div>
    <div><span class="kind-pill ${entry.action === 'DELETE' ? 'custom' : entry.action === 'INSERT' ? 'service' : 'addon'}">${esc(TABLE_LABEL[entry.table_name] || entry.table_name)} ${verb}</span>
      <b>${esc(rowName(entry))}</b></div>
    ${details ? `<div class="history-changes">${details}</div>` : ''}
  </div>`;
}

export default { mount, show };
