// Cash fund (owner): money the boss gives so purchases the day's sales cannot cover yet (abonos)
// never come out of anyone's pocket. Purchases are recorded at EOD (Expenses → Paid from: Cash fund);
// here the owner records the money received, downloads the itemized list and replenishes.
import { $, $$, api, apiDownload, esc, peso, toast, busy, todayLocal, openModal, closeModal, modalHeader } from '../ui.js';

let root;
let fund = null;
const GUIDE_KEY = 'gmqa.cashfund.guide';

function mount(el) {
  root = el;
  root.innerHTML = `
    <div class="view-header">
      <div><h1>Cash fund</h1><div class="desc">Money from the boss for abonos: things the shop must buy before the day's sales can cover them.</div></div>
    </div>
    <details class="card guide" data-guide>
      <summary>How the cash fund works <span class="muted small">New here? Start with these steps.</span></summary>
      <ol class="guide-steps">
        <li><b>Set the fund size.</b> This is the full amount the boss keeps in the fund (for example ₱50,000). Press <b>Set fund size</b>.</li>
        <li><b>Record the money.</b> When the boss hands over the money, press <b>Record money received</b> and type the amount.</li>
        <li><b>Buying something the sales can't cover yet (an abono)?</b>
          <p>Pay with the cash fund money. Then go to <b>EOD Closing → Expenses</b>, choose <b>Paid from: Cash fund</b>, and type what it was
            for and the amount. Write it the same day so nothing is forgotten. It counts as a cost of that day, but it does not change the drawer count.</p></li>
        <li><b>On replenishment day</b> (weekly or monthly, as agreed with the boss), press <b>Download list</b> and give the boss the
          itemized list with the receipts.</li>
        <li><b>When the boss pays it back</b>, press <b>Replenish</b>. The list is cleared and moves to History, and the fund is full again.
          <p>Made a mistake? Press <b>Undo</b> in History; the purchases go back on the list.</p></li>
      </ol>
    </details>
    <div class="metrics-row">
      <div class="metric"><div class="label">Fund size</div><div class="value" data-target-value></div>
        <button class="btn ghost small mt-s" type="button" data-set-target>Set fund size</button></div>
      <div class="metric"><div class="label">Cash in the fund now</div><div class="value teal" data-balance></div></div>
      <div class="metric"><div class="label">Spent, waiting to be paid back</div><div class="value amber" data-pending-total></div></div>
      <div class="metric"><div class="label">Ask the boss for</div><div class="value" data-to-replenish></div></div>
    </div>
    <div class="card">
      <div class="section-header"><h2>Waiting to be replenished</h2>
        <div class="actions">
          <button class="btn ghost" type="button" data-add-money>Record money received</button>
          <button class="btn ghost" type="button" data-sheet>Download list (PDF)</button>
          <button class="btn" type="button" data-replenish>Replenish</button>
        </div></div>
      <p class="hint">Everything bought with the cash fund since the last replenishment. Purchases are added in EOD Closing → Expenses → Paid from: Cash fund.</p>
      <div class="table-wrap"><table class="simple-table funds-table" data-pending></table></div>
    </div>
    <div class="card">
      <h2>History</h2>
      <p class="hint">Every time money was received for the fund. Each replenishment keeps its own list.</p>
      <div class="table-wrap"><table class="simple-table funds-table" data-topups></table></div>
    </div>`;
  const guide = $('[data-guide]', root);
  try { guide.open = localStorage.getItem(GUIDE_KEY) !== 'closed'; } catch { guide.open = true; }
  guide.addEventListener('toggle', () => {
    try { localStorage.setItem(GUIDE_KEY, guide.open ? 'open' : 'closed'); } catch { /* storage blocked: the guide just opens again next time */ }
  });
  $('[data-set-target]', root).addEventListener('click', targetModal);
  $('[data-add-money]', root).addEventListener('click', () => moneyModal({ title: 'Record money received', note: '', amount: '' }));
  $('[data-replenish]', root).addEventListener('click', () => {
    if (!fund.pending.length && !fund.toReplenish) return toast('Nothing to replenish yet', 'error');
    moneyModal({ title: 'Replenish the cash fund', note: 'Replenishment', amount: fund.toReplenish,
      subtitle: `${fund.pending.length} purchase${fund.pending.length === 1 ? '' : 's'} (${peso(fund.pendingTotal)}) will be marked as paid back.` });
  });
  $('[data-sheet]', root).addEventListener('click', e => busy(e.currentTarget, () => apiDownload('/cash-fund/sheet.pdf')));
}

async function show() {
  fund = await api('GET', '/cash-fund');
  render();
}

