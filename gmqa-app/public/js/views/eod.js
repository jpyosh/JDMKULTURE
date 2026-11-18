import { $, $$, api, esc, peso, toast, busy, todayLocal, addDays, sundayOf, weekday, prettyDate, prettyTime, isOwner, state, DEPARTMENTS, openModal, closeModal, modalHeader } from '../ui.js';

// Supplier payments for parts are kept in the parts Excel file once parts moved there.
const supplierPayments = () => isOwner() && !state.partsRetiredFrom;

let root;
let current = { date: todayLocal(), day: null };
// Setup and count boxes typed in but not saved yet. They stay as typed while the rest of the screen refreshes
// (an expense added, money put aside), until they are saved or another day is opened.
const typed = new Set();

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
        <button class="btn" type="button" data-sales-report title="The day's sales report, ready to paste in the group chat">Copy sales report</button>
      </div>
    </div>
    <div data-status></div>
    <div data-tips></div>
    <div class="metrics-row" data-metrics></div>
    <div class="card"><h2>Sales by department</h2><div class="table-wrap"><table class="simple-table dept-table" data-departments></table></div></div>
    <div class="card envelopes" data-envelopes>
      <div class="section-header"><h2>Bill envelopes</h2><span class="muted" data-envelope-week></span></div>
      <p class="hint">Save a little for each bill every week or month, so the full amount is ready when the bill comes.
        Envelopes are for the whole pay week (Sunday to Saturday): do it once a week, on any day of it.</p>
      <ol class="plain-steps">
        <li>Each bill below shows how much to put aside <b>this week</b> or <b>this month</b>. Press its button (from cash), or
          <b>Other amount</b> to change the amount, take it from GCash, or add an online transfer fee.</li>
        <li>Take that money from the week's cash (or send it from GCash) and put it in an <b>envelope</b>. Write the bill name, the amount and the date on it.</li>
        <li>Hand the envelope to the <b>owner</b>. It comes out of this week's money (see <b>This pay week</b>), not today's drawer count.
          A transfer fee is added to today's expenses.</li>
      </ol>
      <div data-envelope-list></div>
    </div>
    <div class="two-col">
      <div>
        <div class="card" data-enter="[data-save]">
          <h2>Setup</h2>
          <div class="form-grid">
            <div><label>Supervisor</label><input type="text" data-m="supervisor" maxlength="80"></div>
            <div><label>Cash float</label><input type="number" min="0" step="0.01" data-m="cash_float"></div>
            <div><label>Commission paid via GCash</label><input type="number" min="0" step="0.01" data-m="commission_gcash_paid"></div>
            <div><label>Other GCash tips</label><input type="number" min="0" step="0.01" data-m="gcash_tips_to_distribute"></div>
            <div><label>GCash tips given to crew</label><input type="number" min="0" step="0.01" data-m="gcash_tips_passed"></div>
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
          <div class="expense-form" data-enter="[data-add-expense]">
            <label class="sr-only" for="expense-side">Paid from</label>
            <select data-e="side" id="expense-side" title="Paid from"><option value="cash">Drawer cash</option><option value="gcash">GCash</option>
              <option value="fund">Cash fund (abono)</option></select>
            <input type="text" data-e="description" placeholder="What was it for?" maxlength="200">
            <input type="number" min="0.01" step="0.01" data-e="amount" placeholder="Amount">
            <button class="btn ghost" type="button" data-add-expense>+ Add</button>
            ${supplierPayments() ? `<label class="check expense-check"><input type="checkbox" data-e="for_resale"> Supplier payment (consigned parts already sold)</label>
              <label class="sr-only" for="expense-supplier">Supplier paid</label>
              <select data-e="supplier_id" id="expense-supplier" title="Supplier paid (Suppliers tab: what is still owed)" hidden></select>` : ''}
          </div>
          <div class="hint" data-fund-hint></div>
        </div>
        <div class="card" data-parts-money>
          <h2>Parts department</h2>
          <p class="hint">Parts keeps its own money and its own Excel file. If the drawer pays something for parts (like the
            mechanic's labor before the customer has paid), add it here as <b>Lent to Parts</b> so the count still matches.
            When parts gives the money back, add <b>Parts paid back</b>. Neither changes the shop's profit.</p>
          <div data-parts-loans></div>
          <div class="expense-form parts-loan-form" data-enter="[data-add-parts-loan]">
            <label class="sr-only" for="parts-loan-kind">Lent or paid back</label>
            <select data-pl="kind" id="parts-loan-kind"><option value="lent">Lent to Parts</option><option value="repaid">Parts paid back</option></select>
            <label class="sr-only" for="parts-loan-side">Cash or GCash</label>
            <select data-pl="side" id="parts-loan-side"><option value="cash">Drawer cash</option><option value="gcash">GCash</option></select>
            <input type="text" data-pl="note" placeholder="What for? (e.g. mechanic's labor)" maxlength="200">
            <input type="number" min="0.01" step="0.01" data-pl="amount" placeholder="Amount">
            <button class="btn ghost" type="button" data-add-parts-loan>+ Add</button>
          </div>
        </div>
      </div>
      <div>
        <div class="card"><h2>Cash drawer</h2><div data-cash></div></div>
        <div class="card"><h2>GCash</h2><div data-gcash></div></div>
        <div class="card"><h2>Variance</h2><div data-variance></div></div>
        <div class="card"><h2>This pay week</h2><div data-week></div></div>
      </div>
    </div>
`;

  $('[data-date]', root).addEventListener('change', e => { if (e.target.value) setDate(e.target.value); });
  $$('[data-shift]', root).forEach(b => b.addEventListener('click', () => setDate(addDays(current.date, Number(b.dataset.shift)))));
  $('[data-today]', root).addEventListener('click', () => setDate(todayLocal()));
  $$('[data-m]', root).forEach(el => el.addEventListener('input', () => { typed.add(el.dataset.m); renderMath(); }));
  $('[data-save]', root).addEventListener('click', e => busy(e.currentTarget, save));
  $('[data-add-expense]', root).addEventListener('click', e => busy(e.currentTarget, addExpense));
  $('[data-add-parts-loan]', root).addEventListener('click', e => busy(e.currentTarget, addPartsLoan));
  $('[data-sales-report]', root).addEventListener('click', e => busy(e.currentTarget, copySalesReport));
  $('[data-e="side"]', root).addEventListener('change', renderFundHint);
  $('[data-e="for_resale"]', root)?.addEventListener('change', () => { showSupplierPicker(); renderFundHint(); });
}

// A supplier payment can name the supplier it paid (owner only), so the Suppliers tab knows what is still owed.
function showSupplierPicker() {
  const picker = $('[data-e="supplier_id"]', root);
  if (!picker) return;
  picker.hidden = !$('[data-e="for_resale"]', root).checked;
  const chosen = picker.value;
  picker.innerHTML = '<option value="">Which supplier? (optional)</option>'
    + (current.suppliers || []).map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join('');
  picker.value = chosen;
}

async function show() { await setDate(current.date); }

async function setDate(date) {
  if (date !== current.date) typed.clear();
  current.date = date;
  $('[data-date]', root).value = date;
  const [day, funds, cashFund, suppliers] = await Promise.all([api('GET', `/days/${date}`), api('GET', `/funds?date=${date}`), api('GET', '/cash-fund'),
    supplierPayments() ? api('GET', '/suppliers') : []]);
  if (date !== current.date) return;
  current.day = day;
  current.funds = funds;
  current.cashFund = cashFund;
  current.suppliers = suppliers;
  render();
  showSupplierPicker();
}

const locked = () => Boolean(current.day.meta.closed_at) && !isOwner();

function render() {
  // trading: cost of parts sold and the real net, sent to the owner only (costs are owner-only).
  const { meta, summary: s, trading } = current.day;
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
    <div class="metric" data-metric="gross-less-commission" title="Collected − commission"><div class="label">Gross − Commission</div><div class="value teal">${peso(s.net)}</div></div>
    ${trading ? `<div class="metric" data-metric="parts-cost" title="What the parts sold today cost the shop"><div class="label">Cost of parts sold</div><div class="value amber">${peso(trading.partsCost)}</div></div>
    <div class="metric" data-metric="net" title="Gross − commission − expenses − cost of parts sold. Expenses: ${peso(trading.costs)} (parts bought to sell and supplier payments are not counted again). The same as Sales Reports' profit."><div class="label">Net</div><div class="value teal">${peso(trading.profit)}</div></div>` : ''}`;

  const deptRow = (label, d, cls = '') => `<tr class="${cls}"><td>${label}</td><td class="num">${d.jobs}</td>
    <td class="num money">${peso(d.collected)}</td><td class="num money amber-text">${d.receivables ? peso(d.receivables) : '—'}</td>
    <td class="num money">${peso(d.commission)}</td><td class="num money pos">${peso(d.net)}</td></tr>`;
  $('[data-departments]', root).innerHTML = `
    <thead><tr><th>Department</th><th class="num">Jobs</th><th class="num">Sales collected</th><th class="num">Unpaid</th>
      <th class="num">Commission</th><th class="num">Gross − Comm.</th></tr></thead>
    <tbody>${DEPARTMENTS.map(d => deptRow(esc(d.label), s.departments[d.key])).join('')}
      ${deptRow('<b>All departments</b>', { jobs: s.vehicles, collected: s.collected, receivables: s.receivables, commission: s.commission, net: s.net }, 'total-row')}</tbody>`;

  for (const el of $$('[data-m]', root)) {
    const value = meta[el.dataset.m];
    if (!typed.has(el.dataset.m)) el.value = value ?? (el.type === 'number' && !['actual_cash', 'actual_gcash'].includes(el.dataset.m) ? 0 : '');
    el.disabled = locked();
  }
  // Before tips were tracked, a day's tips were taken as given out that same day.
  const given = $('[data-m="gcash_tips_passed"]', root);
  if (!s.tipsTracked) { given.value = s.tipsGiven; given.disabled = true; given.title = 'Days before Oct 29, 2026: tips were given out the same day'; }
  $('[data-save]', root).disabled = locked();
  $$('.expense-form [data-e], [data-add-expense]', root).forEach(el => { el.disabled = locked(); });

  $('[data-expenses]', root).innerHTML = current.day.expenses.length
    ? current.day.expenses.map(e => `<div class="row-line"><span class="k"><span class="kind-pill ${EXPENSE_PILL[e.side].cls}">${EXPENSE_PILL[e.side].label}</span> ${esc(e.description)}${e.for_resale && !e.from_stock ? ' <span class="muted small">Supplier payment</span>' : ''}</span>
        <span>${peso(e.amount)} ${e.from_stock ? '<span class="muted small" title="Undo it from the item’s stock history in Inventory">from Inventory</span>'
          : locked() || e.topup_id ? '' : `<button class="icon-btn" type="button" data-del-expense="${e.id}" title="Delete">✕</button>`}</span></div>`).join('')
      + (current.day.summary.fundExpenses ? `<div class="hint mt">${peso(current.day.summary.fundExpenses)} was paid from the cash fund, so it is not taken out of the drawer.</div>` : '')
    : '<div class="empty-state small">No expenses recorded.</div>';
  $$('[data-del-expense]', root).forEach(b => b.addEventListener('click', async () => {
    if (!window.confirm('Delete this expense?')) return;
    current.day = await api('DELETE', `/expenses/${b.dataset.delExpense}`);
    current.cashFund = await api('GET', '/cash-fund');
    toast('Expense deleted');
    render();
  }));
  renderPartsLoans();
  renderEnvelopes();
  renderWeek();
  renderFundHint();
  renderMath();
}

