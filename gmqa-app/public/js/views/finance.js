// Owner's money view for any period: what came in, what went out, net profit, and the bill funds
// (weekly set-asides for Meralco, Maynilad, rent, ...).
import { $, $$, api, esc, peso, toast, busy, todayLocal, addDays, sundayOf, openModal, closeModal, modalHeader, openDaysBanner, DEPARTMENTS } from '../ui.js';

let root;
let range = null;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const FREQ = { monthly: 'Monthly', quarterly: 'Every 3 months', yearly: 'Yearly' };
const SET_ASIDE_EVERY = { weekly: 'Every week', monthly: 'Every month' };
const GUIDE_KEY = 'gmqa.finance.guide';

// Step-by-step directions for someone opening Finance for the first time. Open until they close it.
const GUIDE = `
  <details class="card guide" data-guide>
    <summary>How Finance works <span class="muted small">New here? Start with these steps.</span></summary>
    <ol class="guide-steps">
      <li><b>Pick the period.</b> Use From / To, or the <b>This week</b>, <b>This month</b> and <b>Last month</b> buttons.
        Every number on this page is for those days only, and <b>a day counts once it is closed in EOD Closing</b>. Days still open are named at the top.</li>
      <li><b>Profit &amp; loss: is the shop making money?</b>
        <p>Sales from every department, minus commission, minus the costs of the period: payroll for the days worked,
          bills paid, drawer expenses from EOD and anything bought with the cash fund. <b>Net profit</b> is what is left. Red means the costs were bigger than the sales.</p></li>
      <li><b>Money in &amp; out of the drawer: where the cash and GCash went.</b>
        <p>Money actually received, minus everything taken out. <b>Payroll paid out</b> is the wages handed out on days in this period
          (it can include last week's work), so it can differ from the payroll cost in Profit &amp; loss.
          <b>Left over for the owner</b> is what should remain.</p></li>
      <li><b>Bill funds: save for big bills a little at a time.</b>
        <ul>
          <li>Press <b>Edit</b> on a bill to set its usual amount, due day and whether to set money aside <b>every week or every month</b> (or <b>+ Add fund</b> for a new bill).
            The <b>target</b> is worked out for you.</li>
          <li>Each week or month, in <b>EOD Closing → Bill envelopes</b>, set aside the target with one press. The money goes in a labelled envelope for the owner and waits in the fund.</li>
          <li>When the bill arrives, press <b>Pay bill</b> here. It is paid from the fund first; anything missing comes out of that
            day's Cash or GCash drawer.</li>
        </ul></li>
      <li><b>Made a mistake?</b>
        <p>Every bill paid in the period is listed under <b>Bills paid</b> at the bottom. Press <b>Undo</b> to remove it completely:
          the fund, that day's drawer and the profit go back to how they were. A set-aside is removed in EOD Closing on the day it was made.</p></li>
    </ol>
  </details>`;

function lastDayOfMonth(date) {
  const [y, m] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}
function presets() {
  const today = todayLocal();
  const monthStart = `${today.slice(0, 8)}01`;
  const lastMonthEnd = addDays(monthStart, -1);
  return {
    'this-week': [sundayOf(today), addDays(sundayOf(today), 6)], // the pay week, Sunday to Saturday
    'this-month': [monthStart, lastDayOfMonth(today)],
    'last-month': [`${lastMonthEnd.slice(0, 8)}01`, lastMonthEnd],
  };
}

