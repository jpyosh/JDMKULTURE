// Inventory: everything the shop stocks (parts for sale, chemicals, mitts, towels, machines), two ways: a simple
// list (name and tags, price, stock; tap an item for its details and what can be done with it) or a sheet edited
// in place like Excel. Tags group items; the ones tagged Auto Parts are for sale (Parts tab and job orders).
// Stock sits in four containers: Overall (deliveries land here, auto parts sell from here), Carwash, Detailing and
// Tint & PPF. Everyone can record a stock count in any of them (the difference is what was used); the owner edits
// items and tags, receives deliveries, moves stock between containers, and sees costs and history.
import { $, $$, api, esc, peso, toast, busy, todayLocal, openModal, closeModal, modalHeader, isOwner, loadCatalog } from '../ui.js';
import { toCsv, parsePasted, importRows } from '../components/sheet-io.js';

let root;
let items = [];
let tags = [];
const filter = { tag: '', search: '', container: '' };
const sort = { field: 'name', dir: 1 };
let editing = null;

const MODE_KEY = 'inventory-mode';
// List or sheet: the viewer's own choice on this device; the list until they choose.
let mode = (() => {
  try { return localStorage.getItem(MODE_KEY) === 'sheet' ? 'sheet' : 'list'; } catch { return 'list'; } // private window
})();

// edit: 'owner' = the owner edits the item field in place; 'count' = anyone, records a stock count.
const COLUMNS = [
  { field: 'sku', label: 'SKU', type: 'text', edit: 'owner', max: 40 },
  { field: 'name', label: 'Item', type: 'text', edit: 'owner', max: 120 },
  { field: 'unit', label: 'Unit', type: 'text', edit: 'owner', max: 12 },
  { field: 'tags', label: 'Tags', type: 'tags', edit: 'owner' },
  { field: 'price', label: 'Price', type: 'money', edit: 'owner' },
  { field: 'commission', label: 'Comm./unit', type: 'money', edit: 'owner' },
  // Optional set (e.g. a pair of bulbs): pieces per set and the set's price. Blank = not sold as a set.
  { field: 'set_size', label: 'Set of', type: 'qty', edit: 'owner', optional: true },
  { field: 'set_price', label: 'Set price', type: 'money', edit: 'owner', optional: true },
  { field: 'avg_cost', label: 'Avg cost', type: 'money', ownerOnly: true },
  // One column per container; typing in any of them records a count there.
  { field: 'stock', label: 'Overall', type: 'qty', edit: 'count', container: 'overall' },
  { field: 'carwash', label: 'Carwash', type: 'qty', edit: 'count', container: 'carwash', optional: true },
  { field: 'detailing', label: 'Detailing', type: 'qty', edit: 'count', container: 'detailing', optional: true },
  { field: 'tint_ppf', label: 'Tint & PPF', type: 'qty', edit: 'count', container: 'tint_ppf', optional: true },
  { field: 'total_stock', label: 'Total', type: 'qty' },
  { field: 'reorder_level', label: 'Reorder at', type: 'qty', edit: 'owner' },
  { field: 'value', label: 'Value', type: 'money', ownerOnly: true },
];
const columns = () => COLUMNS.filter(c => !c.ownerOnly || isOwner());
// Auto parts stay in Overall, so a department's cell is not theirs to count.
const editable = (col, item) => (col.edit === 'count' && !(item.for_sale && col.container !== 'overall')) || (col.edit === 'owner' && isOwner());

const PAID_FROM = [['cash', 'Drawer cash'], ['gcash', 'GCash'], ['fund', 'Cash fund (abono)'], ['none', 'Already paid / opening stock']];
const COUNT_REASONS = [['used', 'Used'], ['damaged', 'Damaged'], ['lost', 'Lost'], ['recount', 'Recount (correct the number)']];
const MOVE_LABEL = { receive: 'Received', sale: 'Sold', return: 'Returned', adjust: 'Adjusted', use: 'Used', transfer: 'Moved' };
// Same list as the server (lib/inventory.js).
const CONTAINERS = [['overall', 'Overall'], ['carwash', 'Carwash'], ['detailing', 'Detailing'], ['tint_ppf', 'Tint & PPF']];
// Same list and order as the server (routes/inventory.js); new tags get the first colour no other tag has.
const TAG_COLORS = ['red', 'blue', 'amber', 'green', 'violet', 'orange', 'teal', 'pink', 'lime', 'indigo', 'coral', 'mint', 'grape', 'sky', 'brown', 'rose', 'olive', 'slate'];

const qty = n => String(Math.round(Number(n || 0) * 100) / 100);
const round2 = n => Math.round((Number(n) || 0) * 100) / 100;
const containerName = key => CONTAINERS.find(c => c[0] === key)[1];
const stockIn = (item, key) => (key === 'overall' ? Number(item.stock) : Number(item.departments[key] || 0));
// What the item is worth: everything the shop holds of it, or what is in the container being viewed.
const valueOf = (item, stock = item.total_stock) => Math.round(Number(stock) * Number(item.avg_cost || 0) * 100) / 100;
const shownStock = item => (filter.container ? stockIn(item, filter.container) : item.total_stock);
const heldIn = item => CONTAINERS.filter(([key]) => stockIn(item, key) > 0);
const inDepartment = item => Object.keys(item.departments).length > 0;
const tagOf = tagId => tags.find(t => t.id === tagId);
const tagChip = tag => tag ? `<span class="tag-chip c-${esc(tag.color)}">${esc(tag.name)}</span>` : '';
const tagChips = item => item.tags.map(t => tagChip(tagOf(t))).join('');
const hasSet = item => Number(item.set_size) > 1 && Number(item.set_price) > 0;
const rawValue = (item, field) => (field === 'value' ? valueOf(item, shownStock(item))
  : CONTAINERS.some(c => c[0] === field) ? stockIn(item, field) : item[field]);
const emptyText = () => (filter.container && items.length && !filter.search && !filter.tag ? `Nothing in ${containerName(filter.container)} yet.`
  : items.length ? 'Nothing matches.' : `No items yet.${isOwner() ? ' Add one with “+ New item”, or paste your list from Excel.' : ''}`);

