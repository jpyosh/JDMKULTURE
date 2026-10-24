// Inventory: everything the shop stocks (parts for sale, chemicals, mitts, towels, machines) in a
// spreadsheet-style sheet, or cards on a phone. Tags group items; the ones tagged Auto Parts are for sale
// (Parts tab and job orders). Everyone can record a stock count (the difference is what was used); the
// owner edits items and tags, receives deliveries, and sees costs and history.
import { $, $$, api, esc, peso, toast, busy, todayLocal, openModal, closeModal, modalHeader, isOwner, loadCatalog } from '../ui.js';
import { toCsv, parsePasted, importRows } from '../components/sheet-io.js';

let root;
let items = [];
let tags = [];
const filter = { tag: '', search: '' };
const sort = { field: 'name', dir: 1 };
let editing = null;

const MODE_KEY = 'inventory-mode';
// Sheet or cards: the viewer's own choice on this device; until they choose, cards on a phone.
let mode = (() => {
  let saved = null;
  try { saved = localStorage.getItem(MODE_KEY); } catch { /* private window */ }
  return saved === 'sheet' || saved === 'cards' ? saved : window.matchMedia('(max-width: 700px)').matches ? 'cards' : 'sheet';
})();

// edit: 'owner' = the owner edits the item field in place; 'count' = anyone, records a stock count.
const COLUMNS = [
  { field: 'sku', label: 'SKU', type: 'text', edit: 'owner', max: 40 },
  { field: 'name', label: 'Item', type: 'text', edit: 'owner', max: 120 },
  { field: 'unit', label: 'Unit', type: 'text', edit: 'owner', max: 12 },
  { field: 'tags', label: 'Tags', type: 'tags', edit: 'owner' },
  { field: 'price', label: 'Price', type: 'money', edit: 'owner' },
  { field: 'commission', label: 'Comm./unit', type: 'money', edit: 'owner' },
  { field: 'avg_cost', label: 'Avg cost', type: 'money', ownerOnly: true },
  { field: 'stock', label: 'Stock', type: 'qty', edit: 'count' },
  { field: 'reorder_level', label: 'Reorder at', type: 'qty', edit: 'owner' },
  { field: 'value', label: 'Value', type: 'money', ownerOnly: true },
];
const columns = () => COLUMNS.filter(c => !c.ownerOnly || isOwner());
const editable = col => col.edit === 'count' || (col.edit === 'owner' && isOwner());

const PAID_FROM = [['cash', 'Drawer cash'], ['gcash', 'GCash'], ['fund', 'Cash fund (abono)'], ['none', 'Already paid / opening stock']];
const COUNT_REASONS = [['used', 'Used'], ['damaged', 'Damaged'], ['lost', 'Lost'], ['recount', 'Recount (correct the number)']];
const MOVE_LABEL = { receive: 'Received', sale: 'Sold', return: 'Returned', adjust: 'Adjusted', use: 'Used' };
const TAG_COLORS = ['slate', 'red', 'orange', 'amber', 'green', 'teal', 'blue', 'violet', 'pink'];

const qty = n => String(Math.round(Number(n || 0) * 100) / 100);
const valueOf = item => Math.round(Number(item.stock) * Number(item.avg_cost || 0) * 100) / 100;
const tagOf = tagId => tags.find(t => t.id === tagId);
const tagChip = tag => tag ? `<span class="tag-chip c-${esc(tag.color)}">${esc(tag.name)}</span>` : '';
const tagChips = item => item.tags.map(t => tagChip(tagOf(t))).join('');
const rawValue = (item, field) => (field === 'value' ? valueOf(item) : item[field]);

