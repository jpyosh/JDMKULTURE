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
    <div class="card envelopes" data-envelopes>
      <h2>Bill envelopes</h2>
      <p class="hint">Save a little for each bill every week, so the full amount is ready when the bill comes.</p>
      <ol class="plain-steps">
        <li>Each bill below shows how much to put aside <b>this week</b>. Press its button.</li>
        <li>Take that money out of the drawer and put it in an <b>envelope</b>. Write the bill name, the amount and today's date on it.</li>
        <li>Hand the envelope to the <b>owner</b> together with today's tape. The app already took it out of the expected drawer.</li>
      </ol>
      <div data-envelope-list></div>
    </div>
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
            <label class="sr-only" for="expense-side">Paid from</label>
            <select data-e="side" id="expense-side" title="Paid from"><option value="cash">Drawer cash</option><option value="gcash">GCash</option>
              <option value="fund">Cash fund (abono)</option></select>
            <input type="text" data-e="description" placeholder="What was it for?" maxlength="200">
            <input type="number" min="0.01" step="0.01" data-e="amount" placeholder="Amount">
            <button class="btn ghost" type="button" data-add-expense>+ Add</button>
          </div>
          <div class="hint" data-fund-hint></div>
        </div>
      </div>
      <div>
        <div class="card"><h2>Cash drawer</h2><div data-cash></div></div>
        <div class="card"><h2>GCash</h2><div data-gcash></div></div>
        <div class="card"><h2>Variance</h2><div data-variance></div></div>
      </div>
    </div>
