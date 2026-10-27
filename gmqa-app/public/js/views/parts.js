// Parts: the auto parts for sale (items tagged Auto Parts in Inventory), their stock, and over-the-counter
// sales. Items, prices, deliveries and stock counts are managed on the Inventory tab.
import { $, $$, api, esc, peso, toast, busy, todayLocal, openModal, closeModal, modalHeader, isOwner, loadCatalog, state } from '../ui.js';
import { createJobEditor } from '../components/job-editor.js';
import { itemsSummary, voidJob, restoreJob, showHistory } from '../components/job-actions.js';

let root;
let counterDate = todayLocal();
let counterJobs = [];

function mount(el) {
  root = el;
  root.innerHTML = `
    <div class="view-header">
      <div><h1>Parts</h1><div class="desc">Auto parts for sale and over-the-counter sales. Parts can also be added to any job order.</div></div>
      <div class="header-actions"><button class="btn ghost" type="button" data-go-inventory>Manage in Inventory</button></div>
    </div>
    <div data-low></div>
    <div class="card">
      <div class="section-header"><div><h2>Parts for sale</h2><p class="hint">Everything tagged <b>Auto Parts</b> in Inventory.</p></div></div>
      <div class="table-wrap"><table class="simple-table parts-table" data-parts></table></div>
    </div>
    <div class="card">
      <div class="section-header"><h2>Counter sales</h2>
        <div class="header-actions"><label class="inline-label">On <input type="date" data-counter-date></label>
          <button class="btn" type="button" data-new-sale>+ New counter sale</button></div></div>
      <div class="table-wrap"><table class="jobs-table running-table">
        <thead><tr><th>JO#</th><th>Items</th><th>Payment</th><th>Paid</th><th class="num">Total</th>${isOwner() ? '<th class="num">Cost</th>' : ''}<th></th></tr></thead>
        <tbody data-counter></tbody>
      </table></div>
    </div>`;
  $('[data-counter-date]', root).value = counterDate;
  $('[data-counter-date]', root).addEventListener('change', e => { if (e.target.value) { counterDate = e.target.value; loadCounter(); } });
  $('[data-new-sale]', root).addEventListener('click', counterSaleModal);
  $('[data-go-inventory]', root).addEventListener('click', () => { location.hash = 'inventory'; });
}

async function show() {
  await Promise.all([loadParts(), loadCounter()]);
}

async function loadParts() {
  await loadCatalog(true);
  renderParts(state.catalog.parts);
}

async function loadCounter() {
  counterJobs = await api('GET', `/jobs?date=${counterDate}&department=parts`);
  renderCounter();
}

function renderParts(parts) {
  const owner = isOwner();
  const low = parts.filter(p => p.low);
  $('[data-low]', root).innerHTML = low.length
    ? `<div class="banner"><span>Low stock: ${low.map(p => `<b>${esc(p.name)}</b> (${p.stock} ${esc(p.unit)})`).join(', ')}. Time to reorder.</span></div>` : '';
  $('[data-parts]', root).innerHTML = `
    <thead><tr><th>SKU</th><th>Part</th><th class="num">Price</th><th class="num">Comm./unit</th><th class="num">Set</th>${owner ? '<th class="num">Avg cost</th>' : ''}
      <th class="num">Stock</th><th class="num">Reorder at</th></tr></thead>
    <tbody>${parts.length ? parts.map(p => `
      <tr data-part="${p.id}">
        <td class="mono">${esc(p.sku || '—')}</td>
        <td><b>${esc(p.name)}</b> <span class="muted small">per ${esc(p.unit)}</span></td>
        <td class="num money">${peso(p.price)}</td>
        <td class="num money">${p.commission ? peso(p.commission) : '—'}</td>
        <td class="num money">${p.set_size > 1 && p.set_price > 0 ? `Set of ${p.set_size} · ${peso(p.set_price)}` : '—'}</td>
        ${owner ? `<td class="num money">${peso(p.avg_cost)}</td>` : ''}
        <td class="num" data-stock>${p.stock} ${p.low ? '<span class="status-pill waiting">Low</span>' : ''}</td>
        <td class="num">${p.reorder_level}</td>
      </tr>`).join('') : `<tr><td colspan="8"><div class="empty-state small">No parts for sale yet. Tag items <b>Auto Parts</b> in Inventory.</div></td></tr>`}</tbody>`;
}

function renderCounter() {
  const tbody = $('[data-counter]', root);
  tbody.innerHTML = counterJobs.length ? counterJobs.map(j => `
    <tr data-id="${j.id}" class="${j.voided_at ? 'voided' : ''}">
      <td class="jo-number">${esc(j.jo_number)}${j.voided_at ? `<div class="void-note">VOID · ${esc(j.void_reason)}</div>` : ''}</td>
      <td class="items-cell">${itemsSummary(j)}</td>
      <td>${esc(j.payment_method)}</td>
      <td>${j.payment_received ? 'Paid' : '<span class="amber-text">Unpaid</span>'}</td>
      <td class="num money">${peso(j.totals.total)}</td>
      ${isOwner() ? `<td class="num money muted">${peso(j.totals.cost)}</td>` : ''}
      <td class="row-actions"><div class="actions">${j.voided_at
        ? (isOwner() ? '<button class="btn ghost small" type="button" data-act="restore">Restore</button>' : '')
        : (isOwner() ? '<button class="icon-btn" type="button" data-act="void" title="Void sale">✕</button>' : '')}
        <button class="icon-btn" type="button" data-act="history" title="Change history">⟲</button></div></td>
    </tr>`).join('') : '<tr><td colspan="7"><div class="empty-state small">No counter sales on this day.</div></td></tr>';
  const reloadAll = () => Promise.all([loadParts(), loadCounter()]);
  $$('[data-act]', tbody).forEach(btn => btn.addEventListener('click', () => {
    const job = counterJobs.find(j => j.id === Number(btn.closest('tr').dataset.id));
    ({ void: () => voidJob(job, reloadAll), restore: () => restoreJob(job, reloadAll), history: () => showHistory(job) })[btn.dataset.act]();
  }));
}

function counterSaleModal() {
  openModal(`${modalHeader('New counter sale', `Parts sold over the counter on ${counterDate}. No vehicle needed.`)}
    <div data-sale-editor></div>
    <div class="modal-actions"><button class="btn ghost" type="button" data-close>Cancel</button><button class="btn" type="button" data-save>Record sale</button></div>`,
  card => {
    card.closest('dialog').classList.add('wide');
    const editor = createJobEditor($('[data-sale-editor]', card), { department: 'parts' });
    $('[data-save]', card).addEventListener('click', e => {
      const error = editor.validate();
      if (error) return toast(error, 'error');
      busy(e.currentTarget, async () => {
        const job = await api('POST', '/jobs', { ...editor.payload(), department: 'parts', job_date: counterDate });
        closeModal();
        toast(`${job.jo_number} added`);
        await Promise.all([loadParts(), loadCounter()]);
      });
    });
  });
  $('#modal').addEventListener('close', () => $('#modal').classList.remove('wide'), { once: true });
}

export default { mount, show };
