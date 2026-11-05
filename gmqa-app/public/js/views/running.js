// Running job boards (Detailing, Tint & PPF). A job stays on the board, carried over day after day,
// until it is both marked done and paid. It counts in sales on the day it is finished. The date at the top
// works like Carwash: it picks the day the cards show and the day a new job is entered on.
import { $, $$, api, esc, peso, toast, busy, todayLocal, addDays, formatTime, prettyDate, loadCatalog, classLabel, isOwner,
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
  let current = { date: todayLocal(), day: null };

  function mount(el) {
    root = el;
    root.innerHTML = `
      <div class="view-header">
        <div><h1>${esc(dept.label)}</h1>
          <div class="desc">Job orders stay here until they are done and paid. A job counts in sales on the day it is finished.</div></div>
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
        <div class="section-header"><h2>New ${esc(dept.label)} job</h2><span class="subtle-badge" data-entry-date></span></div>
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
        <div class="section-header"><h2>Completed (done and paid)</h2>
          <label class="inline-label">Show jobs finished since <input type="date" data-completed-date></label></div>
        <div class="table-wrap"><table class="jobs-table running-table">
          <thead><tr><th>JO#</th><th>Opened</th><th>Done</th><th>Paid</th><th>Plate</th><th>Items</th>
            <th class="num">Total</th><th class="num">Comm.</th><th class="num">Net</th><th></th></tr></thead>
          <tbody data-completed></tbody>
        </table></div>
      </div>`;

    $('[data-completed-date]', root).value = addDays(todayLocal(), -6);
    $('[data-date]', root).addEventListener('change', e => { if (e.target.value) setDate(e.target.value); });
    $$('[data-shift]', root).forEach(b => b.addEventListener('click', () => setDate(addDays(current.date, Number(b.dataset.shift)))));
    $('[data-today]', root).addEventListener('click', () => setDate(todayLocal()));
    $('[data-completed-date]', root).addEventListener('change', loadCompleted);
    $('[data-show-voided]', root).addEventListener('change', loadActive);
    $('[data-clear]', root).addEventListener('click', resetEditor);
    $('[data-review]', root).addEventListener('click', () => reviewAndCreate({
      editor, department, jobDate: current.date, onCreated: async () => { resetEditor(); await reload(); },
    }));
  }

  async function show() {
    await loadCatalog(true);
    resetEditor();
    await setDate(current.date);
  }

  function resetEditor() {
    editor = createJobEditor($('[data-editor]', root), { department, autoTimeWhen: () => current.date === todayLocal() });
  }

  async function setDate(date) {
    current.date = date;
    $('[data-date]', root).value = date;
    $('[data-entry-date]', root).textContent = prettyDate(date);
    editor?.syncTime();
    await reload();
  }

  const reload = () => Promise.all([loadDay(), loadActive(), loadCompleted()]);

  async function loadDay() {
    const date = current.date;
    const day = await api('GET', `/days/${date}`);
    if (date !== current.date) return; // user moved on while loading
    current.day = day;
    const closed = day.meta.closed_at;
    $('[data-banner]', root).innerHTML = closed
      ? `<div class="banner">This day was closed by ${esc(day.meta.closed_by || 'someone')}. ${isOwner() ? 'As owner you can still make changes, or reopen it on the EOD screen.' : 'Ask the owner to reopen it if something needs fixing.'}</div>`
      : '';
    $('[data-entry-card]', root).hidden = Boolean(closed) && !isOwner();
    renderMetrics();
  }

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

  // Vehicles, Collected, Commission and Net are the day picked at the top, the same numbers as EOD. Unpaid and
  // In progress are the board as it stands, whatever the day: what customers owe does not go away overnight.
  function renderMetrics() {
    if (!current.day) return;
    const s = current.day.summary.departments[department];
    const live = active.filter(j => !j.voided_at);
    const inProgress = live.filter(j => !j.closed_on);
    const awaiting = live.filter(j => j.closed_on && !j.paid_on);
    const doneSales = completed.filter(j => !j.voided_at);
    $('[data-metrics]', root).innerHTML = `
      <div class="metric"><div class="label">Vehicles</div><div class="value">${s.jobs}</div></div>
      <div class="metric"><div class="label">Collected</div><div class="value">${peso(s.collected)}</div></div>
      <div class="metric"><div class="label">Unpaid (all days)</div><div class="value amber">${peso(awaiting.reduce((sum, j) => sum + j.totals.total, 0))}</div></div>
      <div class="metric"><div class="label">Commission</div><div class="value amber">${peso(s.commission)}</div></div>
      <div class="metric"><div class="label">Net (collected − comm.)</div><div class="value teal">${peso(s.net)}</div></div>
      <div class="metric"><div class="label">In progress</div><div class="value">${inProgress.length}</div></div>
      <div class="metric"><div class="label">Completed since ${esc(($('[data-completed-date]', root).value || '').slice(5))}</div><div class="value teal">${peso(doneSales.reduce((sum, j) => sum + j.totals.total, 0))}</div></div>`;
  }

  function renderActive() {
    const tbody = $('[data-active]', root);
    const today = todayLocal();
    tbody.innerHTML = active.length ? active.map(j => `
      <tr data-id="${j.id}" class="${j.voided_at ? 'voided' : ''}">
        <td class="jo-number">${esc(j.jo_number)}${j.voided_at ? `<div class="void-note">VOID · ${esc(j.void_reason)}</div>` : ''}</td>
        <td><div class="mono">${esc(j.job_date)}</div><div class="muted small">${j.time_in ? `${esc(formatTime(j.time_in))} · ` : ''}${daysBetween(j.job_date, today) === 0 ? 'today' : `${daysBetween(j.job_date, today)} day(s) ago`}</div></td>
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
          job.closed_on ? ' It goes back on the board as awaiting payment. The sale stays on the day it was finished, as unpaid.' : ''}`, 'Payment removed'),
        reopen: () => simpleAction(job, 'reopen', `Mark ${job.jo_number} as not done? It goes back to in progress and stops counting as a sale until it is marked done again.`, 'Back in progress'),
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
        <div><label>Payment date</label><input type="date" data-pay-date value="${current.date}"></div>
        <div><label>Method</label><select data-pay-method>${['Cash', 'GCash'].map(p => `<option ${p === job.payment_method ? 'selected' : ''}>${p}</option>`).join('')}</select></div>
        <div><label>GCash tip</label><input type="number" min="0" step="0.01" data-pay-tip value="${job.tip_gcash || ''}" placeholder="0.00"></div>
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
      : 'It counts as a sale on the done date, and stays on the board as "awaiting payment" until it is paid.')}
      <div class="form-grid modal-form-grid"><div><label>Done date</label><input type="date" data-done-date value="${current.date}"></div></div>
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