function mount(el) {
  root = el;
  Object.assign(filter, { tag: '', search: '', container: '' });
  const owner = isOwner();
  root.innerHTML = `
    <div class="view-header">
      <div><h1>Inventory</h1><div class="desc">Everything the shop stocks. Tap an item to count${owner ? ', receive, send to a department or edit' : ''} it${owner ? ', or use <b>Sheet</b> to edit right in the cells' : ''}.
        Tag an item <b>Auto Parts</b> to sell it.</div></div>
      <div class="header-actions">
        <div class="segmented compact" role="group" aria-label="View">
          <button type="button" data-mode="list">List</button><button type="button" data-mode="sheet">Sheet</button></div>
        <button class="btn ghost" type="button" data-export>Export CSV</button>
        ${owner ? `<button class="btn ghost" type="button" data-paste>Paste from Excel</button>
          <button class="btn ghost" type="button" data-manage-tags>Tags</button>
          <button class="btn" type="button" data-new-item>+ New item</button>` : ''}
      </div>
    </div>
    <div data-low></div>
    <div class="list-toolbar">
      <input type="text" enterkeyhint="search" data-search placeholder="Search item or SKU" aria-label="Search item or SKU">
      <div class="chip-row" data-container-filters role="group" aria-label="Container"></div>
      <div class="chip-row" data-tag-filters></div>
    </div>
    <div class="card list-card" data-list-card>
      <div class="list-head" aria-hidden="true"><span>Item</span><span>Price</span><span>Stock</span></div>
      <div class="simple-list" data-list></div>
      <div class="list-foot" data-foot></div>
    </div>
    <div class="table-wrap sheet-wrap" hidden><table class="sheet-table" data-sheet></table></div>`;
  $$('[data-mode]', root).forEach(b => b.addEventListener('click', () => {
    mode = b.dataset.mode;
    try { localStorage.setItem(MODE_KEY, mode); } catch { /* private window: not remembered */ }
    render();
  }));
  installSheetKeys($('[data-sheet]', root));
  $('[data-search]', root).addEventListener('input', e => { filter.search = e.target.value.trim().toLowerCase(); render(); });
  $('[data-export]', root).addEventListener('click', exportCsv);
  $('[data-paste]', root)?.addEventListener('click', pasteModal);
  $('[data-manage-tags]', root)?.addEventListener('click', tagsModal);
  $('[data-new-item]', root)?.addEventListener('click', () => itemModal(null));
  $('[data-list]', root).addEventListener('click', e => {
    const row = e.target.closest('[data-item]');
    if (row) itemPanel(items.find(i => i.id === Number(row.dataset.item)));
  });
}

async function show() {
  await reload();
}

async function reload({ catalog = false } = {}) {
  [items, tags] = await Promise.all([api('GET', '/inventory'), api('GET', '/tags')]);
  render();
  // Job editors and the Parts tab read the parts list from the shared catalog.
  if (catalog) await loadCatalog(true);
}

// Sorted by name (the API's order), filtered by the container, the tag chip and the search box.
function visibleItems() {
  const tagId = Number(filter.tag) || null;
  return items.filter(i => (!filter.container || stockIn(i, filter.container) > 0) && (!tagId || i.tags.includes(tagId))
    && (!filter.search || i.name.toLowerCase().includes(filter.search) || (i.sku || '').toLowerCase().includes(filter.search)));
}

// The sheet's rows: the same items, in the order of the column sorted on.
function sortedItems() {
  const col = COLUMNS.find(c => c.field === sort.field);
  const key = item => (col.type === 'tags' ? item.tags.map(t => tagOf(t)?.name || '').join(', ').toLowerCase()
    : col.type === 'text' ? String(item[col.field] || '').toLowerCase() : Number(rawValue(item, col.field)) || 0);
  return visibleItems().sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0) * sort.dir);
}

function render() {
  editing = null;
  const low = items.filter(i => i.low);
  $('[data-low]', root).innerHTML = low.length
    ? `<div class="banner"><span>Low stock: ${low.map(i => `<b>${esc(i.name)}</b> (${qty(i.total_stock)} ${esc(i.unit)})`).join(', ')}. Time to reorder.</span></div>` : '';
  $('[data-container-filters]', root).innerHTML = [['', 'All stock'], ...CONTAINERS].map(([key, label]) => `<button type="button"
      class="filter-chip ${filter.container === key ? 'active' : ''}" data-container="${key}" aria-pressed="${filter.container === key}">${label}
      <span>${key ? items.filter(i => stockIn(i, key) > 0).length : items.length}</span></button>`).join('');
  $$('[data-container]', root).forEach(b => b.addEventListener('click', () => { filter.container = b.dataset.container; render(); }));
  $('[data-tag-filters]', root).innerHTML = [`<button type="button" class="filter-chip ${filter.tag ? '' : 'active'}" data-tag-filter="">All <span>${items.length}</span></button>`,
    ...tags.map(t => `<button type="button" class="filter-chip ${Number(filter.tag) === t.id ? 'active' : ''}" data-tag-filter="${t.id}">
      <i class="dot c-${esc(t.color)}"></i>${esc(t.name)} <span>${items.filter(i => i.tags.includes(t.id)).length}</span></button>`)].join('');
  $$('[data-tag-filter]', root).forEach(b => b.addEventListener('click', () => { filter.tag = b.dataset.tagFilter; render(); }));
  $$('[data-mode]', root).forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
  $('[data-list-card]', root).hidden = mode !== 'list';
  $('.sheet-wrap', root).hidden = mode !== 'sheet';
  if (mode === 'sheet') renderSheet(); else renderList();
}

function renderList() {
  const owner = isOwner();
  const list = visibleItems();
  $('[data-list]', root).innerHTML = list.length ? list.map(item => `<button type="button" class="list-row" data-item="${item.id}">
      <span class="list-main"><span class="list-name">${esc(item.name)}</span>
        <span class="list-sub">${tagChips(item)}${hasSet(item) ? `<span class="muted small">set of ${qty(item.set_size)} · ${peso(item.set_price)}</span>` : ''}
          ${!filter.container && inDepartment(item) ? `<span class="muted small" data-spread>${heldIn(item).map(([key, label]) => `${label} ${qty(stockIn(item, key))}`).join(' · ')}</span>` : ''}</span></span>
      <span class="list-price" data-price>${item.for_sale ? peso(item.price) : ''}</span>
      <span class="list-stock"><span data-stock>${qty(shownStock(item))} ${esc(item.unit)}</span>${item.low ? ' <span class="status-pill waiting">Low</span>' : ''}</span>
    </button>`).join('')
    : `<div class="empty-state small">${emptyText()}</div>`;
  $('[data-foot]', root).innerHTML = `<span>${list.length} item${list.length === 1 ? '' : 's'}</span>
    ${owner ? valueFoot(list) : ''}`;
}

