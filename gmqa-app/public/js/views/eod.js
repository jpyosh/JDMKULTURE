import { $, $$, api, esc, peso, toast, busy, todayLocal, addDays, prettyDate, prettyTime, isOwner, DEPARTMENTS } from '../ui.js';

let root;
let current = { date: todayLocal(), day: null };

function mount(el) {
  root = el;
  root.innerHTML = `
    <div class="view-header">
      <div><h1>EOD Closing</h1><div class="desc">Count the drawer and GCash. Variance should be ₱0.00.</div></div>
      <div class="date-nav">
        <button class="btn ghost" type="button" data-shift="-1" aria-label="Previous day">‹</button>
        <input type="date" data-date>
        <button class="btn ghost" type="button" data-shift="1" aria-label="Next day">›</button>
        <button class="btn ghost" type="button" data-today>Today</button>
      </div>
    </div>
    <div data-status></div>
    <div class="metrics-row" data-metrics></div>
    <div class="card"><h2>Sales by department</h2><div class="table-wrap"><table class="simple-table dept-table" data-departments></table></div></div>
    <div class="two-col">
      <div>
        <div class="card">
          <h2>Setup</h2>
          <div class="form-grid">
            <div><label>Supervisor</label><input type="text" data-m="supervisor" maxlength="80"></div>
            <div><label>Cash float</label><input type="number" min="0" step="0.01" data-m="cash_float"></div>
            <div><label>Commission paid via GCash</label><input type="number" min="0" step="0.01" data-m="commission_gcash_paid"></div>
            <div><label>Other GCash tips</label><input type="number" min="0" step="0.01" data-m="gcash_tips_to_distribute"></div>
          </div>
          <h2 class="mt">Actual count</h2>
          <div class="form-grid">
            <div><label>Cash in drawer</label><input type="number" min="0" step="0.01" data-m="actual_cash"></div>
            <div><label>GCash balance</label><input type="number" min="0" step="0.01" data-m="actual_gcash"></div>
          </div>
          <div class="entry-actions"><button class="btn" type="button" data-save>Save</button></div>
        </div>
        <div class="card">
          <h2>Expenses</h2>
          <div data-expenses></div>
          <div class="expense-form">
            <select data-e="side"><option value="cash">Cash</option><option value="gcash">GCash</option></select>
            <input type="text" data-e="description" placeholder="What was it for?" maxlength="200">
            <input type="number" min="0.01" step="0.01" data-e="amount" placeholder="Amount">
            <button class="btn ghost" type="button" data-add-expense>+ Add</button>
          </div>
        </div>
      </div>
      <div>
        <div class="card"><h2>Cash drawer</h2><div data-cash></div></div>
        <div class="card"><h2>GCash</h2><div data-gcash></div></div>
        <div class="card"><h2>Variance</h2><div data-variance></div></div>
      </div>
    </div>
    <div class="card">
      <h2>Set aside for bills</h2>
      <p class="hint">Take each bill's weekly share out of the drawer and put it in its envelope/account. It is removed from the expected drawer above.</p>
      <div class="table-wrap"><table class="simple-table funds-table" data-funds></table></div>
    </div>`;

  $('[data-date]', root).addEventListener('change', e => { if (e.target.value) setDate(e.target.value); });
  $$('[data-shift]', root).forEach(b => b.addEventListener('click', () => setDate(addDays(current.date, Number(b.dataset.shift)))));
  $('[data-today]', root).addEventListener('click', () => setDate(todayLocal()));
  $$('[data-m]', root).forEach(el => el.addEventListener('input', renderMath));
  $('[data-save]', root).addEventListener('click', e => busy(e.currentTarget, save));
  $('[data-add-expense]', root).addEventListener('click', e => busy(e.currentTarget, addExpense));
}

async function show() { await setDate(current.date); }

async function setDate(date) {
  current.date = date;
  $('[data-date]', root).value = date;
  const [day, funds] = await Promise.all([api('GET', `/days/${date}`), api('GET', `/funds?date=${date}`)]);
  if (date !== current.date) return;
  current.day = day;
  current.funds = funds;
  render();
}

