// Parts: job orders on the same board as Detailing and Tint & PPF (a part can stay for days until it is installed),
// each shown itemized, and the auto parts for sale (items tagged Auto Parts in Inventory) as a simple list. One search
// box covers both. Items, prices, deliveries and stock counts are managed on the Inventory tab.
import { $, esc, peso, openModal, modalHeader, isOwner, loadCatalog, state } from '../ui.js';
import { createRunningView } from './running.js';

let root;
let search = '';

const qty = n => String(Math.round(Number(n || 0) * 100) / 100);
const hasSet = p => p.set_size > 1 && p.set_price > 0;
const matches = (...texts) => !search || texts.some(t => String(t || '').toLowerCase().includes(search));

const board = createRunningView('parts', {
  title: 'Parts',
  desc: 'Job orders stay here until they are done and paid. Sale and commission count on the day a job is done.',
  entryTitle: 'New parts job',
  activeTitle: 'Open job orders',
  lead: `<div class="list-toolbar"><input type="text" enterkeyhint="search" data-search placeholder="Search parts and jobs" aria-label="Search parts and jobs"></div>
    <div data-low></div>`,
  tail: `<div class="card list-card">
      <div class="section-header"><div><h2>Parts for sale</h2><p class="hint">Everything tagged <b>Auto Parts</b> in Inventory. Tap a part for its details.</p></div>
        <div class="header-actions"><button class="btn ghost" type="button" data-go-inventory>Manage in Inventory</button></div></div>
      <div class="list-head" aria-hidden="true"><span>Item</span><span>Price</span><span>Stock</span></div>
      <div class="simple-list" data-parts></div>
    </div>`,
  matches: j => matches(j.jo_number, j.detailer, j.plate, j.payment_method, ...j.items.map(i => i.name)),
  onChange: loadParts, // stock moves with every job
});

function mount(el) {
  root = el;
  search = '';
  board.mount(el);
  $('[data-search]', root).addEventListener('input', e => {
    search = e.target.value.trim().toLowerCase();
    renderParts();
    board.render();
  });
  $('[data-go-inventory]', root).addEventListener('click', () => { location.hash = 'inventory'; });
  $('[data-parts]', root).addEventListener('click', e => {
    const row = e.target.closest('[data-part]');
    if (row) partPanel(state.catalog.parts.find(p => p.id === Number(row.dataset.part)));
  });
}

async function show() {
  await board.show();
  renderParts();
}

async function loadParts() {
  await loadCatalog(true);
  renderParts();
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

export default { mount, show };
