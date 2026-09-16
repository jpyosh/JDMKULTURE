const CLASSES = ['S', 'M', 'L', 'XL', 'MOTO', 'BIG_MOTO'];
const todayStr = () => new Date().toISOString().slice(0, 10);
const peso = (n) => '₱' + Number(n || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const esc = value => String(value ?? '').replace(/[&<>'"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[character]));
let toastTimer;

function showToast(message, type = 'success') {
  const toast = document.getElementById('app-toast');
  toast.textContent = message;
  toast.className = `app-toast show ${type === 'error' ? 'error' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.className = 'app-toast'; }, 3200);
}

let pricing = { services: [], addons: [] };
let currentEod = null;
let authClient = null;
let currentSession = null;
const nativeFetch = window.fetch.bind(window);

window.fetch = async (input, init = {}) => {
  const headers = new Headers(init.headers || {});
  if (currentSession?.access_token) headers.set('Authorization', `Bearer ${currentSession.access_token}`);
  const response = await nativeFetch(input, { ...init, headers });
  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    try { message = (await response.clone().json()).error || message; } catch {}
    showToast(message, 'error');
    throw new Error(message);
  }
  return response;
};

window.addEventListener('unhandledrejection', event => {
  showToast(event.reason?.message || 'Something went wrong. Please try again.', 'error');
});

function applyAccessState() {
  const readOnly = !currentSession;
  document.body.classList.toggle('read-only', readOnly);
  document.getElementById('auth-label').textContent = readOnly ? 'Read-only access' : 'Signed in';
  document.querySelector('.status-dot').classList.toggle('online', !readOnly);
  document.getElementById('login-form').hidden = !readOnly;
  document.getElementById('signout-btn').hidden = readOnly;
  document.querySelectorAll('.view input:not([type="date"]), .view select, .view textarea, .view button').forEach(el => {
    el.disabled = readOnly;
  });
}

async function initAuth() {
  const config = await nativeFetch('/api/auth/config').then(r => r.json());
  if (config.url && config.anonKey && window.supabase) {
    authClient = window.supabase.createClient(config.url, config.anonKey);
    const result = await authClient.auth.getSession();
    currentSession = result.data.session;
    authClient.auth.onAuthStateChange((_event, session) => {
      currentSession = session;
      applyAccessState();
      loadDaily();
    });
  }
  applyAccessState();
  loadDaily();
}

document.getElementById('login-form').addEventListener('submit', async event => {
  event.preventDefault();
  const errorEl = document.getElementById('auth-error');
  errorEl.textContent = '';
  if (!authClient) {
    errorEl.textContent = 'Supabase Auth is not configured.';
    return;
  }
  const { error } = await authClient.auth.signInWithPassword({
    email: document.getElementById('login-email').value.trim(),
    password: document.getElementById('login-password').value,
  });
  if (error) errorEl.textContent = error.message;
});

document.getElementById('signout-btn').addEventListener('click', () => authClient?.auth.signOut());

// ---------------- Nav ----------------
document.querySelectorAll('.nav button').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav button').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('view-' + btn.dataset.view).classList.add('active');
    if (btn.dataset.view === 'pricing') loadPricingView();
    if (btn.dataset.view === 'eod') loadEod();
    if (btn.dataset.view === 'weekly') loadWeekly();
    if (btn.dataset.view === 'payroll') loadPayroll();
  });
});

// ================================================================
// DAILY LOG
// ================================================================
const dailyDateEl = document.getElementById('daily-date');
dailyDateEl.value = todayStr();
dailyDateEl.addEventListener('change', loadDaily);

async function ensurePricing() {
  if (!pricing.services.length && !pricing.addons.length) {
    pricing = await fetch('/api/pricing').then(r => r.json());
  }
  populateQuickJobSelectors();
  return pricing;
}

function populateQuickJobSelectors() {
  const serviceEl = document.getElementById('new-job-service');
  const addonEl = document.getElementById('new-job-addon');
  if (!serviceEl || !addonEl) return;

  serviceEl.innerHTML = '<option value="">Select service</option>' + pricing.services.map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join('');
  addonEl.innerHTML = '<option value="">None</option>' + pricing.addons.map(a => `<option value="${a.id}">${esc(a.name)}</option>`).join('');
}

async function loadDaily() {
  await ensurePricing();
  const date = dailyDateEl.value;
  const jobs = await fetch('/api/jobs/' + date).then(r => r.json());
  renderJobs(jobs);
  renderDailyMetrics(jobs);
}

function renderDailyMetrics(jobs) {
  const serviced = jobs.filter(j => j.vehicle_class);
  const gross = serviced.reduce((s, j) => s + j.computed.totalPrice, 0);
  const comm = serviced.reduce((s, j) => s + j.computed.detailerComm, 0);
  const net = gross - comm;
  const gcashTips = serviced.reduce((s, j) => s + Number(j.tip_gcash || 0), 0);
  document.getElementById('daily-metrics').innerHTML = `
    <div class="metric"><div class="label">Vehicles Serviced</div><div class="value">${serviced.length}</div></div>
    <div class="metric"><div class="label">Gross Sales</div><div class="value">${peso(gross)}</div></div>
    <div class="metric"><div class="label">Total Commissions</div><div class="value amber">${peso(comm)}</div></div>
    <div class="metric"><div class="label">GCash Tips</div><div class="value teal">${peso(gcashTips)}</div></div>
    <div class="metric"><div class="label">Net Shop Revenue</div><div class="value teal">${peso(net)}</div></div>
  `;
}

function selectOptions(list, selectedId, placeholder) {
  let html = `<option value="">${placeholder}</option>`;
  for (const item of list) {
    html += `<option value="${item.id}" ${item.id == selectedId ? 'selected' : ''}>${esc(item.name)}</option>`;
  }
  return html;
}

function renderJobs(jobs) {
  const tbody = document.getElementById('jobs-tbody');
  if (!jobs.length) {
    tbody.innerHTML = `<tr><td colspan="14"><div class="empty-state">No job orders yet for this date. Add the first one below.</div></td></tr>`;
    return;
  }
  tbody.innerHTML = jobs.map(j => rowHtml(j)).join('');
  tbody.querySelectorAll('[data-field]').forEach(el => {
    el.addEventListener('change', () => updateJob(el.closest('tr').dataset.id, el.dataset.field, el.value));
  });
  tbody.querySelectorAll('.del-job').forEach(el => {
    el.addEventListener('click', () => deleteJob(el.closest('tr').dataset.id));
  });
  applyAccessState();
}

function rowHtml(j) {
  const c = j.computed;
  return `<tr data-id="${j.id}">
    <td class="jo-number">${j.jo_number || '—'}</td>
    <td><input type="time" data-field="time_in" value="${esc(j.time_in)}"></td>
    <td><input type="time" data-field="time_out" value="${esc(j.time_out)}"></td>
    <td>
      <select data-field="vehicle_class">
        <option value="">—</option>
        ${CLASSES.map(c2 => `<option value="${c2}" ${j.vehicle_class === c2 ? 'selected' : ''}>${c2}</option>`).join('')}
      </select>
    </td>
    <td><input type="text" data-field="plate" value="${esc(j.plate)}"></td>
    <td><select data-field="service_id">${selectOptions(pricing.services, j.service_id, 'Select…')}</select></td>
    <td><select data-field="addon_id">${selectOptions(pricing.addons, j.addon_id, 'None')}</select></td>
    <td>
      <details class="extras-menu">
        <summary>${j.custom_addon_name || j.discount || j.tip_gcash ? 'Edit extras' : 'Add extras'}</summary>
        <div class="extras-fields">
          <input type="text" data-field="custom_addon_name" value="${esc(j.custom_addon_name)}" placeholder="Custom item">
          <input type="number" data-field="custom_price" value="${j.custom_price || ''}" placeholder="Custom price">
          <input type="number" data-field="custom_comm" value="${j.custom_comm || ''}" placeholder="Custom comm.">
          <input type="number" data-field="discount" value="${j.discount || ''}" placeholder="Discount">
          <input type="number" data-field="tip_gcash" value="${j.tip_gcash || ''}" placeholder="GCash tip">
        </div>
      </details>
    </td>
    <td><select data-field="payment_method">
        ${['Cash', 'GCash'].map(p => `<option ${j.payment_method === p ? 'selected' : ''}>${p}</option>`).join('')}
      </select></td>
    <td><input type="text" data-field="detailer" value="${esc(j.detailer)}"></td>
    <td class="num money">${peso(c.totalPrice)}</td>
    <td class="num money amber-text">${peso(c.detailerComm)}</td>
    <td class="num money pos">${peso(c.netRevenue)}</td>
    <td><button class="icon-btn del-job" title="Delete">✕</button></td>
  </tr>`;
}

let pendingJobPayload = null;

function reviewDetail(label, value, full = false) {
  return `<div class="review-detail${full ? ' full' : ''}"><span class="label">${esc(label)}</span><span class="value">${esc(value || '—')}</span></div>`;
}

document.getElementById('add-job-btn').addEventListener('click', () => {
  if (!currentSession) return;
  const date = dailyDateEl.value;
  pendingJobPayload = {
    job_date: date,
    time_in: document.getElementById('new-job-time').value || null,
    vehicle_class: document.getElementById('new-job-class').value || null,
    plate: document.getElementById('new-job-plate').value || null,
    service_id: document.getElementById('new-job-service').value || null,
    addon_id: document.getElementById('new-job-addon').value || null,
    custom_addon_name: document.getElementById('new-job-custom-name').value.trim() || null,
    custom_price: Number(document.getElementById('new-job-custom-price').value || 0),
    custom_comm: Number(document.getElementById('new-job-custom-comm').value || 0),
    discount: Number(document.getElementById('new-job-discount').value || 0),
    discount_reason: document.getElementById('new-job-discount-notes').value.trim() || null,
    payment_method: document.getElementById('new-job-payment').value || 'Cash',
    tip_gcash: Number(document.getElementById('new-job-tip').value || 0),
    detailer: document.getElementById('new-job-detailer').value || null,
  };

  const service = pricing.services.find(item => String(item.id) === pendingJobPayload.service_id);
  const addon = pricing.addons.find(item => String(item.id) === pendingJobPayload.addon_id);
  document.getElementById('job-review-details').innerHTML = [
    reviewDetail('Date', pendingJobPayload.job_date),
    reviewDetail('Time', pendingJobPayload.time_in),
    reviewDetail('Vehicle', `${pendingJobPayload.vehicle_class || 'Not selected'}${pendingJobPayload.plate ? ` (${pendingJobPayload.plate})` : ''}`),
    reviewDetail('Service', service?.name),
    reviewDetail('Add-on', addon?.name),
    reviewDetail('Payment', pendingJobPayload.payment_method),
    reviewDetail('Custom item', pendingJobPayload.custom_addon_name ? `${pendingJobPayload.custom_addon_name} - ${peso(pendingJobPayload.custom_price)}` : null),
    reviewDetail('Custom comm.', pendingJobPayload.custom_comm ? peso(pendingJobPayload.custom_comm) : null),
    reviewDetail('Discount', pendingJobPayload.discount ? `${peso(pendingJobPayload.discount)}${pendingJobPayload.discount_reason ? ` - ${pendingJobPayload.discount_reason}` : ''}` : null, true),
    reviewDetail('GCash tip', peso(pendingJobPayload.tip_gcash)),
    reviewDetail('Detailer', pendingJobPayload.detailer),
  ].join('');
  document.getElementById('job-review-modal').showModal();
});

document.getElementById('confirm-add-job').addEventListener('click', async event => {
  event.preventDefault();
  if (!pendingJobPayload) return;
  const button = event.currentTarget;
  button.disabled = true;
  try {
    await fetch('/api/jobs', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(pendingJobPayload),
    });
    document.getElementById('job-review-modal').close();
    pendingJobPayload = null;
  } finally {
    button.disabled = false;
  }

  document.getElementById('new-job-plate').value = '';
  document.getElementById('new-job-detailer').value = '';
  document.getElementById('new-job-service').value = '';
  document.getElementById('new-job-addon').value = '';
  document.getElementById('new-job-class').value = '';
  document.getElementById('new-job-tip').value = '';
  document.getElementById('new-job-custom-name').value = '';
  document.getElementById('new-job-custom-price').value = '';
  document.getElementById('new-job-custom-comm').value = '';
  document.getElementById('new-job-discount').value = '';
  document.getElementById('new-job-discount-notes').value = '';
  loadDaily();
});

async function updateJob(id, field, value) {
  await fetch('/api/jobs/' + id, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ [field]: value }),
  });
  loadDaily();
}

async function deleteJob(id) {
  if (!window.confirm('Delete this job order? This removes it from daily totals and cannot be undone.')) return;
  await fetch('/api/jobs/' + id, { method: 'DELETE' });
  showToast('Job order deleted');
  await loadDaily();
}

// ================================================================
// PRICING MATRIX
// ================================================================
async function loadPricingView() {
  pricing = await fetch('/api/pricing').then(r => r.json());
  document.getElementById('pricing-service-count').textContent = pricing.services.length;
  document.getElementById('pricing-addon-count').textContent = pricing.addons.length;
  renderPricingTable('services', pricing.services, 'services-tbody');
  renderPricingTable('addons', pricing.addons, 'addons-tbody');
}

function renderPricingTable(kind, rows, tbodyId) {
  const tbody = document.getElementById(tbodyId);
  tbody.innerHTML = rows.map(r => `
    <tr data-id="${r.id}" data-kind="${kind}">
      <td><input type="text" data-field="name" value="${esc(r.name)}" style="width:220px"></td>
      ${CLASSES.map(c => `<td class="num"><input type="number" data-field="price_${c}" value="${r['price_' + c]}" class="mini-input"></td>`).join('')}
      ${CLASSES.map(c => `<td class="num"><input type="number" data-field="comm_${c}" value="${r['comm_' + c]}" class="mini-input"></td>`).join('')}
      <td class="table-actions"><button class="icon-btn del-pricing" title="Delete ${kind === 'services' ? 'service' : 'add-on'}" aria-label="Delete">✕</button></td>
    </tr>`).join('');
  tbody.querySelectorAll('input').forEach(el => {
    el.addEventListener('change', () => savePricingCell(el));
  });
  tbody.querySelectorAll('.del-pricing').forEach(el => {
    el.addEventListener('click', () => deletePricing(el.closest('tr')));
  });
  applyAccessState();
}

async function deletePricing(row) {
  const kind = row.dataset.kind === 'services' ? 'service' : 'addon';
  const label = row.querySelector('[data-field="name"]').value;
  if (!window.confirm(`Delete ${kind === 'service' ? 'service' : 'add-on'} "${label}"? Existing job records will keep their saved details.`)) return;
  await fetch(`/api/pricing/${kind}/${row.dataset.id}`, { method: 'DELETE' });
  pricing = await fetch('/api/pricing').then(r => r.json());
  renderPricingTable('services', pricing.services, 'services-tbody');
  renderPricingTable('addons', pricing.addons, 'addons-tbody');
  populateQuickJobSelectors();
  showToast(`${kind === 'service' ? 'Service' : 'Add-on'} archived`);
}

async function savePricingCell(el) {
  const tr = el.closest('tr');
  const id = tr.dataset.id;
  const kind = tr.dataset.kind === 'services' ? 'service' : 'addon';
  await fetch(`/api/pricing/${kind}/${id}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ [el.dataset.field]: el.dataset.field === 'name' ? el.value : Number(el.value) }),
  });
}