const locked = () => Boolean(current.day.meta.closed_at) && !isOwner();

function render() {
  const { meta, summary: s } = current.day;
  const closed = meta.closed_at;
  $('[data-status]', root).innerHTML = closed
    ? `<div class="banner ok">Closed by ${esc(meta.closed_by || '—')} · ${esc(prettyTime(closed))}
        ${isOwner() ? '<button class="btn ghost small" type="button" data-reopen>Reopen day</button>' : ''}</div>`
    : `<div class="banner">${esc(prettyDate(current.date))} is open. When the count matches, close the day to lock it.
        <button class="btn small" type="button" data-close-day>Close day</button></div>`;
  $('[data-reopen]', root)?.addEventListener('click', e => busy(e.currentTarget, async () => {
    current.day = await api('POST', `/days/${current.date}/reopen`);
    toast('Day reopened');
    render();
  }));
  $('[data-close-day]', root)?.addEventListener('click', e => busy(e.currentTarget, closeDay));

  $('[data-metrics]', root).innerHTML = `
    <div class="metric"><div class="label">Vehicles</div><div class="value">${s.vehicles}</div></div>
    <div class="metric"><div class="label">Collected</div><div class="value">${peso(s.collected)}</div></div>
    <div class="metric"><div class="label">Unpaid (receivable)</div><div class="value amber">${peso(s.receivables)}</div></div>
    <div class="metric"><div class="label">Commission</div><div class="value amber">${peso(s.commission)}</div></div>
    <div class="metric"><div class="label">Net</div><div class="value teal">${peso(s.net)}</div></div>`;

  const deptRow = (label, d, cls = '') => `<tr class="${cls}"><td>${label}</td><td class="num">${d.jobs}</td>
    <td class="num money">${peso(d.collected)}</td><td class="num money amber-text">${d.receivables ? peso(d.receivables) : '—'}</td>
    <td class="num money">${peso(d.commission)}</td><td class="num money pos">${peso(d.net)}</td></tr>`;
  $('[data-departments]', root).innerHTML = `
    <thead><tr><th>Department</th><th class="num">Jobs</th><th class="num">Sales collected</th><th class="num">Unpaid</th>
      <th class="num">Commission</th><th class="num">Net</th></tr></thead>
    <tbody>${DEPARTMENTS.map(d => deptRow(esc(d.label), s.departments[d.key])).join('')}
      ${deptRow('<b>All departments</b>', { jobs: s.vehicles, collected: s.collected, receivables: s.receivables, commission: s.commission, net: s.net }, 'total-row')}</tbody>`;

  for (const el of $$('[data-m]', root)) {
    const value = meta[el.dataset.m];
    el.value = value ?? (el.type === 'number' && !['actual_cash', 'actual_gcash'].includes(el.dataset.m) ? 0 : '');
    el.disabled = locked();
  }
  $('[data-save]', root).disabled = locked();
  $$('.expense-form [data-e], [data-add-expense]', root).forEach(el => { el.disabled = locked(); });

  $('[data-expenses]', root).innerHTML = current.day.expenses.length
    ? current.day.expenses.map(e => `<div class="row-line"><span class="k"><span class="kind-pill ${e.side === 'cash' ? 'service' : 'addon'}">${e.side === 'cash' ? 'Cash' : 'GCash'}</span> ${esc(e.description)}</span>
        <span>${peso(e.amount)} ${locked() ? '' : `<button class="icon-btn" type="button" data-del-expense="${e.id}" title="Delete">✕</button>`}</span></div>`).join('')
    : '<div class="empty-state small">No expenses recorded.</div>';
  $$('[data-del-expense]', root).forEach(b => b.addEventListener('click', async () => {
    if (!window.confirm('Delete this expense?')) return;
    current.day = await api('DELETE', `/expenses/${b.dataset.delExpense}`);
    toast('Expense deleted');
    render();
  }));
  renderFunds();
  renderMath();
}

