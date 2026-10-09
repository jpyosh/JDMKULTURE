// Job actions shared by the Carwash tab and the running boards (Detailing, Tint & PPF).
import { $, api, esc, peso, toast, busy, prettyDate, openModal, closeModal, modalHeader, classLabel, isOwner, departmentOf } from '../ui.js';
import { createJobEditor } from './job-editor.js';

export function itemsSummary(job) {
  return job.items.map(i => `<span class="item-chip ${i.kind}" title="${esc(i.name)} — ${peso(i.price)}">${esc(i.name)}</span>`).join('')
    + (job.totals.discount ? `<span class="item-chip discount">−${peso(job.totals.discount)}</span>` : '');
}

const detail = (label, value, full) =>
  `<div class="review-detail${full ? ' full' : ''}"><span class="label">${esc(label)}</span><span class="value">${value}</span></div>`;

// Shows the review modal for a new job and creates it on confirm.
export function reviewAndCreate({ editor, department, jobDate, onCreated }) {
  const error = editor.validate();
  if (error) return toast(error, 'error');
  editor.syncTime?.(); // an untouched Time in shows the time Review was pressed
  const payload = editor.payload();
  const t = editor.totals();
  const lines = editor.lines();
  const dept = departmentOf(department);
  openModal(`${modalHeader(`Review ${dept.label} job order`, `${dept.running ? 'Opened' : 'Date'}: ${prettyDate(jobDate)}`)}
    ${dept.catalog ? `<div class="review-time"><label for="review-time">Time in</label>
      <input type="time" id="review-time" data-review-time value="${esc(payload.time_in || '')}">
      <span class="hint">${payload.time_in ? 'Filled in for you. Change it if the car came in at another time.' : 'Optional: when the car came in.'}</span></div>` : ''}
    <div class="review-details">
      ${detail('Vehicle', `${esc(classLabel(payload.vehicle_class))}${payload.plate ? ` · ${esc(payload.plate.toUpperCase())}` : ''}`)}
      ${detail('Detailer', esc(payload.detailer || '—'))}
      ${dept.running
        ? detail('Payment', 'Recorded later with <b>Mark paid</b>', true)
        : `${detail('Payment', `${esc(payload.payment_method)} · ${payload.payment_received ? 'paid' : '<b class="amber-text">not paid yet</b>'}`)}${detail('GCash tip', peso(payload.tip_gcash))}`}
      ${detail('Items', lines.map(l => `${esc(l.name)} — ${peso(l.price)}`).join('<br>'), true)}
      ${t.discount ? detail('Discount', `${peso(t.discount)}${payload.discount_reason ? ` · ${esc(payload.discount_reason)}` : ''}`, true) : ''}
      ${detail('Total', `<b>${peso(t.total)}</b>`)}
      ${detail('Commission', peso(t.commission))}
    </div>
    ${dept.running ? '<p class="hint mt">This job stays on the board until it is marked done and paid, and counts in sales on the later of those two days.</p>' : ''}
    <div class="modal-actions"><button class="btn ghost" type="button" data-close>Back</button><button class="btn" type="button" data-confirm>Add job</button></div>`,
  card => $('[data-confirm]', card).addEventListener('click', e => busy(e.currentTarget, async () => {
    const timeIn = $('[data-review-time]', card);
    const job = await api('POST', '/jobs', { ...payload, ...(timeIn ? { time_in: timeIn.value } : {}), department, job_date: jobDate });
    closeModal();
    toast(`${job.jo_number} added`);
    await onCreated(job);
  })));
}

export function editJobModal(job, onSaved) {
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
        await onSaved();
      });
    });
  });
  $('#modal').addEventListener('close', () => $('#modal').classList.remove('wide'), { once: true });
}

export async function voidJob(job, onDone) {
  const reason = window.prompt(`Void ${job.jo_number}? It stays on record but is removed from all totals.\n\nReason:`);
  if (reason == null) return;
  if (!reason.trim()) return toast('A reason is required to void a job', 'error');
  await api('POST', `/jobs/${job.id}/void`, { reason });
  toast(`${job.jo_number} voided`);
  await onDone();
}

export async function restoreJob(job, onDone) {
  await api('POST', `/jobs/${job.id}/restore`);
  toast(`${job.jo_number} restored`);
  await onDone();
}

export async function showHistory(job) {
  if (!isOwner()) return toast('Only the owner can view change history', 'error');
  const [jobLog, itemLog] = await Promise.all([
    api('GET', `/audit?table=jobs&row=${job.id}`),
    api('GET', '/audit?table=job_items&limit=500'),
  ]);
  const entries = [...jobLog, ...itemLog.filter(e => Number((e.new_row || e.old_row)?.job_id) === job.id)]
    .sort((a, b) => b.id - a.id);
  const { describeChange } = await import('../views/settings.js');
  openModal(`${modalHeader(`${job.jo_number} history`, `${entries.length} change${entries.length === 1 ? '' : 's'}`)}
    <div class="history-list">${entries.map(describeChange).join('') || '<div class="empty-state">No changes recorded since the v2 upgrade.</div>'}</div>
    <div class="modal-actions"><button class="btn ghost" type="button" data-close>Close</button></div>`);
}
