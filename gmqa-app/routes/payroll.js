// Owner-only: employees and weekly payroll. Each week's entry stores the rates it was paid at,
// so changing an employee's rate later does not rewrite past payroll.
const express = require('express');
const { requireOwner } = require('../lib/auth');
const { db } = require('../lib/db');
const { payrollPay, ATTENDANCE_CODES, mondayOf, addDays, round2 } = require('../lib/calc');
const { bad, notFound, money, text, date, id, pick } = require('../lib/http');

const router = express.Router();
router.use(['/employees', '/payroll'], requireOwner);

const EMPLOYEE_COLUMNS = 'id, name, role, rate_per_day, construction_rate, active';

router.get('/employees', async (req, res) => {
  res.json(await db.many(`select ${EMPLOYEE_COLUMNS} from employees where active order by id`));
});

function cleanEmployee(body, partial) {
  const f = pick(body, ['name', 'role', 'rate_per_day', 'construction_rate']);
  const out = {};
  if (!partial || 'name' in f) out.name = text(f.name, 'Name', { required: true, max: 80 });
  if ('role' in f) out.role = text(f.role, 'Role', { max: 60 }) || '';
  if (!partial || 'rate_per_day' in f) out.rate_per_day = money(f.rate_per_day, 'Carwash rate');
  if (!partial || 'construction_rate' in f) out.construction_rate = money(f.construction_rate, 'Construction rate');
  return out;
}

router.post('/employees', async (req, res) => {
  const e = cleanEmployee(req.body, false);
  const row = await db.tx(req.user.email, async q => {
    // Re-adding someone who was deactivated brings their old record back instead of failing.
    const existing = await q.one('select id from employees where lower(name) = lower($1)', [e.name]);
    if (existing) {
      return q.one(`update employees set active = true, role = coalesce($2, role), rate_per_day = $3, construction_rate = $4
        where id = $1 returning ${EMPLOYEE_COLUMNS}`, [existing.id, e.role ?? null, e.rate_per_day, e.construction_rate]);
    }
    return q.one(`insert into employees (name, role, rate_per_day, construction_rate) values ($1, $2, $3, $4)
      returning ${EMPLOYEE_COLUMNS}`, [e.name, e.role || '', e.rate_per_day, e.construction_rate]);
  });
  res.status(201).json(row);
});

router.patch('/employees/:id', async (req, res) => {
  const employeeId = id(req.params.id, 'employee');
  const e = cleanEmployee(req.body, true);
  const cols = Object.keys(e);
  if (!cols.length) throw bad('Nothing to save');
  const row = await db.tx(req.user.email, q => q.one(
    `update employees set ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')} where id = $1 returning ${EMPLOYEE_COLUMNS}`,
    [employeeId, ...cols.map(c => e[c])]));
  if (!row) throw notFound('Employee');
  res.json(row);
});

router.delete('/employees/:id', async (req, res) => {
  const changed = await db.tx(req.user.email, q => q.exec('update employees set active = false where id = $1 and active', [id(req.params.id, 'employee')]));
  if (!changed) throw notFound('Employee');
  res.json({ ok: true });
});

async function loadWeek(weekStart) {
  const [employees, entries] = await Promise.all([
    db.many(`select ${EMPLOYEE_COLUMNS} from employees
      where active or id in (select employee_id from payroll_entries where period_start = $1) order by id`, [weekStart]),
    db.many('select * from payroll_entries where period_start = $1', [weekStart]),
  ]);
  const rows = employees.map(employee => {
    const saved = entries.find(e => e.employee_id === employee.id);
    const entry = saved || {
      employee_id: employee.id, period_start: weekStart, attendance: {}, cw_ot_hours: 0, cn_ot_hours: 0,
      deductions: 0, notes: '', rate_per_day: employee.rate_per_day, construction_rate: employee.construction_rate,
    };
    return { employee, entry, saved: Boolean(saved), pay: payrollPay(entry) };
  });
  const dates = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
  return { weekStart, dates, rows, totalNet: round2(rows.reduce((t, r) => t + r.pay.net, 0)) };
}

router.get('/payroll/:week', async (req, res) => {
  res.json(await loadWeek(mondayOf(date(req.params.week, 'Week'))));
});

router.put('/payroll/:week/:employeeId', async (req, res) => {
  const weekStart = mondayOf(date(req.params.week, 'Week'));
  const employeeId = id(req.params.employeeId, 'employee');
  const dates = new Set(Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)));
  const b = req.body || {};

  const attendance = {};
  for (const [day, code] of Object.entries(b.attendance || {})) {
    if (!dates.has(day)) throw bad(`${day} is not in the week starting ${weekStart}`);
    if (code === '' || code == null) continue;
    if (!ATTENDANCE_CODES.includes(code)) throw bad(`Unknown attendance code ${code}`);
    attendance[day] = code;
  }

  await db.tx(req.user.email, async q => {
    const employee = await q.one('select * from employees where id = $1', [employeeId]);
    if (!employee) throw notFound('Employee');
    const rate = 'rate_per_day' in b ? money(b.rate_per_day, 'Carwash rate') : null;
    const cnRate = 'construction_rate' in b ? money(b.construction_rate, 'Construction rate') : null;
    await q.query(`insert into payroll_entries (employee_id, period_start, attendance, cw_ot_hours, cn_ot_hours, deductions, notes,
        rate_per_day, construction_rate)
      values ($1, $2, $3::jsonb, $4, $5, $6, $7, coalesce($8::numeric, $10::numeric), coalesce($9::numeric, $11::numeric))
      on conflict (employee_id, period_start) do update set attendance = excluded.attendance, cw_ot_hours = excluded.cw_ot_hours,
        cn_ot_hours = excluded.cn_ot_hours, deductions = excluded.deductions, notes = excluded.notes,
        rate_per_day = coalesce($8::numeric, payroll_entries.rate_per_day),
        construction_rate = coalesce($9::numeric, payroll_entries.construction_rate)`,
    [employeeId, weekStart, JSON.stringify(attendance), money(b.cw_ot_hours, 'Carwash OT hours'),
      money(b.cn_ot_hours, 'Construction OT hours'), money(b.deductions, 'Deductions'), text(b.notes, 'Notes', { max: 300 }) || '',
      rate, cnRate, employee.rate_per_day, employee.construction_rate]);
    // A rate typed into the payroll grid also becomes the employee's rate from now on.
    if (b.apply_rates_to_employee && (rate != null || cnRate != null)) {
      await q.query(`update employees set rate_per_day = coalesce($2::numeric, rate_per_day),
        construction_rate = coalesce($3::numeric, construction_rate) where id = $1`,
        [employeeId, rate, cnRate]);
    }
  });
  res.json(await loadWeek(weekStart));
});

module.exports = { router };
