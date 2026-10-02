// Job order form: vehicle class + any number of services, add-ons and custom lines.
// Used for new jobs (Daily Log card) and for editing existing jobs (modal).
import { $, $$, esc, peso, state, activeClasses, departmentOf } from '../ui.js';

const KIND_LABEL = { service: 'Service', addon: 'Add-on', custom: 'Custom' };

// department: which catalog items are offered. Running departments (detailing, tint/PPF) record
// payment with Mark paid instead of the checkbox, and lock the amount once paid.
export function createJobEditor(root, { job = null, department = job?.department || 'carwash' } = {}) {
  const running = departmentOf(department).running;
  const locked = Boolean(running && job?.paid_on);
  const originalClass = job?.vehicle_class || '';
  const editor = {
    lines: (job?.items || []).map(i => ({ id: i.id, kind: i.kind, catalog_item_id: i.catalog_item_id, name: i.name, price: i.price, commission: i.commission })),
  };
  const v = (key, fallback = '') => esc(job?.[key] ?? fallback);
  const classes = activeClasses();
  if (job?.vehicle_class && !classes.some(c => c.code === job.vehicle_class)) classes.push({ code: job.vehicle_class, label: job.vehicle_class });
  const items = state.catalog.items.filter(i => i.department === department);

  root.innerHTML = `
    <div class="job-editor">
      <div class="entry-grid">
        <div><label>Vehicle class</label><select data-f="vehicle_class"><option value="">Select</option>
          ${classes.map(c => `<option value="${esc(c.code)}" ${c.code === job?.vehicle_class ? 'selected' : ''}>${esc(c.label)}</option>`).join('')}</select></div>
        <div><label>Plate</label><input type="text" data-f="plate" value="${v('plate')}" placeholder="e.g. NDR7377" maxlength="20"></div>
        <div><label>Detailer</label><input type="text" data-f="detailer" value="${v('detailer')}" placeholder="Name" maxlength="80"></div>
        <div><label>Time in</label><input type="time" data-f="time_in" value="${v('time_in')}"></div>
        ${job ? `<div><label>Time out</label><input type="time" data-f="time_out" value="${v('time_out')}"></div>` : ''}
        ${running ? '' : `<div><label>Payment</label><select data-f="payment_method">
          ${['Cash', 'GCash'].map(p => `<option ${p === (job?.payment_method || 'Cash') ? 'selected' : ''}>${p}</option>`).join('')}</select></div>
        <div class="check-cell"><label class="check"><input type="checkbox" data-f="payment_received" ${job?.payment_received ? 'checked' : ''}> Customer paid</label></div>`}
      </div>

      ${locked ? '<div class="banner">This job is already paid, so its items, class, discount and tip are locked. Undo the payment first to change them.</div>' : ''}
      <div class="line-editor">
        <div class="line-adders">
          <select data-add="service"><option value="">+ Add service…</option>
            ${items.filter(i => i.kind === 'service').map(i => `<option value="${i.id}">${esc(i.name)}</option>`).join('')}</select>
          <select data-add="addon"><option value="">+ Add add-on…</option>
            ${items.filter(i => i.kind === 'addon').map(i => `<option value="${i.id}">${esc(i.name)}</option>`).join('')}</select>
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

  // Price shown for a line: frozen for saved lines unless the class changed (server re-prices then).
  function linePrice(line) {
    const reprice = line.catalog_item_id && (!line.id || currentClass() !== originalClass);
    if (!reprice) return { price: Number(line.price) || 0, commission: Number(line.commission) || 0 };
    const p = items.find(i => i.id === line.catalog_item_id)?.prices[currentClass()];
    return { price: p?.price || 0, commission: p?.commission || 0 };
  }

  function totals() {
    const priced = editor.lines.map(linePrice);
    const subtotal = priced.reduce((s, p) => s + p.price, 0);
    const commission = priced.reduce((s, p) => s + p.commission, 0);
    const discount = Number(field('discount').value || 0);
    return { subtotal, commission, discount, total: subtotal - discount };
  }

  function renderLines() {
    const box = $('[data-lines]', root);
    if (!editor.lines.length) {
      box.innerHTML = '<div class="lines-empty">No items yet. Add a service, add-on or custom item above.</div>';
    } else {
      box.innerHTML = editor.lines.map((line, index) => {
        const p = linePrice(line);
        const editable = line.kind === 'custom' && !line.id;
        return `<div class="line-row" data-index="${index}">
          <span class="kind-pill ${line.kind}">${KIND_LABEL[line.kind]}</span>
          ${editable
            ? `<input type="text" data-l="name" value="${esc(line.name)}" placeholder="Item name" maxlength="120">
               <input type="number" min="0" step="0.01" data-l="price" value="${line.price || ''}" placeholder="Price">
               <input type="number" min="0" step="0.01" data-l="commission" value="${line.commission || ''}" placeholder="Comm.">`
            : `<span class="line-name">${esc(line.name)}</span><span class="money">${peso(p.price)}</span><span class="money muted">${peso(p.commission)}</span>`}
          <button class="icon-btn" type="button" data-remove title="Remove">✕</button>
        </div>`;
      }).join('');
    }
    $$('.line-row', box).forEach(row => {
      const line = editor.lines[Number(row.dataset.index)];
      $('[data-remove]', row).addEventListener('click', () => { editor.lines.splice(Number(row.dataset.index), 1); renderLines(); });
      $$('[data-l]', row).forEach(input => input.addEventListener('input', () => {
        line[input.dataset.l] = input.dataset.l === 'name' ? input.value : Number(input.value || 0);
        renderTotals();
      }));
    });
    renderTotals();
  }

  function renderTotals() {
    const t = totals();
    const missingPrice = currentClass() && editor.lines.some(l => l.catalog_item_id && linePrice(l).price === 0);
    $('[data-totals]', root).innerHTML = `
      <span>Subtotal <b class="money">${peso(t.subtotal)}</b></span>
      ${t.discount ? `<span>Discount <b class="money">−${peso(t.discount)}</b></span>` : ''}
      <span>Commission <b class="money">${peso(t.commission)}</b></span>
      <span class="grand">Total <b class="money">${peso(t.total)}</b></span>
      ${!currentClass() && editor.lines.some(l => l.catalog_item_id) ? '<span class="warn">Pick a vehicle class to price services</span>' : ''}
      ${missingPrice ? '<span class="warn">Some items have no price for this class</span>' : ''}
      ${t.total < 0 ? '<span class="warn">Discount is more than the subtotal</span>' : ''}`;
  }

  $$('[data-add]', root).forEach(select => select.addEventListener('change', () => {
    const item = items.find(i => i.id === Number(select.value));
    if (item) editor.lines.push({ kind: item.kind, catalog_item_id: item.id, name: item.name });
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

  return {
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
        out.items = editor.lines.map(l => (l.id ? { id: l.id } : l.catalog_item_id ? { catalog_item_id: l.catalog_item_id }
          : { name: l.name.trim(), price: Number(l.price) || 0, commission: Number(l.commission) || 0 }));
      }
      return out;
    },
    // Returns an error message or null.
    validate() {
      if (!currentClass()) return 'Choose a vehicle class';
      if (!editor.lines.length) return 'Add at least one service, add-on or custom item';
      if (editor.lines.some(l => l.kind === 'custom' && !l.id && !String(l.name).trim())) return 'Give each custom item a name';
      if (totals().total < 0) return 'Discount cannot be more than the subtotal';
      return null;
    },
  };
}
