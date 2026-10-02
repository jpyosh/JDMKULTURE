// Parts & Inventory: stock list (everyone), owner price/stock management, and over-the-counter sales.
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
      <div><h1>Parts &amp; Inventory</h1><div class="desc">Stock on hand, prices, deliveries, and over-the-counter sales. Parts can also be added to any job order.</div></div>
    </div>
    <div data-low></div>
    <div class="card">
      <div class="section-header"><h2>Stock</h2><button class="btn ghost owner-only" type="button" data-new-part>+ New part</button></div>
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
  $('[data-new-part]', root).addEventListener('click', () => partModal(null));
  $('[data-new-sale]', root).addEventListener('click', counterSaleModal);
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
    ? `<div class="banner">Low stock: ${low.map(p => `<b>${esc(p.name)}</b> (${p.stock} ${esc(p.unit)})`).join(', ')}. Time to reorder.</div>` : '';
  $('[data-parts]', root).innerHTML = `
    <thead><tr><th>SKU</th><th>Part</th><th class="num">Price</th><th class="num">Comm./unit</th>${owner ? '<th class="num">Avg cost</th>' : ''}
      <th class="num">Stock</th><th class="num">Reorder at</th>${owner ? '<th></th>' : ''}</tr></thead>
    <tbody>${parts.length ? parts.map(p => `
      <tr data-part="${p.id}">
        <td class="mono">${esc(p.sku || '—')}</td>
        <td><b>${esc(p.name)}</b> <span class="muted small">per ${esc(p.unit)}</span></td>
        <td class="num money">${peso(p.price)}</td>
        <td class="num money">${p.commission ? peso(p.commission) : '—'}</td>
        ${owner ? `<td class="num money">${peso(p.avg_cost)}</td>` : ''}
        <td class="num" data-stock>${p.stock} ${p.low ? '<span class="status-pill waiting">Low</span>' : ''}</td>
        <td class="num">${p.reorder_level}</td>
        ${owner ? `<td class="row-actions"><div class="actions">
          <button class="btn small" type="button" data-act="receive">Receive</button>
          <button class="btn ghost small" type="button" data-act="adjust">Adjust</button>
          <button class="btn ghost small" type="button" data-act="edit">Edit</button>
          <button class="btn ghost small" type="button" data-act="history">History</button></div></td>` : ''}
      </tr>`).join('') : `<tr><td colspan="8"><div class="empty-state small">No parts yet.${owner ? ' Add one with “+ New part”.' : ''}</div></td></tr>`}</tbody>`;
  $$('[data-parts] [data-act]', root).forEach(btn => btn.addEventListener('click', () => {
    const part = parts.find(p => p.id === Number(btn.closest('tr').dataset.part));
    ({ receive: receiveModal, adjust: adjustModal, edit: partModal, history: historyModal })[btn.dataset.act](part);
  }));
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

function partModal(part) {
  openModal(`${modalHeader(part ? `Edit ${part.name}` : 'New part', part ? 'Price changes apply to new sales; past sales keep their price.' : 'Add stock afterwards with “Receive”.')}
    <div class="form-grid modal-form-grid">
      <div><label>SKU / code</label><input type="text" data-p="sku" maxlength="40" value="${esc(part?.sku || '')}"></div>
      <div class="span-2"><label>Name</label><input type="text" data-p="name" maxlength="120" value="${esc(part?.name || '')}"></div>
      <div><label>Unit</label><input type="text" data-p="unit" maxlength="12" value="${esc(part?.unit || 'pc')}"></div>
      <div><label>Selling price</label><input type="number" min="0" step="0.01" data-p="price" value="${part?.price ?? ''}"></div>
      <div><label>Commission / unit</label><input type="number" min="0" step="0.01" data-p="commission" value="${part?.commission ?? 0}"></div>
      <div><label>Reorder when stock ≤</label><input type="number" min="0" step="1" data-p="reorder_level" value="${part?.reorder_level ?? 0}"></div>
    </div>
    <div class="modal-actions">${part ? '<button class="btn danger" type="button" data-archive>Archive part</button>' : ''}
      <button class="btn ghost" type="button" data-close>Cancel</button><button class="btn" type="button" data-confirm>${part ? 'Save' : 'Add part'}</button></div>`,
  card => {
    $('[data-p="name"]', card).focus();
    $('[data-confirm]', card).addEventListener('click', e => busy(e.currentTarget, async () => {
      const get = k => $(`[data-p="${k}"]`, card).value.trim();
      if (!get('name')) return toast('Name is required', 'error');
      const body = { sku: get('sku'), name: get('name'), unit: get('unit'), price: Number(get('price') || 0),
        commission: Number(get('commission') || 0), reorder_level: Number(get('reorder_level') || 0) };
      if (part) await api('PATCH', `/parts/${part.id}`, body);
      else await api('POST', '/parts', body);
      closeModal();
      toast(part ? 'Part saved' : 'Part added');
      await loadParts();
    }));
    $('[data-archive]', card)?.addEventListener('click', e => busy(e.currentTarget, async () => {
      if (!window.confirm(`Archive ${part.name}? It disappears from sale lists; its history is kept.`)) return;
      await api('PATCH', `/parts/${part.id}`, { active: false });
      closeModal();
      toast('Part archived');
      await loadParts();
    }));
  });
}

