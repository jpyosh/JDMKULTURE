// Remittances (owner): the money taken to the bank, as it shows in the passbook, matched against the days whose
// money it carried. A deposit can cover several days at once; what each day should leave for the bank follows the
// EOD rules (expected drawer less the float, and expected GCash). The matching is remittanceReport in lib/calc.js.
import { $, $$, api, esc, peso, toast, busy, todayLocal, prettyDate, openModal, closeModal, modalHeader, openDaysBanner } from '../ui.js';

let root;
let range = null;
let report = null;
const GUIDE_KEY = 'gmqa.remittances.guide';
const SOURCE_LABEL = { cash: 'Cash', gcash: 'GCash', both: 'Cash + GCash' };
const SIDES = { cash: ['cash'], gcash: ['gcash'], both: ['cash', 'gcash'] };

const GUIDE = `
  <details class="card guide" data-guide>
    <summary>How Remittances works <span class="muted small">New here? Start with these steps.</span></summary>
    <ol class="guide-steps">
      <li><b>Set the passbook balance once.</b> Press <b>Set passbook balance</b> and type the last balance printed in the passbook, with
        its date. Everything before that day is settled. From then on, <b>Passbook should say</b> adds every deposit you record, so you can
        compare it with the passbook each time it is updated (interest and withdrawals are not counted).</li>
      <li><b>Close every day at EOD with the cash and GCash counted.</b> A closed day's money is listed under <b>Still to deposit</b>
        until a deposit covers it.</li>
      <li><b>Record each line of the passbook.</b> Press <b>Add deposit</b>: the date in the passbook, the amount, whether it was
        the drawer's cash, the GCash money or both, and the <b>days</b> whose money it was. Several days in one deposit is fine.
        <p>One transfer split into several passbook lines (for example ₱50,000 at a time)? Record each line with the same days: they are added together.</p></li>
      <li><b>Check the difference.</b> Each deposit is compared with what the app says those days left after commission, expenses
        and payroll. <b>Matches</b> means it ties out; <b>short</b> or <b>over</b> means something was not entered, or money went
        somewhere else. The opening deposit and interest are not shop money: leave them out.</li>
      <li><b>Not sure which days a deposit was for?</b> Leave the days empty. It is listed on its own until you find out; then
        undo it and add it again with its days.</li>
    </ol>
  </details>`;

function mount(el) {
  root = el;
  root.innerHTML = `
    <div class="view-header">
      <div><h1>Remittances</h1><div class="desc">Bank deposits and GCash transfers, checked against the days whose money they carried.</div></div>
      <div class="date-range-picker">
        <div><label>From</label><input type="date" data-start></div>
        <span class="range-arrow" aria-hidden="true">→</span>
        <div><label>To</label><input type="date" data-end></div>
      </div>
    </div>
    ${GUIDE}
    <div data-open-days></div>
    <div class="metrics-row">
      <div class="metric" data-passbook><div class="label">Passbook should say</div><div class="value teal" data-value></div><div class="muted small" data-sub></div>
        <button class="btn ghost small mt-s" type="button" data-set-start>Set passbook balance</button></div>
      <div class="metric" data-metric="cash"><div class="label">Cash to deposit</div><div class="value amber" data-value></div><div class="muted small" data-sub></div></div>
      <div class="metric" data-metric="gcash"><div class="label">GCash to transfer</div><div class="value amber" data-value></div><div class="muted small" data-sub></div></div>
      <div class="metric" data-metric="deposited"><div class="label">Deposited for these days</div><div class="value teal" data-value></div><div class="muted small" data-sub></div></div>
      <div class="metric" data-metric="difference"><div class="label">Difference</div><div class="value" data-value></div><div class="muted small" data-sub></div></div>
    </div>
    <div class="card">
      <div class="section-header"><h2>Still to deposit</h2><button class="btn" type="button" data-add>Add deposit</button></div>
      <p class="hint">Closed days whose money no deposit has carried yet. A payday can be negative: the wages came out of the days before it.</p>
      <div class="table-wrap"><table class="simple-table funds-table" data-to-deposit></table></div>
    </div>
    <div class="card">
      <h2>Deposits</h2>
      <p class="hint">Each deposit, or deposits for the same days added together, against what the app says those days left for the bank.</p>
      <div class="table-wrap"><table class="simple-table funds-table" data-groups></table></div>
    </div>
    <div class="card">
      <h2>Day by day</h2>
      <p class="hint">What each day left for the bank (after commission, expenses, payroll and bill envelopes; the float stays in the drawer) and what was counted at EOD.</p>
      <div class="table-wrap"><table class="simple-table funds-table" data-days></table></div>
    </div>`;
  const guide = $('[data-guide]', root);
  try { guide.open = localStorage.getItem(GUIDE_KEY) !== 'closed'; } catch { guide.open = true; }
  guide.addEventListener('toggle', () => {
    try { localStorage.setItem(GUIDE_KEY, guide.open ? 'open' : 'closed'); } catch { /* storage blocked: the guide just opens again next time */ }
  });
  $('[data-start]', root).addEventListener('change', onRangeInput);
  $('[data-end]', root).addEventListener('change', onRangeInput);
  $('[data-add]', root).addEventListener('click', addModal);
  $('[data-set-start]', root).addEventListener('click', startModal);
}

