// Carwash tab: same-day job orders for one date.
import { $, $$, api, esc, peso, toast, todayLocal, addDays, prettyDate, formatTime, loadCatalog, classLabel, isOwner } from '../ui.js';
import { createJobEditor } from '../components/job-editor.js';
import { itemsSummary, reviewAndCreate, editJobModal, voidJob, restoreJob, showHistory } from '../components/job-actions.js';

const DEPARTMENT = 'carwash';
let root;
let current = { date: todayLocal(), jobs: [], day: null };
let newJobEditor = null;

function mount(el) {
  root = el;
  root.innerHTML = `
    <div class="view-header">
      <div><h1>Carwash</h1><div class="desc">Same-day job orders. They count on the day they are entered.</div></div>
      <div class="date-nav">
        <button class="btn ghost" type="button" data-shift="-1" aria-label="Previous day">‹</button>
        <input type="date" data-date>
        <button class="btn ghost" type="button" data-shift="1" aria-label="Next day">›</button>
        <button class="btn ghost" type="button" data-today>Today</button>
      </div>
    </div>
    <div data-banner></div>
    <div class="metrics-row" data-metrics></div>
    <div class="card" data-entry-card>
      <div class="section-header"><h2>New carwash job</h2><span class="subtle-badge" data-entry-date></span></div>
      <div data-editor></div>
      <div class="entry-actions"><button class="btn ghost" type="button" data-clear>Clear</button><button class="btn" type="button" data-review>Review job</button></div>
    </div>
    <div class="card">
      <div class="section-header">
        <h2>Carwash job orders</h2>
        <div class="job-filters">
          <input type="text" data-filter="detailer" placeholder="Filter detailer">
          <select data-filter="payment"><option value="">All payments</option><option>Cash</option><option>GCash</option></select>
          <select data-filter="paid"><option value="">Paid + unpaid</option><option value="paid">Customer paid</option><option value="unpaid">Unpaid</option></select>
          <label class="check"><input type="checkbox" data-filter="voided"> Show voided</label>
        </div>
      </div>
      <div class="table-wrap"><table class="jobs-table">
        <thead><tr><th>JO#</th><th>Time</th><th>Class</th><th>Plate</th><th>Items</th><th>Payment</th><th>Paid</th><th>Detailer</th>
          <th class="num">Total</th><th class="num">Comm.</th><th class="num">Net</th><th></th></tr></thead>
        <tbody data-jobs></tbody>
      </table></div>
    </div>`;

  $('[data-date]', root).addEventListener('change', e => { if (e.target.value) setDate(e.target.value); });
  $$('[data-shift]', root).forEach(b => b.addEventListener('click', () => setDate(addDays(current.date, Number(b.dataset.shift)))));
  $('[data-today]', root).addEventListener('click', () => setDate(todayLocal()));
  $$('[data-filter]', root).forEach(el => el.addEventListener(el.tagName === 'INPUT' && el.type === 'text' ? 'input' : 'change', renderJobs));
  $('[data-clear]', root).addEventListener('click', resetEditor);
  $('[data-review]', root).addEventListener('click', () => reviewAndCreate({
    editor: newJobEditor, department: DEPARTMENT, jobDate: current.date,
    onCreated: async () => { resetEditor(); await reload(); },
  }));
}

async function show() {
  await loadCatalog(true);
  resetEditor();
  await setDate(current.date);
}

function resetEditor() {
  newJobEditor = createJobEditor($('[data-editor]', root), { department: DEPARTMENT, autoTimeWhen: () => current.date === todayLocal() });
}

async function setDate(date) {
  current.date = date;
  $('[data-date]', root).value = date;
  $('[data-entry-date]', root).textContent = prettyDate(date);
  newJobEditor?.syncTime();
  await reload();
}

async function reload() {
  const date = current.date;
  const [jobs, day] = await Promise.all([
    api('GET', `/jobs?date=${date}&department=${DEPARTMENT}`),
    api('GET', `/days/${date}`),
  ]);
  if (date !== current.date) return; // user moved on while loading
  current.jobs = jobs;
  current.day = day;
  render();
}

const dayLocked = () => Boolean(current.day?.meta.closed_at) && !isOwner();

function render() {
  const s = current.day.summary.departments[DEPARTMENT];
  const closed = current.day.meta.closed_at;
  $('[data-banner]', root).innerHTML = closed
    ? `<div class="banner">This day was closed by ${esc(current.day.meta.closed_by || 'someone')}. ${isOwner() ? 'As owner you can still make changes, or reopen it on the EOD screen.' : 'Ask the owner to reopen it if something needs fixing.'}</div>`
    : '';
  $('[data-metrics]', root).innerHTML = `
    <div class="metric"><div class="label">Vehicles</div><div class="value">${s.jobs}</div></div>
    <div class="metric"><div class="label">Collected</div><div class="value">${peso(s.collected)}</div></div>
    <div class="metric"><div class="label">Unpaid (receivable)</div><div class="value amber">${peso(s.receivables)}</div></div>
    <div class="metric"><div class="label">Commission</div><div class="value amber">${peso(s.commission)}</div></div>
    <div class="metric"><div class="label">Net (collected − comm.)</div><div class="value teal">${peso(s.net)}</div></div>`;
  $('[data-entry-card]', root).hidden = dayLocked();
  renderJobs();
}

