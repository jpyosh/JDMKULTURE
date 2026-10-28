// Payroll for any date range: attendance per day, overtime per day, dated adjustments, and the
// payout that leaves the drawer (shown in that day's EOD).
import { $, $$, api, apiDownload, ApiError, esc, peso, toast, busy, todayLocal, addDays, sundayOf, weekday, prettyDate, openModal, closeModal, modalHeader } from '../ui.js';

let root;
// Pay weeks run Sunday to Saturday.
let range = { start: sundayOf(todayLocal()), end: addDays(sundayOf(todayLocal()), 6) };
let data = null;
// The rate in effect on a date (same rule as rateOn in lib/calc.js): the latest change on or before it.
const rateOn = (rates, date) => rates.filter(r => r.effective_from <= date).at(-1) || { rate_per_day: 0, construction_rate: 0 };
const CODES = ['', 'P', '0.5P', 'CN', '0.5CN', 'A', 'OFF'];
// An employee's own normal carwash hours / OT multiplier (null = the shop rule), as on the sign-off sheet.
const otPayLabel = m => (Number(m) === 1 ? 'OT at normal rate' : `OT +${Math.round((Number(m) - 1) * 100)}%`);
const ownOt = r => `${r.carwash_hours != null ? ` · ${Number(r.carwash_hours)}h day` : ''}${r.ot_multiplier != null ? ` · ${otPayLabel(r.ot_multiplier)}` : ''}`;
const optional = value => (value === '' || value == null ? null : Number(value));
// The shop's overtime setting in effect on a date (same rule as otRuleOn in lib/calc.js).
const ruleOn = date => data.otRules.filter(r => r.effective_from <= date).at(-1) || data.otRules[0];
const amount = n => `₱${Number(n).toLocaleString('en-PH', { maximumFractionDigits: 2 })}`;

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
    // The Sunday–Saturday week after the range on screen (also after a half week).
    'next-week': (() => { const next = addDays(range.end, 7 - new Date(`${range.end}T00:00:00Z`).getUTCDay()); return [next, addDays(next, 6)]; })(),
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
      <button class="btn ghost small" type="button" data-preset="next-week">Next week →</button>
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
        <button class="btn ghost small" type="button" data-ot-settings title="Normal hours of a day and the OT multiplier">OT settings</button>
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
  $('[data-ot-settings]', root).addEventListener('click', otSettingsModal);
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
      <td class="employee-cell"><b>${esc(e.name)}</b><div class="muted small">${esc(e.role || '—')} · ${peso(e.rate_per_day)} / ${peso(e.construction_rate)}${ownOt(e)}</div></td>
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

// ---------------------------------------------------------------- work day & OT choices

// A set of plain choices; `other` adds "Other [number]" for a value not in the list.
function choiceGroup(name, legend, options, current, other = null) {
  const known = options.some(o => o.value === String(current));
  const otherOn = Boolean(other) && !known && current != null && current !== '';
  return `<fieldset class="choice-group"><legend>${esc(legend)}</legend>
    ${options.map(o => `<label><input type="radio" name="${name}" value="${o.value}" ${o.value === String(current) ? 'checked' : ''}> ${esc(o.label)}</label>`).join('')}
    ${other ? `<label><input type="radio" name="${name}" value="other" ${otherOn ? 'checked' : ''}> Other
      <input type="number" class="choice-other" data-other="${name}" min="${other.min}" max="${other.max}" step="${other.step}" value="${otherOn ? Number(current) : ''}" aria-label="${esc(legend)}: other"> ${other.unit}</label>` : ''}
  </fieldset>`;
}
// The chosen value: null for "same as shop", a number, or NaN when "Other" is empty or out of range.
function choiceValue(card, name, min, max) {
  const v = $(`input[name="${name}"]:checked`, card)?.value;
  if (v === 'shop') return null;
  const n = Number(v === 'other' ? $(`[data-other="${name}"]`, card).value || NaN : v);
  return n >= min && n <= max ? n : NaN;
}
function setChoice(card, name, value) {
  const radio = $(`input[name="${name}"][value="${String(value)}"]`, card) || $(`input[name="${name}"][value="other"]`, card);
  if (!radio) return;
  radio.checked = true;
  const other = $(`[data-other="${name}"]`, card);
  if (other) other.value = radio.value === 'other' ? Number(value) : '';
}