async function show() {
  await load(range);
}

function onRangeInput() {
  const start = $('[data-start]', root).value;
  const end = $('[data-end]', root).value;
  if (!start || !end) return;
  if (start > end) return toast('Start date must be on or before the end date', 'error');
  load({ start, end });
}

// With no range yet, the server starts on the first day any deposit covers.
async function load(wanted) {
  const query = wanted ? `?start=${wanted.start}&end=${wanted.end}` : `?end=${todayLocal()}`;
  report = await api('GET', `/remittances${query}`);
  range = { start: report.start, end: report.end };
  $('[data-start]', root).value = range.start;
  $('[data-end]', root).value = range.end;
  render();
}

const shortDate = d => prettyDate(d).replace(/, \d{4}$/, '');
const daysLabel = (from, to) => (from === to ? shortDate(from) : `${shortDate(from)} – ${shortDate(to)}`);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function differenceCell(n) {
  if (Math.abs(n) < 0.005) return '<span class="teal-text">Matches ✓</span>';
  return `<span class="amber-text">${peso(Math.abs(n))} ${n < 0 ? 'short' : 'over'}</span>`;
}

function render() {
  const r = report;
  $('[data-open-days]', root).innerHTML = openDaysBanner(r.openDays);
  const passbook = $('[data-passbook]', root);
  if (r.bank) {
    $('[data-value]', passbook).textContent = peso(r.bank.expected);
    $('[data-sub]', passbook).textContent = `${peso(r.bank.startBalance)} printed on ${shortDate(r.bank.startDate)} + ${peso(r.bank.depositedSince)} from ${plural(r.bank.count, 'deposit')} since`;
    $('[data-set-start]', passbook).textContent = 'Change';
  } else {
    $('[data-value]', passbook).innerHTML = '<span class="amber-text">not set</span>';
    $('[data-sub]', passbook).textContent = 'Type the last balance printed in the passbook to start.';
    $('[data-set-start]', passbook).textContent = 'Set passbook balance';
  }
  const metric = (key, value, sub) => {
    $(`[data-metric="${key}"] [data-value]`, root).innerHTML = value;
    $(`[data-metric="${key}"] [data-sub]`, root).textContent = sub;
  };
  metric('cash', peso(r.toDeposit.cash.amount), plural(r.toDeposit.cash.days.length, 'day'));
  metric('gcash', peso(r.toDeposit.gcash.amount), plural(r.toDeposit.gcash.days.length, 'day'));
  // Amber only while something is waiting for the bank.
  for (const side of ['cash', 'gcash']) {
    $(`[data-metric="${side}"] [data-value]`, root).classList.toggle('amber', r.toDeposit[side].days.length > 0);
  }
  metric('deposited', peso(r.totals.deposited), r.totals.unlinked ? `+ ${peso(r.totals.unlinked)} not tied to any day` : `the app says ${peso(r.totals.due)}`);
  metric('difference', differenceCell(r.totals.difference), 'deposited − what the app says');

  // Still to deposit: one row per day with money waiting on either side.
  const waiting = new Map();
  for (const side of ['cash', 'gcash']) {
    for (const d of r.toDeposit[side].days) waiting.set(d.date, { ...(waiting.get(d.date) || {}), [side]: d.amount });
  }
  const dates = [...waiting.keys()].sort();
  const cell = n => (n == null ? '<span class="muted">—</span>' : peso(n));
  const waitingRows = dates.map(date => `
      <tr><td class="mono">${esc(date)} <span class="muted small">${esc(shortDate(date).split(',')[0])}</span></td>
        <td class="num money">${cell(waiting.get(date).cash)}</td><td class="num money">${cell(waiting.get(date).gcash)}</td></tr>`).join('');
  const totalRow = `<tr class="total-row"><td><b>Total</b></td><td class="num money"><b>${peso(r.toDeposit.cash.amount)}</b></td>
        <td class="num money"><b>${peso(r.toDeposit.gcash.amount)}</b></td></tr>`;
  $('[data-to-deposit]', root).innerHTML = `
    <thead><tr><th>Day</th><th class="num">Cash</th><th class="num">GCash</th></tr></thead>
    <tbody>${dates.length ? waitingRows + totalRow
    : '<tr><td colspan="3"><div class="empty-state">Nothing waiting: every closed day in this range has been deposited.</div></td></tr>'}</tbody>`;

  const depositLines = list => list.map(d => `
    <div class="deposit-line"><span class="mono">${esc(d.deposit_date)}</span> <b>${peso(d.amount)}</b>
      ${d.note ? `<span class="muted small">${esc(d.note)}</span>` : ''}
      <button class="btn ghost small" type="button" data-act="del-deposit" data-id="${d.id}" title="Undo this deposit">Undo</button></div>`).join('');
  const groupRows = r.groups.map(g => `
    <tr data-group="${esc(g.key)}">
      <td><b>${esc(daysLabel(g.from, g.to))}</b>
        ${g.overlaps ? '<div class="amber-text small">Some of these days are in another deposit too.</div>' : ''}
        ${g.openDays.length ? `<div class="amber-text small">Not closed yet: ${esc(g.openDays.map(shortDate).join(', '))}</div>` : ''}</td>
      <td>${esc(SOURCE_LABEL[g.source])}</td>
      <td>${depositLines(g.deposits)}</td>
      <td class="num money">${peso(g.deposited)}</td>
      <td class="num money">${peso(g.due)}</td>
      <td class="num">${differenceCell(g.difference)}</td></tr>`).join('');
  const unlinkedRows = r.unlinked.length ? `
    <tr><td><b>Not tied to any day</b><div class="muted small">Find out which days, then undo it and add it again with its days.</div></td>
      <td>${esc([...new Set(r.unlinked.map(d => SOURCE_LABEL[d.source]))].join(', '))}</td>
      <td>${depositLines(r.unlinked)}</td><td class="num money">${peso(r.totals.unlinked)}</td><td class="num muted">—</td><td class="num muted">—</td></tr>` : '';
  $('[data-groups]', root).innerHTML = `
    <thead><tr><th>Days covered</th><th>Money from</th><th>Passbook lines</th><th class="num">Deposited</th><th class="num">App says</th><th class="num">Difference</th></tr></thead>
    <tbody>${groupRows || unlinkedRows ? groupRows + unlinkedRows
    : '<tr><td colspan="6"><div class="empty-state">No deposits recorded for these days yet. Start with "Add deposit".</div></td></tr>'}</tbody>`;
  $$('[data-act="del-deposit"]', root).forEach(btn => btn.addEventListener('click', () => undoDeposit(Number(btn.dataset.id), btn)));

  const groupOf = key => r.groups.find(g => g.key === key);
  const status = (d, side) => {
    if (!d.closed) return '<span class="muted small">not closed</span>';
    const g = groupOf(d[`${side}Group`]);
    if (g) return `<span class="teal-text small">${esc(g.deposits.map(x => shortDate(x.deposit_date)).filter((v, i, a) => a.indexOf(v) === i).join(', '))} ✓</span>`;
    return Math.abs(d[side]) < 0.005 ? '<span class="muted small">nothing</span>' : '<span class="amber-text small">not yet</span>';
  };
  const counted = n => (n == null ? '<span class="muted small">not counted</span>' : peso(n));
  $('[data-days]', root).innerHTML = `
    <thead><tr><th>Day</th><th class="num">Cash</th><th class="num">Counted</th><th>Deposited</th>
      <th class="num">GCash</th><th class="num">Counted</th><th>Transferred</th></tr></thead>
    <tbody>${r.days.map(d => `
      <tr><td class="mono">${esc(d.date)} <span class="muted small">${esc(shortDate(d.date).split(',')[0])}</span></td>
        <td class="num money">${peso(d.cash)}</td><td class="num money">${counted(d.countedCash)}</td><td>${status(d, 'cash')}</td>
        <td class="num money">${peso(d.gcash)}</td><td class="num money">${counted(d.countedGcash)}</td><td>${status(d, 'gcash')}</td></tr>`).join('')}</tbody>`;
}

