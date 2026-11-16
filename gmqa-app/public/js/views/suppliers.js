// Suppliers (owner): who each item comes from, what its parts sold for and cost in the days picked, the profit, and for
// a supplier paid as its parts sell, what is still to pay. The math is supplierReport in lib/calc.js (GET /suppliers/report).
import { $, $$, api, esc, peso, toast, busy, todayLocal, addDays, sundayOf, prettyDate, openModal, closeModal, modalHeader } from '../ui.js';

let root;
let suppliers = [];
let report = null;

function mount(el) {
  root = el;
  root.innerHTML = `
    <div class="view-header">
      <div><h1>Suppliers</h1><div class="desc">What each supplier's parts sold for and cost, the profit, and what is still to pay them.</div></div>
      <div class="date-range-picker">
        <div><label>From</label><input type="date" data-start></div>
        <span class="range-arrow" aria-hidden="true">→</span>
        <div><label>To</label><input type="date" data-end></div>
      </div>
    </div>
    <div class="preset-row">
      <button class="btn ghost small" type="button" data-preset="this-week">This week</button>
      <button class="btn ghost small" type="button" data-preset="last-week">Last week</button>
      <button class="btn ghost small" type="button" data-preset="this-month">This month</button>
      <button class="btn ghost small" type="button" data-preset="last-30">Last 30 days</button>
      <button class="btn small" type="button" data-add-supplier>+ Add supplier</button>
    </div>
    <div class="metrics-row" data-totals></div>
    <div data-list></div>
    <details class="card help-card">
      <summary>How Suppliers works</summary>
      <ul>
        <li><b>Add a supplier</b>, then <b>Give items</b> to tick the auto parts that come from them (or pick the supplier in an item's Edit form in Inventory).</li>
        <li><b>Sold on</b>: each sale of the item in the days picked, with the day, how many and the JO number (oldest first).</li>
        <li><b>Sold</b>: the parts of that supplier sold in the days picked, booked like any sale (a parts job on the day it is done, paid or not).
          <b>Cost</b> is what they cost the shop when they sold; <b>Profit</b> = Sales − Cost − commission. A job's discount is not split over its parts.</li>
        <li><b>Pays as parts sell</b> (like consignment): <b>Still to pay</b> = the cost of every part of theirs sold since the day you picked, less what was paid to them
          since then, whatever days are shown. <b>Paid on delivery</b>: the shop already paid when the stock came in, so nothing is owed; cost and profit are still shown.</li>
        <li><b>Record payment</b> adds a supplier payment to that day's EOD expenses (drawer cash, GCash or the cash fund). It is not a second cost: the parts' cost already
          counts when they sell. A supplier payment entered in EOD can name the supplier too.</li>
      </ul>
    </details>`;
  $('[data-start]', root).addEventListener('change', load);
  $('[data-end]', root).addEventListener('change', load);
  $$('[data-preset]', root).forEach(b => b.addEventListener('click', () => preset(b.dataset.preset)));
  $('[data-add-supplier]', root).addEventListener('click', () => supplierModal(null));
  preset('this-month', false);
}

function preset(name, reload = true) {
  const today = todayLocal();
  const ranges = {
    'this-week': [sundayOf(today), today],
    'last-week': [addDays(sundayOf(today), -7), addDays(sundayOf(today), -1)],
    'this-month': [`${today.slice(0, 8)}01`, today],
    'last-30': [addDays(today, -29), today],
  };
  [$('[data-start]', root).value, $('[data-end]', root).value] = ranges[name];
  if (reload) load();
}

async function show() { await load(); }

async function load() {
  const start = $('[data-start]', root).value;
  const end = $('[data-end]', root).value;
  if (!start || !end) return;
  const [list, data] = await Promise.all([api('GET', '/suppliers'), api('GET', `/suppliers/report?start=${start}&end=${end}`)]);
  if ($('[data-start]', root).value !== start || $('[data-end]', root).value !== end) return;
  [suppliers, report] = [list, data];
  render();
}