// Money the drawer lent the parts department today and what it paid back, with what parts owes at the end of the day.
function renderPartsLoans() {
  const { partsLoans = [], partsOwes = 0 } = current.day;
  const label = { lent: 'Lent to Parts', repaid: 'Parts paid back' };
  $('[data-parts-loans]', root).innerHTML = partsLoans.map(l => `<div class="row-line" data-parts-loan="${l.kind}">
      <span class="k"><span class="kind-pill ${l.side === 'cash' ? 'service' : 'addon'}">${l.side === 'cash' ? 'Cash' : 'GCash'}</span>
        ${label[l.kind]}${l.note ? ` · ${esc(l.note)}` : ''}</span>
      <span>${l.kind === 'lent' ? '−' : '+'}${peso(l.amount)} ${locked() ? '' : `<button class="icon-btn" type="button" data-del-parts-loan="${l.id}" title="Delete">✕</button>`}</span></div>`).join('')
    + `<div class="row-line total" data-parts-owes><span class="k">Parts owes the shop</span><span class="money">${peso(partsOwes)}</span></div>`;
  $$('[data-pl], [data-add-parts-loan]', root).forEach(el => { el.disabled = locked(); });
  $$('[data-del-parts-loan]', root).forEach(b => b.addEventListener('click', async () => {
    if (!window.confirm('Delete this entry?')) return;
    current.day = await api('DELETE', `/parts-loans/${b.dataset.delPartsLoan}`);
    toast('Entry deleted');
    render();
  }));
}

