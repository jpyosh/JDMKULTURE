// Invoice & Forms (owner and staff): the shop's four customer papers (Service Invoice, Waiver & Release,
// Vehicle Release, Aftercare & Warranty, from "JDM Kulture Garage Operational Docs") filled in on screen and printed
// as A4 pages. Nothing is sent to the server or booked as a sale: what is typed stays in this browser tab
// (sessionStorage, wiped at sign-out) until New customer. The papers' wording is the PDF's, word for word.
// Print rules are in style.css (@media print); only the papers ticked under "Print" come out.
import { $, $$, esc, todayLocal, toast } from '../ui.js';

const STORE = 'gmqa.forms.draft';
const LINES = 5; // the paper invoice has five service lines
const DOCS = [
  { key: 'invoice', label: 'Service Invoice' },
  { key: 'waiver', label: 'Waiver & Release' },
  { key: 'release', label: 'Vehicle Release' },
  { key: 'aftercare', label: 'Aftercare & Warranty' },
];
const PAY = ['Cash', 'GCash', 'Bank Transfer', 'Credit Card'];

// Mirrors invoiceTotals in lib/calc.js (tested there): AMOUNT is each line's amount; subtotal less discount is the total.
const round2 = n => Math.round(n * 100) / 100;
const amount = v => { const n = Number(String(v ?? '').replace(/[₱,\s]/g, '')); return Number.isFinite(n) ? n : 0; };
function invoiceTotals(lines, discount) {
  const subtotal = round2(lines.reduce((t, l) => t + amount(l.amount), 0));
  const off = round2(amount(discount));
  return { subtotal, discount: off, total: round2(subtotal - off) };
}
const money = n => n.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

let root;

const band = title => `
  <header class="doc-band">
    <img class="doc-logo" src="assets/jdm-kulture-logo.png" alt="">
    <div class="doc-brand"><div class="doc-name">JDM KULTURE</div><div class="doc-sub">GARAGE &amp; AUTOSPA</div></div>
    <div class="doc-badge">${title}</div>
  </header>`;
const foot = '<footer class="doc-foot">JDM Kulture Garage &amp; Autospa</footer>';
// A label and the line to write on. k: what it holds; the same k on another paper shows the same value.
// A date prints written out ("November 25, 2026"), never 11/25 or 25/11, whatever the browser's language.
const field = (label, k, { type = 'text', mode = '' } = {}) => `
  <label class="doc-field"><span>${label}</span>
    <input type="${type}" data-k="${k}" autocomplete="off"${mode ? ` inputmode="${mode}"` : ''}>${type === 'date' ? '<span class="doc-date-text" data-date-text></span>' : ''}</label>`;
const sign = label => `<div class="doc-field"><span>${label}</span><span class="doc-blank"></span></div>`;
const box = (attr, label) => `<label class="doc-check"><input type="checkbox" ${attr}><span>${label}</span></label>`;
const list = items => `<ol class="doc-list">${items.map(i => `<li>${i}</li>`).join('')}</ol>`;
const bullets = (items, cls = '') => `<ul class="doc-bullets ${cls}">${items.map(i => `<li>${i}</li>`).join('')}</ul>`;
const lineRow = () => `
  <tr data-line>
    <td><input type="text" data-l="qty" inputmode="decimal" autocomplete="off" aria-label="Qty"></td>
    <td><textarea data-l="desc" rows="1" aria-label="Description of service"></textarea></td>
    <td><input type="text" data-l="amount" inputmode="decimal" autocomplete="off" aria-label="Amount"></td>
    <td><textarea data-l="remarks" rows="1" aria-label="Remarks"></textarea></td>
  </tr>`;