document.getElementById('add-service-btn').addEventListener('click', async () => {
  const button = document.getElementById('add-service-btn');
  const body = { name: 'New Service' };
  CLASSES.forEach(c => { body['price_' + c] = 0; body['comm_' + c] = 0; });
  button.disabled = true;
  try {
    await fetch('/api/pricing/service', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    loadPricingView();
  } finally { button.disabled = false; }
});
document.getElementById('add-addon-btn').addEventListener('click', async () => {
  const button = document.getElementById('add-addon-btn');
  const body = { name: 'New Add-On' };
  CLASSES.forEach(c => { body['price_' + c] = 0; body['comm_' + c] = 0; });
  button.disabled = true;
  try {
    await fetch('/api/pricing/addon', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    loadPricingView();
  } finally { button.disabled = false; }
});

// ================================================================
// EOD DASHBOARD
// ================================================================
const eodDateEl = document.getElementById('eod-date');
eodDateEl.value = todayStr();
eodDateEl.addEventListener('change', loadEod);

async function loadEod() {
  const date = eodDateEl.value;
  const [eod, meta] = await Promise.all([
    fetch('/api/eod/' + date).then(r => r.json()),
    fetch('/api/meta/' + date).then(r => r.json()),
  ]);
  currentEod = eod;

  document.getElementById('eod-metrics').innerHTML = `
    <div class="metric"><div class="label">Vehicles Serviced</div><div class="value">${eod.totalVehicles}</div></div>
    <div class="metric"><div class="label">Gross Sales</div><div class="value">${peso(eod.grossSales)}</div></div>
    <div class="metric"><div class="label">Labor (Commissions)</div><div class="value amber">${peso(eod.totalComm)}</div></div>
    <div class="metric"><div class="label">Total Net Shop Revenue</div><div class="value teal">${peso(eod.totalNetRevenue)}</div></div>
  `;

  document.getElementById('meta-supervisor').value = meta.supervisor || '';
  document.getElementById('meta-float').value = meta.cash_float || 0;
  document.getElementById('meta-tips').value = meta.gcash_tips_to_distribute || 0;
  document.getElementById('meta-actual-cash').value = meta.actual_cash ?? '';
  document.getElementById('meta-actual-gcash').value = meta.actual_gcash ?? '';

  document.getElementById('cash-expenses').innerHTML = expenseListHtml(eod.expenses.filter(e => e.side === 'cash'));
  document.getElementById('gcash-expenses').innerHTML = expenseListHtml(eod.expenses.filter(e => e.side === 'gcash'));
  document.querySelectorAll('.del-exp').forEach(el => el.addEventListener('click', () => deleteExpense(el.dataset.id)));

  document.getElementById('expected-block').innerHTML = `
    <div class="row-line"><span class="k">Cash Float</span><span class="money">${peso(eod.cashFloat)}</span></div>
    <div class="row-line"><span class="k">+ Cash Sales</span><span class="money">${peso(eod.cashSales)}</span></div>
    <div class="row-line"><span class="k">− Commissions</span><span class="money">${peso(eod.totalComm)}</span></div>
    <div class="row-line"><span class="k">− Cash Expenses</span><span class="money">${peso(eod.cashExpenses)}</span></div>
    <div class="row-line total"><span>Expected Cash (After Deductions)</span><span class="money">${peso(eod.expectedCashAfter)}</span></div>
    <div class="row-line" style="margin-top:8px;"><span class="k">GCash / Digital Sales</span><span class="money">${peso(eod.digitalSales)}</span></div>
    <div class="row-line"><span class="k">+ Customer Tips Received</span><span class="money">${peso(eod.gcashTipsReceived)}</span></div>
    <div class="row-line"><span class="k">− GCash Expenses</span><span class="money">${peso(eod.gcashExpenses)}</span></div>
    <div class="row-line"><span class="k">− Tips Sent / Distributed</span><span class="money">${peso(eod.gcashTipsToDistribute)}</span></div>
    <div class="row-line total"><span>Expected GCash (After Deductions)</span><span class="money">${peso(eod.expectedGcashAfter)}</span></div>
    <div class="row-line total" style="border-top:2px solid var(--border);margin-top:10px;"><span>EXPECTED TOTAL</span><span class="money">${peso(eod.expectedTotal)}</span></div>
  `;

  document.getElementById('eod-breakdowns').innerHTML = `
    <div class="breakdown-card"><h2>Cash Reconciliation</h2>
      <div class="row-line"><span class="k">Cash Float</span><span class="money">${peso(eod.cashFloat)}</span></div>
      <div class="row-line"><span class="k">+ Sales</span><span class="money">${peso(eod.cashSales)}</span></div>
      <div class="row-line"><span class="k">− Commission</span><span class="money">${peso(eod.totalComm)}</span></div>
      <div class="row-line"><span class="k">− Cash Expenses</span><span class="money">${peso(eod.cashExpenses)}</span></div>
      <div class="row-line total"><span>Expected Cash</span><span class="money">${peso(eod.expectedCashAfter)}</span></div>
    </div>
    <div class="breakdown-card"><h2>GCash Reconciliation</h2>
      <div class="row-line"><span class="k">Digital Sales</span><span class="money">${peso(eod.digitalSales)}</span></div>
      <div class="row-line"><span class="k">+ Tips Received</span><span class="money">${peso(eod.gcashTipsReceived)}</span></div>
      <div class="row-line"><span class="k">− GCash Expenses</span><span class="money">${peso(eod.gcashExpenses)}</span></div>
      <div class="row-line"><span class="k">− Tips Sent / Distributed</span><span class="money">${peso(eod.gcashTipsToDistribute)}</span></div>
      <div class="row-line total"><span>Expected GCash</span><span class="money">${peso(eod.expectedGcashAfter)}</span></div>
    </div>
    <div class="breakdown-card tips"><h2>GCash Tips to Distribute</h2>
      <div class="row-line"><span class="k">Tips entered on jobs</span><span class="money">${peso(eod.jobGcashTips)}</span></div>
      <div class="row-line"><span class="k">Other tips</span><span class="money">${peso(eod.manualGcashTips)}</span></div>
      <div class="row-line total"><span>Total to distribute</span><span class="money teal-text">${peso(eod.gcashTipsToDistribute)}</span></div>
    </div>
  `;

  const cashV = eod.cashVariance, gcashV = eod.gcashVariance;
  document.getElementById('variance-block').innerHTML = `
    <div class="row-line"><span class="k">Cash Variance</span><span class="${varClass(cashV)}">${cashV == null ? '—' : peso(cashV)}</span></div>
    <div class="row-line"><span class="k">GCash Variance</span><span class="${varClass(gcashV)}">${gcashV == null ? '—' : peso(gcashV)}</span></div>
  `;
  applyAccessState();
}
function varClass(v) { if (v == null) return 'money'; return v === 0 ? 'variance-ok' : 'variance-bad'; }

function renderLiveVariance() {
  if (!currentEod) return;
  const actualCashValue = document.getElementById('meta-actual-cash').value;
  const actualGcashValue = document.getElementById('meta-actual-gcash').value;
  const cashVariance = actualCashValue === '' ? null : Number(actualCashValue) - currentEod.expectedCashAfter;
  const gcashVariance = actualGcashValue === '' ? null : Number(actualGcashValue) - currentEod.expectedGcashAfter;
  document.getElementById('variance-block').innerHTML = `
    <div class="row-line"><span class="k">Cash Variance</span><span class="${varClass(cashVariance)}">${cashVariance == null ? '—' : peso(cashVariance)}</span></div>
    <div class="row-line"><span class="k">GCash Variance</span><span class="${varClass(gcashVariance)}">${gcashVariance == null ? '—' : peso(gcashVariance)}</span></div>
  `;
}

function expenseListHtml(list) {
  if (!list.length) return `<div class="empty-state" style="padding:10px;">No entries yet.</div>`;
  return list.map(e => `
    <div class="row-line">
      <span class="k">${esc(e.description || 'ITEM')}</span>
      <span>${peso(e.amount)} <button class="icon-btn del-exp" data-id="${e.id}">✕</button></span>
    </div>`).join('');
}

async function deleteExpense(id) {
  if (!window.confirm('Delete this expense? It will be removed from the EOD reconciliation.')) return;
  await fetch('/api/expenses/' + id, { method: 'DELETE' });
  showToast('Expense deleted');
  loadEod();
}

document.getElementById('add-cash-exp').addEventListener('click', () => addExpense('cash', 'exp-cash-desc', 'exp-cash-amt'));
document.getElementById('add-gcash-exp').addEventListener('click', () => addExpense('gcash', 'exp-gcash-desc', 'exp-gcash-amt'));

async function addExpense(side, descId, amtId) {
  const description = document.getElementById(descId).value;
  const amount = Number(document.getElementById(amtId).value || 0);
  if (!amount) return;
  const button = document.getElementById(side === 'cash' ? 'add-cash-exp' : 'add-gcash-exp');
  button.disabled = true;
  try {
    await fetch('/api/expenses', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expense_date: eodDateEl.value, side, description, amount }),
    });
    document.getElementById(descId).value = '';
    document.getElementById(amtId).value = '';
    loadEod();
  } finally { button.disabled = false; }
}

