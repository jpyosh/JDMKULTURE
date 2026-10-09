// Running job boards (Detailing, Tint & PPF). A job stays on the board, carried over day after day,
// until it is both marked done and paid; it then counts in sales on the later of those two dates.
import { $, $$, api, esc, peso, toast, busy, todayLocal, addDays, prettyDate, loadCatalog, classLabel, isOwner,
  openModal, closeModal, modalHeader, departmentOf } from '../ui.js';
import { createJobEditor } from '../components/job-editor.js';
import { itemsSummary, reviewAndCreate, editJobModal, voidJob, restoreJob, showHistory } from '../components/job-actions.js';

const daysBetween = (from, to) => Math.round((new Date(`${to}T00:00:00Z`) - new Date(`${from}T00:00:00Z`)) / 86400000);

function status(job) {
  if (job.voided_at) return '<span class="status-pill void">Voided</span>';
  if (job.closed_on && job.paid_on) return '<span class="status-pill done">Completed</span>';
  if (job.closed_on) return `<span class="status-pill waiting">Done ${esc(job.closed_on.slice(5))} · awaiting payment</span>`;
  if (job.paid_on) return `<span class="status-pill paid">Paid ${esc(job.paid_on.slice(5))} · in progress</span>`;
  return '<span class="status-pill progress">In progress</span>';
}