const valueFoot = list => `<span>${filter.container ? `${containerName(filter.container)} stock value` : 'Stock value'}
  <b class="money" data-total-value>${peso(list.reduce((s, i) => s + valueOf(i, shownStock(i)), 0))}</b></span>`;

// ---------------------------------------------------------------- sheet

function cellHtml(item, col) {
  const v = rawValue(item, col.field);
  if (col.type === 'tags') return tagChips(item) || '<span class="muted">—</span>';
  if (v == null || ((col.field === 'price' || col.field === 'commission' || col.optional) && !Number(v))) return '<span class="muted">—</span>';
  if (col.type === 'money') return peso(v);
  if (col.type === 'qty') return col.field === 'total_stock' && item.low ? `${qty(v)} <span class="status-pill waiting">Low</span>` : qty(v);
  return v ? esc(v) : '<span class="muted">—</span>';
}

function renderSheet() {
  const cols = columns();
  const list = sortedItems();
  const owner = isOwner();
  const arrow = f => (sort.field === f ? (sort.dir > 0 ? ' ▲' : ' ▼') : '');
  $('[data-sheet]', root).innerHTML = `
    <thead><tr>${cols.map(c => `<th class="${c.type === 'money' || c.type === 'qty' ? 'num' : ''}" data-sort="${c.field}"
      aria-sort="${sort.field === c.field ? (sort.dir > 0 ? 'ascending' : 'descending') : 'none'}"><button type="button">${c.label}${arrow(c.field)}</button></th>`).join('')}
      <th><span class="sr-only">Actions</span></th></tr></thead>
    <tbody>${list.length ? list.map(item => `<tr data-item="${item.id}">${cols.map(c => `<td data-field="${c.field}" tabindex="-1"
        class="${c.type === 'money' || c.type === 'qty' ? 'num' : ''} ${editable(c, item) ? 'editable' : ''} ${c.field === 'sku' ? 'mono' : ''}">${cellHtml(item, c)}</td>`).join('')}
      <td class="row-actions"><div class="actions">${rowButtons(item)}</div></td></tr>`).join('')
    : `<tr><td colspan="${cols.length + 1}"><div class="empty-state small">${emptyText()}</div></td></tr>`}</tbody>
    <tfoot><tr><td colspan="${cols.length + 1}"><div class="sheet-foot"><span>${list.length} item${list.length === 1 ? '' : 's'}</span>
      ${owner ? valueFoot(list) : ''}</div></td></tr></tfoot>`;
  const first = $('[data-sheet] tbody td[data-field]', root);
  if (first) first.tabIndex = 0;
  $$('[data-sheet] th[data-sort] button', root).forEach(b => b.addEventListener('click', () => {
    const field = b.closest('th').dataset.sort;
    sort.dir = sort.field === field ? -sort.dir : 1;
    sort.field = field;
    renderSheet();
  }));
  $$('[data-sheet] [data-act]', root).forEach(b => b.addEventListener('click', () => {
    const item = items.find(i => i.id === Number(b.closest('tr').dataset.item));
    ITEM_ACTIONS[b.dataset.act](item);
  }));
}

function rowButtons(item) {
  return isOwner() ? `<button class="btn small" type="button" data-act="receive">Receive</button>
      ${item.for_sale ? '' : '<button class="btn ghost small" type="button" data-act="move">Send</button>'}
      <button class="btn ghost small" type="button" data-act="count">Count</button>
      <button class="btn ghost small" type="button" data-act="history">History</button>
      <button class="btn ghost small" type="button" data-act="edit">Edit</button>`
    : `<button class="btn ghost small" type="button" data-act="count" aria-label="Count ${esc(item.name)}">Count</button>`;
}

// Sheet keyboard, like Excel: arrow keys move; Enter / F2 / double-click edits; typing replaces the cell; in a
// cell being edited, Enter saves and moves down, Tab saves and moves right (Shift: back), Escape cancels.

function cellAt(itemId, field) {
  return $(`[data-sheet] tr[data-item="${itemId}"] td[data-field="${field}"]`, root);
}

function focusCell(td) {
  if (!td) return;
  $$('[data-sheet] td[tabindex="0"]', root).forEach(c => { c.tabIndex = -1; });
  td.tabIndex = 0;
  td.focus();
}

function position(td) {
  const rows = $$('[data-sheet] tbody tr[data-item]', root);
  const fields = columns().map(c => c.field);
  return { rows, fields, row: rows.indexOf(td.closest('tr')), col: fields.indexOf(td.dataset.field) };
}

// The cell `dr` rows down and `dc` columns right of td, as { itemId, field } (it survives a re-render).
function neighbour(td, dr, dc) {
  const { rows, fields, row, col } = position(td);
  const r = Math.max(0, Math.min(rows.length - 1, row + dr));
  const c = Math.max(0, Math.min(fields.length - 1, col + dc));
  return { itemId: Number(rows[r].dataset.item), field: fields[c] };
}
const focusAt = target => target && focusCell(cellAt(target.itemId, target.field));

function installSheetKeys(table) {
  table.addEventListener('focusin', e => {
    const td = e.target.closest?.('td[data-field]');
    if (td && !editing) focusCell(td);
  });
  table.addEventListener('dblclick', e => {
    const td = e.target.closest('td[data-field]');
    if (td && !editing) startEdit(td);
  });
  table.addEventListener('keydown', e => {
    // Only keys pressed on a cell itself (not ones bubbling up from a cell being edited).
    if (editing || e.defaultPrevented || !e.target.matches?.('td[data-field]')) return;
    const td = e.target;
    const moves = { ArrowDown: [1, 0], ArrowUp: [-1, 0], ArrowRight: [0, 1], ArrowLeft: [0, -1] };
    if (moves[e.key]) {
      e.preventDefault();
      focusAt(neighbour(td, ...moves[e.key]));
    } else if (e.key === 'Enter' || e.key === 'F2') {
      e.preventDefault();
      startEdit(td);
    } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      startEdit(td, e.key);
    }
  });
}

