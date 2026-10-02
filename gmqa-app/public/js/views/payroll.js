import { $, $$, api, esc, peso, toast, busy, todayLocal, addDays, mondayOf, weekday, openModal, closeModal, modalHeader } from '../ui.js';

let root;
let week = mondayOf(todayLocal());
let data = null;
const CODES = ['', 'P', '0.5P', 'CN', '0.5CN', 'A', 'OFF'];

function mount(el) {
  root = el;
  root.innerHTML = `
    <div class="view-header">
      <div><h1>Payroll</h1><div class="desc">Mark attendance, overtime and deductions. Each week keeps the rates it was paid at.</div></div>
      <div class="date-nav">
        <button class="btn ghost" type="button" data-shift="-7" aria-label="Previous week">‹</button>
        <input type="date" data-week title="Any day in the week">
        <button class="btn ghost" type="button" data-shift="7" aria-label="Next week">›</button>
      </div>
    </div>
    <div class="card">
      <div class="attendance-legend">
        <span class="attendance-code present">P = Carwash day</span><span class="attendance-code half">0.5P = Half carwash</span>
        <span class="attendance-code construction">CN = Construction</span><span class="attendance-code half">0.5CN = Half construction</span>
        <span class="attendance-code absence">A = Absent</span><span class="attendance-code off">OFF = Day off</span>
        <span class="hint">OT pays rate ÷ 8 × 1.25 per hour.</span>
      </div>
      <div class="table-wrap"><table class="payroll-table"><thead data-head></thead><tbody data-body></tbody></table></div>
      <div class="row-line total mt"><span>Total net pay</span><span class="money" data-total></span></div>
      <div class="entry-actions"><button class="btn ghost" type="button" data-add-employee>+ Add employee</button></div>
    </div>`;
  $('[data-week]', root).addEventListener('change', e => { if (e.target.value) setWeek(mondayOf(e.target.value)); });
  $$('[data-shift]', root).forEach(b => b.addEventListener('click', () => setWeek(addDays(week, Number(b.dataset.shift)))));
  $('[data-add-employee]', root).addEventListener('click', addEmployee);
}

async function show() { await setWeek(week); }

async function setWeek(monday) {
  week = monday;
  $('[data-week]', root).value = monday;
  data = await api('GET', `/payroll/${monday}`);
  render();
}

function render() {
  $('[data-head]', root).innerHTML = `<tr><th>Employee</th><th>Role</th>
    ${data.dates.map(d => `<th class="attendance-day">${weekday(d)}<small>${d.slice(5)}</small></th>`).join('')}
    <th class="num">CW days</th><th class="num">CN days</th><th class="num">CW rate</th><th class="num">CN rate</th>
    <th class="num">CW OT h</th><th class="num">CN OT h</th><th class="num">Gross</th><th class="num">Deduct.</th><th class="num">Net</th><th></th></tr>`;
  $('[data-body]', root).innerHTML = data.rows.length ? data.rows.map(({ employee: e, entry, pay }) => `
    <tr data-emp="${e.id}" class="${e.active ? '' : 'inactive'}">
      <td><input type="text" data-emp-field="name" value="${esc(e.name)}" class="employee-name" maxlength="80"></td>
      <td><input type="text" data-emp-field="role" value="${esc(e.role)}" class="employee-role" placeholder="Role" maxlength="60"></td>
      ${data.dates.map(d => `<td class="attendance-cell"><select data-day="${d}" class="attendance-select code-${(entry.attendance[d] || 'none').replace('.', '_')}">
        ${CODES.map(c => `<option value="${c}" ${(entry.attendance[d] || '') === c ? 'selected' : ''}>${c || '—'}</option>`).join('')}</select></td>`).join('')}
      <td class="num">${pay.carwashDays}</td><td class="num">${pay.constructionDays}</td>
      <td class="num"><input type="number" min="0" step="0.01" class="mini-input" data-entry="rate_per_day" value="${entry.rate_per_day}"></td>
      <td class="num"><input type="number" min="0" step="0.01" class="mini-input" data-entry="construction_rate" value="${entry.construction_rate}"></td>
      <td class="num"><input type="number" min="0" step="0.25" class="mini-input" data-entry="cw_ot_hours" value="${entry.cw_ot_hours || 0}"></td>
      <td class="num"><input type="number" min="0" step="0.25" class="mini-input" data-entry="cn_ot_hours" value="${entry.cn_ot_hours || 0}"></td>
      <td class="num money">${peso(pay.gross)}</td>
      <td class="num"><input type="number" min="0" step="0.01" class="mini-input" data-entry="deductions" value="${entry.deductions || 0}"></td>
      <td class="num money pos">${peso(pay.net)}</td>
      <td>${e.active ? '<button class="icon-btn" type="button" data-deactivate title="Remove from payroll">✕</button>' : '<span class="muted small">inactive</span>'}</td>
    </tr>`).join('') : '<tr><td colspan="20"><div class="empty-state">No employees yet.</div></td></tr>';
  $('[data-total]', root).textContent = peso(data.totalNet);

  $$('[data-day], [data-entry]', root).forEach(el => el.addEventListener('change', () => saveEntry(el.closest('tr'))));
  $$('[data-emp-field]', root).forEach(el => el.addEventListener('change', () => saveEmployee(el)));
  $$('[data-deactivate]', root).forEach(b => b.addEventListener('click', () => deactivate(Number(b.closest('tr').dataset.emp))));
}