function mount(el) {
  root = el;
  root.innerHTML = `
    <div class="view-header">
      <div><h1>Finance</h1><div class="desc">Money in and out for any period, and the funds set aside for upcoming bills.</div></div>
      <div class="date-range-picker">
        <div><label>From</label><input type="date" data-start></div>
        <span class="range-arrow" aria-hidden="true">→</span>
        <div><label>To</label><input type="date" data-end></div>
      </div>
    </div>
    <div class="preset-row">
      <button class="btn ghost small" type="button" data-preset="this-week">This week</button>
      <button class="btn ghost small" type="button" data-preset="this-month">This month</button>
      <button class="btn ghost small" type="button" data-preset="last-month">Last month</button>
    </div>
    ${GUIDE}
    <div data-open-days></div>
    <div class="two-col">
      <div class="card"><h2>Profit &amp; loss</h2><div data-pl></div></div>
      <div class="card"><h2>Money in &amp; out of the drawer</h2><div data-cashflow></div></div>
    </div>
    <div class="card" data-parts-weeks>
      <div class="section-header"><h2>Parts department</h2></div>
      <p class="hint">Parts keeps its sales in its own Excel file. Every Saturday, open its <b>WEEKLY</b> tab and type the week's
        <b>NET PROFIT</b> here (a loss with a minus sign). It is added to the profit above, in the month the week's Saturday falls in.</p>
      <div class="expense-form parts-week-form" data-enter="[data-save-parts-week]">
        <label class="sr-only" for="parts-week">Week</label>
        <select data-pw="week" id="parts-week"></select>
        <input type="number" step="0.01" data-pw="amount" placeholder="Net profit" aria-label="Net profit for the week">
        <input type="text" data-pw="note" placeholder="Note (optional)" maxlength="200" aria-label="Note">
        <button class="btn" type="button" data-save-parts-week>Save week</button>
      </div>
      <div class="table-wrap"><table class="simple-table" data-parts-weeks-table></table></div>
    </div>
    <div class="card">
      <div class="section-header"><h2>Bill funds</h2><button class="btn ghost" type="button" data-add-fund>+ Add fund</button></div>
      <p class="hint">Each week or month, by what you chose for the bill, set aside its <b>target</b> at EOD (EOD Closing → Bill envelopes). When the bill comes,
        pay it here: it is taken from its fund, and any shortfall is taken from that day's drawer.</p>
      <div class="table-wrap"><table class="simple-table funds-table" data-funds-table></table></div>
    </div>
    <div class="card">
      <div class="section-header"><h2>Bills paid</h2></div>
      <p class="hint">Every bill paid in this period. It counts in profit once its day is closed. Recorded one by mistake? Press <b>Undo</b> to remove it completely.</p>
      <div class="table-wrap"><table class="simple-table funds-table" data-bills-paid></table></div>
    </div>`;
  const guide = $('[data-guide]', root);
  try { guide.open = localStorage.getItem(GUIDE_KEY) !== 'closed'; } catch { guide.open = true; }
  guide.addEventListener('toggle', () => {
    try { localStorage.setItem(GUIDE_KEY, guide.open ? 'open' : 'closed'); } catch { /* storage blocked: the guide just opens again next time */ }
  });
  $('[data-start]', root).addEventListener('change', onRangeInput);
  $('[data-end]', root).addEventListener('change', onRangeInput);
  $$('[data-preset]', root).forEach(b => b.addEventListener('click', () => setRange(...presets()[b.dataset.preset])));
  $('[data-add-fund]', root).addEventListener('click', () => fundModal(null));
  $('[data-save-parts-week]', root).addEventListener('click', e => busy(e.currentTarget, savePartsWeek));
}

// ---------------------------------------------------------------- parts department weekly net
const PARTS_FIRST_WEEK = '2026-11-15'; // the week parts moved to its Excel file (Nov 15-17 is still in the app)
let partsWeeks = [];

// Every pay week from the first one to this one, newest first; the select starts on the latest week not entered yet.
function partsWeekList() {
  const out = [];
  for (let w = sundayOf(todayLocal()); w >= PARTS_FIRST_WEEK; w = addDays(w, -7)) out.push(w);
  return out;
}
const weekLabel = w => {
  const day = d => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  return `${day(w)} – ${day(addDays(w, 6))}`;
};