function startEdit(td, typed = null) {
  const col = COLUMNS.find(c => c.field === td.dataset.field);
  const item = items.find(i => i.id === Number(td.closest('tr').dataset.item));
  if (!col || !item || !editable(col, item)) return;
  if (col.type === 'tags') return typed == null ? tagsPicker(item) : undefined;
  const input = document.createElement('input');
  input.type = 'text';
  input.inputMode = col.type === 'text' ? 'text' : 'decimal';
  input.className = 'cell-input';
  input.setAttribute('aria-label', col.label);
  input.value = typed ?? String(rawValue(item, col.field) ?? '');
  td.replaceChildren(input);
  editing = { td, input, item, col };
  input.focus();
  if (typed == null) input.select();
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); commit(neighbour(td, e.shiftKey ? -1 : 1, 0)); }
    else if (e.key === 'Tab') { e.preventDefault(); commit(neighbour(td, 0, e.shiftKey ? -1 : 1)); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancelEdit(); }
  });
  input.addEventListener('blur', () => { if (editing?.input === input) commit(null); });
}

function cancelEdit() {
  const { item, td } = editing;
  editing = null;
  const target = { itemId: item.id, field: td.dataset.field };
  renderSheet();
  focusAt(target);
}

async function commit(target) {
  const { item, col, input, td } = editing;
  editing = null;
  const here = { itemId: item.id, field: col.field };
  const raw = input.value.trim();
  const done = () => { renderSheet(); focusAt(target || here); };

  if (col.edit === 'count') {
    done();
    if (raw !== '' && Number(raw) !== stockIn(item, col.container)) countModal(item, raw, col.container);
    return;
  }
  let value = raw;
  if (col.type !== 'text' && raw === '' && col.optional) value = null;
  else if (col.type !== 'text') {
    value = Number(raw.replace(/₱|,/g, '') || 0);
    if (!Number.isFinite(value) || value < 0) { toast(`${col.label} must be a number of 0 or more`, 'error'); return done(); }
  }
  if (col.field === 'name' && !value) { toast('Name is required', 'error'); return done(); }
  if (String(value ?? '') === String(item[col.field] ?? '')) return done();
  td.classList.add('saving');
  try {
    const saved = await api('PATCH', `/inventory/${item.id}`, { [col.field]: value });
    items = items.map(i => (i.id === saved.id ? saved : i));
    toast('Saved');
    loadCatalog(true).catch(() => {});
  } catch { /* the API error is already shown */ }
  done();
}

function tagsPicker(item) {
  openModal(`${modalHeader(`Tags for ${item.name}`, 'Auto Parts puts it on the Parts tab and job orders (it needs a selling price).')}
    <div class="tag-pick-list">${tags.map(t => `<label class="tag-pick" data-tag-pick><input type="checkbox" value="${t.id}" ${item.tags.includes(t.id) ? 'checked' : ''}> ${tagChip(t)}</label>`).join('')}</div>
    <div class="modal-actions"><button class="btn ghost" type="button" data-close>Cancel</button><button class="btn" type="button" data-confirm>Save tags</button></div>`,
  card => $('[data-confirm]', card).addEventListener('click', e => busy(e.currentTarget, async () => {
    const chosen = $$('[data-tag-pick] input:checked', card).map(i => Number(i.value));
    await api('PATCH', `/inventory/${item.id}`, { tags: chosen });
    closeModal();
    toast('Saved');
    await reload({ catalog: true });
  })));
}

// ---------------------------------------------------------------- modals

const ITEM_ACTIONS = { receive: receiveModal, move: moveModal, count: countModal, history: historyModal, edit: itemModal };

// An item's details with what can be done with it (staff: count only).
function itemPanel(item) {
  const owner = isOwner();
  const row = (label, value) => `<div class="panel-row"><span>${label}</span><b>${value}</b></div>`;
  openModal(`${modalHeader(item.name)}
    <div class="panel" data-panel>
      ${item.sku ? row('SKU', `<span class="mono">${esc(item.sku)}</span>`) : ''}
      ${row('Stock', `${qty(item.total_stock)} ${esc(item.unit)}${item.low ? ' <span class="status-pill waiting">Low</span>' : ''}`)}
      ${inDepartment(item) ? heldIn(item).map(([key, label]) => row(label, `${qty(stockIn(item, key))} ${esc(item.unit)}`)).join('') : ''}
      ${row('Reorder at', qty(item.reorder_level))}
      ${item.for_sale ? row('Price', `${peso(item.price)} per ${esc(item.unit)}`) : ''}
      ${hasSet(item) ? row('Set', `set of ${qty(item.set_size)} · ${peso(item.set_price)}`) : ''}
      ${Number(item.commission) ? row('Commission', `${peso(item.commission)} per ${esc(item.unit)}`) : ''}
      ${owner ? row('Avg cost', peso(item.avg_cost)) + row('Value', peso(valueOf(item))) : ''}
      ${item.tags.length ? row('Tags', `<span class="panel-tags">${tagChips(item)}</span>`) : ''}
    </div>
    <div class="panel-actions">
      ${owner ? '<button class="btn" type="button" data-act="receive">Receive</button>' : ''}
      ${owner && !item.for_sale ? '<button class="btn ghost" type="button" data-act="move">Send</button>' : ''}
      <button class="btn ${owner ? 'ghost' : ''}" type="button" data-act="count">Count</button>
      ${owner ? `<button class="btn ghost" type="button" data-act="history">History</button>
        <button class="btn ghost" type="button" data-act="edit">Edit</button>` : ''}
    </div>`,
  card => $$('[data-act]', card).forEach(b => b.addEventListener('click', () => ITEM_ACTIONS[b.dataset.act](item))));
}