function filteredJobs() {
  const f = Object.fromEntries($$('[data-filter]', root).map(el => [el.dataset.filter, el.type === 'checkbox' ? el.checked : el.value.trim().toLowerCase()]));
  return current.jobs.filter(j =>
    (f.voided || !j.voided_at)
    && (!f.detailer || String(j.detailer || '').toLowerCase().includes(f.detailer))
    && (!f.payment || j.payment_method.toLowerCase() === f.payment)
    && (!f.paid || (f.paid === 'paid') === j.payment_received));
}

function renderJobs() {
  const tbody = $('[data-jobs]', root);
  const jobs = filteredJobs();
  if (!jobs.length) {
    tbody.innerHTML = `<tr><td colspan="12"><div class="empty-state">${current.jobs.length ? 'No job orders match the filters.' : 'No carwash job orders yet for this date.'}</div></td></tr>`;
    return;
  }
  const locked = dayLocked();
  tbody.innerHTML = jobs.map(j => {
    const t = j.totals;
    const off = locked || j.voided_at ? 'disabled' : '';
    return `<tr data-id="${j.id}" class="${j.voided_at ? 'voided' : ''} ${j.payment_method === 'GCash' ? 'gcash-row' : 'cash-row'}">
      <td class="jo-number">${esc(j.jo_number || '—')}${j.voided_at ? `<div class="void-note" title="${esc(j.void_reason)}">VOID · ${esc(j.void_reason)}</div>` : ''}</td>
      <td class="time-cell"><div class="time-in"><span class="time-label">In</span> <b>${esc(formatTime(j.time_in) || '—')}</b></div>
        <label class="time-out"><span class="time-label">Out</span><input type="time" data-inline="time_out" value="${esc(j.time_out)}" ${off} aria-label="Time out for ${esc(j.jo_number)}"></label></td>
      <td>${esc(classLabel(j.vehicle_class))}</td>
      <td>${esc(j.plate || '—')}</td>
      <td class="items-cell">${itemsSummary(j)}</td>
      <td><select data-inline="payment_method" ${off}>${['Cash', 'GCash'].map(p => `<option ${p === j.payment_method ? 'selected' : ''}>${p}</option>`).join('')}</select></td>
      <td><label class="check"><input type="checkbox" data-inline="payment_received" ${j.payment_received ? 'checked' : ''} ${off}> Paid</label></td>
      <td>${esc(j.detailer || '—')}</td>
      <td class="num money">${peso(t.total)}</td>
      <td class="num money amber-text">${peso(t.commission)}</td>
      <td class="num money pos">${peso(t.net)}</td>
      <td class="row-actions">
        ${j.voided_at
          ? (isOwner() ? '<button class="btn ghost small" type="button" data-act="restore">Restore</button>' : '')
          : `<button class="btn ghost small" type="button" data-act="edit" ${locked ? 'disabled' : ''}>Edit</button>
             ${isOwner() ? '<button class="icon-btn" type="button" data-act="void" title="Void job">✕</button>' : ''}`}
        <button class="icon-btn" type="button" data-act="history" title="Change history">⟲</button>
      </td>
    </tr>`;
  }).join('');

  $$('[data-inline]', tbody).forEach(el => el.addEventListener('change', () => {
    const id = Number(el.closest('tr').dataset.id);
    patchJob(id, { [el.dataset.inline]: el.type === 'checkbox' ? el.checked : el.value }, el.closest('tr'));
  }));
  $$('[data-act]', tbody).forEach(el => el.addEventListener('click', () => {
    const job = current.jobs.find(j => j.id === Number(el.closest('tr').dataset.id));
    const actions = {
      edit: () => editJobModal(job, reload),
      void: () => voidJob(job, reload),
      restore: () => restoreJob(job, reload),
      history: () => showHistory(job),
    };
    actions[el.dataset.act]();
  }));
}

async function patchJob(id, body, row) {
  row?.classList.add('saving');
  try {
    const updated = await api('PATCH', `/jobs/${id}`, body);
    current.jobs = current.jobs.map(j => (j.id === id ? updated : j));
    current.day = await api('GET', `/days/${current.date}`);
    render();
    toast('Saved');
  } catch {
    await reload();
  }
}

export default { mount, show };