function renderPartsWeeks() {
  const entered = new Map(partsWeeks.map(w => [w.week_start, w]));
  const weeks = partsWeekList();
  const select = $('[data-pw="week"]', root);
  const chosen = select.value;
  select.innerHTML = weeks.map(w => `<option value="${w}">Week of ${esc(weekLabel(w))}${entered.has(w) ? ' (entered)' : ''}</option>`).join('');
  select.value = chosen && weeks.includes(chosen) ? chosen : (weeks.find(w => !entered.has(w) && addDays(w, 6) < todayLocal()) || weeks[0]);
  $('[data-parts-weeks-table]', root).innerHTML = `
    <thead><tr><th>Week</th><th class="num">Net profit</th><th>Note</th><th></th></tr></thead>
    <tbody>${weeks.map(w => {
    const row = entered.get(w);
    const over = addDays(w, 6) < todayLocal();
    return `<tr data-parts-week="${w}"><td>${esc(weekLabel(w))}</td>
      <td class="num money">${row ? `<span class="${row.amount < 0 ? 'neg' : ''}">${peso(row.amount)}</span>` : over ? '<span class="amber-text">not entered yet</span>' : '<span class="muted">this week</span>'}</td>
      <td>${esc(row?.note || '')}</td>
      <td class="row-actions">${row ? `<button class="btn ghost small" type="button" data-pw-edit>Edit</button>
        <button class="icon-btn" type="button" data-pw-del title="Delete" aria-label="Delete the week of ${esc(weekLabel(w))}">✕</button>` : ''}</td></tr>`;
  }).join('')}</tbody>`;
  $$('[data-pw-edit]', root).forEach(b => b.addEventListener('click', () => {
    const row = entered.get(b.closest('tr').dataset.partsWeek);
    select.value = row.week_start;
    $('[data-pw="amount"]', root).value = row.amount;
    $('[data-pw="note"]', root).value = row.note || '';
    $('[data-pw="amount"]', root).focus();
  }));
  $$('[data-pw-del]', root).forEach(b => b.addEventListener('click', async () => {
    const week = b.closest('tr').dataset.partsWeek;
    if (!window.confirm(`Delete the parts figure for the week of ${weekLabel(week)}?`)) return;
    await api('DELETE', `/parts-weekly-net/${week}`);
    toast('Parts week deleted');
    await reload();
  }));
}

async function savePartsWeek() {
  const week = $('[data-pw="week"]', root).value;
  const amount = $('[data-pw="amount"]', root).value;
  if (amount === '') return toast('Type the week\'s net profit from the parts Excel file', 'error');
  await api('PUT', `/parts-weekly-net/${week}`, { amount: Number(amount), note: $('[data-pw="note"]', root).value.trim() });
  $('[data-pw="amount"]', root).value = '';
  $('[data-pw="note"]', root).value = '';
  toast(`Parts, week of ${weekLabel(week)}: ${peso(Number(amount))} saved`);
  await reload();
}

async function show() {
  const [start, end] = range ? [range.start, range.end] : presets()['this-month'];
  await setRange(start, end);
}

function onRangeInput() {
  const start = $('[data-start]', root).value;
  const end = $('[data-end]', root).value;
  if (start && end) setRange(start, end);
}

async function setRange(start, end) {
  if (start > end) return toast('Start date must be on or before the end date', 'error');
  range = { start, end };
  $('[data-start]', root).value = start;
  $('[data-end]', root).value = end;
  const [summary, funds, weeks] = await Promise.all([
    api('GET', `/finance/summary?start=${start}&end=${end}`),
    api('GET', `/funds?date=${todayLocal()}`),
    api('GET', '/parts-weekly-net'),
  ]);
  partsWeeks = weeks;
  render(summary, funds);
  renderPartsWeeks();
}

const reload = () => setRange(range.start, range.end);
const line = (label, value, cls = '') => `<div class="row-line ${cls}"><span class="k">${label}</span><span class="money">${value}</span></div>`;

