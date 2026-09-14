const CLASSES = ['S', 'M', 'L', 'XL', 'MOTO', 'BIG_MOTO'];
const todayStr = () => new Date().toISOString().slice(0, 10);
const peso = (n) => '₱' + Number(n || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

let pricing = { services: [], addons: [] };

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

  serviceEl.innerHTML = '<option value="">Select service</option>' + pricing.services.map(s => `<option value="${s.id}">${s.name}</option>`).join('');
  addonEl.innerHTML = '<option value="">None</option>' + pricing.addons.map(a => `<option value="${a.id}">${a.name}</option>`).join('');
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
    html += `<option value="${item.id}" ${item.id == selectedId ? 'selected' : ''}>${item.name}</option>`;
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
}

function rowHtml(j) {
  const c = j.computed;
  return `<tr data-id="${j.id}">
    <td class="jo-number">${j.jo_number || '—'}</td>
    <td><input type="time" data-field="time_in" value="${j.time_in || ''}"></td>
    <td><input type="time" data-field="time_out" value="${j.time_out || ''}"></td>
    <td>
      <select data-field="vehicle_class">
        <option value="">—</option>
        ${CLASSES.map(c2 => `<option value="${c2}" ${j.vehicle_class === c2 ? 'selected' : ''}>${c2}</option>`).join('')}
      </select>
    </td>
    <td><input type="text" data-field="plate" value="${j.plate || ''}"></td>
    <td><select data-field="service_id">${selectOptions(pricing.services, j.service_id, 'Select…')}</select></td>
    <td><select data-field="addon_id">${selectOptions(pricing.addons, j.addon_id, 'None')}</select></td>
    <td>
      <details class="extras-menu">
        <summary>${j.custom_addon_name || j.discount || j.tip_gcash ? 'Edit extras' : 'Add extras'}</summary>
        <div class="extras-fields">
          <input type="text" data-field="custom_addon_name" value="${j.custom_addon_name || ''}" placeholder="Custom item">
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
    <td><input type="text" data-field="detailer" value="${j.detailer || ''}"></td>
    <td class="num money">${peso(c.totalPrice)}</td>
    <td class="num money amber-text">${peso(c.detailerComm)}</td>
    <td class="num money pos">${peso(c.netRevenue)}</td>
    <td><button class="icon-btn del-job" title="Delete">✕</button></td>
  </tr>`;
}