// When a change starts: this pay week (the default), next pay week, or another date.
function startsChoice() {
  const sunday = sundayOf(todayLocal());
  return `<fieldset class="choice-group"><legend>Starts</legend>
    <label><input type="radio" name="starts" value="this" checked> This pay week (${esc(prettyDate(sunday))})</label>
    <label><input type="radio" name="starts" value="next"> Next pay week (${esc(prettyDate(addDays(sunday, 7)))})</label>
    <label><input type="radio" name="starts" value="date"> Another date <input type="date" class="choice-other" data-starts-date aria-label="Start date"></label>
  </fieldset>`;
}
function startsValue(card) {
  const sunday = sundayOf(todayLocal());
  const v = $('input[name="starts"]:checked', card)?.value;
  return v === 'this' ? sunday : v === 'next' ? addDays(sunday, 7) : $('[data-starts-date]', card).value;
}

// Starts with placeholder lines the size of the usual answer, so Save does not jump when it arrives.
const PREVIEW_PANEL = `<div class="ot-preview" aria-live="polite"><p data-example>Working out what one OT hour pays…</p>
  <div data-changes><p class="muted small">Checking whose pay changes…</p></div><div class="ot-paid" data-paid hidden></div></div>`;

// Shows what the change on the form would do (asked of the server, which computes pay), and keeps Save
// disabled while the form is incomplete, the answer is pending, or a paid-out week would change
// without the second confirm. build() returns { body } for /payroll/preview, or { error }.
function livePreview(card, build, exampleText) {
  const save = $('[data-confirm]', card);
  let seq = 0;
  let timer = null;
  let state = 'pending';
  const confirmBox = () => $('[data-confirm-paid]', card);
  card.addEventListener('input', ev => {
    if (ev.target.matches('.choice-other')) ev.target.closest('label').querySelector('input[type="radio"]').checked = true;
  });
  const sync = () => { save.disabled = state !== 'ready' || Boolean(confirmBox() && !confirmBox().checked); };
  const show = p => {
    $('[data-example]', card).textContent = p.example ? exampleText(p.example) : '';
    const list = p.changes;
    const line = c => `${esc(c.name)}: ${c.before.otPay !== c.after.otPay ? `OT pay ${peso(c.before.otPay)} → ${peso(c.after.otPay)} · ` : ''}total ${peso(c.before.gross)} → ${peso(c.after.gross)}`;
    $('[data-changes]', card).innerHTML = !list.length
      ? `<p class="muted small">No recorded pay changes. Days from ${esc(prettyDate(p.from))} on will use this.</p>`
      : `<p class="small"><b>Pay that changes</b> (from ${esc(prettyDate(p.from))}${p.until ? ` to ${esc(prettyDate(p.until))}` : ''})</p>
        <ul class="ot-change-list">${list.slice(0, 8).map(c => `<li>${line(c)}</li>`).join('')}${list.length > 8 ? `<li class="muted">and ${list.length - 8} more</li>` : ''}</ul>`;
    const paid = $('[data-paid]', card);
    paid.hidden = !p.paidOut.length;
    paid.innerHTML = p.paidOut.length
      ? `<p>⚠ Wages for ${p.paidOut.map(x => `${esc(prettyDate(x.period_start))} – ${esc(prettyDate(x.period_end))}`).join(', ')} are already paid out.
          Saving changes what those weeks should have paid; any difference is not added or taken back automatically.</p>
        <label><input type="checkbox" data-confirm-paid> Yes, change pay for weeks already paid out</label>`
      : '';
    confirmBox()?.addEventListener('change', sync);
  };
  // The values last asked about: a `change` that only repeats them (it fires when a field loses focus,
  // e.g. on the mouse-down of a click on Save) must not disable Save again and swallow the click.
  let asked = null;
  const run = ev => {
    if (ev?.target?.matches?.('[data-confirm-paid]')) return;
    const built = build();
    const key = JSON.stringify(built);
    if (key === asked) return;
    asked = key;
    clearTimeout(timer);
    const mine = ++seq;
    if (built.error) {
      state = 'invalid';
      $('[data-example]', card).textContent = built.error;
      $('[data-changes]', card).innerHTML = '';
      $('[data-paid]', card).innerHTML = '';
      $('[data-paid]', card).hidden = true;
      return sync();
    }
    state = 'pending';
    sync();
    timer = setTimeout(async () => {
      let p;
      try { p = await api('POST', '/payroll/preview', built.body, { quiet: true }); } catch { asked = null; return; }
      if (mine !== seq) return; // the form changed while this was loading
      show(p);
      state = 'ready';
      sync();
    }, 200);
  };
  card.addEventListener('input', run);
  card.addEventListener('change', run);
  run();
  return { confirmedPaid: () => Boolean(confirmBox()?.checked) };
}