function render(s, fundStatus) {
  const { income: i, opex: o, cashflow: c } = s;
  $('[data-open-days]', root).innerHTML = openDaysBanner(s.openDays);
  $('[data-pl]', root).innerHTML = `
    <div class="pl-section">Income</div>
    ${DEPARTMENTS.filter(d => d.key !== 'parts' || i.departments.parts).map(d => line(`${esc(d.label)} sales`, peso(i.departments[d.key]))).join('')}
    ${line('<b>Gross sales</b>', `<b>${peso(i.gross)}</b>`)}
    ${line('− Commission', peso(i.commission))}
    ${line('<b>Net sales</b>', `<b>${peso(i.net)}</b>`)}
    ${i.partsSales ? line(`− Cost of parts sold <span class="muted small">(${peso(i.partsSales)} of parts sold)</span>`, peso(i.partsCost)) : ''}
    <div class="pl-section">Operating expenses</div>
    ${line('Payroll (net pay for work in this period)', peso(o.payroll))}
    ${o.bills.map(b => line(`Bill: ${esc(b.name)}`, peso(b.amount))).join('')}
    ${line('Drawer expenses (EOD)', peso(o.drawerExpenses))}
    ${o.fundExpenses ? line('Bought with the cash fund (abonos)', peso(o.fundExpenses)) : ''}
    ${line('<b>Total operating expenses</b>', `<b>${peso(o.total)}</b>`)}
    ${line('Net profit', peso(s.netProfit), `total ${s.netProfit < 0 ? 'neg-total' : ''}`)}
    ${s.partsNet.weeks.length ? `<div data-parts-net>
      ${line(`+ Parts department <span class="muted small">(${s.partsNet.weeks.length} week${s.partsNet.weeks.length === 1 ? '' : 's'} from its Excel file)</span>`, peso(s.partsNet.total))}
      ${line('Total net profit', peso(s.totalProfit), `total ${s.totalProfit < 0 ? 'neg-total' : ''}`)}</div>` : ''}
    ${o.partsBought ? `<p class="hint mt">${peso(o.partsBought)} of auto parts bought to sell or paid to suppliers is not counted above:
      each part's cost counts as “Cost of parts sold” when it sells.</p>` : ''}
    ${i.receivables ? `<p class="hint mt">${peso(i.receivables)} of jobs in this period are still unpaid and not counted above.</p>` : ''}`;
  $('[data-cashflow]', root).innerHTML = `
    ${line('Cash received', peso(c.cashIn))}
    ${line('GCash received', peso(c.gcashIn))}
    ${line('− Commission paid', peso(c.commissionPaid))}
    ${line('− Drawer expenses', peso(c.drawerExpenses))}
    ${line('− Payroll paid out', peso(c.payrollPayouts))}
    ${line('− Set aside to bill funds', peso(c.setAsides))}
    ${line('− Bill shortfalls paid from drawer', peso(c.billTopUps))}
    ${s.partsMoney.lent ? line('− Lent to Parts', peso(s.partsMoney.lent)) : ''}
    ${s.partsMoney.repaid ? line('+ Parts paid back', peso(s.partsMoney.repaid)) : ''}
    ${line('Left over for the owner', peso(c.net), 'total')}
    ${s.partsMoney.owes ? `<p class="hint mt" data-parts-owes>Parts owes the shop <b>${peso(s.partsMoney.owes)}</b> (lent from the drawer, not paid back yet).</p>` : ''}
    <p class="hint mt">Set-asides are not costs: they move money into the funds below. The cost is counted when the bill is paid.</p>`;

  const rows = s.funds.filter(f => f.active).map(f => ({ ...f, ...(fundStatus.find(x => x.id === f.id) || {}) }));
  $('[data-funds-table]', root).innerHTML = `
    <thead><tr><th>Fund</th><th class="num">Usual bill</th><th>Due</th><th class="num">Balance now</th><th class="num">Set-aside target</th>
      <th class="num">Set aside (period)</th><th class="num">Paid (period)</th><th></th></tr></thead>
    <tbody>${rows.map(f => `
      <tr data-fund="${f.id}">
        <td><b>${esc(f.name)}</b></td>
        <td class="num money">${f.amount ? peso(f.amount) : '<span class="amber-text">set amount</span>'}</td>
        <td>${esc(FREQ[f.frequency] || '')}<div class="muted small">next ${esc(f.nextDue || '—')}${f.daysLeft != null ? ` · ${f.daysLeft} day(s)` : ''}</div></td>
        <td class="num money">${peso(f.balance)}${f.shortBy ? `<div class="muted small">short ${peso(f.shortBy)}</div>` : ''}</td>
        <td class="num money">${peso(f.target || 0)}<div class="muted small">per ${esc(f.periodWord || 'week')}${f.remaining ? ` · ${peso(f.remaining)} left this ${esc(f.periodWord)}` : ''}</div></td>
        <td class="num money">${peso(f.setAside)}</td>
        <td class="num money">${peso(f.paid)}</td>
        <td class="row-actions"><button class="btn ghost small" type="button" data-act="edit-fund">Edit</button>
          <button class="btn small" type="button" data-act="pay-bill">Pay bill</button></td>
      </tr>`).join('')}</tbody>`;
  $$('[data-funds-table] [data-act]', root).forEach(btn => btn.addEventListener('click', () => {
    const fund = rows.find(f => f.id === Number(btn.closest('tr').dataset.fund));
    ({ 'edit-fund': fundModal, 'pay-bill': billModal })[btn.dataset.act](fund);
  }));

  $('[data-bills-paid]', root).innerHTML = `
    <thead><tr><th>Paid on</th><th>Bill</th><th class="num">Amount</th><th class="num">From fund</th><th class="num">From drawer</th><th>Note</th><th></th></tr></thead>
    <tbody>${s.billPayments.length ? s.billPayments.map(b => `
      <tr data-bill="${b.id}">
        <td class="mono">${esc(b.paid_on)}</td>
        <td><b>${esc(b.name)}</b></td>
        <td class="num money">${peso(b.amount)}</td>
        <td class="num money">${peso(b.from_fund)}</td>
        <td class="num money">${peso(b.from_drawer)}${b.from_drawer ? `<div class="muted small">${sideLabel(b.drawer_side)}</div>` : ''}</td>
        <td>${esc(b.note || '—')}</td>
        <td class="row-actions"><button class="btn ghost small" type="button" data-act="undo-bill">Undo</button></td>
      </tr>`).join('') : '<tr><td colspan="7"><div class="empty-state">No bills paid in this period.</div></td></tr>'}</tbody>`;
  $$('[data-bills-paid] [data-act="undo-bill"]', root).forEach(btn => btn.addEventListener('click', () =>
    undoBill(s.billPayments.find(b => b.id === Number(btn.closest('tr').dataset.bill)))));
}

const sideLabel = side => (side === 'gcash' ? 'GCash' : 'cash drawer');

async function undoBill(bill) {
  const back = [
    bill.from_fund ? `${peso(bill.from_fund)} goes back into the ${bill.name} fund` : '',
    bill.from_drawer ? `${peso(bill.from_drawer)} goes back to the ${sideLabel(bill.drawer_side)} on ${bill.paid_on}` : '',
  ].filter(Boolean).join(' and ');
  if (!window.confirm(`Undo the ${bill.name} bill of ${peso(bill.amount)} paid on ${bill.paid_on}?\n\nIt is removed completely: ${back}.`)) return;
  await api('DELETE', `/bill-payments/${bill.id}`);
  toast(`${bill.name} bill payment undone`);
  await reload();
}

function fundModal(fund) {
  openModal(`${modalHeader(fund ? `Edit ${fund.name}` : 'Add bill fund', 'The set-aside target is worked out from the usual amount and the due date.')}
    <div class="form-grid modal-form-grid">
      <div><label>Name</label><input type="text" data-fund-name maxlength="80" value="${esc(fund?.name || '')}"></div>
      <div><label>Usual bill amount</label><input type="number" min="0" step="0.01" data-fund-amount value="${fund?.amount ?? ''}"></div>
      <div><label>How often</label><select data-fund-frequency>${Object.entries(FREQ).map(([k, v]) => `<option value="${k}" ${k === (fund?.frequency || 'monthly') ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
      <div><label>Set money aside</label><select data-fund-every>${Object.entries(SET_ASIDE_EVERY).map(([k, v]) => `<option value="${k}" ${k === (fund?.set_aside_every || 'weekly') ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
      <div><label>Due day of month</label><input type="number" min="1" max="31" data-fund-day value="${fund?.due_day ?? 1}"></div>
      <div><label>Due month (yearly / 3-monthly)</label><select data-fund-month><option value="">—</option>
        ${MONTHS.map((m, i) => `<option value="${i + 1}" ${fund?.due_month === i + 1 ? 'selected' : ''}>${m}</option>`).join('')}</select></div>
    </div>
    <div class="modal-actions">${fund ? '<button class="btn danger" type="button" data-archive>Remove fund</button>' : ''}
      <button class="btn ghost" type="button" data-close>Cancel</button><button class="btn" type="button" data-confirm>Save</button></div>`,
  card => {
    $('[data-confirm]', card).addEventListener('click', e => busy(e.currentTarget, async () => {
      const body = {
        name: $('[data-fund-name]', card).value.trim(),
        amount: Number($('[data-fund-amount]', card).value || 0),
        frequency: $('[data-fund-frequency]', card).value,
        set_aside_every: $('[data-fund-every]', card).value,
        due_day: Number($('[data-fund-day]', card).value),
        due_month: $('[data-fund-month]', card).value || null,
      };
      if (fund) await api('PATCH', `/funds/${fund.id}`, body);
      else await api('POST', '/funds', body);
      closeModal();
      toast('Fund saved');
      await reload();
    }));
    $('[data-archive]', card)?.addEventListener('click', e => busy(e.currentTarget, async () => {
      if (!window.confirm(`Remove the ${fund.name} fund? Its history is kept.`)) return;
      await api('PATCH', `/funds/${fund.id}`, { active: false });
      closeModal();
      toast('Fund removed');
      await reload();
    }));
  });
}

function billModal(fund) {
  openModal(`${modalHeader(`Pay ${fund.name} bill`, `Fund balance: ${peso(fund.balance)}. Anything above that comes from the drawer on the payment date.`)}
    <div class="form-grid modal-form-grid">
      <div><label>Payment date</label><input type="date" data-bill-date value="${todayLocal()}"></div>
      <div><label>Bill amount</label><input type="number" min="0.01" step="0.01" data-bill-amount value="${fund.amount || ''}"></div>
      <div><label>Shortfall taken from</label><select data-bill-side><option value="cash">Cash drawer</option><option value="gcash">GCash</option></select></div>
      <div><label>Note</label><input type="text" data-bill-note maxlength="200" placeholder="e.g. September bill"></div>
    </div>
    <div class="hint" data-bill-split></div>
    <div class="modal-actions"><button class="btn ghost" type="button" data-close>Cancel</button><button class="btn" type="button" data-confirm>Record payment</button></div>`,
  card => {
    const preview = () => {
      const amount = Number($('[data-bill-amount]', card).value || 0);
      const fromFund = Math.max(0, Math.min(amount, fund.balance));
      $('[data-bill-split]', card).textContent = amount
        ? `${peso(fromFund)} from the fund${amount > fromFund ? `, ${peso(amount - fromFund)} from the drawer` : ''}.` : '';
    };
    $('[data-bill-amount]', card).addEventListener('input', preview);
    preview();
    $('[data-confirm]', card).addEventListener('click', e => busy(e.currentTarget, async () => {
      await api('POST', `/funds/${fund.id}/bills`, {
        date: $('[data-bill-date]', card).value, amount: Number($('[data-bill-amount]', card).value || 0),
        drawer_side: $('[data-bill-side]', card).value, note: $('[data-bill-note]', card).value.trim(),
      });
      closeModal();
      toast('Bill recorded');
      await reload();
    }));
  });
}

export default { mount, show };
