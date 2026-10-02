import { $, $$, api, esc, toast, busy, loadCatalog, state, isOwner } from '../ui.js';

let root;

function mount(el) {
  root = el;
  root.innerHTML = `
    <div class="view-header">
      <div><h1>Pricing Matrix</h1><div class="desc">Price and commission per vehicle class. Changes apply to new job lines only; past jobs keep their price.</div></div>
      <div class="owner-only header-actions"><button class="btn" type="button" data-save-all>Save changes</button></div>
    </div>
    <div class="card">
      <div class="section-header"><h2>Services</h2><button class="btn ghost owner-only" type="button" data-add="service">+ Add service</button></div>
      <div class="table-wrap"><table class="matrix-table" data-table="service"></table></div>
    </div>
    <div class="card">
      <div class="section-header"><h2>Add-ons</h2><button class="btn ghost owner-only" type="button" data-add="addon">+ Add add-on</button></div>
      <div class="table-wrap"><table class="matrix-table" data-table="addon"></table></div>
    </div>
    <p class="hint">Vehicle classes are managed in Settings. A price of ₱0 means the item is not normally offered for that class.</p>`;

  $$('[data-add]', root).forEach(b => b.addEventListener('click', () => addItem(b.dataset.add)));
  $('[data-save-all]', root).addEventListener('click', e => busy(e.currentTarget, saveAll));
}

async function show() {
  await loadCatalog(true);
  render();
}

function render() {
  const classes = state.catalog.classes.filter(c => c.active);
  const owner = isOwner();
  for (const kind of ['service', 'addon']) {
    const items = state.catalog.items.filter(i => i.kind === kind);
    $(`[data-table="${kind}"]`, root).innerHTML = `
      <thead>
        <tr><th class="sticky-name" rowspan="2">${kind === 'service' ? 'Service' : 'Add-on'}</th>
          <th colspan="${classes.length}" class="group-head">Price</th><th colspan="${classes.length}" class="group-head">Commission</th>
          ${owner ? '<th rowspan="2"></th>' : ''}</tr>
        <tr>${classes.map(c => `<th class="num">${esc(c.label)}</th>`).join('').repeat(2)}</tr>
      </thead>
      <tbody>${items.length ? items.map(item => `
        <tr data-id="${item.id}">
          <td class="sticky-name">${owner ? `<input type="text" data-name value="${esc(item.name)}" maxlength="120">` : esc(item.name)}</td>
          ${['price', 'commission'].map(field => classes.map(c => {
            const value = item.prices[c.code]?.[field] ?? 0;
            return `<td class="num">${owner ? `<input type="number" min="0" step="0.01" data-class="${esc(c.code)}" data-field="${field}" value="${value}">` : (value ? value.toLocaleString('en-PH') : '—')}</td>`;
          }).join('')).join('')}
          ${owner ? '<td><button class="icon-btn" type="button" data-archive title="Archive">✕</button></td>' : ''}
        </tr>`).join('') : `<tr><td colspan="${classes.length * 2 + 2}"><div class="empty-state small">None yet.</div></td></tr>`}</tbody>`;
  }
  $$('tbody input', root).forEach(input => input.addEventListener('input', () => input.closest('tr').classList.add('dirty')));
  $$('[data-archive]', root).forEach(b => b.addEventListener('click', () => archive(Number(b.closest('tr').dataset.id))));
}

function rowPayload(tr) {
  const prices = {};
  $$('[data-class]', tr).forEach(input => {
    prices[input.dataset.class] ??= {};
    prices[input.dataset.class][input.dataset.field] = Number(input.value || 0);
  });
  return { name: $('[data-name]', tr).value.trim(), prices };
}

async function saveAll() {
  const dirty = $$('tr.dirty', root);
  if (!dirty.length) return toast('Nothing changed');
  for (const tr of dirty) {
    const body = rowPayload(tr);
    if (!body.name) return toast('Every item needs a name', 'error');
    await api('PATCH', `/catalog/${tr.dataset.id}`, body);
    tr.classList.remove('dirty');
  }
  toast(`Saved ${dirty.length} item${dirty.length === 1 ? '' : 's'}`);
  await show();
}

async function addItem(kind) {
  if ($$('tr.dirty', root).length && !window.confirm('You have unsaved price changes. Continue without saving them?')) return;
  const name = window.prompt(`Name of the new ${kind === 'service' ? 'service' : 'add-on'}:`);
  if (!name?.trim()) return;
  await api('POST', '/catalog', { kind, name: name.trim() });
  toast(`${name.trim()} added. Set its prices, then Save changes.`);
  await show();
}

async function archive(id) {
  const item = state.catalog.items.find(i => i.id === id);
  if (!window.confirm(`Archive "${item.name}"? It disappears from new job orders; past jobs keep it.`)) return;
  await api('DELETE', `/catalog/${id}`);
  toast(`${item.name} archived`);
  await show();
}

export default { mount, show };
