// Payroll for any date range: attendance per day, overtime per day, dated adjustments, and the
// payout that leaves the drawer (shown in that day's EOD).
import { $, $$, api, apiDownload, ApiError, esc, peso, toast, busy, todayLocal, addDays, sundayOf, weekday, openModal, closeModal, modalHeader } from '../ui.js';

let root;
// Pay weeks run Sunday to Saturday.
let range = { start: sundayOf(todayLocal()), end: addDays(sundayOf(todayLocal()), 6) };
let data = null;
const CODES = ['', 'P', '0.5P', 'CN', '0.5CN', 'A', 'OFF'];

function lastDayOfMonth(date) {
  const [y, m] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

function presets() {
  const today = todayLocal();
  const sunday = sundayOf(today);
  const month = today.slice(0, 8);
  return {
    'this-week': [sunday, addDays(sunday, 6)],
    'last-week': [addDays(sunday, -7), addDays(sunday, -1)],
    'first-half': [`${month}01`, `${month}15`],
    'second-half': [`${month}16`, lastDayOfMonth(today)],
  };
}

function mount(el) {
  root = el;
  root.innerHTML = `
    <div class="view-header">
      <div><h1>Payroll</h1><div class="desc">Pick any date range. Each day is paid at the rate in effect that day.</div></div>
      <div class="date-range-picker">
        <div><label>From</label><input type="date" data-start></div>
        <span class="range-arrow" aria-hidden="true">→</span>
        <div><label>To</label><input type="date" data-end></div>
      </div>
    </div>
    <div class="preset-row">
      <button class="btn ghost small" type="button" data-preset="this-week">This week</button>
      <button class="btn ghost small" type="button" data-preset="last-week">Last week</button>
      <button class="btn ghost small" type="button" data-preset="first-half">1st–15th</button>
      <button class="btn ghost small" type="button" data-preset="second-half">16th–end</button>
      <button class="btn small signoff-btn" type="button" data-signoff title="A printable PDF for each employee to sign when paid">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11m0 0l-4.5-4.5M12 15l4.5-4.5M5 19.5h14"/></svg>Sign-off sheet (PDF)</button>
    </div>
    <div class="card">
      <div class="attendance-legend">
        <span class="attendance-code present">P = Carwash day</span><span class="attendance-code half">0.5P = Half carwash</span>
        <span class="attendance-code construction">CN = Construction</span><span class="attendance-code half">0.5CN = Half construction</span>
        <span class="attendance-code absence">A = Absent</span><span class="attendance-code off">OFF = Day off</span>
        <span class="hint" data-ot-rule></span>
      </div>
      <div class="table-wrap"><table class="payroll-table"><thead data-head></thead><tbody data-body></tbody></table></div>
      <div class="row-line total mt"><span>Total net pay for this range</span><span class="money" data-total></span></div>
      <div class="entry-actions">
        <button class="btn ghost" type="button" data-add-employee>+ Add employee</button>
        <button class="btn" type="button" data-payout>Record payout</button>
      </div>
    </div>
    <div class="card">
      <h2>Payouts for this range</h2>
      <p class="hint">A payout is the wages handed out. Paid from Cash or GCash, it is subtracted from that day's expected drawer on the EOD screen.</p>
      <div data-payouts></div>
    </div>`;
  $('[data-start]', root).addEventListener('change', onRangeInput);
  $('[data-end]', root).addEventListener('change', onRangeInput);
  $$('[data-preset]', root).forEach(b => b.addEventListener('click', () => setRange(...presets()[b.dataset.preset])));
  $('[data-add-employee]', root).addEventListener('click', () => employeeModal());
  $('[data-payout]', root).addEventListener('click', payoutModal);
  $('[data-signoff]', root).addEventListener('click', e => busy(e.currentTarget,
    () => apiDownload(`/payroll/signoff.pdf?start=${range.start}&end=${range.end}`)));
}

async function show() { await setRange(range.start, range.end); }

// Moving "From" past "To" (or "To" before "From") moves the whole range, keeping its number of days,
// so a week can be shifted forward or back by changing either date.
function onRangeInput(event) {
  let start = $('[data-start]', root).value;
  let end = $('[data-end]', root).value;
  if (!start || !end) return;
  if (start > end) {
    const length = data?.dates.length || 7; // days shown now
    if (event?.target?.matches('[data-start]')) end = addDays(start, length - 1);
    else start = addDays(end, 1 - length);
  }
  setRange(start, end);
}

// The table, the From/To dates and `range` always describe the same days: a range only takes effect
// once its payroll has loaded, a refused range puts the dates back, and when ranges are changed quickly
// only the latest answer is shown.
let rangeRequest = 0;
const showRangeInputs = () => {
  $('[data-start]', root).value = range.start;
  $('[data-end]', root).value = range.end;
};

async function setRange(start, end) {
  const request = ++rangeRequest;
  if (start > end) {
    showRangeInputs();
    return toast('Start date must be on or before the end date', 'error');
  }
  $('[data-start]', root).value = start;
  $('[data-end]', root).value = end;
  let next;
  try {
    next = await api('GET', `/payroll?start=${start}&end=${end}`);
  } catch (error) {
    if (request === rangeRequest) showRangeInputs();
    if (error instanceof ApiError) return; // already shown as a toast
    throw error;
  }
  if (request !== rangeRequest) return; // a newer range was picked while this one loaded
  range = { start, end };
  data = next;
  render();
}

const reload = () => setRange(range.start, range.end);

function render() {
  $('[data-head]', root).innerHTML = `<tr><th>Employee</th>
    ${data.dates.map(d => `<th class="attendance-day" data-date="${d}">${weekday(d)}<small>${d.slice(5)}</small></th>`).join('')}
    <th class="num">CW days</th><th class="num">CN days</th><th class="num">OT</th><th class="num">OT pay</th><th class="num">Gross</th>
    <th class="num">Adjust.</th><th class="num">Net</th><th></th></tr>`;
  $('[data-body]', root).innerHTML = data.rows.length ? data.rows.map(({ employee: e, days, adjustments, pay }) => `
    <tr data-emp="${e.id}" class="${e.active ? '' : 'inactive'}">
      <td class="employee-cell"><b>${esc(e.name)}</b><div class="muted small">${esc(e.role || '—')} · ${peso(e.rate_per_day)} / ${peso(e.construction_rate)}</div></td>
      ${data.dates.map(d => `<td class="attendance-cell"><select data-day="${d}" class="attendance-select code-${(days[d]?.code || 'none').replace('.', '_')}" aria-label="${esc(e.name)} ${d}">
        ${CODES.map(c => `<option value="${c}" ${(days[d]?.code || '') === c ? 'selected' : ''}>${c || '—'}</option>`).join('')}</select>
        ${days[d]?.cw_ot_hours || days[d]?.cn_ot_hours ? `<div class="ot-badge">+${(days[d].cw_ot_hours || 0) + (days[d].cn_ot_hours || 0)}h</div>` : ''}</td>`).join('')}
      <td class="num">${pay.carwashDays}</td><td class="num">${pay.constructionDays}</td>
      <td class="num"><button class="btn ghost small" type="button" data-act="ot">${pay.otHours}h</button></td>
      <td class="num money ${pay.otPay ? '' : 'muted'}" data-ot-pay>${pay.otPay ? peso(pay.otPay) : '—'}</td>
      <td class="num money">${peso(pay.gross - pay.additions)}</td>
      <td class="num"><button class="btn ghost small" type="button" data-act="adjust">${pay.additions || pay.deductions
        ? `${pay.additions ? `+${peso(pay.additions)}` : ''}${pay.deductions ? ` −${peso(pay.deductions)}` : ''}` : 'Add'}</button></td>
      <td class="num money pos" data-net>${peso(pay.net)}</td>
      <td class="row-actions"><button class="btn ghost small" type="button" data-act="edit" title="Edit employee / rates">Edit</button>
        ${e.active ? '<button class="icon-btn" type="button" data-act="deactivate" title="Remove from payroll">✕</button>' : '<span class="muted small">inactive</span>'}</td>
    </tr>`).join('') : `<tr><td colspan="${data.dates.length + 9}"><div class="empty-state">No employees yet.</div></td></tr>`;
  $('[data-total]', root).textContent = peso(data.totalNet);
  $('[data-ot-rule]', root).textContent = data.otRule; // the overtime rule(s) for these days, from lib/calc.js

  $('[data-payouts]', root).innerHTML = data.payouts.length
    ? data.payouts.map(p => `<div class="row-line"><span class="k">${esc(p.payout_date)} · ${p.side === 'cash' ? 'Cash' : 'GCash'} · for ${esc(p.period_start)} → ${esc(p.period_end)}${p.note ? ` · ${esc(p.note)}` : ''}</span>
        <span>${peso(p.amount)} <button class="icon-btn" type="button" data-del-payout="${p.id}" title="Delete payout">✕</button></span></div>`).join('')
    : '<div class="empty-state small">No payout recorded for this range yet.</div>';

  $$('[data-day]', root).forEach(sel => sel.addEventListener('change', () => saveDay(sel)));
  $$('[data-act]', root).forEach(btn => btn.addEventListener('click', () => {
    const row = data.rows.find(r => r.employee.id === Number(btn.closest('tr').dataset.emp));
    ({ ot: otModal, adjust: adjustModal, edit: employeeModal, deactivate })[btn.dataset.act](row);
  }));
  $$('[data-del-payout]', root).forEach(btn => btn.addEventListener('click', async () => {
    if (!window.confirm('Delete this payout? It will be added back to that day\'s expected drawer.')) return;
    await api('DELETE', `/payroll/payouts/${btn.dataset.delPayout}`);
    toast('Payout deleted');
    await reload();
  }));
}

async function saveDay(select) {
  const row = data.rows.find(r => r.employee.id === Number(select.closest('tr').dataset.emp));
  const day = select.dataset.day;
  const current = row.days[day] || {};
  try {
    await api('PUT', `/payroll/attendance/${row.employee.id}/${day}`, {
      code: select.value, cw_ot_hours: current.cw_ot_hours || 0, cn_ot_hours: current.cn_ot_hours || 0,
    });
  } finally {
    await reload();
  }
}

function otModal({ employee, days }) {
  openModal(`${modalHeader(`Overtime: ${employee.name}`, `${range.start} → ${range.end}. Hours per day.`)}
    <div class="ot-grid">
      <div class="ot-head">Day</div><div class="ot-head">Carwash OT h</div><div class="ot-head">Construction OT h</div>
      ${data.dates.map(d => `<div>${weekday(d)} ${d.slice(5)}</div>
        <input type="number" min="0" max="24" step="0.25" data-cw="${d}" value="${days[d]?.cw_ot_hours || ''}">
        <input type="number" min="0" max="24" step="0.25" data-cn="${d}" value="${days[d]?.cn_ot_hours || ''}">`).join('')}
    </div>
    <div class="modal-actions"><button class="btn ghost" type="button" data-close>Cancel</button><button class="btn" type="button" data-confirm>Save overtime</button></div>`,
  card => $('[data-confirm]', card).addEventListener('click', e => busy(e.currentTarget, async () => {
    for (const d of data.dates) {
      const cw = Number($(`[data-cw="${d}"]`, card).value || 0);
      const cn = Number($(`[data-cn="${d}"]`, card).value || 0);
      const before = days[d] || {};
      if (cw === (before.cw_ot_hours || 0) && cn === (before.cn_ot_hours || 0)) continue;
      await api('PUT', `/payroll/attendance/${employee.id}/${d}`, { code: before.code || '', cw_ot_hours: cw, cn_ot_hours: cn });
    }
    closeModal();
    toast('Overtime saved');
    await reload();
  })));
}

function adjustModal({ employee, adjustments }) {
  openModal(`${modalHeader(`Adjustments: ${employee.name}`, 'Cash advances and other deductions, or bonuses and other additions.')}
    <div data-adj-list>${adjustments.length ? adjustments.map(a => `<div class="row-line"><span class="k">${esc(a.adj_date)} · ${esc(a.note)}</span>
      <span class="${a.kind === 'deduction' ? 'amber-text' : 'pos'}">${a.kind === 'deduction' ? '−' : '+'}${peso(a.amount)}
        <button class="icon-btn" type="button" data-del-adj="${a.id}" title="Delete">✕</button></span></div>`).join('')
      : '<div class="empty-state small">None in this range.</div>'}</div>
    <div class="form-grid modal-form-grid">
      <div><label>Date</label><input type="date" data-adj-date value="${range.end < todayLocal() ? range.end : todayLocal()}"></div>
      <div><label>Type</label><select data-adj-kind><option value="deduction">Deduction</option><option value="addition">Addition</option></select></div>
      <div><label>Amount</label><input type="number" min="0.01" step="0.01" data-adj-amount></div>
      <div><label>Note</label><input type="text" data-adj-note maxlength="200" placeholder="e.g. Cash advance"></div>
    </div>
    <div class="modal-actions"><button class="btn ghost" type="button" data-close>Close</button><button class="btn" type="button" data-confirm>Add adjustment</button></div>`,
  card => {
    $$('[data-del-adj]', card).forEach(btn => btn.addEventListener('click', async () => {
      await api('DELETE', `/payroll/adjustments/${btn.dataset.delAdj}`);
      closeModal();
      toast('Adjustment deleted');
      await reload();
    }));
    $('[data-confirm]', card).addEventListener('click', e => busy(e.currentTarget, async () => {
      await api('POST', '/payroll/adjustments', {
        employee_id: employee.id, date: $('[data-adj-date]', card).value, kind: $('[data-adj-kind]', card).value,
        amount: Number($('[data-adj-amount]', card).value || 0), note: $('[data-adj-note]', card).value.trim(),
      });
      closeModal();
      toast('Adjustment added');
      await reload();
    }));
  });
}

function employeeModal(row = null) {
  const e = row?.employee;
  openModal(`${modalHeader(e ? `Edit ${e.name}` : 'Add employee', e ? 'A rate change applies from its effective date; earlier days keep the old rate.' : 'Re-adding a former employee brings their record back.', 'Team')}
    <div class="form-grid modal-form-grid">
      <div><label>Name</label><input type="text" data-n="name" maxlength="80" value="${esc(e?.name || '')}"></div>
      <div><label>Role</label><input type="text" data-n="role" maxlength="60" placeholder="Detailer" value="${esc(e?.role || '')}"></div>
      <div><label>Carwash rate / day</label><input type="number" min="0" step="0.01" data-n="rate_per_day" value="${e ? e.rate_per_day : 250}"></div>
      <div><label>Construction rate / day</label><input type="number" min="0" step="0.01" data-n="construction_rate" value="${e ? e.construction_rate : 700}"></div>
      ${e ? `<div><label>Rate change effective</label><input type="date" data-n="effective_from" value="${todayLocal()}"></div>` : ''}
    </div>
    <div class="modal-actions"><button class="btn ghost" type="button" data-close>Cancel</button><button class="btn" type="button" data-confirm>${e ? 'Save' : 'Add employee'}</button></div>`,
  card => {
    $('[data-n="name"]', card).focus();
    $('[data-confirm]', card).addEventListener('click', ev => busy(ev.currentTarget, async () => {
      const get = k => $(`[data-n="${k}"]`, card)?.value;
      if (!get('name').trim()) return toast('Name is required', 'error');
      const body = { name: get('name').trim(), role: get('role').trim() };
      const rate = Number(get('rate_per_day') || 0);
      const cnRate = Number(get('construction_rate') || 0);
      if (!e) {
        await api('POST', '/employees', { ...body, rate_per_day: rate, construction_rate: cnRate });
      } else {
        if (rate !== e.rate_per_day || cnRate !== e.construction_rate) Object.assign(body, { rate_per_day: rate, construction_rate: cnRate, effective_from: get('effective_from') });
        await api('PATCH', `/employees/${e.id}`, body);
      }
      closeModal();
      toast(e ? 'Employee saved' : 'Employee added');
      await reload();
    }));
  });
}

async function deactivate({ employee }) {
  if (!window.confirm(`Remove ${employee.name} from payroll? Their past records are kept.`)) return;
  await api('DELETE', `/employees/${employee.id}`);
  toast(`${employee.name} removed`);
  await reload();
}

function payoutModal() {
  openModal(`${modalHeader('Record payout', `Wages for ${range.start} → ${range.end}. Paid from the drawer, so it comes off that day's EOD.`)}
    <div class="form-grid modal-form-grid">
      <div><label>Payout date</label><input type="date" data-payout-date value="${todayLocal()}"></div>
      <div><label>Paid from</label><select data-payout-side><option value="cash">Cash</option><option value="gcash">GCash</option></select></div>
      <div><label>Amount</label><input type="number" min="0.01" step="0.01" data-payout-amount value="${data.totalNet}"></div>
      <div><label>Note</label><input type="text" data-payout-note maxlength="200" placeholder="Optional"></div>
    </div>
    <div class="modal-actions"><button class="btn ghost" type="button" data-close>Cancel</button><button class="btn" type="button" data-confirm>Record payout</button></div>`,
  card => $('[data-confirm]', card).addEventListener('click', e => busy(e.currentTarget, async () => {
    await api('POST', '/payroll/payouts', {
      payout_date: $('[data-payout-date]', card).value, period_start: range.start, period_end: range.end,
      side: $('[data-payout-side]', card).value, amount: Number($('[data-payout-amount]', card).value || 0),
      note: $('[data-payout-note]', card).value.trim(),
    });
    closeModal();
    toast('Payout recorded');
    await reload();
  })));
}

export default { mount, show };