document.getElementById('save-meta').addEventListener('click', async event => {
  const button = event.currentTarget;
  button.disabled = true;
  try { await fetch('/api/meta/' + eodDateEl.value, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      supervisor: document.getElementById('meta-supervisor').value,
      cash_float: Number(document.getElementById('meta-float').value || 0),
      gcash_tips_to_distribute: Number(document.getElementById('meta-tips').value || 0),
      actual_cash: document.getElementById('meta-actual-cash').value === '' ? null : Number(document.getElementById('meta-actual-cash').value),
      actual_gcash: document.getElementById('meta-actual-gcash').value === '' ? null : Number(document.getElementById('meta-actual-gcash').value),
    }),
  });
    showToast('EOD details saved');
    loadEod();
  } finally { button.disabled = false; }
});

document.getElementById('meta-actual-cash').addEventListener('input', renderLiveVariance);
document.getElementById('meta-actual-gcash').addEventListener('input', renderLiveVariance);

// ================================================================
// WEEKLY ROLLUP
// ================================================================
const weekStartEl = document.getElementById('week-start');
const weekEndEl = document.getElementById('week-end');
(function initWeek() {
  const end = new Date();
  const start = new Date();
  start.setDate(end.getDate() - 6);
  weekStartEl.value = start.toISOString().slice(0, 10);
  weekEndEl.value = end.toISOString().slice(0, 10);
})();
weekStartEl.addEventListener('change', loadWeekly);
weekEndEl.addEventListener('change', loadWeekly);