function itemModal(item) {
  const v = k => esc(item?.[k] ?? '');
  openModal(`${modalHeader(item ? `Edit ${item.name}` : 'New item', item ? 'Price changes apply to new sales; past sales keep their price.' : 'Add stock afterwards with “Receive”.')}
    <div class="form-grid modal-form-grid">
      <div><label>SKU / code</label><input type="text" data-p="sku" maxlength="40" value="${v('sku')}"></div>
      <div class="span-2"><label>Name</label><input type="text" data-p="name" maxlength="120" value="${v('name')}"></div>
      <div><label>Unit</label><input type="text" data-p="unit" maxlength="12" value="${esc(item?.unit || 'pc')}" placeholder="pc, gal, set"></div>
      <div><label>Selling price</label><input type="number" min="0" step="0.01" data-p="price" value="${item?.price || ''}" placeholder="Only for Auto Parts"></div>
      <div><label>Commission / unit</label><input type="number" min="0" step="0.01" data-p="commission" value="${item?.commission ?? 0}"></div>
      <div><label>Reorder when stock ≤</label><input type="number" min="0" step="1" data-p="reorder_level" value="${item?.reorder_level ?? 0}"></div>
      <div><label>Set of (pieces)</label><input type="number" min="0" step="1" data-p="set_size" value="${item?.set_size ?? ''}" placeholder="e.g. 2 for a pair"></div>
      <div><label>Set price</label><input type="number" min="0" step="0.01" data-p="set_price" value="${item?.set_price ?? ''}" placeholder="Blank: no set"></div>
      <div><label>Commission / set</label><input type="number" min="0" step="0.01" data-p="set_commission" value="${item?.set_commission ?? 0}"></div>
    </div>
    <div class="inv-label">Tags</div>
    <div class="tag-pick-list">${tags.map(t => `<label class="tag-pick" data-tag-pick><input type="checkbox" value="${t.id}" ${item?.tags.includes(t.id) ? 'checked' : ''}> ${tagChip(t)}</label>`).join('')}</div>
    <div class="modal-actions">${item ? '<button class="btn danger" type="button" data-archive>Archive item</button>' : ''}
      <button class="btn ghost" type="button" data-close>Cancel</button><button class="btn" type="button" data-confirm>${item ? 'Save' : 'Add item'}</button></div>`,
  card => {
    $('[data-p="name"]', card).focus();
    $('[data-confirm]', card).addEventListener('click', e => busy(e.currentTarget, async () => {
      const get = k => $(`[data-p="${k}"]`, card).value.trim();
      if (!get('name')) return toast('Name is required', 'error');
      const body = { sku: get('sku'), name: get('name'), unit: get('unit'), price: Number(get('price') || 0),
        commission: Number(get('commission') || 0), reorder_level: Number(get('reorder_level') || 0),
        set_size: get('set_size') === '' ? null : Number(get('set_size')), set_price: get('set_price') === '' ? null : Number(get('set_price')),
        set_commission: Number(get('set_commission') || 0),
        tags: $$('[data-tag-pick] input:checked', card).map(i => Number(i.value)) };
      if (item) await api('PATCH', `/inventory/${item.id}`, body);
      else await api('POST', '/inventory', body);
      closeModal();
      toast(item ? 'Item saved' : 'Item added');
      await reload({ catalog: true });
    }));
    $('[data-archive]', card)?.addEventListener('click', e => busy(e.currentTarget, async () => {
      if (!window.confirm(`Archive ${item.name}? It disappears from the lists; its history is kept.`)) return;
      await api('PATCH', `/inventory/${item.id}`, { active: false });
      closeModal();
      toast('Item archived');
      await reload({ catalog: true });
    }));
  });
}

function receiveModal(item) {
  openModal(`${modalHeader(`Receive ${item.name}`, `In stock: ${qty(item.total_stock)} ${item.unit} at an average cost of ${peso(item.avg_cost)}. It goes into Overall.`)}
    <div class="form-grid modal-form-grid">
      <div><label>Date</label><input type="date" data-r="date" value="${todayLocal()}"></div>
      <div><label>Quantity (${esc(item.unit)})</label><input type="number" min="0.01" step="any" data-r="quantity"></div>
      <div><label>Cost per ${esc(item.unit)}</label><input type="number" min="0" step="0.01" data-r="unit_cost" value="${item.avg_cost || ''}"></div>
      <div><label>Supplier</label><input type="text" data-r="supplier" maxlength="120"></div>
      <div class="span-2"><label>Paid with</label><select data-r="paid_from">${PAID_FROM.map(([k, label]) => `<option value="${k}">${label}</option>`).join('')}</select></div>
    </div>
    <p class="hint" data-r-hint></p>
    <div class="modal-actions"><button class="btn ghost" type="button" data-close>Cancel</button><button class="btn" type="button" data-confirm>Receive stock</button></div>`,
  card => {
    const get = k => $(`[data-r="${k}"]`, card).value;
    const hint = () => {
      const total = Math.round(Number(get('quantity') || 0) * Number(get('unit_cost') || 0) * 100) / 100;
      const paid = get('paid_from');
      $('[data-r-hint]', card).textContent = paid === 'none'
        ? 'No money is recorded: use this for stock already on the shelf or paid for elsewhere.'
        : `${peso(total)} is recorded as paid from ${PAID_FROM.find(p => p[0] === paid)[1].toLowerCase()} on that day's EOD. `
          + (item.for_sale ? 'It is an auto part, so its cost counts in Finance when each one is sold.' : 'Finance counts it as a cost of that day.');
    };
    $$('[data-r]', card).forEach(el => el.addEventListener('input', hint));
    hint();
    $('[data-confirm]', card).addEventListener('click', e => busy(e.currentTarget, async () => {
      await api('POST', `/inventory/${item.id}/receive`, {
        date: get('date'), quantity: Number(get('quantity') || 0), unit_cost: Number(get('unit_cost') || 0),
        supplier: get('supplier').trim(), paid_from: get('paid_from'),
      });
      closeModal();
      toast('Stock received');
      await reload({ catalog: true });
    }));
  });
}