const INVOICE = `
  <article class="paper" data-doc="invoice">${band('SERVICE INVOICE')}
    <div class="doc-grid"><div></div>${field('Date:', 'date', { type: 'date' })}</div>
    <h3 class="doc-h">CUSTOMER INFORMATION</h3>
    <div class="doc-grid">${field('Customer Name:', 'name')}${field('Contact Number:', 'contact', { mode: 'tel' })}</div>
    <div class="doc-grid one">${field('Email Address:', 'email', { mode: 'email' })}</div>
    <h3 class="doc-h">VEHICLE INFORMATION</h3>
    <div class="doc-grid">${field('Make:', 'make')}${field('Color:', 'color')}</div>
    <div class="doc-grid">${field('Model:', 'model')}${field('Plate Number:', 'plate')}</div>
    <div class="doc-grid">${field('Year:', 'year', { mode: 'numeric' })}${field('Mileage:', 'mileage')}</div>
    <h3 class="doc-h">SERVICES PERFORMED</h3>
    <table class="doc-table">
      <colgroup><col style="width:10%"><col style="width:45%"><col style="width:20%"><col style="width:25%"></colgroup>
      <thead><tr><th>QTY</th><th>DESCRIPTION OF SERVICE</th><th>AMOUNT</th><th>REMARKS</th></tr></thead>
      <tbody data-lines></tbody>
    </table>
    <div class="doc-line-actions screen-only">
      <button type="button" class="btn ghost small" data-add-line>+ Add line</button>
      <button type="button" class="btn ghost small" data-remove-line>− Remove last line</button>
    </div>
    <div class="doc-totals">
      <div class="doc-field"><span>Subtotal: ₱</span><span class="doc-out" data-subtotal></span></div>
      <label class="doc-field"><span>Discount: ₱</span><input type="text" data-k="discount" inputmode="decimal" autocomplete="off"></label>
      <div class="doc-field"><span>TOTAL DUE: ₱</span><span class="doc-out" data-total></span></div>
    </div>
    <h3 class="doc-h">PAYMENT DETAILS</h3>
    <div class="doc-checks">${PAY.map(p => box(`data-pay="${p}"`, p)).join('')}
      <label class="doc-check other"><input type="checkbox" data-pay="Other"><span>Other:</span><input type="text" data-k="pay_other" autocomplete="off" aria-label="Other payment"></label>
    </div>
    <h3 class="doc-h">REMARKS</h3>
    <textarea class="doc-remarks" data-k="remarks" rows="4" aria-label="Remarks"></textarea>
    ${foot}
  </article>`;

const WAIVER = `
  <article class="paper" data-doc="waiver">${band('WAIVER &amp; RELEASE')}
    <p class="doc-p">I, the undersigned customer, voluntarily authorize JDM Kulture Garage and Autospa to perform the requested services on my vehicle. By signing this document, I acknowledge and agree to the following:</p>
    ${list([
      'I confirm that the information I have provided about my vehicle is accurate and complete.',
      'I understand that automotive detailing, paint protection film (PPF), ceramic coating, and window tint installation are cosmetic enhancement services and cannot repair or conceal pre-existing damage, defects, or poor paint conditions.',
      'I acknowledge that any scratches, dents, paint chips, fading, oxidation, rock chips, rust, previous repairs, repainted panels, cracked glass, damaged trim, or other pre-existing conditions are not the responsibility of JDM Kulture Garage and Autospa.',
      'I understand that paint protection film and window tint require a curing period. Temporary moisture, haze, or small bubbles may be visible during this period and are considered normal.',
      'I agree to follow all aftercare instructions provided by JDM Kulture Garage and Autospa. Failure to follow these instructions may void any applicable workmanship or product warranty.',
      'I understand that warranty coverage does not apply to damage caused by accidents, improper maintenance, misuse, neglect, unauthorized repairs or modifications, chemical exposure, vandalism, natural disasters, or normal wear and tear.',
      'I authorize JDM Kulture Garage and Autospa to move, test, and operate my vehicle within the premises as reasonably necessary to complete the requested services.',
      'I understand that personal belongings and valuables should be removed before service. JDM Kulture Garage and Autospa is not responsible for the loss of cash, jewelry, electronics, documents, or other personal items left inside the vehicle.',
      'I authorize JDM Kulture Garage and Autospa to photograph my vehicle before, during, and after service for documentation, quality control, and warranty records. Use of these photos for promotional and marketing purposes is subject to my choice below.',
    ])}
    <div class="doc-box">
      <div class="doc-box-title">MARKETING CONSENT</div>
      ${box('data-consent="allow"', 'I allow JDM Kulture Garage and Autospa to use photos or videos of my vehicle for social media and marketing purposes.')}
      ${box('data-consent="deny"', 'I do not allow photos or videos of my vehicle to be used for promotional or marketing purposes.')}
    </div>
    <ol class="doc-list" start="10"><li>I have inspected my vehicle upon release, or I agree to inspect it before leaving the premises. Any concerns regarding workmanship should be reported before leaving whenever reasonably possible.</li></ol>
    <p class="doc-red doc-center">By signing below, I confirm that I have read, understood, and voluntarily agree to the Aftercare Instructions, Warranty Terms, and this Customer Waiver.</p>
    <div class="doc-signs">
      <div class="doc-grid">${field('Customer Name:', 'name')}${field('Date:', 'date', { type: 'date' })}</div>
      <div class="doc-grid">${sign('Customer Signature:')}${field('JDM Kulture Representative:', 'rep')}</div>
    </div>
    ${foot}
  </article>`;