const exampleLine = ex => `day rate ${amount(ex.rate)} ÷ ${ex.hours} h × ${ex.multiplier} = ${peso(ex.perHour)} per OT hour`;
const otPayWords = m => (Number(m) === 1 ? 'Normal hourly rate' : Number(m) === 1.25 ? 'Normal + 25%' : `× ${Number(m)}`);

function employeeModal(row = null) {
  const e = row?.employee;
  const shopNow = ruleOn(sundayOf(todayLocal()));
  const mult = e?.ot_multiplier;
  openModal(`<div data-ot-form>${modalHeader(e ? `Edit ${e.name}` : 'Add employee', e ? 'Changes start on the date you choose below; earlier days keep what they had.' : 'Re-adding a former employee brings their record back.', 'Team')}
    <div class="form-grid modal-form-grid">
      <div><label>Name</label><input type="text" data-n="name" maxlength="80" value="${esc(e?.name || '')}"></div>
      <div><label>Role</label><input type="text" data-n="role" maxlength="60" placeholder="Detailer" value="${esc(e?.role || '')}"></div>
      <div><label>Carwash rate / day</label><input type="number" min="0" step="0.01" data-n="rate_per_day" value="${e ? e.rate_per_day : 250}"></div>
      <div><label>Construction rate / day</label><input type="number" min="0" step="0.01" data-n="construction_rate" value="${e ? e.construction_rate : 700}"></div>
    </div>
    <h3 class="mt">Work day &amp; OT</h3>
    ${choiceGroup('work-day', 'Carwash work day', [{ value: 'shop', label: `Same as shop (${Number(shopNow.carwash_hours)} h)` }, { value: '8', label: '8-hour day' }],
    e?.carwash_hours ?? 'shop', { min: 1, max: 24, step: 0.25, unit: 'hours' })}
    ${choiceGroup('emp-ot', 'OT pay', [{ value: 'shop', label: `Same as shop (${otPayWords(shopNow.multiplier).toLowerCase()})` },
    { value: '1', label: 'Normal hourly rate' }, { value: '1.25', label: 'Normal + 25%' }],
    mult ?? 'shop', mult != null && ![1, 1.25].includes(Number(mult)) ? { min: 1, max: 3, step: 0.05, unit: '× hourly' } : null)}
    ${e ? startsChoice() : ''}
    ${e ? '<p class="hint" data-rate-note></p>' : ''}
    ${PREVIEW_PANEL}
    <div class="modal-actions"><button class="btn ghost" type="button" data-close>Cancel</button><button class="btn" type="button" data-confirm>${e ? 'Save' : 'Add employee'}</button></div></div>`,
  modalCard => {
    const card = $('[data-ot-form]', modalCard);
    $('[data-n="name"]', card).focus();
    const get = k => $(`[data-n="${k}"]`, card)?.value;
    const next = () => ({ rate_per_day: Number(get('rate_per_day') || 0), construction_rate: Number(get('construction_rate') || 0),
      carwash_hours: choiceValue(card, 'work-day', 1, 24), ot_multiplier: choiceValue(card, 'emp-ot', 1, 3) });
    const describe = r => `${peso(r.rate_per_day)} / ${peso(r.construction_rate)}${ownOt(r)}`;
    // A change is measured against what is in effect on its start date, not today: a raise first saved
    // from today can then be moved back to Sunday with the same amount.
    const before = () => rateOn(row.rates, startsValue(card));
    const changesRate = () => {
      const b = before();
      const n = next();
      return n.rate_per_day !== Number(b.rate_per_day) || n.construction_rate !== Number(b.construction_rate)
        || n.carwash_hours !== optional(b.carwash_hours) || n.ot_multiplier !== optional(b.ot_multiplier);
    };
    const build = () => {
      const n = next();
      if (Number.isNaN(n.carwash_hours)) return { error: 'Enter the hours of their work day (1 to 24).' };
      if (Number.isNaN(n.ot_multiplier)) return { error: 'Enter their OT multiplier (1 to 3).' };
      const from = e ? startsValue(card) : undefined;
      if (e && !from) return { error: 'Pick the date the change starts.' };
      return { body: { kind: 'employee', employee_id: e?.id, name: get('name').trim(), effective_from: from, ...n } };
    };
    const showNote = () => {
      const from = startsValue(card);
      $('[data-rate-note]', card).textContent = !from ? 'Pick the date the change starts.'
        : !changesRate() ? `No change: from ${prettyDate(from)} it is already ${describe(before())}.`
          : `From ${prettyDate(from)} on: ${describe(before())} → ${describe(next())}. `
            + (from < sundayOf(todayLocal()) ? 'This also changes pay for days before this week.' : 'Earlier days keep what they had.');
    };
    if (e) {
      card.addEventListener('input', showNote);
      card.addEventListener('change', showNote);
      showNote();
    }
    const preview = livePreview(card, build, ex => `${ex.name}'s OT: ${exampleLine(ex)}`);
    $('[data-confirm]', card).addEventListener('click', ev => busy(ev.currentTarget, async () => {
      if (!get('name').trim()) return toast('Name is required', 'error');
      const built = build();
      if (built.error) return toast(built.error, 'error');
      const body = { name: get('name').trim(), role: get('role').trim() };
      if (!e) {
        await api('POST', '/employees', { ...body, ...next() });
      } else {
        if (changesRate()) Object.assign(body, { ...next(), effective_from: startsValue(card), confirm_paid: preview.confirmedPaid() });
        await api('PATCH', `/employees/${e.id}`, body);
      }
      closeModal();
      toast(e ? 'Employee saved' : 'Employee added');
      await reload();
    }));
  });
}