// Stock moved between containers: nothing bought or sold, so no money is recorded. Starts from the container in view.
function moveModal(item) {
  const held = heldIn(item).map(([key]) => key);
  const start = held.includes(filter.container) ? filter.container : held[0] || 'overall';
  const options = picked => CONTAINERS.map(([key, label]) => `<option value="${key}" ${key === picked ? 'selected' : ''}>${label} (${qty(stockIn(item, key))} ${esc(item.unit)})</option>`).join('');
  openModal(`${modalHeader(`Send ${item.name}`, 'Move stock between Overall and the departments.')}
    <div class="form-grid modal-form-grid">
      <div><label>From</label><select data-m="from">${options(start)}</select></div>
      <div><label>To</label><select data-m="to">${options(start === 'overall' ? 'carwash' : 'overall')}</select></div>
      <div><label>Quantity (${esc(item.unit)})</label><input type="number" min="0.01" step="any" data-m="quantity"></div>
      <div><label>Date</label><input type="date" data-m="date" value="${todayLocal()}"></div>
      <div class="span-2"><label>Note (optional)</label><input type="text" data-m="note" maxlength="160"></div>
    </div>
    <p class="hint" data-m-hint></p>
    <div class="modal-actions"><button class="btn ghost" type="button" data-close>Cancel</button><button class="btn" type="button" data-confirm>Send stock</button></div>`,
  card => {
    const get = k => $(`[data-m="${k}"]`, card).value;
    const hint = () => {
      const [from, to, quantity] = [get('from'), get('to'), round2(get('quantity'))];
      const change = (key, by) => `${containerName(key)} ${qty(stockIn(item, key))} → ${qty(stockIn(item, key) + by)}`;
      $('[data-m-hint]', card).textContent = from === to ? 'Choose two different places.'
        : quantity > stockIn(item, from) ? `Only ${qty(stockIn(item, from))} ${item.unit} in ${containerName(from)}.`
          : `${quantity > 0 ? `${change(from, -quantity)} · ${change(to, quantity)}. ` : ''}No money is recorded: the total stock and Finance stay the same.`;
      $('[data-confirm]', card).disabled = from === to || !(quantity > 0) || quantity > stockIn(item, from);
    };
    $$('[data-m]', card).forEach(el => el.addEventListener('input', hint));
    hint();
    $('[data-m="quantity"]', card).focus();
    $('[data-confirm]', card).addEventListener('click', e => busy(e.currentTarget, async () => {
      await api('POST', `/inventory/${item.id}/move`, { date: get('date'), from: get('from'), to: get('to'), quantity: Number(get('quantity') || 0), note: get('note').trim() });
      closeModal();
      toast('Stock moved');
      await reload();
    }));
  });
}

// A count in one container: the one given (a sheet cell), the one in view, or the first that holds any, so stock that
// is all in a department is not counted again in an empty Overall. Auto parts are only in Overall.
function countModal(item, counted = '', container = filter.container || heldIn(item)[0]?.[0] || 'overall') {
  const start = item.for_sale ? 'overall' : container;
  openModal(`${modalHeader(`Count ${item.name}`, item.for_sale ? `On record: ${qty(item.stock)} ${item.unit}. Enter what is on the shelf now.` : 'Enter what is on the shelf now, in the place you counted.')}
    <div class="form-grid modal-form-grid">
      ${item.for_sale ? '' : `<div class="span-2"><label>Where</label><select data-c="container">${CONTAINERS.map(([key, label]) => `<option value="${key}" ${key === start ? 'selected' : ''}>${label} (${qty(stockIn(item, key))} ${esc(item.unit)} on record)</option>`).join('')}</select></div>`}
      <div><label>Date</label><input type="date" data-c="date" value="${todayLocal()}"></div>
      <div><label>On the shelf (${esc(item.unit)})</label><input type="number" min="0" step="any" data-c="counted" value="${esc(counted)}"></div>
      <div class="span-2"><label>The difference is</label><select data-c="reason">${COUNT_REASONS.map(([k, label]) => `<option value="${k}">${label}</option>`).join('')}</select></div>
      <div class="span-2"><label>Note (optional)</label><input type="text" data-c="note" maxlength="160"></div>
    </div>
    <p class="hint" data-c-summary></p>
    <div class="modal-actions"><button class="btn ghost" type="button" data-close>Cancel</button><button class="btn" type="button" data-confirm>Save count</button></div>`,
  card => {
    const get = k => $(`[data-c="${k}"]`, card).value;
    const reason = $('[data-c="reason"]', card);
    const where = () => $('[data-c="container"]', card)?.value || 'overall';
    const summary = () => {
      const diff = Math.round((Number(get('counted')) - stockIn(item, where())) * 100) / 100;
      const amount = `${qty(Math.abs(diff))} ${item.unit}`;
      const refused = diff > 0 && !isOwner();
      $('[data-confirm]', card).disabled = refused;
      $('[data-c-summary]', card).textContent = get('counted') === '' || !Number.isFinite(diff) ? ''
        : diff === 0 ? 'That matches the record; nothing to save.'
          : refused ? `${amount} more than on record. Only the owner can raise a count, so ask them to correct it.`
          : diff > 0 ? `${amount} more than on record (a recount).`
            : `${amount} ${reason.value === 'recount' ? 'less than on record (a recount)' : reason.value}.`;
    };
    // More than on record can only be a recount. The reason it replaced comes back once that no longer holds.
    let replaced = null;
    const suggest = () => {
      const over = Number(get('counted')) > stockIn(item, where());
      if (over && reason.value !== 'recount') { replaced = reason.value; reason.value = 'recount'; }
      else if (!over && replaced) { reason.value = replaced; replaced = null; }
      summary();
    };
    $('[data-c="counted"]', card).addEventListener('input', suggest);
    $('[data-c="container"]', card)?.addEventListener('change', suggest);
    reason.addEventListener('change', () => { replaced = null; summary(); });
    suggest();
    $('[data-c="counted"]', card).focus();
    $('[data-confirm]', card).addEventListener('click', e => busy(e.currentTarget, async () => {
      await api('POST', `/inventory/${item.id}/count`, { date: get('date'), container: where(), counted: get('counted') === '' ? '' : Number(get('counted')), reason: reason.value, note: get('note').trim() });
      closeModal();
      toast('Count saved');
      await reload({ catalog: true });
    }));
  });
}