const RELEASE = `
  <article class="paper" data-doc="release">${band('VEHICLE RELEASE')}
    <p class="doc-p doc-strong">This Quitclaim and Vehicle Release Waiver (“Agreement”) is executed by the undersigned client (“Client”) in favor of JDM Kulture Garage and Autospa (“Company”) upon release of the serviced vehicle.</p>
    <h3 class="doc-h">I. CLIENT INFORMATION</h3>
    <div class="doc-grid">${field('Name:', 'name')}${field('Vehicle Make/Model:', 'vehicle')}</div>
    <div class="doc-grid">${field('Contact Number:', 'contact', { mode: 'tel' })}${field('Plate Number:', 'plate')}</div>
    <div class="doc-grid one">${field('Address:', 'address')}</div>
    <div class="doc-grid">${field('Date of Service:', 'date', { type: 'date' })}${field('Date of Release:', 'date_release', { type: 'date' })}</div>
    <h3 class="doc-h">II. DECLARATION</h3>
    <p class="doc-p">I, the undersigned Client, hereby acknowledge that I have received my vehicle from JDM Kulture Garage and Autospa in good order and condition, subject to the services availed. I confirm that the requested services have been completed to my satisfaction.</p>
    <h3 class="doc-h">III. QUITCLAIM AND WAIVER</h3>
    <p class="doc-p">For and in consideration of the services rendered, I hereby voluntarily and freely:</p>
    ${list([
      'Release, waive, and discharge JDM Kulture Garage and Autospa, its owners, management, and employees from any and all claims, liabilities, damages, or causes of action arising from or related to the services performed on my vehicle.',
      'Confirm that any scratches, dents, or damage existing on the vehicle prior to service have been properly declared or documented.',
      'Agree that failure to report any concern, issue, or damage at the time of vehicle release shall be deemed a waiver of any future claim against JDM Kulture Garage and Autospa.',
    ])}
    <h3 class="doc-h">IV. CONDITIONS</h3>
    <p class="doc-p">The Client agrees to the following conditions:</p>
    ${list([
      'The Company shall not be held liable for any pre-existing damage that was not declared prior to service.',
      'The Company shall not be held responsible for the loss of any personal belongings left inside the vehicle.',
      'The Company shall not be held liable for mechanical, electrical, or internal issues that are not directly related to the services performed.',
      'Any claims must be reported immediately upon inspection and before leaving the premises.',
      '<span class="doc-red">Vehicles not claimed within two (2) days after completion may be subject to storage fees.</span>',
      'The Company reserves the right to document the condition of the vehicle before, during, and after service.',
    ])}
    <div class="doc-signs">
      <div class="doc-grid">${field('Client Name:', 'name')}${field('Date:', 'date_release', { type: 'date' })}</div>
      <div class="doc-grid">${sign('Client Signature:')}${field('Released By:', 'released_by')}</div>
    </div>
    ${foot}
  </article>`;

const care = (title, items) => `<section class="doc-care"><h3 class="doc-care-h">${title}</h3>${bullets(items)}</section>`;
const AFTERCARE = `
  <article class="paper" data-doc="aftercare">${band('AFTERCARE &amp; WARRANTY')}
    <div class="doc-care-grid">
      ${care('WINDOW TINT AFTERCARE', [
        'Do not roll down the windows for <b>30 days</b> after installation.',
        'Do not clean the inside of the windows for <b>7 days</b>.',
        'Small water bubbles or haze are normal during the curing process and should disappear.',
        'Avoid ammonia-based glass cleaners.',
        'Clean only with a soft microfiber cloth and a tint-safe cleaner.',
      ])}
      ${care('PPF AFTERCARE', [
        'Do not wash the vehicle for <b>7 days</b> after installation.',
        'Avoid pressure washing directly on the edges of the film.',
        'Do not wax or polish the film during the <b>60-day</b> curing period.',
        'Hand washing with a pH-neutral shampoo is recommended.',
        'Return for a complimentary inspection if one has been scheduled.',
      ])}
      ${care('CERAMIC COATING AFTERCARE', [
        'Do not wash the vehicle for <b>7 days</b> after application.',
        'Avoid rain, sprinklers, and other contaminants during curing.',
        'Wash only with a pH-neutral car shampoo.',
        'Avoid abrasive cleaners, compounds, and polishing.',
        'Regular maintenance washes help maximize performance.',
      ])}
      ${care('AUTO DETAILING CARE', [
        'Wash your vehicle using the two-bucket method.',
        'Use clean microfiber towels only.',
        'Avoid automatic brush car washes.',
        'Remove bird droppings, tree sap, and bug splatter as soon as possible.',
        'Schedule regular maintenance to preserve your vehicle’s appearance.',
      ])}
    </div>
    <h3 class="doc-h">WARRANTY TERMS</h3>
    <p class="doc-p">Warranty coverage applies only to the products installed and the workmanship provided by JDM Kulture Garage and Autospa. The warranty does not cover damage caused by:</p>
    ${bullets(['Accidents or collisions', 'Improper washing or maintenance', 'Chemical spills or misuse', 'Vandalism',
      'Natural disasters or acts of God', 'Unauthorized repairs, modifications, or removal', 'Normal wear and tear'], 'doc-cols')}
    <p class="doc-p">For warranty questions, please contact JDM Kulture Garage &amp; Autospa and keep your service invoice.</p>
    ${foot}
  </article>`;