async function saveEntry(tr) {
  const body = { attendance: {}, apply_rates_to_employee: true };
  $$('[data-day]', tr).forEach(s => { body.attendance[s.dataset.day] = s.value; });
  $$('[data-entry]', tr).forEach(i => { body[i.dataset.entry] = Number(i.value || 0); });
  tr.classList.add('saving');
  try {
    data = await api('PUT', `/payroll/${week}/${tr.dataset.emp}`, body);
  } finally {
    render();
  }
}

async function saveEmployee(el) {
  await api('PATCH', `/employees/${el.closest('tr').dataset.emp}`, { [el.dataset.empField]: el.value.trim() });
  toast('Employee saved');
  await setWeek(week);
}

async function deactivate(id) {
  const row = data.rows.find(r => r.employee.id === id);
  if (!window.confirm(`Remove ${row.employee.name} from payroll? Their past weeks are kept.`)) return;
  await api('DELETE', `/employees/${id}`);
  toast(`${row.employee.name} removed`);
  await setWeek(week);
}

function addEmployee() {
  openModal(`${modalHeader('Add employee', 'Re-adding a former employee brings their record back.', 'Team')}
    <div class="form-grid modal-form-grid">
      <div><label>Name</label><input type="text" data-n="name" maxlength="80"></div>
      <div><label>Role</label><input type="text" data-n="role" placeholder="Detailer" maxlength="60"></div>
      <div><label>Carwash rate / day</label><input type="number" min="0" step="0.01" data-n="rate_per_day" value="250"></div>
      <div><label>Construction rate / day</label><input type="number" min="0" step="0.01" data-n="construction_rate" value="700"></div>
    </div>
    <div class="modal-actions"><button class="btn ghost" type="button" data-close>Cancel</button><button class="btn" type="button" data-confirm>Add employee</button></div>`,
  card => {
    $('[data-n="name"]', card).focus();
    $('[data-confirm]', card).addEventListener('click', e => busy(e.currentTarget, async () => {
      const get = k => $(`[data-n="${k}"]`, card).value;
      if (!get('name').trim()) return toast('Name is required', 'error');
      await api('POST', '/employees', { name: get('name'), role: get('role'), rate_per_day: Number(get('rate_per_day') || 0), construction_rate: Number(get('construction_rate') || 0) });
      closeModal();
      toast('Employee added');
      await setWeek(week);
    }));
  });
}

export default { mount, show };