`;

  $('[data-date]', root).addEventListener('change', e => { if (e.target.value) setDate(e.target.value); });
  $$('[data-shift]', root).forEach(b => b.addEventListener('click', () => setDate(addDays(current.date, Number(b.dataset.shift)))));
  $('[data-today]', root).addEventListener('click', () => setDate(todayLocal()));
  $$('[data-m]', root).forEach(el => el.addEventListener('input', renderMath));
  $('[data-save]', root).addEventListener('click', e => busy(e.currentTarget, save));
  $('[data-add-expense]', root).addEventListener('click', e => busy(e.currentTarget, addExpense));
  $('[data-e="side"]', root).addEventListener('change', renderFundHint);
}

async function show() { await setDate(current.date); }

async function setDate(date) {
  current.date = date;
  $('[data-date]', root).value = date;
  const [day, funds, cashFund] = await Promise.all([api('GET', `/days/${date}`), api('GET', `/funds?date=${date}`), api('GET', '/cash-fund')]);
  if (date !== current.date) return;
  current.day = day;
  current.funds = funds;
  current.cashFund = cashFund;
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
    ? current.day.expenses.map(e => `<div class="row-line"><span class="k"><span class="kind-pill ${EXPENSE_PILL[e.side].cls}">${EXPENSE_PILL[e.side].label}</span> ${esc(e.description)}</span>
        <span>${peso(e.amount)} ${locked() || e.topup_id ? '' : `<button class="icon-btn" type="button" data-del-expense="${e.id}" title="Delete">✕</button>`}</span></div>`).join('')
      + (current.day.summary.fundExpenses ? `<div class="hint mt">${peso(current.day.summary.fundExpenses)} was paid from the cash fund, so it is not taken out of the drawer.</div>` : '')
    : '<div class="empty-state small">No expenses recorded.</div>';
  $$('[data-del-expense]', root).forEach(b => b.addEventListener('click', async () => {
    if (!window.confirm('Delete this expense?')) return;
    current.day = await api('DELETE', `/expenses/${b.dataset.delExpense}`);
    current.cashFund = await api('GET', '/cash-fund');
    toast('Expense deleted');
    render();
  }));
  renderEnvelopes();
  renderFundHint();
  renderMath();
}

const EXPENSE_PILL = { cash: { cls: 'service', label: 'Cash' }, gcash: { cls: 'addon', label: 'GCash' }, fund: { cls: 'part', label: 'Cash fund' } };

function renderFundHint() {
  const fund = current.cashFund;
  const hint = $('[data-fund-hint]', root);
  if ($('[data-e="side"]', root).value !== 'fund') {
    hint.textContent = 'Bought something today\'s sales can\'t cover (an abono)? Choose "Cash fund (abono)" in the first box.';
    return;
  }
  hint.textContent = fund.balance > 0
    ? `Cash fund: ${peso(fund.balance)} left. This purchase is a cost of today but does not change the drawer count.`
    : 'The cash fund is empty. The owner records the money for it in the Cash fund tab.';
}

// Bill envelopes: one row per bill with its amount for this week filled in, so putting money aside is one press.
function renderEnvelopes() {
  const off = locked() ? 'disabled' : '';
  const withAmount = current.funds.filter(f => f.amount > 0);
  const noAmount = current.funds.filter(f => !(f.amount > 0));
  const shortDate = d => (d ? prettyDate(d).replace(/^\w+, /, '') : '—');
  $('[data-envelope-list]', root).innerHTML = withAmount.map(f => {
    const todays = f.setAsidesOnDate.map(x => `<span class="item-chip">${peso(x.amount)} ${x.side === 'cash' ? 'cash' : 'GCash'} today
      ${off ? '' : `<button class="icon-btn" type="button" data-del-sa="${x.id}" title="Undo" aria-label="Undo ${peso(x.amount)}">✕</button>`}</span>`).join('');
    const status = f.remainingThisWeek > 0
      ? `Put <b>${peso(f.remainingThisWeek)}</b> aside this week${f.setAsideThisWeek ? ` (${peso(f.setAsideThisWeek)} of ${peso(f.weeklyTarget)} done)` : ''}`
      : '<span class="variance-ok">Done for this week ✓</span>';
    return `<div class="envelope" data-envelope data-fund="${f.id}">
      <div class="envelope-main">
        <div><b>${esc(f.name)}</b> <span class="muted small">bill ${peso(f.amount)} · due ${esc(shortDate(f.nextDue))} · ${peso(f.balance)} saved so far</span></div>
        <div class="envelope-status">${status}</div>
        ${todays ? `<div class="envelope-today">${todays}</div>` : ''}
      </div>
      <div class="envelope-actions">
        ${f.remainingThisWeek > 0 ? `<button class="btn" type="button" data-put-aside ${off}>Put ${peso(f.remainingThisWeek)} aside</button>` : ''}
        <button class="btn ghost small" type="button" data-other ${off}>Other amount</button>
      </div>
      <div class="envelope-other" hidden>
        <input type="number" min="0.01" step="0.01" data-sa-amount placeholder="Amount" aria-label="Amount to put aside for ${esc(f.name)}" ${off}>
        <select data-sa-side aria-label="Taken from" ${off}><option value="cash">from drawer cash</option><option value="gcash">from GCash</option></select>
        <button class="btn small" type="button" data-sa-add ${off}>Put aside</button>
      </div>
    </div>`;
  }).join('')
    + (noAmount.length ? `<p class="hint" data-no-amount>No amount yet for ${noAmount.map(f => esc(f.name)).join(', ')}.
      ${isOwner() ? 'Set each bill\'s usual amount in Finance → Bill funds → Edit.' : 'The owner sets each bill\'s amount; until then there is nothing to put aside for it.'}</p>` : '')
    + (!withAmount.length && !noAmount.length ? '<p class="hint">No bills set up.</p>' : '');

  const putAside = async (row, amount, side) => {
    const name = current.funds.find(f => f.id === Number(row.dataset.fund)).name;
    await api('POST', `/funds/${row.dataset.fund}/set-asides`, { date: current.date, side, amount });
    toast(`${name}: ${peso(amount)} put aside`);
    await setDate(current.date);
  };
  $$('[data-envelope]', root).forEach(row => {
    const fund = current.funds.find(f => f.id === Number(row.dataset.fund));
    $('[data-put-aside]', row)?.addEventListener('click', e => busy(e.currentTarget, () => putAside(row, fund.remainingThisWeek, 'cash')));
    $('[data-other]', row).addEventListener('click', () => {
      const other = $('.envelope-other', row);
      other.hidden = !other.hidden;
      if (!other.hidden) $('[data-sa-amount]', row).focus();
    });
    $('[data-sa-add]', row).addEventListener('click', e => busy(e.currentTarget, async () => {
      const amount = Number($('[data-sa-amount]', row).value || 0);
      if (!(amount > 0)) return toast('Type the amount to put aside', 'error');
      await putAside(row, amount, $('[data-sa-side]', row).value);
    }));
  });
  $$('[data-del-sa]', root).forEach(btn => btn.addEventListener('click', async () => {
    if (!window.confirm('Undo this? The money goes back into the expected drawer.')) return;
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
    + (s.setAsideCash ? line('− Put aside for bills (envelopes)', peso(s.setAsideCash)) : '')
    + (s.billTopUpCash ? line('− Bill shortfall from drawer', peso(s.billTopUpCash)) : '')
    + line('Expected in drawer', peso(expectedCash), 'total');
  $('[data-gcash]', root).innerHTML =
    line('GCash received today', peso(s.gcashReceived))
    + line('+ Tips received', peso(tips))
    + line('− Tips passed to crew', peso(tips))
    + line('− Commission paid via GCash', peso(commissionGcash))
    + line('− GCash expenses', peso(s.gcashExpenses))
    + (s.payrollGcash ? line('− Payroll paid out', peso(s.payrollGcash)) : '')
    + (s.setAsideGcash ? line('− Put aside for bills (envelopes)', peso(s.setAsideGcash)) : '')
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
  if (body.side === 'fund') current.cashFund = await api('GET', '/cash-fund');
  get('description').value = '';
  get('amount').value = '';
  toast('Expense added');
  render();
}

export default { mount, show };