function renderFunds() {
  const off = locked() ? 'disabled' : '';
  $('[data-funds]', root).innerHTML = `<thead><tr><th>Fund</th><th class="num">This week</th><th>Set aside today</th><th></th></tr></thead>
    <tbody>${current.funds.map(f => `<tr data-fund="${f.id}">
      <td><b>${esc(f.name)}</b><div class="muted small">balance ${peso(f.balance)} · next bill ${esc(f.nextDue || '—')}</div></td>
      <td class="num money">${f.amount ? `${peso(f.weeklyTarget)}<div class="muted small">${f.remainingThisWeek ? `${peso(f.remainingThisWeek)} left` : 'done ✓'}</div>` : '<span class="muted small">amount not set</span>'}</td>
      <td>${f.setAsidesOnDate.map(x => `<span class="item-chip">${peso(x.amount)} ${x.side === 'cash' ? 'cash' : 'GCash'}
        ${off ? '' : `<button class="icon-btn" type="button" data-del-sa="${x.id}" title="Undo">✕</button>`}</span>`).join('') || '<span class="muted small">—</span>'}</td>
      <td class="sa-form"><input type="number" min="0.01" step="0.01" data-sa-amount placeholder="${f.remainingThisWeek || 'Amount'}" ${off}>
        <select data-sa-side ${off}><option value="cash">Cash</option><option value="gcash">GCash</option></select>
        <button class="btn ghost small" type="button" data-sa-add ${off}>Set aside</button></td>
    </tr>`).join('')}</tbody>`;
  $$('[data-sa-add]', root).forEach(btn => btn.addEventListener('click', () => busy(btn, async () => {
    const tr = btn.closest('tr');
    const amount = Number($('[data-sa-amount]', tr).value || 0);
    if (!(amount > 0)) return toast('Enter the amount to set aside', 'error');
    await api('POST', `/funds/${tr.dataset.fund}/set-asides`, { date: current.date, side: $('[data-sa-side]', tr).value, amount });
    toast('Set aside recorded');
    await setDate(current.date);
  })));
  $$('[data-del-sa]', root).forEach(btn => btn.addEventListener('click', async () => {
    if (!window.confirm('Undo this set-aside? The money goes back into the expected drawer.')) return;
    await api('DELETE', `/fund-set-asides/${btn.dataset.delSa}`);
    toast('Set-aside removed');
    await setDate(current.date);
  }));
}