async function loadWeekly() {
  const { days, totals } = await fetch(`/api/weekly?start=${weekStartEl.value}&end=${weekEndEl.value}`).then(r => r.json());
  const tbody = document.getElementById('weekly-tbody');
  document.getElementById('weekly-summary').innerHTML = `
    <div class="weekly-stat"><span class="weekly-stat-label">Vehicles serviced</span><strong>${totals.vehicles}</strong><span class="weekly-stat-note">Across selected days</span></div>
    <div class="weekly-stat"><span class="weekly-stat-label">Gross sales</span><strong>${peso(totals.grossSales)}</strong><span class="weekly-stat-note">Total collected</span></div>
    <div class="weekly-stat"><span class="weekly-stat-label">Total deductions</span><strong class="amber-text">${peso(totals.commissions + totals.otherExpenses)}</strong><span class="weekly-stat-note">Commissions + expenses</span></div>
    <div class="weekly-stat weekly-stat-profit"><span class="weekly-stat-label">True net profit</span><strong class="pos">${peso(totals.netProfit)}</strong><span class="weekly-stat-note">After all deductions</span></div>
  `;
  if (!days.length) {
    tbody.innerHTML = `<tr><td colspan="6"><div class="empty-state">No job data in this range yet.</div></td></tr>`;
    return;
  }
  tbody.innerHTML = days.map(d => `
    <tr>
      <td><strong class="weekly-date">${d.date}</strong></td><td class="num" data-label="Vehicles serviced">${d.vehicles}</td><td class="num money" data-label="Gross sales">${peso(d.grossSales)}</td>
      <td class="num money" data-label="Commissions">${peso(d.commissions)}</td><td class="num money" data-label="Other expenses">${peso(d.otherExpenses)}</td><td class="num money pos weekly-profit" data-label="True net profit">${peso(d.netProfit)}</td>
    </tr>`).join('') + `
    <tr class="weekly-total">
      <td><strong>Total for period</strong></td><td class="num">${totals.vehicles}</td><td class="num money">${peso(totals.grossSales)}</td>
      <td class="num money">${peso(totals.commissions)}</td><td class="num money">${peso(totals.otherExpenses)}</td>
      <td class="num money pos weekly-profit">${peso(totals.netProfit)}</td>
    </tr>`;
}