export function createRunningView(department) {
  const dept = departmentOf(department);
  let root;
  let editor = null;
  let active = [];
  let completed = [];

  function mount(el) {
    root = el;
    root.innerHTML = `
      <div class="view-header">
        <div><h1>${esc(dept.label)}</h1>
          <div class="desc">Running job orders stay here every day until they are done and paid. They count in sales on the later of those two days.</div></div>
      </div>
      <div class="metrics-row" data-metrics></div>
      <div class="card">
        <div class="section-header"><h2>New ${esc(dept.label)} job</h2>
          <label class="inline-label">Opened on <input type="date" data-open-date></label></div>
        <div data-editor></div>
        <div class="entry-actions"><button class="btn ghost" type="button" data-clear>Clear</button><button class="btn" type="button" data-review>Review job</button></div>
      </div>
      <div class="card">
        <div class="section-header"><h2>Active jobs</h2>
          <label class="check owner-only"><input type="checkbox" data-show-voided> Show voided</label></div>
        <div class="table-wrap"><table class="jobs-table running-table">
          <thead><tr><th>JO#</th><th>Opened</th><th>Class</th><th>Plate</th><th>Items</th><th>Detailer</th>
            <th class="num">Total</th><th class="num">Comm.</th><th>Status</th><th></th></tr></thead>
          <tbody data-active></tbody>
        </table></div>
      </div>
      <div class="card">
        <div class="section-header"><h2>Completed (counted as sales)</h2>
          <label class="inline-label">Since <input type="date" data-completed-date></label></div>
        <div class="table-wrap"><table class="jobs-table running-table">
          <thead><tr><th>JO#</th><th>Opened</th><th>Done</th><th>Paid</th><th>Plate</th><th>Items</th>
            <th class="num">Total</th><th class="num">Comm.</th><th class="num">Net</th><th></th></tr></thead>
          <tbody data-completed></tbody>
        </table></div>
      </div>`;

    $('[data-open-date]', root).value = todayLocal();
    $('[data-completed-date]', root).value = addDays(todayLocal(), -6);
    $('[data-open-date]', root).addEventListener('change', () => editor?.syncTime());
    $('[data-completed-date]', root).addEventListener('change', loadCompleted);
    $('[data-show-voided]', root).addEventListener('change', loadActive);
    $('[data-clear]', root).addEventListener('click', resetEditor);
    $('[data-review]', root).addEventListener('click', () => {
      const jobDate = $('[data-open-date]', root).value;
      if (!jobDate) return toast('Pick the date the job was opened', 'error');
      reviewAndCreate({ editor, department, jobDate, onCreated: async () => { resetEditor(); await reload(); } });
    });
  }

  async function show() {
    await loadCatalog(true);
    resetEditor();
    await reload();
  }

  function resetEditor() {
    editor = createJobEditor($('[data-editor]', root), { department, autoTimeWhen: () => $('[data-open-date]', root).value === todayLocal() });
  }

  const reload = () => Promise.all([loadActive(), loadCompleted()]);

  async function loadActive() {
    const voided = $('[data-show-voided]', root).checked ? '&include_voided=1' : '';
    active = await api('GET', `/jobs/active?department=${department}${voided}`);
    renderActive();
  }

  async function loadCompleted() {
    const day = $('[data-completed-date]', root).value;
    if (!day) return;
    completed = await api('GET', `/jobs/completed?department=${department}&since=${day}`);
    renderCompleted();
  }

  function renderMetrics() {
    const live = active.filter(j => !j.voided_at);
    const inProgress = live.filter(j => !j.closed_on);
    const awaiting = live.filter(j => j.closed_on && !j.paid_on);
    const doneSales = completed.filter(j => !j.voided_at);
    $('[data-metrics]', root).innerHTML = `
      <div class="metric"><div class="label">In progress</div><div class="value">${inProgress.length}</div></div>
      <div class="metric"><div class="label">Done, awaiting payment</div><div class="value amber">${awaiting.length} · ${peso(awaiting.reduce((s, j) => s + j.totals.total, 0))}</div></div>
      <div class="metric"><div class="label">Paid in advance</div><div class="value">${peso(inProgress.filter(j => j.paid_on).reduce((s, j) => s + j.totals.total, 0))}</div></div>
      <div class="metric"><div class="label">Sales since ${esc(($('[data-completed-date]', root).value || '').slice(5))}</div><div class="value teal">${peso(doneSales.reduce((s, j) => s + j.totals.total, 0))}</div></div>`;
  }

  function renderActive() {
    const tbody = $('[data-active]', root);
    const today = todayLocal();
    tbody.innerHTML = active.length ? active.map(j => `
      <tr data-id="${j.id}" class="${j.voided_at ? 'voided' : ''}">
        <td class="jo-number">${esc(j.jo_number)}${j.voided_at ? `<div class="void-note">VOID · ${esc(j.void_reason)}</div>` : ''}</td>
        <td><div class="mono">${esc(j.job_date)}</div><div class="muted small">${daysBetween(j.job_date, today) === 0 ? 'today' : `${daysBetween(j.job_date, today)} day(s) ago`}</div></td>
        <td>${esc(classLabel(j.vehicle_class))}</td>
        <td>${esc(j.plate || '—')}</td>
        <td class="items-cell">${itemsSummary(j)}</td>
        <td>${esc(j.detailer || '—')}</td>
        <td class="num money">${peso(j.totals.total)}</td>
        <td class="num money amber-text">${peso(j.totals.commission)}</td>
        <td>${status(j)}</td>
        <td class="row-actions"><div class="actions">${j.voided_at
          ? (isOwner() ? '<button class="btn ghost small" type="button" data-act="restore">Restore</button>' : '')
          : `<button class="btn ghost small" type="button" data-act="edit">Edit</button>
             ${j.paid_on ? '<button class="btn ghost small" type="button" data-act="unpay">Undo payment</button>'
               : '<button class="btn small" type="button" data-act="pay">Mark paid</button>'}
             ${j.closed_on ? '<button class="btn ghost small" type="button" data-act="reopen">Not done</button>'
               : '<button class="btn small" type="button" data-act="complete">Mark done</button>'}
             ${isOwner() ? '<button class="icon-btn" type="button" data-act="void" title="Void job">✕</button>' : ''}`}
          <button class="icon-btn" type="button" data-act="history" title="Change history">⟲</button></div></td>
      </tr>`).join('')
      : `<tr><td colspan="10"><div class="empty-state">No active ${esc(dept.label)} jobs.</div></td></tr>`;
    bindActions(tbody, active);
    renderMetrics();
  }

  function renderCompleted() {
    const tbody = $('[data-completed]', root);
    tbody.innerHTML = completed.length ? completed.map(j => `
      <tr data-id="${j.id}" class="${j.voided_at ? 'voided' : ''}">
        <td class="jo-number">${esc(j.jo_number)}${j.voided_at ? `<div class="void-note">VOID · ${esc(j.void_reason)}</div>` : ''}</td>
        <td class="mono">${esc(j.job_date)}</td><td class="mono">${esc(j.closed_on)}</td>
        <td class="mono">${esc(j.paid_on)} <span class="muted small">${esc(j.payment_method)}</span>${
          j.sale_date > todayLocal() ? '<div class="status-pill waiting">Dated after today</div>' : ''}</td>
        <td>${esc(j.plate || '—')}</td>
        <td class="items-cell">${itemsSummary(j)}</td>
        <td class="num money">${peso(j.totals.total)}</td>
        <td class="num money amber-text">${peso(j.totals.commission)}</td>
        <td class="num money pos">${peso(j.totals.net)}</td>
        <td class="row-actions"><div class="actions">${j.voided_at
          ? (isOwner() ? '<button class="btn ghost small" type="button" data-act="restore">Restore</button>' : '')
          : `<button class="btn ghost small" type="button" data-act="edit">Edit</button>
             <button class="btn ghost small" type="button" data-act="unpay">Undo payment</button>
             <button class="btn ghost small" type="button" data-act="reopen">Not done</button>
             ${isOwner() ? '<button class="icon-btn" type="button" data-act="void" title="Void job">✕</button>' : ''}`}
          <button class="icon-btn" type="button" data-act="history" title="Change history">⟲</button></div></td>
      </tr>`).join('')
      : '<tr><td colspan="10"><div class="empty-state">Nothing completed since this day.</div></td></tr>';
    bindActions(tbody, completed);
    renderMetrics();
  }

  function bindActions(tbody, list) {
    $$('[data-act]', tbody).forEach(el => el.addEventListener('click', () => {
      const job = list.find(j => j.id === Number(el.closest('tr').dataset.id));
      const actions = {
        edit: () => editJobModal(job, reload),
        pay: () => payModal(job),
        complete: () => completeModal(job),
        unpay: () => simpleAction(job, 'unpay', `Undo the payment for ${job.jo_number}?${
          job.closed_on ? ' It goes back on the board as awaiting payment and stops counting as a sale.' : ''}`, 'Payment removed'),
        reopen: () => simpleAction(job, 'reopen', `Mark ${job.jo_number} as not done? It goes back to in progress${
          job.paid_on ? ' and stops counting as a sale until it is marked done again' : ''}.`, 'Back in progress'),
        void: () => voidJob(job, reload),
        restore: () => restoreJob(job, reload),
        history: () => showHistory(job),
      };
      actions[el.dataset.act]();
    }));
  }

  async function simpleAction(job, action, question, done) {
    if (!window.confirm(question)) return;
    await api('POST', `/jobs/${job.id}/${action}`);
    toast(done);
    await reload();
  }

  function payModal(job) {
    openModal(`${modalHeader(`Mark ${job.jo_number} paid`, `Full payment of ${peso(job.totals.total)}. The money counts in the drawer on the payment date.`)}
      <div class="form-grid modal-form-grid">
        <div><label>Payment date</label><input type="date" data-pay-date value="${todayLocal()}"></div>
        <div><label>Method</label><select data-pay-method><option>Cash</option><option>GCash</option></select></div>
        <div><label>GCash tip</label><input type="number" min="0" step="0.01" data-pay-tip placeholder="0.00"></div>
      </div>
      <div class="modal-actions"><button class="btn ghost" type="button" data-close>Cancel</button><button class="btn" type="button" data-confirm>Record payment</button></div>`,
    card => $('[data-confirm]', card).addEventListener('click', e => busy(e.currentTarget, async () => {
      await api('POST', `/jobs/${job.id}/pay`, {
        date: $('[data-pay-date]', card).value,
        payment_method: $('[data-pay-method]', card).value,
        tip_gcash: Number($('[data-pay-tip]', card).value || 0),
      });
      closeModal();
      toast(`${job.jo_number}: payment recorded`);
      await reload();
    })));
  }

  function completeModal(job) {
    openModal(`${modalHeader(`Mark ${job.jo_number} done`, job.paid_on
      ? 'Already paid, so it becomes a sale on the done date.'
      : 'It stays on the board as "awaiting payment" until it is paid.')}
      <div class="form-grid modal-form-grid"><div><label>Done date</label><input type="date" data-done-date value="${todayLocal()}"></div></div>
      <div class="modal-actions"><button class="btn ghost" type="button" data-close>Cancel</button><button class="btn" type="button" data-confirm>Mark done</button></div>`,
    card => $('[data-confirm]', card).addEventListener('click', e => busy(e.currentTarget, async () => {
      await api('POST', `/jobs/${job.id}/complete`, { date: $('[data-done-date]', card).value });
      closeModal();
      toast(`${job.jo_number} marked done`);
      await reload();
    })));
  }

  return { mount, show };
}

export const detailing = createRunningView('detailing');
export const tintPpf = createRunningView('tint_ppf');