function mount(el) {
  root = el;
  root.innerHTML = `
    <div class="view-header">
      <div><h1>Invoice &amp; Forms</h1><div class="desc">Fill in the customer's papers on screen, then print them. Type the customer once; it shows on every paper.</div></div>
    </div>
    <div class="card forms-bar">
      <div class="forms-picks" role="group" aria-label="Papers to print"><span class="muted small">Print:</span>
        ${DOCS.map(d => `<label class="check-inline"><input type="checkbox" data-pick="${d.key}" checked> ${esc(d.label)}</label>`).join('')}
      </div>
      <div class="actions">
        <button type="button" class="btn ghost" data-clear>New customer</button>
        <button type="button" class="btn" data-print>Print</button>
      </div>
      <p class="hint">Not saved in the app or counted as a sale: it stays in this browser tab until New customer or sign-out.
        Signatures are left blank for pen. In the print window pick A4 paper.</p>
    </div>
    <div class="papers">${INVOICE}${WAIVER}${RELEASE}${AFTERCARE}</div>`;

  root.addEventListener('input', onInput);
  root.addEventListener('change', onChange);
  $('[data-add-line]', root).addEventListener('click', () => {
    addLine();
    save();
    $$('[data-line]', root).at(-1).querySelector('[data-l="desc"]').focus();
  });
  $('[data-remove-line]', root).addEventListener('click', () => {
    const rows = $$('[data-line]', root);
    if (rows.length <= LINES) return toast(`The invoice keeps at least ${LINES} lines`, 'error');
    rows.at(-1).remove();
    totals();
    save();
  });
  $('[data-clear]', root).addEventListener('click', () => {
    if (typed() && !window.confirm('Clear every paper for a new customer?')) return;
    reset();
    save();
    toast('Cleared for a new customer');
  });
  $('[data-print]', root).addEventListener('click', () => {
    if (!$$('[data-pick]:checked', root).length) return toast('Tick at least one paper to print', 'error');
    window.print();
  });
  restore();
}

// Rows grow with what is typed so a long description is never cut off on paper.
const grow = el => { el.style.height = 'auto'; el.style.height = `${el.scrollHeight}px`; };
// Remarks fills the rest of the page (style.css); a longer note makes it taller instead of being cut off.
const growRemarks = () => {
  const el = $('.doc-remarks', root);
  el.style.minHeight = '';
  if (el.scrollHeight > el.clientHeight) el.style.minHeight = `${el.scrollHeight + 2}px`;
};
const growAll = () => { $$('[data-line] textarea', root).forEach(grow); growRemarks(); };

function addLine() { $('[data-lines]', root).insertAdjacentHTML('beforeend', lineRow()); }

function totals() {
  const lines = $$('[data-line]', root).map(r => ({ amount: r.querySelector('[data-l="amount"]').value }));
  const discount = $('[data-k="discount"]', root).value;
  const blank = !lines.some(l => l.amount.trim()) && !discount.trim();
  const t = invoiceTotals(lines, discount);
  $('[data-subtotal]', root).textContent = blank ? '' : money(t.subtotal);
  $('[data-total]', root).textContent = blank ? '' : money(t.total);
}