// Live preview using the values typed in, with the same formula as the server (lib/calc.js).
function renderMath() {
  const s = current.day.summary;
  const val = key => $(`[data-m="${key}"]`, root).value;
  const num = key => Number(val(key) || 0);
  const commissionGcash = Math.min(num('commission_gcash_paid'), s.commission);
  const commissionCash = s.commission - commissionGcash;
  const tips = s.jobTips + num('gcash_tips_to_distribute');
  const expectedCash = num('cash_float') + s.cashReceived - commissionCash - s.cashExpenses
    - s.payrollCash - s.setAsideCash - s.billTopUpCash;
  const expectedGcash = s.gcashReceived + tips - commissionGcash - s.gcashExpenses - tips
    - s.payrollGcash - s.setAsideGcash - s.billTopUpGcash;
  const line = (k, v, cls = '') => `<div class="row-line ${cls}"><span class="k">${k}</span><span class="money">${v}</span></div>`;

  $('[data-cash]', root).innerHTML =
    line('Cash float', peso(num('cash_float')))
    + line('+ Cash received today', peso(s.cashReceived))
    + line('− Commission paid in cash', peso(commissionCash))
    + line('− Cash expenses', peso(s.cashExpenses))
    + (s.payrollCash ? line('− Payroll paid out', peso(s.payrollCash)) : '')
    + (s.setAsideCash ? line('− Set aside to funds', peso(s.setAsideCash)) : '')
    + (s.billTopUpCash ? line('− Bill shortfall from drawer', peso(s.billTopUpCash)) : '')
    + line('Expected in drawer', peso(expectedCash), 'total');
  $('[data-gcash]', root).innerHTML =
    line('GCash received today', peso(s.gcashReceived))
    + line('+ Tips received', peso(tips))
    + line('− Tips passed to crew', peso(tips))
    + line('− Commission paid via GCash', peso(commissionGcash))
    + line('− GCash expenses', peso(s.gcashExpenses))
    + (s.payrollGcash ? line('− Payroll paid out', peso(s.payrollGcash)) : '')
    + (s.setAsideGcash ? line('− Set aside to funds', peso(s.setAsideGcash)) : '')
    + (s.billTopUpGcash ? line('− Bill shortfall from GCash', peso(s.billTopUpGcash)) : '')
    + line('Expected GCash', peso(expectedGcash), 'total');
  const notes = [];
  if (s.paidInAdvance) notes.push(`${peso(s.paidInAdvance)} received today is for running jobs that are not done yet. It is in today's count but becomes a sale when the job is done.`);
  if (s.paidEarlier) notes.push(`${peso(s.paidEarlier)} of today's sales were paid on an earlier day, so that money is not in today's count.`);
  $('[data-cash]', root).insertAdjacentHTML('beforeend', notes.map(n => `<div class="hint mt">${esc(n)}</div>`).join(''));

  const variance = (key, expected) => {
    if (val(key) === '') return '<span class="muted">not counted</span>';
    const v = Math.round((num(key) - expected) * 100) / 100;
    return `<span class="${v === 0 ? 'variance-ok' : 'variance-bad'}">${v > 0 ? '+' : ''}${peso(v)}${v === 0 ? ' ✓' : v > 0 ? ' over' : ' short'}</span>`;
  };
  $('[data-variance]', root).innerHTML = `
    <div class="row-line"><span class="k">Cash</span>${variance('actual_cash', expectedCash)}</div>
    <div class="row-line"><span class="k">GCash</span>${variance('actual_gcash', expectedGcash)}</div>
    ${s.unpaidJobs ? `<div class="hint">${s.unpaidJobs} unpaid job${s.unpaidJobs === 1 ? '' : 's'} (${peso(s.receivables)}) are not in the expected amounts.</div>` : ''}`;
}

function metaPayload() {
  const out = {};
  $$('[data-m]', root).forEach(el => {
    const key = el.dataset.m;
    out[key] = el.type === 'number' ? (el.value === '' ? (key.startsWith('actual_') ? null : 0) : Number(el.value)) : el.value.trim();
  });
  return out;
}

async function save() {
  current.day = await api('PUT', `/days/${current.date}`, metaPayload());
  toast('EOD saved');
  render();
}

async function closeDay() {
  // Save whatever is typed first so the day is closed with the numbers on screen.
  current.day = await api('PUT', `/days/${current.date}`, metaPayload());
  render();
  const fresh = current.day.summary;
  const s = fresh;
  const warnings = [];
  if (fresh.actualCash == null || fresh.actualGcash == null) warnings.push('the cash/GCash count has not been entered');
  else if (fresh.cashVariance !== 0 || fresh.gcashVariance !== 0) warnings.push(`there is a variance (cash ${peso(fresh.cashVariance)}, GCash ${peso(fresh.gcashVariance)})`);
  if (s.unpaidJobs) warnings.push(`${s.unpaidJobs} job(s) are still unpaid`);
  const msg = `Close ${current.date}? ${isOwner() ? '' : 'Staff will not be able to change it afterwards.'}${warnings.length ? `\n\nHeads up: ${warnings.join('; ')}.` : ''}`;
  if (!window.confirm(msg)) return;
  current.day = await api('POST', `/days/${current.date}/close`);
  toast('Day closed');
  render();
}

async function addExpense() {
  const get = key => $(`[data-e="${key}"]`, root);
  const body = { side: get('side').value, description: get('description').value.trim(), amount: Number(get('amount').value || 0) };
  if (!body.description) return toast('Describe the expense', 'error');
  if (!(body.amount > 0)) return toast('Enter an amount greater than zero', 'error');
  current.day = await api('POST', `/days/${current.date}/expenses`, body);
  get('description').value = '';
  get('amount').value = '';
  toast('Expense added');
  render();
}

export default { mount, show };
