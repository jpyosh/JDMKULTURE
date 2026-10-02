import { $, $$, api, esc, peso, toast, busy, todayLocal, addDays, prettyDate, openModal, closeModal, modalHeader,
  loadCatalog, classLabel, isOwner } from '../ui.js';
import { createJobEditor } from '../components/job-editor.js';

let root;
let current = { date: todayLocal(), jobs: [], day: null };
let newJobEditor = null;

function mount(el) {
  root = el;
  root.innerHTML = `
    <div class="view-header">
      <div><h1>Daily Log</h1><div class="desc">Job orders price themselves from the Pricing Matrix and keep that price forever.</div></div>
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
      <div class="section-header"><h2>New job order</h2><span class="subtle-badge" data-entry-date></span></div>
      <div data-editor></div>
      <div class="entry-actions"><button class="btn ghost" type="button" data-clear>Clear</button><button class="btn" type="button" data-review>Review job</button></div>
    </div>
    <div class="card">
      <div class="section-header">
        <h2>Job orders</h2>
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
  $('[data-review]', root).addEventListener('click', reviewNewJob);
}

async function show() {
  await loadCatalog(true);
  resetEditor();
  await setDate(current.date);
}

function resetEditor() {
  newJobEditor = createJobEditor($('[data-editor]', root));
}

async function setDate(date) {
  current.date = date;
  $('[data-date]', root).value = date;
  $('[data-entry-date]', root).textContent = prettyDate(date);
  await reload();
}

async function reload() {
  const date = current.date;
  const [jobs, day] = await Promise.all([api('GET', `/jobs?date=${date}`), api('GET', `/days/${date}`)]);
  if (date !== current.date) return; // user moved on while loading
  current.jobs = jobs;
  current.day = day;
  render();
}

const dayLocked = () => Boolean(current.day?.meta.closed_at) && !isOwner();

function render() {
  const s = current.day.summary;
  const closed = current.day.meta.closed_at;
  $('[data-banner]', root).innerHTML = closed
    ? `<div class="banner">This day was closed by ${esc(current.day.meta.closed_by || 'someone')}. ${isOwner() ? 'As owner you can still make changes, or reopen it on the EOD screen.' : 'Ask the owner to reopen it if something needs fixing.'}</div>`
    : '';
  $('[data-metrics]', root).innerHTML = `
    <div class="metric"><div class="label">Vehicles</div><div class="value">${s.vehicles}</div></div>
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

function itemsSummary(job) {
  return job.items.map(i => `<span class="item-chip ${i.kind}" title="${esc(i.name)} — ${peso(i.price)}">${esc(i.name)}</span>`).join('');
}

function renderJobs() {
  const tbody = $('[data-jobs]', root);
  const jobs = filteredJobs();
  if (!jobs.length) {
    tbody.innerHTML = `<tr><td colspan="12"><div class="empty-state">${current.jobs.length ? 'No job orders match the filters.' : 'No job orders yet for this date.'}</div></td></tr>`;
    return;
  }
  const locked = dayLocked();
  tbody.innerHTML = jobs.map(j => {
    const t = j.totals;
    const off = locked || j.voided_at ? 'disabled' : '';
    return `<tr data-id="${j.id}" class="${j.voided_at ? 'voided' : ''} ${j.payment_method === 'GCash' ? 'gcash-row' : 'cash-row'}">
      <td class="jo-number">${esc(j.jo_number || '—')}${j.voided_at ? `<div class="void-note" title="${esc(j.void_reason)}">VOID · ${esc(j.void_reason)}</div>` : ''}</td>
      <td class="time-cell"><span><small>in</small> ${esc(j.time_in || "—")}</span><input type="time" data-inline="time_out" value="${esc(j.time_out)}" ${off} title="Time out"></td>
      <td>${esc(classLabel(j.vehicle_class))}</td>
      <td>${esc(j.plate || '—')}</td>
      <td class="items-cell">${itemsSummary(j)}${j.totals.discount ? `<span class="item-chip discount">−${peso(j.totals.discount)}</span>` : ''}</td>
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
    ({ edit: editJob, void: voidJob, restore: restoreJob, history: showHistory })[el.dataset.act](job);
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

function reviewNewJob() {
  const error = newJobEditor.validate();
  if (error) return toast(error, 'error');
  const payload = newJobEditor.payload();
  const t = newJobEditor.totals();
  const lines = newJobEditor.lines();
  const detail = (label, value, full) => `<div class="review-detail${full ? ' full' : ''}"><span class="label">${esc(label)}</span><span class="value">${value}</span></div>`;
  openModal(`${modalHeader('Review job order', `${prettyDate(current.date)} — check everything before adding it.`)}
    <div class="review-details">
      ${detail('Vehicle', `${esc(classLabel(payload.vehicle_class))}${payload.plate ? ` · ${esc(payload.plate.toUpperCase())}` : ''}`)}
      ${detail('Detailer', esc(payload.detailer || '—'))}
      ${detail('Payment', `${esc(payload.payment_method)} · ${payload.payment_received ? 'paid' : '<b class="amber-text">not paid yet</b>'}`)}
      ${detail('GCash tip', peso(payload.tip_gcash))}
      ${detail('Items', lines.map(l => `${esc(l.name)} — ${peso(l.price)}`).join('<br>'), true)}
      ${t.discount ? detail('Discount', `${peso(t.discount)}${payload.discount_reason ? ` · ${esc(payload.discount_reason)}` : ''}`, true) : ''}
      ${detail('Total', `<b>${peso(t.total)}</b>`)}
      ${detail('Commission', peso(t.commission))}
    </div>
    <div class="modal-actions"><button class="btn ghost" type="button" data-close>Back</button><button class="btn" type="button" data-confirm>Add job</button></div>`,
  card => $('[data-confirm]', card).addEventListener('click', e => busy(e.currentTarget, async () => {
    const job = await api('POST', '/jobs', { ...payload, job_date: current.date });
    closeModal();
    toast(`${job.jo_number} added`);
    resetEditor();
    await reload();
  })));
}

function editJob(job) {
  openModal(`${modalHeader(`Edit ${job.jo_number}`, 'Saved items keep their original price unless you change the vehicle class.')}
    <div data-edit-editor></div>
    <div class="modal-actions"><button class="btn ghost" type="button" data-close>Cancel</button><button class="btn" type="button" data-save>Save changes</button></div>`,
  card => {
    card.closest('dialog').classList.add('wide');
    const editor = createJobEditor($('[data-edit-editor]', card), { job });
    $('[data-save]', card).addEventListener('click', e => {
      const error = editor.validate();
      if (error) return toast(error, 'error');
      busy(e.currentTarget, async () => {
        await api('PATCH', `/jobs/${job.id}`, editor.payload());
        closeModal();
        toast(`${job.jo_number} saved`);
        await reload();
      });
    });
  });
  $('#modal').addEventListener('close', () => $('#modal').classList.remove('wide'), { once: true });
}

async function voidJob(job) {
  const reason = window.prompt(`Void ${job.jo_number}? It stays on record but is removed from all totals.\n\nReason:`);
  if (reason == null) return;
  if (!reason.trim()) return toast('A reason is required to void a job', 'error');
  await api('POST', `/jobs/${job.id}/void`, { reason });
  toast(`${job.jo_number} voided`);
  await reload();
}

async function restoreJob(job) {
  await api('POST', `/jobs/${job.id}/restore`);
  toast(`${job.jo_number} restored`);
  await reload();
}

async function showHistory(job) {
  if (!isOwner()) return toast('Only the owner can view change history', 'error');
  const [jobLog, itemLog] = await Promise.all([
    api('GET', `/audit?table=jobs&row=${job.id}`),
    api('GET', `/audit?table=job_items&limit=500`),
  ]);
  const entries = [...jobLog, ...itemLog.filter(e => Number((e.new_row || e.old_row)?.job_id) === job.id)]
    .sort((a, b) => b.id - a.id);
  const { describeChange } = await import('./settings.js');
  openModal(`${modalHeader(`${job.jo_number} history`, `${entries.length} change${entries.length === 1 ? '' : 's'}`)}
    <div class="history-list">${entries.map(describeChange).join('') || '<div class="empty-state">No changes recorded since the v2 upgrade.</div>'}</div>
    <div class="modal-actions"><button class="btn ghost" type="button" data-close>Close</button></div>`);
}

export default { mount, show };