// ================================================================
// PAYROLL
// ================================================================
const payrollPeriodEl = document.getElementById('payroll-period');
function mondayOf(dateString) {
  const date = new Date(`${dateString}T00:00:00`);
  const day = date.getDay();
  date.setDate(date.getDate() - (day === 0 ? 6 : day - 1));
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const dayOfMonth = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${dayOfMonth}`;
}
function weekDates(start) {
  return Array.from({ length: 7 }, (_, index) => {
    const date = new Date(`${start}T00:00:00`);
    date.setDate(date.getDate() + index);
    return date.toISOString().slice(0, 10);
  });
}
const attendanceCodes = ['', 'P', '0.5P', 'CN', '0.5CN', 'A', 'OFF'];
payrollPeriodEl.value = mondayOf(todayStr());
payrollPeriodEl.addEventListener('change', () => {
  payrollPeriodEl.value = mondayOf(payrollPeriodEl.value);
  loadPayroll();
});

async function loadPayroll() {
  if (!payrollPeriodEl.value) return;
  const periodLabel = mondayOf(payrollPeriodEl.value);
  payrollPeriodEl.value = periodLabel;
  const { rows, totalNetPay } = await fetch('/api/payroll/' + encodeURIComponent(periodLabel)).then(r => r.json());
  const dates = weekDates(periodLabel);
  const dayNames = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  document.getElementById('payroll-head').innerHTML = `<tr>
    <th>Employee</th><th>Role</th>${dates.map((date, index) => `<th class="attendance-day">${dayNames[index]}<small>${date.slice(5)}</small></th>`).join('')}
    <th class="num">CW Days</th><th class="num">CN Days</th><th class="num">CW Rate</th><th class="num">CN Rate</th><th class="num">CW OT</th><th class="num">CN OT</th><th class="num">Gross Pay</th><th class="num">Deductions</th><th class="num">Net Pay</th><th></th>
  </tr>`;
  const tbody = document.getElementById('payroll-tbody');
  tbody.innerHTML = rows.map(r => `
    <tr data-emp="${r.employee.id}">
      <td><input type="text" data-employee-field="name" value="${esc(r.employee.name)}" class="employee-name"></td>
      <td><input type="text" data-employee-field="role" value="${esc(r.employee.role)}" placeholder="Role" class="employee-role"></td>
      ${dates.map(date => `<td class="attendance-cell"><select data-attendance-date="${date}" class="attendance-select">${attendanceCodes.map(code => `<option value="${code}" ${(JSON.parse(r.entry.attendance || '{}')[date] || '') === code ? 'selected' : ''}>${code || '—'}</option>`).join('')}</select></td>`).join('')}
      <td class="num">${r.entry.days_worked + (r.entry.half_days || 0) * 0.5}</td>
      <td class="num">${r.entry.construction_days}</td>
      <td class="num"><input type="number" class="mini-input" data-employee-field="rate_per_day" value="${r.employee.rate_per_day}" aria-label="Carwash rate"></td>
      <td class="num"><input type="number" class="mini-input" data-employee-field="construction_rate" value="${r.employee.construction_rate}"></td>
      <td class="num"><input type="number" class="mini-input" data-field="cw_ot_hours" value="${r.entry.cw_ot_hours || 0}"></td>
      <td class="num"><input type="number" class="mini-input" data-field="cn_ot_hours" value="${r.entry.cn_ot_hours || 0}"></td>
      <td class="num money">${peso(r.finalSalary + Number(r.entry.deductions || 0))}</td>
      <td class="num"><input type="number" class="mini-input" data-field="deductions" value="${r.entry.deductions || 0}"></td>
      <td class="num money pos">${peso(r.finalSalary)}</td>
      <td><button class="icon-btn remove-employee" title="Deactivate employee">✕</button></td>
    </tr>`).join('');
  tbody.querySelectorAll('[data-field], [data-attendance-date]').forEach(el => el.addEventListener('change', () => savePayrollCell(el)));
  tbody.querySelectorAll('[data-employee-field]').forEach(el => el.addEventListener('change', () => saveEmployeeCell(el)));
  tbody.querySelectorAll('.remove-employee').forEach(el => el.addEventListener('click', () => removeEmployee(el.closest('tr').dataset.emp)));
  document.getElementById('payroll-total').textContent = peso(totalNetPay);
  applyAccessState();
}

async function savePayrollCell(el) {
  const empId = el.closest('tr').dataset.emp;
  const row = document.querySelector(`tr[data-emp="${empId}"]`);
  const body = {};
  row.querySelectorAll('[data-field]').forEach(i => { body[i.dataset.field] = Number(i.value || 0); });
  body.attendance = {};
  row.querySelectorAll('[data-attendance-date]').forEach(i => { body.attendance[i.dataset.attendanceDate] = i.value; });
  await fetch(`/api/payroll/${encodeURIComponent(mondayOf(payrollPeriodEl.value))}/${empId}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  loadPayroll();
}