// What the app says the days from..to left for the bank, from the days on screen (null when some are not shown).
function dueFor(source, from, to) {
  if (!from || !to || from > to) return null;
  const days = report.days.filter(d => d.date >= from && d.date <= to);
  const count = Math.round((new Date(`${to}T00:00:00Z`) - new Date(`${from}T00:00:00Z`)) / 86400000) + 1;
  if (days.length !== count) return null;
  return Math.round(days.reduce((t, d) => t + SIDES[source].reduce((s, side) => s + d[side], 0), 0) * 100) / 100;
}

// Filled in with the days still waiting for the chosen money, and their total.
function suggestion(source) {
  const lists = SIDES[source].map(side => report.toDeposit[side].days);
  const dates = lists.flat().map(d => d.date).sort();
  if (!dates.length) return { from: '', to: '', amount: '' };
  const from = dates[0];
  const to = dates.at(-1);
  const due = dueFor(source, from, to);
  return { from, to, amount: due > 0 ? String(due) : '' };
}

function addModal() {
  const first = suggestion('cash');
  openModal(`${modalHeader('Add deposit', 'One line of the passbook: a cash deposit or a GCash transfer.')}
    <div class="form-grid modal-form-grid">
      <div><label>Date in the passbook</label><input type="date" data-r-date value="${todayLocal()}"></div>
      <div><label>Money from</label><select data-r-source>
        <option value="cash">Cash (the drawer)</option><option value="gcash">GCash</option><option value="both">Cash and GCash together</option></select></div>
      <div><label>Amount</label><input type="number" min="0.01" step="0.01" data-r-amount value="${esc(first.amount)}"></div>
      <div><label>First day it covers</label><input type="date" data-r-from value="${esc(first.from)}"></div>
      <div><label>Last day it covers</label><input type="date" data-r-to value="${esc(first.to)}"></div>
      <div><label>Note</label><input type="text" maxlength="200" data-r-note placeholder="e.g. BDO slip no."></div>
    </div>
    <p class="hint" data-r-due></p>
    <p class="hint">Leave both days empty if you do not know yet which days it was for.</p>
    <div class="modal-actions"><button class="btn ghost" type="button" data-close>Cancel</button><button class="btn" type="button" data-confirm>Record</button></div>`,
  card => {
    const field = name => $(`[data-r-${name}]`, card);
    let amountTyped = false;
    const showDue = () => {
      const due = dueFor(field('source').value, field('from').value, field('to').value);
      const words = { cash: 'in cash', gcash: 'in GCash', both: 'in cash and GCash' }[field('source').value];
      field('due').textContent = due == null ? '' : `The app says these days left ${peso(due)} ${words}.`;
    };
    field('amount').addEventListener('input', () => { amountTyped = true; });
    field('source').addEventListener('change', () => {
      const s = suggestion(field('source').value);
      field('from').value = s.from;
      field('to').value = s.to;
      if (!amountTyped) field('amount').value = s.amount;
      showDue();
    });
    for (const name of ['from', 'to']) field(name).addEventListener('change', showDue);
    showDue();
    $('[data-confirm]', card).addEventListener('click', e => busy(e.currentTarget, async () => {
      const amount = Number(field('amount').value || 0);
      if (!(amount > 0)) return toast('Type the amount in the passbook', 'error');
      await api('POST', '/remittances', {
        deposit_date: field('date').value, amount, source: field('source').value,
        covers_from: field('from').value || null, covers_to: field('to').value || null, note: field('note').value.trim(),
      });
      closeModal();
      toast(`${peso(amount)} recorded`);
      await load(range);
    }));
  });
}