function mount(el) {
  root = el;
  Object.assign(filter, { tag: '', search: '' });
  const owner = isOwner();
  root.innerHTML = `
    <div class="view-header">
      <div><h1>Inventory</h1><div class="desc">Everything the shop stocks. Tag an item <b>Auto Parts</b> to sell it on the Parts tab and on job orders.
        Count the shelf to record what was used.</div></div>
      <div class="header-actions">
        <div class="segmented compact" role="group" aria-label="View">
          <button type="button" data-mode="sheet">Sheet</button><button type="button" data-mode="cards">Cards</button></div>
        <button class="btn ghost" type="button" data-export>Export CSV</button>
        ${owner ? `<button class="btn ghost" type="button" data-paste>Paste from Excel</button>
          <button class="btn ghost" type="button" data-manage-tags>Tags</button>
          <button class="btn" type="button" data-new-item>+ New item</button>` : ''}
      </div>
    </div>
    <div data-low></div>
    <div class="inv-toolbar">
      <input type="text" data-search placeholder="Search item or SKU" aria-label="Search item or SKU">
      <div class="chip-row" data-tag-filters></div>
    </div>
    <div class="table-wrap sheet-wrap"><table class="sheet-table" data-sheet></table></div>
    <div class="inv-cards" data-cards hidden></div>`;
  $$('[data-mode]', root).forEach(b => b.addEventListener('click', () => {
    mode = b.dataset.mode;
    try { localStorage.setItem(MODE_KEY, mode); } catch { /* private window: not remembered */ }
    render();
  }));
  $('[data-search]', root).addEventListener('input', e => { filter.search = e.target.value.trim().toLowerCase(); render(); });
  $('[data-export]', root).addEventListener('click', exportCsv);
  $('[data-paste]', root)?.addEventListener('click', pasteModal);
  $('[data-manage-tags]', root)?.addEventListener('click', tagsModal);
  $('[data-new-item]', root)?.addEventListener('click', () => itemModal(null));
  installSheetKeys($('[data-sheet]', root));
  $('[data-cards]', root).addEventListener('click', e => {
    const btn = e.target.closest('[data-act]');
    if (btn) rowAction(btn.dataset.act, items.find(i => i.id === Number(btn.closest('[data-item]').dataset.item)));
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

function visibleItems() {
  const tagId = Number(filter.tag) || null;
  const list = items.filter(i => (!tagId || i.tags.includes(tagId))
    && (!filter.search || i.name.toLowerCase().includes(filter.search) || (i.sku || '').toLowerCase().includes(filter.search)));
  const col = COLUMNS.find(c => c.field === sort.field);
  const key = item => (col.type === 'tags' ? item.tags.map(t => tagOf(t)?.name || '').join(', ').toLowerCase()
    : col.type === 'text' ? String(item[col.field] || '').toLowerCase() : Number(rawValue(item, col.field)) || 0);
  return list.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0) * sort.dir);
}

function render() {
  editing = null;
  const low = items.filter(i => i.low);
  $('[data-low]', root).innerHTML = low.length
    ? `<div class="banner">Low stock: ${low.map(i => `<b>${esc(i.name)}</b> (${qty(i.stock)} ${esc(i.unit)})`).join(', ')}. Time to reorder.</div>` : '';
  $('[data-tag-filters]', root).innerHTML = [`<button type="button" class="filter-chip ${filter.tag ? '' : 'active'}" data-tag-filter="">All <span>${items.length}</span></button>`,
    ...tags.map(t => `<button type="button" class="filter-chip ${Number(filter.tag) === t.id ? 'active' : ''}" data-tag-filter="${t.id}">
      <i class="dot c-${esc(t.color)}"></i>${esc(t.name)} <span>${items.filter(i => i.tags.includes(t.id)).length}</span></button>`)].join('');
  $$('[data-tag-filter]', root).forEach(b => b.addEventListener('click', () => { filter.tag = b.dataset.tagFilter; render(); }));
  $$('[data-mode]', root).forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
  $('.sheet-wrap', root).hidden = mode !== 'sheet';
  $('[data-cards]', root).hidden = mode !== 'cards';
  if (mode === 'sheet') renderSheet(); else renderCards();
}

function cellHtml(item, col) {
  const v = rawValue(item, col.field);
  if (col.type === 'tags') return tagChips(item) || '<span class="muted">—</span>';
  if (col.type === 'money') return (col.field === 'price' || col.field === 'commission') && !Number(v) ? '<span class="muted">—</span>' : peso(v);
  if (col.type === 'qty') return col.field === 'stock' && item.low ? `${qty(v)} <span class="status-pill waiting">Low</span>` : qty(v);
  return v ? esc(v) : '<span class="muted">—</span>';
}

function renderSheet() {
  const cols = columns();
  const list = visibleItems();
  const owner = isOwner();
  const arrow = f => (sort.field === f ? (sort.dir > 0 ? ' ▲' : ' ▼') : '');
  $('[data-sheet]', root).innerHTML = `
    <thead><tr>${cols.map(c => `<th class="${c.type === 'money' || c.type === 'qty' ? 'num' : ''}" data-sort="${c.field}"
      aria-sort="${sort.field === c.field ? (sort.dir > 0 ? 'ascending' : 'descending') : 'none'}"><button type="button">${c.label}${arrow(c.field)}</button></th>`).join('')}
      <th><span class="sr-only">Actions</span></th></tr></thead>
    <tbody>${list.length ? list.map(item => `<tr data-item="${item.id}">${cols.map(c => `<td data-field="${c.field}" tabindex="-1"
        class="${c.type === 'money' || c.type === 'qty' ? 'num' : ''} ${editable(c) ? 'editable' : ''} ${c.field === 'sku' ? 'mono' : ''}">${cellHtml(item, c)}</td>`).join('')}
      <td class="row-actions"><div class="actions">${rowButtons(item)}</div></td></tr>`).join('')
    : `<tr><td colspan="${cols.length + 1}"><div class="empty-state small">${items.length ? 'Nothing matches.' : `No items yet.${owner ? ' Add one with “+ New item”, or paste your list from Excel.' : ''}`}</div></td></tr>`}</tbody>
    <tfoot><tr><td colspan="${cols.length + 1}"><span>${list.length} item${list.length === 1 ? '' : 's'}</span>
      ${owner ? `<span>Stock value <b class="money" data-total-value>${peso(list.reduce((s, i) => s + valueOf(i), 0))}</b></span>` : ''}</td></tr></tfoot>`;
  const first = $('[data-sheet] tbody td[data-field]', root);
  if (first) first.tabIndex = 0;
  $$('[data-sheet] th[data-sort] button', root).forEach(b => b.addEventListener('click', () => {
    const field = b.closest('th').dataset.sort;
    sort.dir = sort.field === field ? -sort.dir : 1;
    sort.field = field;
    renderSheet();
  }));
  $$('[data-sheet] [data-act]', root).forEach(b => b.addEventListener('click', () =>
    rowAction(b.dataset.act, items.find(i => i.id === Number(b.closest('tr').dataset.item)))));
}

function rowButtons(item) {
  return isOwner() ? `<button class="btn small" type="button" data-act="receive">Receive</button>
      <button class="btn ghost small" type="button" data-act="count">Count</button>
      <button class="btn ghost small" type="button" data-act="history">History</button>
      <button class="btn ghost small" type="button" data-act="edit">Edit</button>`
    : `<button class="btn ghost small" type="button" data-act="count" aria-label="Count ${esc(item.name)}">Count</button>`;
}

function rowAction(act, item) {
  ({ receive: receiveModal, count: i => countModal(i), history: historyModal, edit: itemModal })[act](item);
}

function renderCards() {
  const list = visibleItems();
  $('[data-cards]', root).innerHTML = list.length ? list.map(item => `<div class="inv-card" data-item="${item.id}">
      <div class="inv-card-head"><b>${esc(item.name)}</b>${item.sku ? ` <span class="mono muted small">${esc(item.sku)}</span>` : ''}</div>
      <div class="inv-card-tags">${tagChips(item)}</div>
      <div class="inv-card-stock"><span class="big">${qty(item.stock)}</span> ${esc(item.unit)} ${item.low ? '<span class="status-pill waiting">Low</span>' : ''}
        <span class="muted small">reorder at ${qty(item.reorder_level)}</span></div>
      ${item.for_sale ? `<div class="muted small">Sells for ${peso(item.price)}</div>` : ''}
      <div class="actions">${rowButtons(item)}</div></div>`).join('')
    : `<div class="empty-state small">${items.length ? 'Nothing matches.' : 'No items yet.'}</div>`;
}

// ---------------------------------------------------------------- sheet keyboard (Excel-style)
// Arrow keys move; Enter / F2 / double-click edits; typing replaces the cell; in a cell being edited,
// Enter saves and moves down, Tab saves and moves right (Shift: back), Escape cancels.

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
  if (!col || !item || !editable(col)) return;
  if (col.type === 'tags') return typed == null ? tagsPicker(item) : undefined;
  const input = document.createElement('input');
  input.type = 'text';
  input.inputMode = col.type === 'text' ? 'text' : 'decimal';
  input.className = 'cell-input';
  input.setAttribute('aria-label', col.label);
  input.value = typed ?? String(item[col.field] ?? '');
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
    if (raw !== '' && Number(raw) !== Number(item.stock)) countModal(item, raw);
    return;
  }
  let value = raw;
  if (col.type !== 'text') {
    value = Number(raw.replace(/₱|,/g, '') || 0);
    if (!Number.isFinite(value) || value < 0) { toast(`${col.label} must be a number of 0 or more`, 'error'); return done(); }
  }
  if (col.field === 'name' && !value) { toast('Name is required', 'error'); return done(); }
  if (String(value) === String(item[col.field] ?? '')) return done();
  td.classList.add('saving');
  try {
    const saved = await api('PATCH', `/inventory/${item.id}`, { [col.field]: value });
    items = items.map(i => (i.id === saved.id ? saved : i));
    toast('Saved');
    loadCatalog(true).catch(() => {});
  } catch { /* the API error is already shown */ }
  done();
}