async function addPartsLoan() {
  const field = key => $(`[data-pl="${key}"]`, root);
  const amount = Number(field('amount').value || 0);
  if (!(amount > 0)) return toast('Type the amount', 'error');
  const kind = field('kind').value;
  current.day = await api('POST', `/days/${current.date}/parts-loans`, { kind, side: field('side').value, amount, note: field('note').value.trim() });
  field('amount').value = '';
  field('note').value = '';
  toast(kind === 'lent' ? `${peso(amount)} lent to Parts` : `Parts paid back ${peso(amount)}`);
  render();
}

const EXPENSE_PILL = { cash: { cls: 'service', label: 'Cash' }, gcash: { cls: 'addon', label: 'GCash' }, fund: { cls: 'part', label: 'Cash fund' } };

function renderFundHint() {
  const fund = current.cashFund;
  const hint = $('[data-fund-hint]', root);
  if ($('[data-e="for_resale"]', root)?.checked) {
    hint.textContent = 'For parts already sold: the money still comes off what was paid from, but its cost is not counted twice in Finance.';
    return;
  }
  if ($('[data-e="side"]', root).value !== 'fund') {
    hint.textContent = 'Bought something today\'s sales can\'t cover (an abono)? Choose "Cash fund (abono)" in the first box.';
    return;
  }
  hint.textContent = fund.balance > 0
    ? `Cash fund: ${peso(fund.balance)} left. This purchase is a cost of today but does not change the drawer count.`
    : 'The cash fund is empty. The owner records the money for it in the Cash fund tab.';
}