async function historyModal(item) {
  const moves = await api('GET', `/inventory/${item.id}/movements`);
  const last = moves.at(-1);
  const paid = m => (m.paid_from ? ` · paid ${peso(m.paid_amount)} from ${PAID_FROM.find(p => p[0] === m.paid_from)[1].toLowerCase()}` : '');
  const place = m => containerName(m.department || 'overall');
  // A move is two lines, out of one container and into another: shown once, on the line it went into.
  const entries = moves.filter(m => m.kind !== 'transfer' || m.quantity > 0);
  const amount = m => (m.kind === 'transfer'
    ? `<b>${qty(m.quantity)} ${esc(item.unit)}</b> · ${esc(place(moves[moves.indexOf(m) - 1]))} → ${esc(place(m))}`
    : `<b>${m.quantity > 0 ? '+' : ''}${qty(m.quantity)} ${esc(item.unit)}</b>${m.department ? ` · ${esc(place(m))}` : ''}`);
  openModal(`${modalHeader(`${item.name} stock history`, `${entries.length} change${entries.length === 1 ? '' : 's'}`)}
    <div class="history-list">${entries.slice().reverse().map(m => `<div class="history-entry">
      <div class="history-meta"><span>${esc(m.moved_on)}</span><span>${esc(m.created_by || '')}</span></div>
      <div><span class="kind-pill ${m.kind === 'transfer' ? 'addon' : m.quantity > 0 ? 'service' : 'custom'}">${MOVE_LABEL[m.kind]}</span>
        ${amount(m)}${m.unit_cost != null ? ` @ ${peso(m.unit_cost)}` : ''}${paid(m)}
        ${m.jo_number ? ` · ${esc(m.jo_number)}` : ''}${m.supplier ? ` · ${esc(m.supplier)}` : ''}${m.note ? ` · ${esc(m.note)}` : ''}
        ${m.kind === 'receive' ? `<button class="btn ghost small" type="button" data-correct-cost="${m.id}">Correct cost</button>` : ''}
        ${m === last && m.kind === 'receive' ? `<button class="btn ghost small" type="button" data-undo="${m.id}">Undo</button>` : ''}</div>
    </div>`).join('') || '<div class="empty-state small">No stock changes yet.</div>'}</div>
    <div class="modal-actions"><button class="btn ghost" type="button" data-close>Close</button></div>`,
  card => {
    $$('[data-correct-cost]', card).forEach(b => b.addEventListener('click', () =>
      correctCostModal(item, moves, moves.find(m => m.id === Number(b.dataset.correctCost)))));
    $('[data-undo]', card)?.addEventListener('click', e => busy(e.currentTarget, async () => {
      if (!window.confirm('Undo this delivery? Its stock comes off again and what it recorded as paid is removed.')) return;
      await api('POST', `/inventory/movements/${e.currentTarget.dataset.undo}/undo`);
      closeModal();
      toast('Delivery undone');
      await reload({ catalog: true });
    }));
  });
}

// Mirrors replayAvgCost in lib/calc.js: the average cost replayed from a delivery on, to preview a correction.
function replayAvgCost(stock, avg, moves) {
  for (const m of moves) {
    const q = Number(m.quantity);
    if (m.kind === 'receive') avg = stock + q > 0 ? round2((stock * avg + q * Number(m.unit_cost)) / (stock + q)) : round2(m.unit_cost);
    stock = round2(stock + q);
  }
  return avg;
}

// A delivery entered at the wrong price (e.g. opening stock at ₱0, or a different supplier's price): the owner
// types the right cost per unit; the average cost and what was paid follow. Sales already made keep their cost.
function correctCostModal(item, moves, move) {
  const index = moves.indexOf(move);
  const stockBefore = moves.slice(0, index).reduce((s, m) => round2(s + Number(m.quantity)), 0);
  const avgWith = cost => replayAvgCost(stockBefore, Number(move.prev_avg_cost) || 0, [{ ...move, unit_cost: cost }, ...moves.slice(index + 1)]);
  openModal(`${modalHeader(`Correct cost: ${item.name}`, `Delivery of ${qty(move.quantity)} ${item.unit} on ${move.moved_on}${move.supplier ? ` from ${move.supplier}` : ''}, entered at ${peso(move.unit_cost)} per ${item.unit}.`)}
    <div class="form-grid modal-form-grid">
      <div><label>Right cost per ${esc(item.unit)}</label><input type="number" min="0" step="0.01" data-cc="unit_cost" value="${Number(move.unit_cost) || ''}"></div>
    </div>
    <p class="hint" data-cc-hint></p>
    <div class="modal-actions"><button class="btn ghost" type="button" data-close>Cancel</button><button class="btn" type="button" data-confirm>Save cost</button></div>`,
  card => {
    const input = $('[data-cc="unit_cost"]', card);
    const hint = () => {
      const cost = Number(input.value || 0);
      $('[data-cc-hint]', card).textContent = `The average cost becomes ${peso(avgWith(cost))} (now ${peso(item.avg_cost)}).`
        + (move.paid_from ? ` What was paid becomes ${peso(round2(cost * Number(move.quantity)))} on that day's EOD.` : '')
        + ' Sales already made keep the cost they were sold at.';
    };
    input.addEventListener('input', hint);
    hint();
    input.focus();
    $('[data-confirm]', card).addEventListener('click', e => busy(e.currentTarget, async () => {
      await api('POST', `/inventory/movements/${move.id}/cost`, { unit_cost: Number(input.value || 0) });
      closeModal();
      toast('Cost corrected');
      await reload({ catalog: true });
    }));
  });
}