// ---------------------------------------------------------------- modals

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
  openModal(`${modalHeader(`Receive ${item.name}`, `In stock: ${qty(item.stock)} ${item.unit} at an average cost of ${peso(item.avg_cost)}.`)}
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

function countModal(item, counted = '') {
  openModal(`${modalHeader(`Count ${item.name}`, `On record: ${qty(item.stock)} ${item.unit}. Enter what is on the shelf now.`)}
    <div class="form-grid modal-form-grid">
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
    const summary = () => {
      const diff = Math.round((Number(get('counted')) - Number(item.stock)) * 100) / 100;
      const amount = `${qty(Math.abs(diff))} ${item.unit}`;
      $('[data-c-summary]', card).textContent = get('counted') === '' || !Number.isFinite(diff) ? ''
        : diff === 0 ? 'That matches the record; nothing to save.'
          : diff > 0 ? `${amount} more than on record (a recount).`
            : `${amount} ${reason.value === 'recount' ? 'less than on record (a recount)' : reason.value}.`;
    };
    const suggest = () => { if (Number(get('counted')) > Number(item.stock)) reason.value = 'recount'; summary(); };
    $('[data-c="counted"]', card).addEventListener('input', suggest);
    reason.addEventListener('change', summary);
    suggest();
    $('[data-c="counted"]', card).focus();
    $('[data-confirm]', card).addEventListener('click', e => busy(e.currentTarget, async () => {
      await api('POST', `/inventory/${item.id}/count`, { date: get('date'), counted: get('counted') === '' ? '' : Number(get('counted')), reason: reason.value, note: get('note').trim() });
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
  openModal(`${modalHeader(`${item.name} stock history`, `${moves.length} change${moves.length === 1 ? '' : 's'}`)}
    <div class="history-list">${moves.slice().reverse().map(m => `<div class="history-entry">
      <div class="history-meta"><span>${esc(m.moved_on)}</span><span>${esc(m.created_by || '')}</span></div>
      <div><span class="kind-pill ${m.quantity > 0 ? 'service' : 'custom'}">${MOVE_LABEL[m.kind]}</span>
        <b>${m.quantity > 0 ? '+' : ''}${qty(m.quantity)} ${esc(item.unit)}</b>${m.unit_cost != null ? ` @ ${peso(m.unit_cost)}` : ''}${paid(m)}
        ${m.jo_number ? ` · ${esc(m.jo_number)}` : ''}${m.supplier ? ` · ${esc(m.supplier)}` : ''}${m.note ? ` · ${esc(m.note)}` : ''}
        ${m === last && m.kind === 'receive' ? `<button class="btn ghost small" type="button" data-undo="${m.id}">Undo</button>` : ''}</div>
    </div>`).join('') || '<div class="empty-state small">No stock changes yet.</div>'}</div>
    <div class="modal-actions"><button class="btn ghost" type="button" data-close>Close</button></div>`,
  card => $('[data-undo]', card)?.addEventListener('click', e => busy(e.currentTarget, async () => {
    if (!window.confirm('Undo this delivery? Its stock comes off again and what it recorded as paid is removed.')) return;
    await api('POST', `/inventory/movements/${e.currentTarget.dataset.undo}/undo`);
    closeModal();
    toast('Delivery undone');
    await reload({ catalog: true });
  })));
}

function tagsModal() {
  const row = t => `<div class="tag-row" data-tag-row="${t.id}">
      <input type="text" data-t="name" maxlength="40" value="${esc(t.name)}" aria-label="Tag name">
      <select data-t="color" aria-label="Colour">${TAG_COLORS.map(c => `<option value="${c}" ${c === t.color ? 'selected' : ''}>${c}</option>`).join('')}</select>
      <button class="btn ghost small" type="button" data-t-save>Save</button>
      ${t.system_key ? '<span class="muted small">built in</span>' : '<button class="icon-btn" type="button" data-t-delete title="Delete tag">✕</button>'}</div>`;
  openModal(`${modalHeader('Tags', 'Group items any way you like. Deleting a tag only removes the label from its items.')}
    <div class="tag-rows">${tags.map(row).join('')}</div>
    <div class="tag-row"><input type="text" data-new-tag maxlength="40" placeholder="New tag, e.g. Wax & sealants" aria-label="New tag">
      <button class="btn small" type="button" data-add-tag>+ Add tag</button></div>
    <div class="modal-actions"><button class="btn ghost" type="button" data-close>Done</button></div>`,
  card => {
    $$('[data-tag-row]', card).forEach(r => {
      const tagId = Number(r.dataset.tagRow);
      $('[data-t-save]', r).addEventListener('click', e => busy(e.currentTarget, async () => {
        await api('PATCH', `/tags/${tagId}`, { name: $('[data-t="name"]', r).value.trim(), color: $('[data-t="color"]', r).value });
        toast('Tag saved');
        await reload();
      }));
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
      await api('POST', '/tags', { name, color: TAG_COLORS[tags.length % TAG_COLORS.length] });
      await reload();
      tagsModal();
    }));
  });
}

function pasteModal() {
  openModal(`${modalHeader('Paste from Excel or Sheets', 'Select your rows in Excel / Google Sheets (include the header row), copy, and paste here.')}
    <textarea data-paste-text rows="7" placeholder="SKU&#9;Item&#9;Unit&#9;Selling price&#9;Reorder at&#9;Tags&#9;Stock&#9;Cost"></textarea>
    <p class="hint">Columns it understands: SKU, Item (or Name), Unit, Selling price, Commission, Reorder at, Tags (separate with , or ;), Stock, Cost.
      Other columns are ignored. Stock is added as opening stock at its cost; no money is recorded.</p>
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
          <th class="num">Stock</th><th class="num">Cost</th><th class="num">Reorder at</th></tr></thead>
        <tbody>${parsed.rows.map(r => `<tr><td class="mono">${esc(r.sku)}</td><td>${esc(r.name)}</td><td>${esc(r.unit)}</td><td>${r.tags.map(esc).join(', ')}</td>
          <td class="num">${r.price ? peso(r.price) : '—'}</td><td class="num">${qty(r.stock)}</td><td class="num">${peso(r.unit_cost)}</td><td class="num">${qty(r.reorder_level)}</td></tr>`).join('')}</tbody>` : '';
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
  const header = ['SKU', 'Item', 'Unit', 'Tags', 'Price', 'Commission', ...(owner ? ['Avg cost'] : []), 'Stock', 'Reorder at', ...(owner ? ['Value'] : [])];
  const rows = visibleItems().map(i => [i.sku || '', i.name, i.unit, i.tags.map(t => tagOf(t)?.name).filter(Boolean).join(', '),
    Number(i.price), Number(i.commission), ...(owner ? [Number(i.avg_cost)] : []), Number(i.stock), Number(i.reorder_level), ...(owner ? [valueOf(i)] : [])]);
  const url = URL.createObjectURL(new Blob([toCsv([header, ...rows])], { type: 'text/csv;charset=utf-8' }));
  const link = Object.assign(document.createElement('a'), { href: url, download: `Inventory_${todayLocal()}.csv` });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default { mount, show };