function receiveModal(part) {
  openModal(`${modalHeader(`Receive ${part.name}`, `In stock: ${part.stock} ${part.unit} at an average cost of ${peso(part.avg_cost)}.`)}
    <div class="form-grid modal-form-grid">
      <div><label>Date</label><input type="date" data-r="date" value="${todayLocal()}"></div>
      <div><label>Quantity</label><input type="number" min="0.01" step="1" data-r="quantity"></div>
      <div><label>Cost per ${esc(part.unit)}</label><input type="number" min="0" step="0.01" data-r="unit_cost" value="${part.avg_cost || ''}"></div>
      <div><label>Supplier</label><input type="text" data-r="supplier" maxlength="120"></div>
    </div>
    <div class="modal-actions"><button class="btn ghost" type="button" data-close>Cancel</button><button class="btn" type="button" data-confirm>Receive stock</button></div>`,
  card => $('[data-confirm]', card).addEventListener('click', e => busy(e.currentTarget, async () => {
    const get = k => $(`[data-r="${k}"]`, card).value;
    await api('POST', `/parts/${part.id}/receive`, {
      date: get('date'), quantity: Number(get('quantity') || 0), unit_cost: Number(get('unit_cost') || 0), supplier: get('supplier').trim(),
    });
    closeModal();
    toast('Stock received');
    await loadParts();
  })));
}

function adjustModal(part) {
  openModal(`${modalHeader(`Adjust ${part.name}`, `Correct the count after a stock check. In stock: ${part.stock} ${part.unit}.`)}
    <div class="form-grid modal-form-grid">
      <div><label>Date</label><input type="date" data-a="date" value="${todayLocal()}"></div>
      <div><label>Change (+ add / − remove)</label><input type="number" step="1" data-a="quantity" placeholder="-1"></div>
      <div class="span-2"><label>Reason</label><input type="text" data-a="note" maxlength="200" placeholder="e.g. damaged, recount"></div>
    </div>
    <div class="modal-actions"><button class="btn ghost" type="button" data-close>Cancel</button><button class="btn" type="button" data-confirm>Save adjustment</button></div>`,
  card => $('[data-confirm]', card).addEventListener('click', e => busy(e.currentTarget, async () => {
    const get = k => $(`[data-a="${k}"]`, card).value;
    await api('POST', `/parts/${part.id}/adjust`, { date: get('date'), quantity: Number(get('quantity') || 0), note: get('note').trim() });
    closeModal();
    toast('Stock adjusted');
    await loadParts();
  })));
}

async function historyModal(part) {
  const moves = await api('GET', `/parts/${part.id}/movements`);
  const label = { receive: 'Received', sale: 'Sold', return: 'Returned', adjust: 'Adjusted' };
  openModal(`${modalHeader(`${part.name} stock history`, `${moves.length} movement${moves.length === 1 ? '' : 's'}`)}
    <div class="history-list">${moves.slice().reverse().map(m => `<div class="history-entry">
      <div class="history-meta"><span>${esc(m.moved_on)}</span><span>${esc(m.created_by || '')}</span></div>
      <div><span class="kind-pill ${m.quantity > 0 ? 'service' : 'custom'}">${label[m.kind]}</span>
        <b>${m.quantity > 0 ? '+' : ''}${m.quantity} ${esc(part.unit)}</b>${m.unit_cost != null ? ` @ ${peso(m.unit_cost)}` : ''}
        ${m.jo_number ? ` · ${esc(m.jo_number)}` : ''}${m.supplier ? ` · ${esc(m.supplier)}` : ''}${m.note ? ` · ${esc(m.note)}` : ''}</div>
    </div>`).join('') || '<div class="empty-state small">No movements yet.</div>'}</div>
    <div class="modal-actions"><button class="btn ghost" type="button" data-close>Close</button></div>`);
}

export default { mount, show };
