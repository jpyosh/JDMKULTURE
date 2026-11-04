// Parts: the auto parts for sale (items tagged Auto Parts in Inventory) as a simple list, and over-the-counter
// sales, each shown itemized. One search box covers both. Items, prices, deliveries and stock counts are managed
// on the Inventory tab.
import { $, $$, api, esc, peso, toast, busy, todayLocal, openModal, closeModal, modalHeader, isOwner, loadCatalog, state } from '../ui.js';
import { createJobEditor } from '../components/job-editor.js';
import { receipt, voidJob, restoreJob, showHistory } from '../components/job-actions.js';

let root;
let counterDate = todayLocal();
let counterJobs = [];
let owingJobs = []; // unpaid counter sales of other days
let search = '';

const dayLabel = d => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-PH', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const qty = n => String(Math.round(Number(n || 0) * 100) / 100);
const hasSet = p => p.set_size > 1 && p.set_price > 0;
const matches = (...texts) => !search || texts.some(t => String(t || '').toLowerCase().includes(search));

function mount(el) {
  root = el;
  search = '';
  root.innerHTML = `
    <div class="view-header">
      <div><h1>Parts</h1><div class="desc">Auto parts for sale and over-the-counter sales. Tap a part for its details.</div></div>
      <div class="header-actions"><button class="btn ghost" type="button" data-go-inventory>Manage in Inventory</button></div>
    </div>
    <div class="list-toolbar"><input type="text" enterkeyhint="search" data-search placeholder="Search parts and sales" aria-label="Search parts and sales"></div>
    <div data-low></div>
    <div class="card list-card">
      <div class="section-header"><div><h2>Parts for sale</h2><p class="hint">Everything tagged <b>Auto Parts</b> in Inventory.</p></div></div>
      <div class="list-head" aria-hidden="true"><span>Item</span><span>Price</span><span>Stock</span></div>
      <div class="simple-list" data-parts></div>
    </div>
    <div class="card">
      <div class="section-header"><h2>Counter sales</h2>
        <div class="header-actions"><label class="inline-label">On <input type="date" data-counter-date></label>
          <button class="btn" type="button" data-new-sale>+ New counter sale</button></div></div>
      <div data-owing></div>
      <div class="sale-cards" data-counter></div>
    </div>`;
  $('[data-search]', root).addEventListener('input', e => { search = e.target.value.trim().toLowerCase(); renderParts(); renderCounter(); });
  $('[data-counter-date]', root).value = counterDate;
  $('[data-counter-date]', root).addEventListener('change', e => { if (e.target.value) { counterDate = e.target.value; loadCounter(); } });
  $('[data-new-sale]', root).addEventListener('click', counterSaleModal);
  $('[data-go-inventory]', root).addEventListener('click', () => { location.hash = 'inventory'; });
  $('[data-parts]', root).addEventListener('click', e => {
    const row = e.target.closest('[data-part]');
    if (row) partPanel(state.catalog.parts.find(p => p.id === Number(row.dataset.part)));
  });
}

async function show() {
  await Promise.all([loadParts(), loadCounter()]);
}

async function loadParts() {
  await loadCatalog(true);
  renderParts();
}

async function loadCounter() {
  const [day, owing] = await Promise.all([
    api('GET', `/jobs?date=${counterDate}&department=parts`),
    api('GET', '/jobs?department=parts&unpaid=1'),
  ]);
  counterJobs = day;
  owingJobs = owing.filter(j => j.job_date !== counterDate);
  renderCounter();
}

function renderParts() {
  const parts = state.catalog.parts;
  const low = parts.filter(p => p.low);
  $('[data-low]', root).innerHTML = low.length
    ? `<div class="banner"><span>Low stock: ${low.map(p => `<b>${esc(p.name)}</b> (${p.stock} ${esc(p.unit)})`).join(', ')}. Time to reorder.</span></div>` : '';
  const list = parts.filter(p => matches(p.name, p.sku));
  $('[data-parts]', root).innerHTML = list.length ? list.map(p => `<button type="button" class="list-row" data-part="${p.id}">
      <span class="list-main"><span class="list-name">${esc(p.name)}</span>
        ${hasSet(p) ? `<span class="list-sub"><span class="muted small">set of ${p.set_size} · ${peso(p.set_price)}</span></span>` : ''}</span>
      <span class="list-price">${peso(p.price)}</span>
      <span class="list-stock"><span data-stock>${qty(p.stock)} ${esc(p.unit)}</span>${p.low ? ' <span class="status-pill waiting">Low</span>' : ''}</span>
    </button>`).join('')
    : `<div class="empty-state small">${parts.length ? 'No parts match.' : 'No parts for sale yet. Tag items <b>Auto Parts</b> in Inventory.'}</div>`;
}

// A part's details (costs only for the owner).
function partPanel(p) {
  const row = (label, value) => `<div class="panel-row"><span>${label}</span><b>${value}</b></div>`;
  openModal(`${modalHeader(p.name)}
    <div class="panel" data-panel>
      ${p.sku ? row('SKU', `<span class="mono">${esc(p.sku)}</span>`) : ''}
      ${row('Price', `${peso(p.price)} per ${esc(p.unit)}`)}
      ${hasSet(p) ? row('Set', `set of ${p.set_size} · ${peso(p.set_price)}`) : ''}
      ${Number(p.commission) ? row('Commission', `${peso(p.commission)} per ${esc(p.unit)}`) : ''}
      ${isOwner() ? row('Avg cost', peso(p.avg_cost)) : ''}
      ${row('Stock', `${qty(p.stock)} ${esc(p.unit)}${p.low ? ' <span class="status-pill waiting">Low</span>' : ''}`)}
      ${row('Reorder at', qty(p.reorder_level))}
    </div>
    <div class="modal-actions"><button class="btn ghost" type="button" data-close>Close</button></div>`);
}