function render() {
  $('[data-target-value]', root).innerHTML = fund.target ? peso(fund.target) : '<span class="amber-text">not set</span>';
  $('[data-balance]', root).textContent = peso(fund.balance);
  $('[data-pending-total]', root).textContent = peso(fund.pendingTotal);
  $('[data-to-replenish]', root).textContent = peso(fund.toReplenish);
  $('[data-replenish]', root).textContent = fund.toReplenish ? `Replenish ${peso(fund.toReplenish)}` : 'Replenish';

  $('[data-pending]', root).innerHTML = `
    <thead><tr><th>Date</th><th>What it was for</th><th>Recorded by</th><th class="num">Amount</th></tr></thead>
    <tbody>${fund.pending.length ? fund.pending.map(e => `
      <tr><td class="mono">${esc(e.expense_date)}</td><td><b>${esc(e.description)}</b></td>
        <td class="muted">${esc((e.created_by || '').split('@')[0] || '—')}</td><td class="num money">${peso(e.amount)}</td></tr>`).join('')
      : '<tr><td colspan="4"><div class="empty-state">Nothing waiting. Purchases paid from the cash fund show up here.</div></td></tr>'}</tbody>`;

  $('[data-topups]', root).innerHTML = `
    <thead><tr><th>Date</th><th>Note</th><th class="num">Money received</th><th class="num">Purchases paid back</th><th></th></tr></thead>
    <tbody>${fund.topups.length ? fund.topups.map(t => `
      <tr data-topup="${t.id}"><td class="mono">${esc(t.entry_date)}</td><td>${esc(t.note || '—')}</td>
        <td class="num money">${peso(t.amount)}</td>
        <td class="num money">${t.itemCount ? `${peso(t.itemsTotal)}<div class="muted small">${t.itemCount} item${t.itemCount === 1 ? '' : 's'}</div>` : '—'}</td>
        <td class="row-actions"><div class="actions">
          ${t.itemCount ? '<button class="btn ghost small" type="button" data-act="topup-sheet">List (PDF)</button>' : ''}
          <button class="btn ghost small" type="button" data-act="undo-topup">Undo</button></div></td></tr>`).join('')
      : '<tr><td colspan="5"><div class="empty-state">No money recorded yet. Start with "Record money received".</div></td></tr>'}</tbody>`;
  $$('[data-topups] [data-act]', root).forEach(btn => btn.addEventListener('click', () => {
    const topup = fund.topups.find(t => t.id === Number(btn.closest('tr').dataset.topup));
    if (btn.dataset.act === 'topup-sheet') return busy(btn, () => apiDownload(`/cash-fund/sheet.pdf?topup=${topup.id}`));
    return undoTopup(topup);
  }));
}

function targetModal() {
  openModal(`${modalHeader('Set fund size', 'The full amount the boss keeps in the cash fund. "Ask the boss for" is worked out from it.')}
    <div class="form-grid modal-form-grid"><div><label>Fund size</label><input type="number" min="0" step="0.01" data-target value="${fund.target || ''}" placeholder="e.g. 50000"></div></div>
    <div class="modal-actions"><button class="btn ghost" type="button" data-close>Cancel</button><button class="btn" type="button" data-confirm>Save</button></div>`,
  card => $('[data-confirm]', card).addEventListener('click', e => busy(e.currentTarget, async () => {
    fund = await api('PUT', '/cash-fund', { target: Number($('[data-target]', card).value || 0) });
    closeModal();
    toast('Fund size saved');
    render();
  })));
}

function moneyModal({ title, subtitle = 'Money the boss handed over for the cash fund.', amount, note }) {
  openModal(`${modalHeader(title, subtitle)}
    <div class="form-grid modal-form-grid">
      <div><label>Date received</label><input type="date" data-topup-date value="${todayLocal()}"></div>
      <div><label>Amount received</label><input type="number" min="0.01" step="0.01" data-topup-amount value="${amount || ''}"></div>
      <div><label>Note</label><input type="text" maxlength="200" data-topup-note value="${esc(note)}" placeholder="e.g. Starting fund"></div>
    </div>
    <div class="modal-actions"><button class="btn ghost" type="button" data-close>Cancel</button><button class="btn" type="button" data-confirm>Record</button></div>`,
  card => $('[data-confirm]', card).addEventListener('click', e => busy(e.currentTarget, async () => {
    const value = Number($('[data-topup-amount]', card).value || 0);
    if (!(value > 0)) return toast('Type the amount received', 'error');
    await api('POST', '/cash-fund/topups', { date: $('[data-topup-date]', card).value, amount: value, note: $('[data-topup-note]', card).value.trim() });
    closeModal();
    toast(`${peso(value)} recorded`);
    await show();
  })));
}

async function undoTopup(topup) {
  const items = topup.itemCount ? `\n\nIts ${topup.itemCount} purchase${topup.itemCount === 1 ? '' : 's'} will be waiting to be replenished again.` : '';
  if (!window.confirm(`Undo the ${peso(topup.amount)} received on ${topup.entry_date}?${items}`)) return;
  fund = await api('DELETE', `/cash-fund/topups/${topup.id}`);
  toast('Replenishment undone');
  render();
}

export default { mount, show };