function tagsModal() {
  // Swatches: a colour another tag already uses is marked (still allowed), so it is easy to keep them unique.
  const swatches = t => TAG_COLORS.map(c => {
    const usedBy = tags.find(o => o.id !== t.id && o.color === c);
    return `<label class="swatch c-${c} ${usedBy ? 'used' : ''}" data-swatch="${c}" title="${c}${usedBy ? ` (used by ${esc(usedBy.name)})` : ''}">
      <input type="radio" name="tag-color-${t.id}" value="${c}" ${c === t.color ? 'checked' : ''} aria-label="${c}"><span></span></label>`;
  }).join('');
  const row = t => `<div class="tag-row" data-tag-row="${t.id}">
      <div class="tag-row-head"><span class="tag-chip c-${esc(t.color)}" data-t-preview>${esc(t.name)}</span>
        <input type="text" data-t="name" maxlength="40" value="${esc(t.name)}" aria-label="Tag name">
        <button class="btn ghost small" type="button" data-t-save>Save</button>
        ${t.system_key ? '<span class="muted small">built in</span>' : '<button class="icon-btn" type="button" data-t-delete title="Delete tag">✕</button>'}</div>
      <div class="swatches" role="radiogroup" aria-label="Colour for ${esc(t.name)}">${swatches(t)}</div></div>`;
  openModal(`${modalHeader('Tags', 'Group items any way you like. Each new tag gets its own colour; click a swatch to change it. Deleting a tag only removes the label from its items.')}
    <div class="tag-rows">${tags.map(row).join('')}</div>
    <div class="tag-row"><input type="text" data-new-tag maxlength="40" placeholder="New tag, e.g. Wax & sealants" aria-label="New tag">
      <button class="btn small" type="button" data-add-tag>+ Add tag</button></div>
    <div class="modal-actions"><button class="btn ghost" type="button" data-close>Done</button></div>`,
  card => {
    $$('[data-tag-row]', card).forEach(r => {
      const tagId = Number(r.dataset.tagRow);
      $('[data-t-save]', r).addEventListener('click', e => busy(e.currentTarget, async () => {
        const color = $('[data-swatch] input:checked', r)?.value;
        await api('PATCH', `/tags/${tagId}`, { name: $('[data-t="name"]', r).value.trim(), ...(color ? { color } : {}) });
        toast('Tag saved');
        await reload();
      }));
      // The preview chip follows the picked colour and the typed name.
      const preview = $('[data-t-preview]', r);
      $$('[data-swatch] input', r).forEach(i => i.addEventListener('change', () => { preview.className = `tag-chip c-${i.value}`; }));
      $('[data-t="name"]', r).addEventListener('input', e => { preview.textContent = e.target.value || ' '; });
      $('[data-t-delete]', r)?.addEventListener('click', e => busy(e.currentTarget, async () => {
        if (!window.confirm(`Delete the tag ${tagOf(tagId).name}? Its items stay; only the label goes.`)) return;
        await api('DELETE', `/tags/${tagId}`);
        await reload();
        tagsModal();
      }));
    });
    $('[data-add-tag]', card).addEventListener('click', e => busy(e.currentTarget, async () => {
      const name = $('[data-new-tag]', card).value.trim();
      if (!name) return toast('Name the tag', 'error');
      await api('POST', '/tags', { name });
      await reload();
      tagsModal();
    }));
  });
}

function pasteModal() {
  openModal(`${modalHeader('Paste from Excel or Sheets', 'Select your rows in Excel / Google Sheets (include the header row), copy, and paste here.')}
    <textarea data-paste-text rows="7" placeholder="SKU&#9;Item&#9;Unit&#9;Selling price&#9;Reorder at&#9;Tags&#9;Stock&#9;Cost"></textarea>
    <p class="hint">Columns it understands: SKU, Item (or Name), Unit, Selling price, Commission, Set of, Set price, Reorder at, Tags (separate with , or ;), Stock, Cost.
      Other columns are ignored. Stock goes into Overall as opening stock at its cost; no money is recorded.</p>
    <div data-paste-errors></div>
    <div class="table-wrap"><table class="simple-table" data-preview></table></div>
    <div class="modal-actions"><button class="btn ghost" type="button" data-close>Cancel</button><button class="btn" type="button" data-confirm disabled>Add items</button></div>`,
  card => {
    card.closest('dialog').classList.add('wide');
    $('#modal').addEventListener('close', () => $('#modal').classList.remove('wide'), { once: true });
    let parsed = { rows: [], errors: [] };
    const known = new Set(tags.map(t => t.name.toLowerCase()));
    $('[data-paste-text]', card).addEventListener('input', e => {
      parsed = importRows(parsePasted(e.target.value));
      const fresh = [...new Set(parsed.rows.flatMap(r => r.tags).filter(t => !known.has(t.toLowerCase())))];
      $('[data-paste-errors]', card).innerHTML = parsed.errors.length
        ? `<div class="banner">${parsed.errors.map(esc).join('<br>')}<br>Fix these in your sheet and paste again.</div>`
        : fresh.length ? `<p class="hint">New tags will be created: ${fresh.map(esc).join(', ')}</p>` : '';
      $('[data-preview]', card).innerHTML = parsed.rows.length ? `<thead><tr><th>SKU</th><th>Item</th><th>Unit</th><th>Tags</th><th class="num">Price</th>
          <th class="num">Set</th><th class="num">Stock</th><th class="num">Cost</th><th class="num">Reorder at</th></tr></thead>
        <tbody>${parsed.rows.map(r => `<tr><td class="mono">${esc(r.sku)}</td><td>${esc(r.name)}</td><td>${esc(r.unit)}</td><td>${r.tags.map(esc).join(', ')}</td>
          <td class="num">${r.price ? peso(r.price) : '—'}</td><td class="num">${r.set_size ? `of ${qty(r.set_size)}${r.set_price ? ` · ${peso(r.set_price)}` : ''}` : '—'}</td><td class="num">${qty(r.stock)}</td><td class="num">${peso(r.unit_cost)}</td><td class="num">${qty(r.reorder_level)}</td></tr>`).join('')}</tbody>` : '';
      const button = $('[data-confirm]', card);
      button.disabled = !parsed.rows.length || parsed.errors.length > 0;
      button.textContent = parsed.rows.length ? `Add ${parsed.rows.length} item${parsed.rows.length === 1 ? '' : 's'}` : 'Add items';
    });
    $('[data-confirm]', card).addEventListener('click', e => busy(e.currentTarget, async () => {
      const { created } = await api('POST', '/inventory/import', { date: todayLocal(), rows: parsed.rows });
      closeModal();
      toast(`${created} item${created === 1 ? '' : 's'} added`);
      await reload({ catalog: true });
    }));
  });
}

function exportCsv() {
  const owner = isOwner();
  const header = ['SKU', 'Item', 'Unit', 'Tags', 'Price', 'Commission', 'Set of', 'Set price', ...(owner ? ['Avg cost'] : []),
    ...CONTAINERS.map(c => c[1]), 'Total stock', 'Reorder at', ...(owner ? ['Value'] : [])];
  const rows = visibleItems().map(i => [i.sku || '', i.name, i.unit, i.tags.map(t => tagOf(t)?.name).filter(Boolean).join(', '),
    Number(i.price), Number(i.commission), i.set_size ?? '', i.set_price ?? '',
    ...(owner ? [Number(i.avg_cost)] : []), ...CONTAINERS.map(([key]) => stockIn(i, key)), Number(i.total_stock), Number(i.reorder_level), ...(owner ? [valueOf(i)] : [])]);
  const url = URL.createObjectURL(new Blob([toCsv([header, ...rows])], { type: 'text/csv;charset=utf-8' }));
  const link = Object.assign(document.createElement('a'), { href: url, download: `Inventory_${todayLocal()}.csv` });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default { mount, show };