const shortDate = d => prettyDate(d).replace(/^\w+, /, '');
const monthDay = d => shortDate(d).replace(/, \d{4}$/, '');
const qty = n => Number(n).toLocaleString('en-PH', { maximumFractionDigits: 2 });

function itemsTable(items) {
  if (!items.length) return '<div class="empty-state small">No parts sold in these days.</div>';
  // When it sold: one line per sale (day, how many, JO number), oldest first; "not paid yet" if the customer still owes.
  const soldOn = i => i.sold.map(s => `<span class="sold-line">${esc(monthDay(s.date))} · ${qty(s.quantity)} ${esc(i.unit)} · <span class="mono">${esc(s.jo_number || '')}</span>${s.paid ? '' : ' <span class="amber-text">not paid yet</span>'}</span>`).join('');
  return `<div class="table-wrap"><table class="simple-table supplier-items">
    <thead><tr><th>Item</th><th>Sold on</th><th class="num">Sold</th><th class="num">Sales</th><th class="num">Cost</th><th class="num">Profit</th></tr></thead>
    <tbody>${items.map(i => `<tr data-item="${i.part_id}"><td>${esc(i.name)}</td><td class="sold-on" data-sold-on>${soldOn(i)}</td><td class="num">${qty(i.quantity)} ${esc(i.unit)}</td>
      <td class="num money">${peso(i.sales)}</td><td class="num money">${peso(i.cost)}</td>
      <td class="num money ${i.profit < 0 ? 'neg' : 'pos'}">${peso(i.profit)}</td></tr>`).join('')}</tbody>
  </table></div>`;
}