// Vehicle Make/Model on the release follows Make and Model until someone types in it.
function followVehicle() {
  const vehicle = $('[data-k="vehicle"]', root);
  if (vehicle.hasAttribute('data-typed')) return;
  vehicle.value = [$('[data-k="make"]', root).value, $('[data-k="model"]', root).value].map(s => s.trim()).filter(Boolean).join(' ');
}

const longDate = v => (/^\d{4}-\d{2}-\d{2}$/.test(v)
  ? new Date(`${v}T00:00:00Z`).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : '');
const showDates = () => $$('[data-date-text]', root).forEach(s => { s.textContent = longDate(s.previousElementSibling.value); });

function syncField(input) {
  const k = input.dataset.k;
  $$(`[data-k="${k}"]`, root).forEach(other => { if (other !== input) other.value = input.value; });
  if (input.type === 'date') showDates();
  if (k === 'vehicle') input.toggleAttribute('data-typed', Boolean(input.value.trim()));
  if (k === 'make' || k === 'model') followVehicle();
}

function onInput(e) {
  const t = e.target;
  if (t.matches('[data-k]')) syncField(t);
  if (t.matches('[data-line] textarea')) grow(t);
  if (t.matches('.doc-remarks')) growRemarks();
  if (t.matches('[data-l="amount"], [data-k="discount"]')) totals();
  if (t.closest('.papers')) save();
}

function onChange(e) {
  const t = e.target;
  if (t.matches('[data-k]')) syncField(t); // date fields and pasted values
  if (t.matches('[data-consent]') && t.checked) $$('[data-consent]', root).forEach(c => { if (c !== t) c.checked = false; });
  if (t.matches('[data-pick]')) $(`.paper[data-doc="${t.dataset.pick}"]`, root).classList.toggle('skip', !t.checked);
  save();
}

function collect() {
  const fields = {};
  $$('[data-k]', root).forEach(i => { fields[i.dataset.k] = i.value; });
  return {
    fields,
    vehicleTyped: $('[data-k="vehicle"]', root).hasAttribute('data-typed'),
    lines: $$('[data-line]', root).map(r => Object.fromEntries($$('[data-l]', r).map(i => [i.dataset.l, i.value]))),
    pay: $$('[data-pay]:checked', root).map(i => i.dataset.pay),
    consent: $('[data-consent]:checked', root)?.dataset.consent || '',
    skip: $$('[data-pick]:not(:checked)', root).map(i => i.dataset.pick),
  };
}

function typed() {
  const d = collect();
  return Object.entries(d.fields).some(([k, v]) => v && !k.startsWith('date'))
    || d.lines.some(l => Object.values(l).some(Boolean)) || d.pay.length > 0 || Boolean(d.consent);
}

function save() {
  try { sessionStorage.setItem(STORE, JSON.stringify(collect())); } catch { /* storage blocked: the papers just don't survive a refresh */ }
}

function apply(d) {
  $('[data-lines]', root).innerHTML = '';
  const lines = d.lines || [];
  for (let i = 0; i < Math.max(LINES, lines.length); i += 1) addLine();
  $$('[data-line]', root).forEach((row, i) => $$('[data-l]', row).forEach(input => { input.value = lines[i]?.[input.dataset.l] || ''; }));
  const today = todayLocal();
  const fields = { date: today, date_release: today, ...(d.fields || {}) };
  $$('[data-k]', root).forEach(input => { input.value = fields[input.dataset.k] || ''; });
  showDates();
  $('[data-k="vehicle"]', root).toggleAttribute('data-typed', Boolean(d.vehicleTyped));
  followVehicle();
  $$('[data-pay]', root).forEach(i => { i.checked = (d.pay || []).includes(i.dataset.pay); });
  $$('[data-consent]', root).forEach(i => { i.checked = i.dataset.consent === d.consent; });
  $$('[data-pick]', root).forEach(i => {
    i.checked = !(d.skip || []).includes(i.dataset.pick);
    $(`.paper[data-doc="${i.dataset.pick}"]`, root).classList.toggle('skip', !i.checked);
  });
  totals();
  growAll();
}

// New customer: every paper blank again with today's date; which papers to print stays as picked.
function reset() { apply({ skip: collect().skip }); }

function restore() {
  let d = null;
  try { d = JSON.parse(sessionStorage.getItem(STORE)); } catch { /* nothing saved */ }
  apply(d || {});
}

// Sign-out wipes what was typed, so the next person never sees the previous customer.
export const clearFormsDraft = () => { try { sessionStorage.removeItem(STORE); } catch { /* storage blocked */ } };

export default { mount, show: () => growAll() };