async function saveEmployeeCell(el) {
  await fetch(`/api/employees/${el.closest('tr').dataset.emp}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [el.dataset.employeeField]: ['name', 'role'].includes(el.dataset.employeeField) ? el.value.trim() : Number(el.value || 0) }),
  });
  loadPayroll();
}

async function removeEmployee(id) {
  if (!confirm('Remove this employee from active payroll?')) return;
  await fetch(`/api/employees/${id}`, { method: 'DELETE' });
  loadPayroll();
}

document.getElementById('add-employee-btn').addEventListener('click', () => {
  document.getElementById('employee-form').reset();
  document.getElementById('employee-rate').value = '250';
  document.getElementById('employee-construction-rate').value = '700';
  document.getElementById('employee-modal').showModal();
});

document.getElementById('confirm-add-employee').addEventListener('click', async event => {
  event.preventDefault();
  const name = document.getElementById('employee-name').value.trim();
  if (!name) return;
  const button = event.currentTarget;
  button.disabled = true;
  try {
    await fetch('/api/employees', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, role: document.getElementById('employee-role').value.trim(), rate_per_day: Number(document.getElementById('employee-rate').value || 0), construction_rate: Number(document.getElementById('employee-construction-rate').value || 0) }),
    });
    document.getElementById('employee-modal').close();
    showToast('Employee added');
    loadPayroll();
  } finally { button.disabled = false; }
});

// ---------------- init ----------------
initAuth();