// How overtime is paid for everyone: the hours of a carwash and a construction day and the OT pay,
// from a start date (earlier days keep theirs). Someone with a different work day is set in Edit.
function otSettingsModal() {
  const rules = data.otRules;
  const first = rules[0]?.effective_from;
  const now = ruleOn(sundayOf(todayLocal()));
  const extra = m => (![1, 1.25].includes(Number(m)) ? { min: 1, max: 3, step: 0.05, unit: '× hourly' } : null);
  openModal(`<div data-ot-form>${modalHeader('Overtime settings', 'How overtime is paid for everyone. Someone with a different work day (e.g. the GM on 8 hours) is set with Edit next to their name.', 'Payroll')}
    ${choiceGroup('cw-hours', 'Carwash work day', [{ value: '8', label: '8 hours' }, { value: '11', label: '11 hours' }], Number(now.carwash_hours),
    { min: 1, max: 24, step: 0.25, unit: 'hours' })}
    ${choiceGroup('cn-hours', 'Construction work day', [{ value: '8', label: '8 hours' }], Number(now.construction_hours),
    { min: 1, max: 24, step: 0.25, unit: 'hours' })}
    ${choiceGroup('ot-pay', 'OT pay per hour', [{ value: '1', label: 'Same as the normal hourly rate' }, { value: '1.25', label: 'Normal + 25% (Labor Code)' }],
    Number(now.multiplier), extra(now.multiplier))}
    ${startsChoice()}
    ${PREVIEW_PANEL}
    <details class="ot-history" data-history><summary>Earlier changes (${rules.length})</summary>
      <div class="table-wrap"><table class="ot-rules-table"><thead><tr><th>From</th><th class="num">Carwash day</th><th class="num">Construction day</th><th>OT pay</th><th></th></tr></thead>
        <tbody>${rules.map(r => `<tr data-rule-row="${r.effective_from}"><td>${r.effective_from === first ? 'The start' : esc(prettyDate(r.effective_from))}</td>
          <td class="num">${Number(r.carwash_hours)} h</td><td class="num">${Number(r.construction_hours)} h</td><td>${otPayWords(r.multiplier)}</td>
          <td class="row-actions">${r.effective_from === first ? '' : '<button class="btn ghost small" type="button" data-del-rule>Undo</button>'}</td></tr>`).join('')}</tbody></table></div>
    </details>
    <div class="modal-actions"><button class="btn ghost" type="button" data-close>Cancel</button><button class="btn" type="button" data-confirm>Save</button></div></div>`,
  modalCard => {
    const card = $('[data-ot-form]', modalCard);
    // Until a choice is touched, picking another start date shows the setting in effect on that date.
    let touched = false;
    card.addEventListener('change', ev => {
      if (ev.target.matches('[name="cw-hours"], [name="cn-hours"], [name="ot-pay"], [data-other]')) touched = true;
      if (!touched && ev.target.matches('[name="starts"], [data-starts-date]') && startsValue(card)) {
        const r = ruleOn(startsValue(card));
        setChoice(card, 'cw-hours', Number(r.carwash_hours));
        setChoice(card, 'cn-hours', Number(r.construction_hours));
        setChoice(card, 'ot-pay', Number(r.multiplier));
      }
    });
    const build = () => {
      const from = startsValue(card);
      if (!from) return { error: 'Pick the date the change starts.' };
      const cw = choiceValue(card, 'cw-hours', 1, 24);
      const cn = choiceValue(card, 'cn-hours', 1, 24);
      const m = choiceValue(card, 'ot-pay', 1, 3);
      if (Number.isNaN(cw) || Number.isNaN(cn)) return { error: 'Enter the hours of a work day (1 to 24).' };
      if (Number.isNaN(m)) return { error: 'Enter the OT multiplier (1 to 3).' };
      return { body: { kind: 'ot-rule', effective_from: from, carwash_hours: cw, construction_hours: cn, multiplier: m } };
    };
    const preview = livePreview(card, build, ex => `Example, ${ex.name}: ${exampleLine(ex)}`);
    $$('[data-del-rule]', card).forEach(btn => btn.addEventListener('click', ev => busy(ev.currentTarget, async () => {
      const from = btn.closest('tr').dataset.ruleRow;
      const p = await api('POST', '/payroll/preview', { kind: 'ot-rule', effective_from: from, remove: true });
      const paid = p.paidOut.length ? `\n\nWages for ${p.paidOut.map(x => `${prettyDate(x.period_start)} – ${prettyDate(x.period_end)}`).join(', ')} are already paid out and would change.` : '';
      if (!window.confirm(`Undo the overtime change from ${prettyDate(from)}? Those days go back to the setting before it.${paid}`)) return;
      await api('DELETE', `/payroll/ot-rules/${from}${p.paidOut.length ? '?confirm_paid=1' : ''}`);
      closeModal();
      toast('Overtime change undone');
      await reload();
    })));
    $('[data-confirm]', card).addEventListener('click', ev => busy(ev.currentTarget, async () => {
      const built = build();
      if (built.error) return toast(built.error, 'error');
      const { effective_from: from, carwash_hours, construction_hours, multiplier } = built.body;
      await api('PUT', `/payroll/ot-rules/${from}`, { carwash_hours, construction_hours, multiplier, confirm_paid: preview.confirmedPaid() });
      closeModal();
      toast('Overtime settings saved');
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