function render() {
  const t = report.totals;
  $('[data-totals]', root).innerHTML = `
    <div class="metric"><div class="label">Parts sold for</div><div class="value">${peso(t.sales)}</div></div>
    <div class="metric"><div class="label">Their cost</div><div class="value amber">${peso(t.cost)}</div></div>
    <div class="metric"><div class="label">Profit</div><div class="value teal">${peso(t.profit)}</div></div>
    <div class="metric" data-total-owed><div class="label">Still to pay (all suppliers)</div><div class="value amber">${peso(t.owed)}</div></div>`;

  const countOf = id => suppliers.find(s => s.id === id)?.item_count || 0;
  const cards = report.suppliers.map(s => {
    const owes = s.pays_when_sold;
    const n = countOf(s.id);
    return `<div class="card" data-supplier="${s.id}">
      <div class="section-header"><div><h2>${esc(s.name)}</h2>
        <span class="muted small">${owes ? `Pays as parts sell · counted from ${esc(shortDate(s.owed_from))}` : 'Paid on delivery'} · ${n} item${n === 1 ? '' : 's'}${s.note ? ` · ${esc(s.note)}` : ''}</span></div>
        <div class="actions">
          <button class="btn ghost small" type="button" data-assign>Give items</button>
          <button class="btn ghost small" type="button" data-edit>Edit</button>
          <button class="btn small" type="button" data-pay>Record payment</button>
        </div></div>
      <div class="supplier-figures">
        <div><span class="muted small">Sold for</span><b>${peso(s.sales)}</b></div>
        <div><span class="muted small">Cost</span><b class="amber-text" data-cost>${peso(s.cost)}</b></div>
        <div><span class="muted small">Profit</span><b class="${s.profit < 0 ? 'neg' : 'pos'}">${peso(s.profit)}</b></div>
        <div><span class="muted small">Paid in these days</span><b>${peso(s.paidInRange)}</b></div>
        ${owes ? `<div class="supplier-owed" title="Cost of parts sold since ${esc(shortDate(s.owed_from))} (${peso(s.soldSince)}) less paid since then (${peso(s.paidSince)})">
          <span class="muted small">Still to pay</span><b class="${s.owed > 0 ? 'amber-text' : ''}" data-owed>${peso(s.owed)}</b></div>` : ''}
      </div>
      ${n || s.items.length ? itemsTable(s.items) : '<div class="empty-state small">No items yet. Press <b>Give items</b> to pick the parts that come from this supplier.</div>'}
      ${s.payments.length ? `<div class="hint mt">Paid: ${s.payments.map(p => `${peso(p.amount)} ${p.side === 'gcash' ? 'GCash' : p.side === 'fund' ? 'cash fund' : 'cash'} on ${esc(shortDate(p.expense_date))}`).join(', ')}.
        Undo one from that day's EOD expenses.</div>` : ''}
    </div>`;
  }).join('');
  const none = report.none.items.length ? `<div class="card" data-no-supplier>
      <div class="section-header"><div><h2>No supplier</h2><span class="muted small">Parts sold that have no supplier yet. Give them to a supplier to track what you owe.</span></div></div>
      ${itemsTable(report.none.items)}</div>` : '';
  $('[data-list]', root).innerHTML = (cards || '<div class="card"><div class="empty-state">No suppliers yet. Press <b>+ Add supplier</b>.</div></div>') + none;

  $$('[data-supplier]', root).forEach(card => {
    const supplier = suppliers.find(s => s.id === Number(card.dataset.supplier));
    const row = report.suppliers.find(s => s.id === supplier.id);
    $('[data-assign]', card).addEventListener('click', e => busy(e.currentTarget, () => assignModal(supplier)));
    $('[data-edit]', card).addEventListener('click', () => supplierModal(supplier));
    $('[data-pay]', card).addEventListener('click', () => payModal(supplier, row));
  });
}

function supplierModal(s) {
  openModal(`${modalHeader(s ? `Edit ${s.name}` : 'New supplier', 'Who the parts come from, and how they are paid.')}
    <div class="form-grid modal-form-grid">
      <div class="span-2"><label>Name</label><input type="text" data-s="name" maxlength="80" value="${esc(s?.name || '')}" placeholder="e.g. Greaseheads"></div>
      <div class="span-2"><label class="check"><input type="checkbox" data-s="pays_when_sold" ${!s || s.pays_when_sold ? 'checked' : ''}>
        Pay for the parts as they sell (like consignment)</label>
        <div class="hint">Untick if the shop pays when the stock is delivered: then nothing is owed, only cost and profit are tracked.</div></div>
      <div><label>Count what is owed from</label><input type="date" data-s="owed_from" value="${esc(s?.owed_from || todayLocal())}"></div>
      <div><label>Note</label><input type="text" data-s="note" maxlength="200" value="${esc(s?.note || '')}" placeholder="Contact, terms…"></div>
    </div>
    <p class="hint">Sales from this day on count toward what is owed. Pick the day after you last settled with them.</p>
    <div class="modal-actions">${s ? '<button class="btn danger" type="button" data-remove>Remove supplier</button>' : ''}
      <button class="btn ghost" type="button" data-close>Cancel</button><button class="btn" type="button" data-confirm>${s ? 'Save' : 'Add supplier'}</button></div>`,
  card => {
    $('[data-s="name"]', card).focus();
    $('[data-confirm]', card).addEventListener('click', e => busy(e.currentTarget, async () => {
      const get = k => $(`[data-s="${k}"]`, card);
      if (!get('name').value.trim()) return toast('Name is required', 'error');
      const body = { name: get('name').value.trim(), pays_when_sold: get('pays_when_sold').checked, owed_from: get('owed_from').value, note: get('note').value.trim() };
      if (s) await api('PATCH', `/suppliers/${s.id}`, body);
      else await api('POST', '/suppliers', body);
      closeModal();
      toast('Supplier saved');
      await load();
    }));
    $('[data-remove]', card)?.addEventListener('click', e => busy(e.currentTarget, async () => {
      if (!window.confirm(`Remove ${s.name}? Its items will have no supplier; past sales and payments are kept.`)) return;
      await api('PATCH', `/suppliers/${s.id}`, { active: false });
      closeModal();
      toast('Supplier removed');
      await load();
    }));
  });
}

// Tick the items that come from this supplier (auto parts, the ones that sell). An item has one supplier: ticking one of
// another supplier's items moves it here.
async function assignModal(s) {
  const items = (await api('GET', '/inventory')).filter(i => i.for_sale);
  const nameOf = id => suppliers.find(x => x.id === id)?.name;
  openModal(`${modalHeader(`Items from ${s.name}`, 'Tick every part that comes from this supplier.')}
    <div class="pick-tools"><input type="search" data-item-search placeholder="Search items" aria-label="Search items">
      <button class="btn ghost small" type="button" data-tick-all>Tick all shown</button></div>
    <div class="pick-list" data-pick-list>${items.map(i => `<label class="check pick-row" data-item-row data-name="${esc(i.name.toLowerCase())}">
      <input type="checkbox" value="${i.id}" ${i.supplier_id === s.id ? 'checked' : ''}> ${esc(i.name)}
      ${i.supplier_id && i.supplier_id !== s.id ? `<span class="muted small">now ${esc(nameOf(i.supplier_id) || 'another supplier')}</span>` : ''}</label>`).join('')
      || '<div class="empty-state small">No auto parts in Inventory yet.</div>'}</div>
    <div class="modal-actions"><button class="btn ghost" type="button" data-close>Cancel</button><button class="btn" type="button" data-confirm>Save</button></div>`,
  card => {
    const search = $('[data-item-search]', card);
    search.focus();
    search.addEventListener('input', () => {
      const words = search.value.trim().toLowerCase();
      $$('[data-item-row]', card).forEach(r => { r.hidden = Boolean(words) && !r.dataset.name.includes(words); });
    });
    $('[data-tick-all]', card).addEventListener('click', () => {
      $$('[data-item-row]', card).filter(r => !r.hidden).forEach(r => { $('input', r).checked = true; });
    });
    $('[data-confirm]', card).addEventListener('click', e => busy(e.currentTarget, async () => {
      const boxes = $$('[data-item-row] input', card);
      const was = new Set(items.filter(i => i.supplier_id === s.id).map(i => i.id));
      const add = boxes.filter(b => b.checked && !was.has(Number(b.value))).map(b => Number(b.value));
      const remove = boxes.filter(b => !b.checked && was.has(Number(b.value))).map(b => Number(b.value));
      if (!add.length && !remove.length) { closeModal(); return; }
      await api('POST', `/suppliers/${s.id}/items`, { part_ids: add, remove_ids: remove });
      closeModal();
      const total = was.size + add.length - remove.length;
      toast(`${s.name}: ${total} item${total === 1 ? '' : 's'}`);
      await load();
    }));
  });
}

function payModal(s, row) {
  const owed = row?.owed > 0 ? row.owed : '';
  openModal(`${modalHeader(`Pay ${s.name}`, owed ? `Still to pay: ${peso(owed)}` : 'A supplier payment, recorded in that day\'s EOD expenses.')}
    <div class="form-grid modal-form-grid">
      <div><label>Date paid</label><input type="date" data-p="date" value="${todayLocal()}"></div>
      <div><label>Paid from</label><select data-p="side"><option value="cash">Drawer cash</option><option value="gcash">GCash</option><option value="fund">Cash fund</option></select></div>
      <div><label>Amount</label><input type="number" min="0.01" step="0.01" data-p="amount" value="${owed}"></div>
      <div><label>Note</label><input type="text" data-p="note" maxlength="120" placeholder="e.g. receipt no."></div>
    </div>
    <p class="hint">It leaves the drawer (or GCash, or the cash fund) that day, but it is not a second cost: the parts' cost counted when they sold.
      An online transfer fee is a separate expense in EOD.</p>
    <div class="modal-actions"><button class="btn ghost" type="button" data-close>Cancel</button><button class="btn" type="button" data-confirm>Record payment</button></div>`,
  card => {
    $('[data-p="amount"]', card).focus();
    $('[data-confirm]', card).addEventListener('click', e => busy(e.currentTarget, async () => {
      const get = k => $(`[data-p="${k}"]`, card).value;
      const amount = Number(get('amount') || 0);
      if (!(amount > 0)) return toast('Type the amount paid', 'error');
      await api('POST', `/suppliers/${s.id}/payments`, { date: get('date'), side: get('side'), amount, note: get('note').trim() });
      closeModal();
      toast(`Payment recorded: ${peso(amount)} to ${s.name}`);
      await load();
    }));
  });
}

export default { mount, show };
