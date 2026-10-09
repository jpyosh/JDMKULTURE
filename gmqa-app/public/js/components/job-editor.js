// Job order form: vehicle class + any number of services, add-ons, parts and custom lines.
// Used for new jobs (department tabs, parts counter) and for editing existing jobs (modal).
import { $, $$, esc, peso, state, activeClasses, departmentOf, shopTime } from '../ui.js';

const KIND_LABEL = { service: 'Service', addon: 'Add-on', custom: 'Custom', part: 'Part' };
const round2 = n => Math.round(n * 100) / 100;

// department: which catalog items are offered. Running departments (detailing, tint/PPF) record
// payment with Mark paid instead of the checkbox, and lock the amount once paid. The parts counter
// (no catalog) sells parts and custom items only and needs no vehicle.
// autoTimeWhen: for a new job, () => true when its date is today; Time in then follows the shop clock
// until the user types a time of their own.
export function createJobEditor(root, { job = null, department = job?.department || 'carwash', autoTimeWhen = null } = {}) {
  const dept = departmentOf(department);
  const running = dept.running;
  const locked = Boolean(running && job?.paid_on);
  const originalClass = job?.vehicle_class || '';
  const editor = {
    lines: (job?.items || []).map(i => ({
      id: i.id, kind: i.kind, catalog_item_id: i.catalog_item_id, part_id: i.part_id, quantity: i.quantity,
      name: i.name, price: i.price, commission: i.commission,
    })),
  };
  const v = (key, fallback = '') => esc(job?.[key] ?? fallback);
  const classes = activeClasses();
  if (job?.vehicle_class && !classes.some(c => c.code === job.vehicle_class)) classes.push({ code: job.vehicle_class, label: job.vehicle_class });
  // This department's services, plus every add-on (add-ons are shared by all departments).
  const items = state.catalog.items.filter(i => i.kind === 'addon' || i.department === department);
  const parts = state.catalog.parts || [];
  const partOf = partId => parts.find(p => p.id === partId);

  root.innerHTML = `
    <div class="job-editor">
      <div class="entry-grid">
        <div><label>Vehicle class${dept.catalog ? '' : ' (optional)'}</label><select data-f="vehicle_class"><option value="">${dept.catalog ? 'Select' : 'None'}</option>
          ${classes.map(c => `<option value="${esc(c.code)}" ${c.code === job?.vehicle_class ? 'selected' : ''}>${esc(c.label)}</option>`).join('')}</select></div>
        <div><label>Plate${dept.catalog ? '' : ' (optional)'}</label><input type="text" data-f="plate" value="${v('plate')}" placeholder="e.g. NDR7377" maxlength="20"></div>
        <div><label>${dept.catalog ? 'Detailer' : 'Sold by'}</label><input type="text" data-f="detailer" value="${v('detailer')}" placeholder="Name" maxlength="80"></div>
        ${dept.catalog ? `<div><label>Time in</label><input type="time" data-f="time_in" value="${v('time_in')}"></div>` : ''}
        ${job && dept.catalog ? `<div><label>Time out</label><input type="time" data-f="time_out" value="${v('time_out')}"></div>` : ''}
        ${running ? '' : `<div><label>Payment</label><select data-f="payment_method">
          ${['Cash', 'GCash'].map(p => `<option ${p === (job?.payment_method || 'Cash') ? 'selected' : ''}>${p}</option>`).join('')}</select></div>
        <div class="check-cell"><label class="check"><input type="checkbox" data-f="payment_received" ${(job ? job.payment_received : !dept.catalog) ? 'checked' : ''}> Customer paid</label></div>`}
      </div>

      ${locked ? '<div class="banner">This job is already paid, so its items, class, discount and tip are locked. Undo the payment first to change them.</div>' : ''}
      <div class="line-editor">
        <div class="line-adders">
          ${dept.catalog ? `<select data-add="service"><option value="">+ Add service…</option>
            ${items.filter(i => i.kind === 'service').map(i => `<option value="${i.id}">${esc(i.name)}</option>`).join('')}</select>
          <select data-add="addon"><option value="">+ Add add-on…</option>
            ${items.filter(i => i.kind === 'addon').map(i => `<option value="${i.id}">${esc(i.name)}</option>`).join('')}</select>` : ''}
          <select data-add="part"><option value="">+ Add part…</option>
            ${parts.map(p => `<option value="${p.id}" ${p.stock > 0 ? '' : 'disabled'}>${esc(p.name)} · ${peso(p.price)} · ${p.stock} ${esc(p.unit)} left</option>`).join('')}</select>
          <button class="btn ghost" type="button" data-add-custom>+ Custom item</button>
        </div>
        <div class="lines" data-lines></div>
      </div>

      <div class="entry-grid">
        <div><label>Discount</label><input type="number" min="0" step="0.01" data-f="discount" value="${job?.discount || ''}" placeholder="0.00"></div>
        <div class="span-2"><label>Discount reason</label><input type="text" data-f="discount_reason" value="${v('discount_reason')}" placeholder="Optional" maxlength="200"></div>
        ${running ? '' : `<div><label>GCash tip</label><input type="number" min="0" step="0.01" data-f="tip_gcash" value="${job?.tip_gcash || ''}" placeholder="0.00"></div>`}
        <div class="span-2"><label>Remarks</label><input type="text" data-f="remarks" value="${v('remarks')}" placeholder="Optional" maxlength="500"></div>
      </div>
      <div class="editor-totals" data-totals></div>
    </div>`;

  const field = key => $(`[data-f="${key}"]`, root);
  const currentClass = () => field('vehicle_class').value;

  // Price shown for a line. Saved lines keep their frozen price, except catalog lines when the class
  // changes (the server re-prices those). New part lines are priced from the parts list x quantity.
  function linePrice(line) {
    if (line.kind === 'part' && !line.id) {
      const part = partOf(line.part_id);
      const qty = Number(line.quantity) || 0;
      return { price: round2((part?.price || 0) * qty), commission: round2((part?.commission || 0) * qty) };
    }
    const reprice = line.catalog_item_id && (!line.id || currentClass() !== originalClass);
    if (!reprice) return { price: Number(line.price) || 0, commission: Number(line.commission) || 0 };
    const p = items.find(i => i.id === line.catalog_item_id)?.prices[currentClass()];
    return { price: p?.price || 0, commission: p?.commission || 0 };
  }

  function totals() {
    const priced = editor.lines.map(linePrice);
    const subtotal = round2(priced.reduce((s, p) => s + p.price, 0));
    const commission = round2(priced.reduce((s, p) => s + p.commission, 0));
    const discount = Number(field('discount').value || 0);
    return { subtotal, commission, discount, total: round2(subtotal - discount) };
  }

  function lineBody(line, p) {
    if (line.kind === 'custom' && !line.id) {
      return `<input type="text" data-l="name" value="${esc(line.name)}" placeholder="Item name" maxlength="120">
        <input type="number" min="0" step="0.01" data-l="price" value="${line.price || ''}" placeholder="Price">
        <input type="number" min="0" step="0.01" data-l="commission" value="${line.commission || ''}" placeholder="Comm.">`;
    }
    if (line.kind === 'part' && !line.id) {
      const part = partOf(line.part_id);
      return `<span class="line-name">${esc(line.name)} <span class="muted small">${part ? `${part.stock} ${esc(part.unit)} in stock` : ''}</span></span>
        <span class="qty-cell"><input type="number" min="0.01" step="1" data-l="quantity" value="${line.quantity}" aria-label="Quantity"> × ${peso(part?.price || 0)}</span>
        <span class="money">${peso(p.price)}</span>`;
    }
    const qty = line.kind === 'part' ? ` <span class="muted small">× ${line.quantity}</span>` : '';
    return `<span class="line-name">${esc(line.name)}${qty}</span><span class="money">${peso(p.price)}</span><span class="money muted">${peso(p.commission)}</span>`;
  }

  function renderLines() {
    const box = $('[data-lines]', root);
    if (!editor.lines.length) {
      box.innerHTML = `<div class="lines-empty">No items yet. Add ${dept.catalog ? 'a service, add-on, part' : 'a part'} or custom item above.</div>`;
    } else {
      box.innerHTML = editor.lines.map((line, index) => `<div class="line-row" data-index="${index}">
          <span class="kind-pill ${line.kind}">${KIND_LABEL[line.kind]}</span>
          ${lineBody(line, linePrice(line))}
          <button class="icon-btn" type="button" data-remove title="Remove">✕</button>
        </div>`).join('');
    }
    $$('.line-row', box).forEach(row => {
      const line = editor.lines[Number(row.dataset.index)];
      $('[data-remove]', row).addEventListener('click', () => { editor.lines.splice(Number(row.dataset.index), 1); renderLines(); });
      $$('[data-l]', row).forEach(input => input.addEventListener('input', () => {
        line[input.dataset.l] = input.dataset.l === 'name' ? input.value : Number(input.value || 0);
        if (input.dataset.l === 'quantity') {
          const money = row.querySelector('.money');
          if (money) money.textContent = peso(linePrice(line).price);
        }
        renderTotals();
      }));
    });
    renderTotals();
  }

  function renderTotals() {
    const t = totals();
    const missingPrice = currentClass() && editor.lines.some(l => l.catalog_item_id && linePrice(l).price === 0);
    const overStock = editor.lines.some(l => l.kind === 'part' && !l.id && Number(l.quantity) > (partOf(l.part_id)?.stock ?? 0));
    $('[data-totals]', root).innerHTML = `
      <span>Subtotal <b class="money">${peso(t.subtotal)}</b></span>
      ${t.discount ? `<span>Discount <b class="money">−${peso(t.discount)}</b></span>` : ''}
      <span>Commission <b class="money">${peso(t.commission)}</b></span>
      <span class="grand">Total <b class="money">${peso(t.total)}</b></span>
      ${!currentClass() && editor.lines.some(l => l.catalog_item_id) ? '<span class="warn">Pick a vehicle class to price services</span>' : ''}
      ${missingPrice ? '<span class="warn">Some items have no price for this class</span>' : ''}
      ${overStock ? '<span class="warn">Quantity is more than what is in stock</span>' : ''}
      ${t.total < 0 ? '<span class="warn">Discount is more than the subtotal</span>' : ''}`;
  }

  $$('[data-add]', root).forEach(select => select.addEventListener('change', () => {
    if (select.dataset.add === 'part') {
      const part = partOf(Number(select.value));
      if (part) editor.lines.push({ kind: 'part', part_id: part.id, name: part.name, quantity: 1 });
    } else {
      const item = items.find(i => i.id === Number(select.value));
      if (item) editor.lines.push({ kind: item.kind, catalog_item_id: item.id, name: item.name });
    }
    select.value = '';
    renderLines();
  }));
  $('[data-add-custom]', root).addEventListener('click', () => {
    editor.lines.push({ kind: 'custom', name: '', price: 0, commission: 0 });
    renderLines();
    $$('[data-l="name"]', root).at(-1)?.focus();
  });
  field('vehicle_class').addEventListener('change', renderLines);
  field('discount').addEventListener('input', renderTotals);
  renderLines();

  // Matches AMOUNT_FIELDS in routes/jobs.js (payment method and tip are not shown for running jobs).
  const LOCKED_FIELDS = ['vehicle_class', 'discount'];
  if (locked) {
    LOCKED_FIELDS.forEach(key => { field(key).disabled = true; });
    $$('.line-adders select, .line-adders button, [data-lines] button, [data-lines] input', root).forEach(el => { el.disabled = true; });
  }

  // New job on today's date: Time in shows the current shop time and keeps up while the form is filled in,
  // until the user changes it. On another day it is left empty.
  const timeIn = field('time_in');
  let syncTime = () => {};
  if (!job && timeIn && autoTimeWhen) {
    let typed = false;
    const markTyped = () => { typed = true; };
    timeIn.addEventListener('input', markTyped);
    timeIn.addEventListener('change', markTyped);
    syncTime = () => { if (!typed) timeIn.value = autoTimeWhen() ? shopTime() : ''; };
    syncTime();
    const timer = setInterval(() => (timeIn.isConnected ? syncTime() : clearInterval(timer)), 5000);
  }

  return {
    syncTime: () => syncTime(),
    totals,
    lines: () => editor.lines.map(l => ({ ...l, ...linePrice(l) })),
    payload() {
      const out = {};
      $$('[data-f]', root).forEach(el => {
        const key = el.dataset.f;
        if (locked && LOCKED_FIELDS.includes(key)) return;
        out[key] = el.type === 'checkbox' ? el.checked : el.type === 'number' ? Number(el.value || 0) : el.value.trim();
      });
      if (!locked) {
        out.items = editor.lines.map(l => {
          if (l.id) return { id: l.id };
          if (l.kind === 'part') return { part_id: l.part_id, quantity: Number(l.quantity) || 0 };
          if (l.catalog_item_id) return { catalog_item_id: l.catalog_item_id };
          return { name: l.name.trim(), price: Number(l.price) || 0, commission: Number(l.commission) || 0 };
        });
      }
      return out;
    },
    // Returns an error message or null.
    validate() {
      if (!currentClass() && dept.catalog) return 'Choose a vehicle class';
      if (!editor.lines.length) return 'Add at least one item';
      if (editor.lines.some(l => l.kind === 'custom' && !l.id && !String(l.name).trim())) return 'Give each custom item a name';
      if (editor.lines.some(l => l.kind === 'part' && !l.id && !(Number(l.quantity) > 0))) return 'Enter a quantity for each part';
      if (totals().total < 0) return 'Discount cannot be more than the subtotal';
      return null;
    },
  };
}