document.getElementById('add-job-btn').addEventListener('click', async () => {
  const date = dailyDateEl.value;
  const payload = {
    job_date: date,
    time_in: document.getElementById('new-job-time').value || null,
    vehicle_class: document.getElementById('new-job-class').value || null,
    plate: document.getElementById('new-job-plate').value || null,
    service_id: document.getElementById('new-job-service').value || null,
    addon_id: document.getElementById('new-job-addon').value || null,
    payment_method: document.getElementById('new-job-payment').value || 'Cash',
    tip_gcash: Number(document.getElementById('new-job-tip').value || 0),
    detailer: document.getElementById('new-job-detailer').value || null,
  };

  await fetch('/api/jobs', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  document.getElementById('new-job-plate').value = '';
  document.getElementById('new-job-detailer').value = '';
  document.getElementById('new-job-service').value = '';
  document.getElementById('new-job-addon').value = '';
  document.getElementById('new-job-class').value = '';
  document.getElementById('new-job-tip').value = '';
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
  await fetch('/api/jobs/' + id, { method: 'DELETE' });
  loadDaily();
}

// ================================================================
// PRICING MATRIX
// ================================================================
async function loadPricingView() {
  pricing = await fetch('/api/pricing').then(r => r.json());
  renderPricingTable('services', pricing.services, 'services-tbody');
  renderPricingTable('addons', pricing.addons, 'addons-tbody');
}

function renderPricingTable(kind, rows, tbodyId) {
  const tbody = document.getElementById(tbodyId);
  tbody.innerHTML = rows.map(r => `
    <tr data-id="${r.id}" data-kind="${kind}">
      <td><input type="text" data-field="name" value="${r.name}" style="width:220px"></td>
      ${CLASSES.map(c => `<td class="num"><input type="number" data-field="price_${c}" value="${r['price_' + c]}" class="mini-input"></td>`).join('')}
      ${CLASSES.map(c => `<td class="num"><input type="number" data-field="comm_${c}" value="${r['comm_' + c]}" class="mini-input"></td>`).join('')}
    </tr>`).join('');
  tbody.querySelectorAll('input').forEach(el => {
    el.addEventListener('change', () => savePricingCell(el));
  });
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
  const body = { name: 'New Service' };
  CLASSES.forEach(c => { body['price_' + c] = 0; body['comm_' + c] = 0; });
  await fetch('/api/pricing/service', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  loadPricingView();
});
document.getElementById('add-addon-btn').addEventListener('click', async () => {
  const body = { name: 'New Add-On' };
  CLASSES.forEach(c => { body['price_' + c] = 0; body['comm_' + c] = 0; });
  await fetch('/api/pricing/addon', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  loadPricingView();
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
    <div class="row-line"><span class="k">Cash Float + Cash Sales</span><span class="money">${peso(eod.expectedCashPre)}</span></div>
    <div class="row-line"><span class="k">− Commissions − Cash Expenses</span><span class="money">${peso(eod.totalComm + eod.cashExpenses)}</span></div>
    <div class="row-line total"><span>Expected Cash (After Deductions)</span><span class="money">${peso(eod.expectedCashAfter)}</span></div>
    <div class="row-line" style="margin-top:8px;"><span class="k">Digital Sales</span><span class="money">${peso(eod.digitalSales)}</span></div>
    <div class="row-line"><span class="k">− GCash Expenses − Tips to Distribute</span><span class="money">${peso(eod.gcashExpenses + eod.gcashTipsToDistribute)}</span></div>
    <div class="row-line total"><span>Expected GCash (After Deductions)</span><span class="money">${peso(eod.expectedGcashAfter)}</span></div>
    <div class="row-line total" style="border-top:2px solid var(--border);margin-top:10px;"><span>EXPECTED TOTAL</span><span class="money">${peso(eod.expectedTotal)}</span></div>
  `;

  const cashV = eod.cashVariance, gcashV = eod.gcashVariance;
  document.getElementById('variance-block').innerHTML = `
    <div class="row-line"><span class="k">Cash Variance</span><span class="${varClass(cashV)}">${cashV == null ? '—' : peso(cashV)}</span></div>
    <div class="row-line"><span class="k">GCash Variance</span><span class="${varClass(gcashV)}">${gcashV == null ? '—' : peso(gcashV)}</span></div>
  `;
}
function varClass(v) { if (v == null) return 'money'; return v === 0 ? 'variance-ok' : 'variance-bad'; }

function expenseListHtml(list) {
  if (!list.length) return `<div class="empty-state" style="padding:10px;">No entries yet.</div>`;
  return list.map(e => `
    <div class="row-line">
      <span class="k">${e.description || 'ITEM'}</span>
      <span>${peso(e.amount)} <button class="icon-btn del-exp" data-id="${e.id}">✕</button></span>
    </div>`).join('');
}

async function deleteExpense(id) {
  await fetch('/api/expenses/' + id, { method: 'DELETE' });
  loadEod();
}

document.getElementById('add-cash-exp').addEventListener('click', () => addExpense('cash', 'exp-cash-desc', 'exp-cash-amt'));
document.getElementById('add-gcash-exp').addEventListener('click', () => addExpense('gcash', 'exp-gcash-desc', 'exp-gcash-amt'));

async function addExpense(side, descId, amtId) {
  const description = document.getElementById(descId).value;
  const amount = Number(document.getElementById(amtId).value || 0);
  if (!amount) return;
  await fetch('/api/expenses', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ expense_date: eodDateEl.value, side, description, amount }),
  });
  document.getElementById(descId).value = '';
  document.getElementById(amtId).value = '';
  loadEod();
}

document.getElementById('save-meta').addEventListener('click', async () => {
  await fetch('/api/meta/' + eodDateEl.value, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      supervisor: document.getElementById('meta-supervisor').value,
      cash_float: Number(document.getElementById('meta-float').value || 0),
      gcash_tips_to_distribute: Number(document.getElementById('meta-tips').value || 0),
      actual_cash: document.getElementById('meta-actual-cash').value === '' ? null : Number(document.getElementById('meta-actual-cash').value),
      actual_gcash: document.getElementById('meta-actual-gcash').value === '' ? null : Number(document.getElementById('meta-actual-gcash').value),
    }),
  });
  loadEod();
});

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
  if (!days.length) {
    tbody.innerHTML = `<tr><td colspan="6"><div class="empty-state">No job data in this range yet.</div></td></tr>`;
    return;
  }
  tbody.innerHTML = days.map(d => `
    <tr>
      <td>${d.date}</td><td class="num">${d.vehicles}</td><td class="num money">${peso(d.grossSales)}</td>
      <td class="num money">${peso(d.commissions)}</td><td class="num money">${peso(d.otherExpenses)}</td>
      <td class="num money pos">${peso(d.netProfit)}</td>
    </tr>`).join('') + `
    <tr style="font-weight:600;">
      <td>Total</td><td class="num">${totals.vehicles}</td><td class="num money">${peso(totals.grossSales)}</td>
      <td class="num money">${peso(totals.commissions)}</td><td class="num money">${peso(totals.otherExpenses)}</td>
      <td class="num money pos">${peso(totals.netProfit)}</td>
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
  return date.toISOString().slice(0, 10);
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
payrollPeriodEl.addEventListener('change', loadPayroll);

async function loadPayroll() {
  if (!payrollPeriodEl.value) return;
  const { rows, totalNetPay } = await fetch('/api/payroll/' + encodeURIComponent(payrollPeriodEl.value)).then(r => r.json());
  const dates = weekDates(payrollPeriodEl.value);
  const dayNames = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  document.getElementById('payroll-head').innerHTML = `<tr>
    <th>Employee</th><th>Role</th>${dates.map((date, index) => `<th class="attendance-day">${dayNames[index]}<small>${date.slice(5)}</small></th>`).join('')}
    <th class="num">CW Days</th><th class="num">CN Days</th><th class="num">CW Rate</th><th class="num">CN Rate</th><th class="num">CW OT</th><th class="num">CN OT</th><th class="num">Gross Pay</th><th class="num">Deductions</th><th class="num">Net Pay</th><th></th>
  </tr>`;
  const tbody = document.getElementById('payroll-tbody');
  tbody.innerHTML = rows.map(r => `
    <tr data-emp="${r.employee.id}">
      <td><input type="text" data-employee-field="name" value="${r.employee.name}" class="employee-name"></td>
      <td><input type="text" data-employee-field="role" value="${r.employee.role || ''}" placeholder="Role" class="employee-role"></td>
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
}

async function savePayrollCell(el) {
  const empId = el.closest('tr').dataset.emp;
  const row = document.querySelector(`tr[data-emp="${empId}"]`);
  const body = {};
  row.querySelectorAll('[data-field]').forEach(i => { body[i.dataset.field] = Number(i.value || 0); });
  body.attendance = {};
  row.querySelectorAll('[data-attendance-date]').forEach(i => { body.attendance[i.dataset.attendanceDate] = i.value; });
  await fetch(`/api/payroll/${encodeURIComponent(payrollPeriodEl.value)}/${empId}`, {
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

document.getElementById('add-employee-btn').addEventListener('click', async () => {
  const name = prompt('Employee name:');
  if (!name) return;
  const rate = Number(prompt('Rate per day:', '250') || 0);
  await fetch('/api/employees', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, rate_per_day: rate, construction_rate: 700 }),
  });
  loadPayroll();
});

// ---------------- init ----------------
loadDaily();