// One counter sale, itemized. Unpaid: Mark paid (on the day the customer pays). Paid on a later day: Undo payment.
function saleCard(j, { showDate = false } = {}) {
  const owner = isOwner();
  const paidLater = j.paid_on && j.paid_on !== j.job_date;
  const status = j.payment_received
    ? `${esc(j.payment_method)} · Paid${paidLater ? ` ${dayLabel(j.paid_on)}` : ''}`
    : '<span class="amber-text">Unpaid</span>';
  const payButton = j.voided_at ? ''
    : !j.payment_received ? '<button class="btn small" type="button" data-act="pay">Mark paid</button>'
      : paidLater ? '<button class="btn ghost small" type="button" data-act="unpay">Undo payment</button>' : '';
  return `
    <div class="sale-card ${j.voided_at ? 'voided' : ''}" data-sale="${j.id}">
      <div class="sale-head">
        <div><b class="jo-number">${esc(j.jo_number)}</b>${j.detailer ? ` <span class="muted small">by ${esc(j.detailer)}</span>` : ''}
          <div class="small">${showDate ? `Sold ${dayLabel(j.job_date)} · ` : ''}${status}</div></div>
        <div class="actions">${payButton}${j.voided_at
          ? (owner ? '<button class="btn ghost small" type="button" data-act="restore">Restore</button>' : '')
          : (owner ? '<button class="icon-btn" type="button" data-act="void" title="Void sale">✕</button>' : '')}
          <button class="icon-btn" type="button" data-act="history" title="Change history">⟲</button></div>
      </div>
      ${j.voided_at ? `<div class="void-note">VOID · ${esc(j.void_reason)}</div>` : ''}
      ${receipt(j)}
      ${owner ? `<div class="sale-foot muted small">Cost of parts ${peso(j.totals.cost)}</div>` : ''}
    </div>`;
}

function renderCounter() {
  const filter = list => list.filter(j => matches(j.jo_number, j.detailer, j.plate, j.payment_method, ...j.items.map(i => i.name)));
  const list = filter(counterJobs);
  const owing = filter(owingJobs);
  const owingBox = $('[data-owing]', root);
  owingBox.innerHTML = owing.length ? `<div class="owing">
      <h3>Unpaid from other days <span class="muted small">${owing.length} · ${peso(owing.reduce((t, j) => t + j.totals.total, 0))}</span></h3>
      <p class="hint">Press <b>Mark paid</b> when the customer pays. The money counts on the day they pay.</p>
      <div class="sale-cards">${owing.map(j => saleCard(j, { showDate: true })).join('')}</div></div>` : '';
  const box = $('[data-counter]', root);
  box.innerHTML = list.length ? list.map(j => saleCard(j)).join('')
    : `<div class="empty-state small">${counterJobs.length ? 'No sales match.' : 'No counter sales on this day.'}</div>`;
  const reloadAll = () => Promise.all([loadParts(), loadCounter()]);
  [owingBox, box].forEach(el => $$('[data-act]', el).forEach(btn => btn.addEventListener('click', () => {
    const saleId = Number(btn.closest('[data-sale]').dataset.sale);
    const job = [...counterJobs, ...owingJobs].find(j => j.id === saleId);
    ({
      void: () => voidJob(job, reloadAll),
      restore: () => restoreJob(job, reloadAll),
      history: () => showHistory(job),
      pay: () => payModal(job),
      unpay: () => undoPayment(job),
    })[btn.dataset.act]();
  })));
}

// The customer pays for a sale taken on credit: the money counts in that day's drawer or GCash.
function payModal(job) {
  openModal(`${modalHeader(`Mark ${job.jo_number} paid`, `${peso(job.totals.total)} for the sale of ${dayLabel(job.job_date)}. The money counts on the day it is paid.`)}
    ${receipt(job)}
    <div class="form-grid modal-form-grid mt">
      <div><label>Paid on</label><input type="date" data-pay-date value="${counterDate < job.job_date ? job.job_date : counterDate}" min="${job.job_date}"></div>
      <fieldset class="choice-group pay-choice" data-pay-method><legend>Paid with</legend>
        ${['Cash', 'GCash'].map(p => `<label><input type="radio" name="counter-pay" value="${p}"> ${p}</label>`).join('')}</fieldset>
    </div>
    <div class="modal-actions"><button class="btn ghost" type="button" data-close>Cancel</button><button class="btn" type="button" data-confirm>Record payment</button></div>`,
  card => $('[data-confirm]', card).addEventListener('click', e => {
    const method = $('[data-pay-method] input:checked', card)?.value;
    if (!method) return toast('Choose Cash or GCash', 'error');
    busy(e.currentTarget, async () => {
      await api('POST', `/jobs/${job.id}/pay`, { date: $('[data-pay-date]', card).value, payment_method: method });
      closeModal();
      toast(`${job.jo_number} paid`);
      await loadCounter();
    });
  }));
}

async function undoPayment(job) {
  if (!window.confirm(`Undo the payment for ${job.jo_number}? It goes back to unpaid and its ${peso(job.totals.total)} comes off ${dayLabel(job.paid_on)}.`)) return;
  await api('POST', `/jobs/${job.id}/unpay`);
  toast('Payment removed');
  await loadCounter();
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