function startModal() {
  const bank = report.bank;
  openModal(`${modalHeader('Set passbook balance', 'The last balance printed in the passbook, and the date of that line. Deposits after that date are added to it.')}
    <div class="form-grid modal-form-grid">
      <div><label>Date of the last line</label><input type="date" data-b-date value="${esc(bank?.startDate || todayLocal())}"></div>
      <div><label>Balance printed</label><input type="number" min="0" step="0.01" data-b-balance value="${esc(bank?.startBalance ?? '')}" placeholder="244607.86"></div>
    </div>
    <div class="modal-actions"><button class="btn ghost" type="button" data-close>Cancel</button><button class="btn" type="button" data-confirm>Save</button></div>`,
  card => $('[data-confirm]', card).addEventListener('click', e => busy(e.currentTarget, async () => {
    const value = $('[data-b-balance]', card).value;
    if (value === '' || !(Number(value) >= 0)) return toast('Type the balance printed in the passbook', 'error');
    await api('PUT', '/remittances/start', { start_date: $('[data-b-date]', card).value, balance: Number(value) });
    closeModal();
    toast('Passbook balance saved');
    await load(range);
  })));
}

async function undoDeposit(depositId, button) {
  const d = [...report.groups.flatMap(g => g.deposits), ...report.unlinked].find(x => x.id === depositId);
  if (!d || !window.confirm(`Undo the ${peso(d.amount)} deposit of ${d.deposit_date}? Its days will be waiting to be deposited again.`)) return;
  await busy(button, async () => {
    await api('DELETE', `/remittances/${depositId}`);
    toast('Deposit removed');
    await load(range);
  });
}

export default { mount, show };