// Bill envelopes: one row per bill with its amount for this week or month filled in, so putting money aside is one press.
function renderEnvelopes() {
  const off = locked() ? 'disabled' : '';
  const withAmount = current.funds.filter(f => f.amount > 0);
  const noAmount = current.funds.filter(f => !(f.amount > 0));
  const shortDate = d => (d ? prettyDate(d).replace(/^\w+, /, '') : '—');
  // The pay week of the day shown, e.g. "Week of Nov 15 – 21" (or "Nov 29 – Dec 5").
  const weekStart = sundayOf(current.date);
  const monthDay = d => prettyDate(d).replace(/^\w+, /, '').replace(/, \d{4}$/, '');
  const weekEnd = monthDay(addDays(weekStart, 6));
  $('[data-envelope-week]', root).textContent = `Week of ${monthDay(weekStart)} – ${weekEnd.slice(0, 3) === monthDay(weekStart).slice(0, 3) ? weekEnd.slice(4) : weekEnd}`;
  $('[data-envelope-list]', root).innerHTML = withAmount.map(f => {
    const todays = f.setAsidesThisWeek.map(x => `<span class="item-chip">${peso(x.amount)} ${x.side === 'cash' ? 'cash' : 'GCash'} · ${esc(weekday(x.entry_date))}${x.fee ? ` (fee ${peso(x.fee)})` : ''}
      ${off ? '' : `<button class="icon-btn" type="button" data-del-sa="${x.id}" title="Undo" aria-label="Undo ${peso(x.amount)}">✕</button>`}</span>`).join('');
    const status = f.remaining > 0
      ? `Put <b>${peso(f.remaining)}</b> aside this ${f.periodWord}${f.setAsideThisPeriod ? ` (${peso(f.setAsideThisPeriod)} of ${peso(f.target)} done)` : ''}`
      : `<span class="variance-ok">Done for this ${f.periodWord} ✓</span>`;
    return `<div class="envelope" data-envelope data-fund="${f.id}">
      <div class="envelope-main">
        <div><b>${esc(f.name)}</b> <span class="muted small">bill ${peso(f.amount)} · due ${esc(shortDate(f.nextDue))} · ${peso(f.balance)} saved so far</span></div>
        <div class="envelope-status">${status}</div>
        ${todays ? `<div class="envelope-today">${todays}</div>` : ''}
      </div>
      <div class="envelope-actions">
        ${f.remaining > 0 ? `<button class="btn" type="button" data-put-aside ${off}>Put ${peso(f.remaining)} aside</button>` : ''}
        <button class="btn ghost small" type="button" data-other ${off}>Other amount</button>
      </div>
      <div class="envelope-other" data-enter="[data-sa-add]" hidden>
        <input type="number" min="0.01" step="0.01" data-sa-amount placeholder="Amount" aria-label="Amount to put aside for ${esc(f.name)}" ${off}>
        <select data-sa-side aria-label="Taken from" ${off}><option value="cash">from the week's cash</option><option value="gcash">from GCash</option></select>
        <input type="number" min="0" step="0.01" data-sa-fee placeholder="Fee (if any)" aria-label="Online transfer fee" title="An online transfer fee, logged as today's expense" ${off}>
        <button class="btn small" type="button" data-sa-add ${off}>Put aside</button>
      </div>
    </div>`;
  }).join('')
    + (noAmount.length ? `<p class="hint" data-no-amount>No amount yet for ${noAmount.map(f => esc(f.name)).join(', ')}.
      ${isOwner() ? 'Set each bill\'s usual amount in Finance → Bill funds → Edit.' : 'The owner sets each bill\'s amount; until then there is nothing to put aside for it.'}</p>` : '')
    + (!withAmount.length && !noAmount.length ? '<p class="hint">No bills set up.</p>' : '');

  const putAside = async (row, amount, side, fee = 0) => {
    const name = current.funds.find(f => f.id === Number(row.dataset.fund)).name;
    await api('POST', `/funds/${row.dataset.fund}/set-asides`, { date: current.date, side, amount, fee });
    toast(`${name}: ${peso(amount)} put aside${fee ? ` (fee ${peso(fee)} added to expenses)` : ''}`);
    await setDate(current.date);
  };
  $$('[data-envelope]', root).forEach(row => {
    const fund = current.funds.find(f => f.id === Number(row.dataset.fund));
    $('[data-put-aside]', row)?.addEventListener('click', e => busy(e.currentTarget, () => putAside(row, fund.remaining, 'cash')));
    $('[data-other]', row).addEventListener('click', () => {
      const other = $('.envelope-other', row);
      other.hidden = !other.hidden;
      if (!other.hidden) $('[data-sa-amount]', row).focus();
    });
    $('[data-sa-add]', row).addEventListener('click', e => busy(e.currentTarget, async () => {
      const amount = Number($('[data-sa-amount]', row).value || 0);
      const fee = Number($('[data-sa-fee]', row).value || 0);
      if (!(amount > 0)) return toast('Type the amount to put aside', 'error');
      if (fee < 0) return toast('A fee cannot be negative', 'error');
      await putAside(row, amount, $('[data-sa-side]', row).value, fee);
    }));
  });
  $$('[data-del-sa]', root).forEach(btn => btn.addEventListener('click', async () => {
    if (!window.confirm('Undo this? The money goes back into the week\'s money, and its transfer fee (if any) is removed from expenses.')) return;
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
  const tips = round2(s.jobTips + num('gcash_tips_to_distribute'));
  // Same rule as lib/calc.js: tips stay in GCash until given to the crew; what is not given carries over.
  const tipsGiven = s.tipsTracked ? num('gcash_tips_passed') : tips;
  const tipsToGive = Math.max(0, round2(s.tipsOwedBefore + tips - tipsGiven));
  // Same rule as lib/calc.js: weekly payroll comes from the money saved during the week, never from today's count.
  // Same rule as lib/calc.js: money lent to the parts department leaves the drawer, money it pays back comes in.
  const expectedCash = num('cash_float') + s.cashReceived - commissionCash - s.cashExpenses
    - s.setAsideCash - s.billTopUpCash - s.partsLentCash + s.partsRepaidCash;
  const expectedGcash = s.gcashReceived + tips - tipsGiven - commissionGcash - s.gcashExpenses
    - s.setAsideGcash - s.billTopUpGcash - s.partsLentGcash + s.partsRepaidGcash;
  const line = (k, v, cls = '') => `<div class="row-line ${cls}"><span class="k">${k}</span><span class="money">${v}</span></div>`;
  // On a day with parts counter sales, money received is split into job orders and the parts counter.
  const counter = s.partsCashReceived || s.partsGcashReceived;
  const received = (sign, label, total, parts) => (counter
    ? line(`${sign}${label} from job orders`, peso(round2(total - parts))) + line(`+ ${label} from parts counter`, peso(parts))
    : line(`${sign}${label} received today`, peso(total)));

  $('[data-cash]', root).innerHTML =
    line('Cash float', peso(num('cash_float')))
    + received('+ ', 'Cash', s.cashReceived, s.partsCashReceived)
    + line('− Commission paid in cash', peso(commissionCash))
    + line('− Cash expenses', peso(s.cashExpenses))
    + (s.setAsideCash ? line('− Put aside for bills (envelopes)', peso(s.setAsideCash)) : '')
    + (s.billTopUpCash ? line('− Bill shortfall from drawer', peso(s.billTopUpCash)) : '')
    + (s.partsLentCash ? line('− Lent to Parts', peso(s.partsLentCash)) : '')
    + (s.partsRepaidCash ? line('+ Parts paid back', peso(s.partsRepaidCash)) : '')
    + line('Expected in drawer', peso(expectedCash), 'total');
  $('[data-gcash]', root).innerHTML =
    received('', 'GCash', s.gcashReceived, s.partsGcashReceived)
    + line('+ Tips received', peso(tips))
    + line('− Tips given to crew', peso(tipsGiven))
    + line('− Commission paid via GCash', peso(commissionGcash))
    + line('− GCash expenses', peso(s.gcashExpenses))
    + (s.setAsideGcash ? line('− Put aside for bills (envelopes)', peso(s.setAsideGcash)) : '')
    + (s.billTopUpGcash ? line('− Bill shortfall from GCash', peso(s.billTopUpGcash)) : '')
    + (s.partsLentGcash ? line('− Lent to Parts', peso(s.partsLentGcash)) : '')
    + (s.partsRepaidGcash ? line('+ Parts paid back', peso(s.partsRepaidGcash)) : '')
    + line('Expected GCash', peso(expectedGcash), 'total')
    + (tipsToGive ? `<div class="hint mt">${peso(tipsToGive)} in tips is still in GCash until it is given to the crew.</div>` : '');
  renderTipsReminder(tipsToGive, tipsGiven);
  const notes = [];
  if (s.paidInAdvance) notes.push(`${peso(s.paidInAdvance)} received today is for running jobs that are not done yet. It is in today's count but becomes a sale when the job is done.`);
  if (s.paidEarlier) notes.push(`${peso(s.paidEarlier)} of today's sales were paid on an earlier day, so that money is not in today's count.`);
  if (s.earlierSalesPaid) notes.push(`${peso(s.earlierSalesPaid)} received today is for jobs and counter sales from earlier days. It is in today's count; the sales stay on their own days.`);
  if (s.paidLater) notes.push(`${peso(s.paidLater)} of today's sales were paid on a later day, so that money is not in today's count.`);
  $('[data-cash]', root).insertAdjacentHTML('beforeend', notes.map(n => `<div class="hint mt">${esc(n)}</div>`).join(''));
  // Wages handed out today: named, but not taken out of today's drawer or GCash.
  const payroll = round2(s.payrollCash + s.payrollGcash);
  if (payroll) {
    const split = s.payrollCash && s.payrollGcash ? ` (${peso(s.payrollCash)} cash, ${peso(s.payrollGcash)} GCash)` : s.payrollGcash ? ' (GCash)' : ' (cash)';
    $('[data-cash]', root).insertAdjacentHTML('beforeend', `<div class="payroll-note mt" data-payroll-note>
      <div class="row-line"><span class="k">Payroll handed out today${split}</span><span class="money">${peso(payroll)}</span></div>
      <div class="hint">Paid from the week's cash, not this drawer, so it is not in the count above. See This pay week.</div></div>`);
  }

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

const round2 = n => Math.round(n * 100) / 100;

// The whole pay week (Sunday to Saturday): each day's money after commission and expenses, the wages for that week
// (wherever they were handed out), and what is left after them. Built by payWeek in lib/calc.js.
function renderWeek() {
  const w = current.day.week;
  const box = $('[data-week]', root);
  if (!w) { box.innerHTML = ''; return; }
  const short = d => prettyDate(d).replace(/, \d{4}$/, '');
  const span = (a, b) => `${short(a).replace(/^\w+, /, '')} – ${short(b).replace(/^\w+, /, '')}`;
  const status = d => (d.date > todayLocal() ? '' : d.closed ? '<span class="muted small">closed</span>' : (d.cash || d.gcash) ? '<span class="amber-text small">open</span>' : '');
  const paid = w.payouts.map(p => `${peso(p.amount)} ${p.side === 'gcash' ? 'GCash' : 'cash'} on ${short(p.payout_date)}`).join(', ');
  box.innerHTML = `
    <p class="hint">${esc(span(w.start, w.end))}. Each day's money after commission and expenses; the week's wages and bill envelopes come out of it.</p>
    <div class="table-wrap"><table class="simple-table week-table">
      <thead><tr><th>Day</th><th class="num">Cash</th><th class="num">GCash</th><th></th></tr></thead>
      <tbody>
        ${w.days.map(d => `<tr data-week-day="${d.date}"${d.date === current.date ? ' class="is-today"' : ''}>
          <td>${esc(short(d.date))}</td><td class="num money">${peso(d.cash)}</td><td class="num money">${peso(d.gcash)}</td><td>${status(d)}</td></tr>`).join('')}
        <tr class="total-row"><td>Week's money</td><td class="num money" data-week-total="cash">${peso(w.cash)}</td>
          <td class="num money" data-week-total="gcash">${peso(w.gcash)}</td><td></td></tr>
        <tr><td>− Payroll for this week</td><td class="num money" data-week-payroll="cash">${peso(w.payrollCash)}</td>
          <td class="num money" data-week-payroll="gcash">${peso(w.payrollGcash)}</td><td></td></tr>
        <tr><td>− Bill envelopes this week</td><td class="num money" data-week-envelopes="cash">${peso(w.envelopeCash)}</td>
          <td class="num money" data-week-envelopes="gcash">${peso(w.envelopeGcash)}</td><td></td></tr>
        <tr class="total-row"><td>Left after payroll and envelopes</td><td class="num money" data-week-left="cash">${peso(w.cashLeft)}</td>
          <td class="num money" data-week-left="gcash">${peso(w.gcashLeft)}</td><td></td></tr>
      </tbody></table></div>
    <p class="hint">${w.payouts.length ? `Wages for this week: ${esc(paid)}.` : 'No wages recorded for this week yet (Payroll → Record payout).'}
      ${w.openDays.length ? ` Not closed yet: ${esc(w.openDays.map(short).join(', '))}.` : ''}</p>`;
}

// A reminder at the top of EOD while any GCash tip (today's or an earlier day's) has not been given out.
function renderTipsReminder(toGive, given) {
  const box = $('[data-tips]', root);
  if (!toGive) { box.innerHTML = ''; return; }
  const earlier = Math.min(current.day.summary.tipsOwedBefore, toGive);
  box.innerHTML = `<div class="banner tips-reminder" data-tips-reminder>
    <span><b>${peso(toGive)} in GCash tips</b> still to give to the crew${earlier ? ` (${peso(earlier)} from earlier days)` : ''}.</span>
    ${locked() ? '' : `<button class="btn small" type="button" data-give-tips>Mark ${peso(toGive)} given</button>`}</div>`;
  $('[data-give-tips]', box)?.addEventListener('click', e => busy(e.currentTarget, async () => {
    $('[data-m="gcash_tips_passed"]', root).value = round2(given + toGive);
    await saveMeta();
    toast(`${peso(toGive)} in tips given to the crew`);
    render();
  }));
}

// Asks what to do with GCash tips not given out yet: 'give' (given now), 'later' (carry over) or null (cancel).
function askAboutTips(toGive) {
  return new Promise(resolve => {
    let answer = null;
    const dialog = openModal(`${modalHeader('Give out the GCash tips?', `${peso(toGive)} in GCash tips has not been given to the crew yet.`, 'Before closing')}
      <p class="hint">Give it to the crew now, or close the day and it will be on the next day's EOD as a reminder.</p>
      <div class="modal-actions"><button class="btn ghost" type="button" data-close>Cancel</button>
        <button class="btn ghost" type="button" data-tips-later>Close, give it later</button>
        <button class="btn" type="button" data-tips-give-close>Given out ${peso(toGive)}, close day</button></div>`, card => {
      $('[data-tips-later]', card).addEventListener('click', () => { answer = 'later'; closeModal(); });
      $('[data-tips-give-close]', card).addEventListener('click', () => { answer = 'give'; closeModal(); });
    });
    dialog.addEventListener('close', () => resolve(answer), { once: true });
  });
}

function metaPayload() {
  const out = {};
  $$('[data-m]', root).forEach(el => {
    const key = el.dataset.m;
    out[key] = el.type === 'number' ? (el.value === '' ? (key.startsWith('actual_') ? null : 0) : Number(el.value)) : el.value.trim();
  });
  return out;
}

// Saves every Setup and count box as shown; nothing is left unsaved afterwards.
async function saveMeta() {
  current.day = await api('PUT', `/days/${current.date}`, metaPayload());
  typed.clear();
}

async function save() {
  await saveMeta();
  toast('EOD saved');
  render();
}

async function closeDay() {
  // Save whatever is typed first so the day is closed with the numbers on screen.
  await saveMeta();
  render();
  let tips = null;
  if (current.day.summary.tipsToGive > 0) {
    tips = await askAboutTips(current.day.summary.tipsToGive);
    if (!tips) return;
    if (tips === 'give') {
      const s = current.day.summary;
      $('[data-m="gcash_tips_passed"]', root).value = round2(s.tipsGiven + s.tipsToGive);
      await saveMeta();
      render();
    }
  }
  const fresh = current.day.summary;
  const s = fresh;
  const warnings = [];
  if (fresh.actualCash == null || fresh.actualGcash == null) warnings.push('the cash/GCash count has not been entered');
  else if (fresh.cashVariance !== 0 || fresh.gcashVariance !== 0) warnings.push(`there is a variance (cash ${peso(fresh.cashVariance)}, GCash ${peso(fresh.gcashVariance)})`);
  if (s.unpaidJobs) warnings.push(`${s.unpaidJobs} job(s) are still unpaid`);
  const msg = `Close ${current.date}? ${isOwner() ? '' : 'Staff will not be able to change it afterwards.'}${warnings.length ? `\n\nHeads up: ${warnings.join('; ')}.` : ''}`;
  if (!window.confirm(msg)) return;
  current.day = await api('POST', `/days/${current.date}/close`, { tips_later: tips === 'later' });
  toast('Day closed');
  render();
}

// The day's sales report in the boss's format (lib/calc.js salesReport), copied for the group chat and
// shown, so it can also be copied by hand where the browser does not allow copying.
async function copySalesReport() {
  if (!locked()) {
    await saveMeta(); // with the numbers on screen
    render();
  }
  const text = current.day.report.text;
  let copied = false;
  try { await navigator.clipboard.writeText(text); copied = true; } catch { /* shown below to copy by hand */ }
  openModal(`${modalHeader('Sales report', copied ? 'Copied. Paste it in the group chat.' : 'Select the text and copy it.', prettyDate(current.date))}
    <textarea class="report-text" data-report-text readonly rows="12">${esc(text)}</textarea>
    <div class="modal-actions"><button class="btn ghost" type="button" data-close>Close</button>
      <button class="btn" type="button" data-copy-again>Copy again</button></div>`, card => {
    $('[data-copy-again]', card).addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(text); toast('Sales report copied'); } catch { $('[data-report-text]', card).select(); }
    });
  });
  toast(copied ? 'Sales report copied' : 'Select the text and copy it', copied ? 'success' : 'error');
}

async function addExpense() {
  const get = key => $(`[data-e="${key}"]`, root);
  const body = { side: get('side').value, description: get('description').value.trim(), amount: Number(get('amount').value || 0) };
  if (!body.description) return toast('Describe the expense', 'error');
  if (!(body.amount > 0)) return toast('Enter an amount greater than zero', 'error');
  if (get('for_resale')?.checked) {
    body.for_resale = true;
    if (get('supplier_id')?.value) body.supplier_id = Number(get('supplier_id').value);
  }
  current.day = await api('POST', `/days/${current.date}/expenses`, body);
  if (body.side === 'fund') current.cashFund = await api('GET', '/cash-fund');
  get('description').value = '';
  get('amount').value = '';
  if (get('for_resale')) {
    get('for_resale').checked = false;
    get('supplier_id').value = '';
    showSupplierPicker();
  }
  toast('Expense added');
  render();
}

export default { mount, show };
