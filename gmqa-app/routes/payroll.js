// Owner-only: employees and payroll by any date range. Attendance and overtime are recorded per
// day, adjustments (cash advance, bonus) per date, and each day is paid at the rate in effect that
// day (employee_rates), so changing a rate never rewrites earlier periods.
const express = require('express');
const { requireOwner } = require('../lib/auth');
const { db } = require('../lib/db');
const { payrollForRange, ATTENDANCE_CODES, datesBetween, round2 } = require('../lib/calc');
const { bad, notFound, money, text, date, oneOf, id, pick } = require('../lib/http');

const router = express.Router();
router.use(['/employees', '/payroll'], requireOwner);

const MAX_RANGE_DAYS = 62;
const SHOP_TODAY = "(now() at time zone 'Asia/Manila')::date";
// Employees with the rate in effect today.
const EMPLOYEE_SELECT = `select e.id, e.name, e.role, e.active,
    coalesce(r.rate_per_day, 0) as rate_per_day, coalesce(r.construction_rate, 0) as construction_rate
  from employees e
  left join lateral (
    select rate_per_day, construction_rate from employee_rates
    where employee_id = e.id and effective_from <= ${SHOP_TODAY}
    order by effective_from desc limit 1
  ) r on true`;

const loadEmployee = (q, employeeId) => q.one(`${EMPLOYEE_SELECT} where e.id = $1`, [employeeId]);

router.get('/employees', async (req, res) => {
  res.json(await db.many(`${EMPLOYEE_SELECT} where e.active order by e.id`));
});

router.post('/employees', async (req, res) => {
  const name = text(req.body.name, 'Name', { required: true, max: 80 });
  const role = text(req.body.role, 'Role', { max: 60 }) || '';
  const rate = money(req.body.rate_per_day, 'Carwash rate');
  const cnRate = money(req.body.construction_rate, 'Construction rate');
  const employeeId = await db.tx(req.user.email, async q => {
    // Re-adding someone who was deactivated brings their old record (and history) back.
    const existing = await q.one('select id from employees where lower(name) = lower($1)', [name]);
    if (existing) {
      await q.query('update employees set active = true, role = $2 where id = $1', [existing.id, role]);
      await q.query(`insert into employee_rates (employee_id, effective_from, rate_per_day, construction_rate)
        values ($1, ${SHOP_TODAY}, $2, $3)
        on conflict (employee_id, effective_from) do update set rate_per_day = excluded.rate_per_day, construction_rate = excluded.construction_rate`,
      [existing.id, rate, cnRate]);
      return existing.id;
    }
    const row = await q.one('insert into employees (name, role) values ($1, $2) returning id', [name, role]);
    await q.query("insert into employee_rates (employee_id, effective_from, rate_per_day, construction_rate) values ($1, '2000-01-01', $2, $3)",
      [row.id, rate, cnRate]);
    return row.id;
  });
  res.status(201).json(await loadEmployee(db, employeeId));
});

// Rates change from `effective_from` (default: today); earlier days keep the rate they had.
router.patch('/employees/:id', async (req, res) => {
  const employeeId = id(req.params.id, 'employee');
  const f = pick(req.body, ['name', 'role', 'rate_per_day', 'construction_rate', 'effective_from']);
  await db.tx(req.user.email, async q => {
    if (!(await q.one('select 1 from employees where id = $1', [employeeId]))) throw notFound('Employee');
    if ('name' in f) await q.query('update employees set name = $2 where id = $1', [employeeId, text(f.name, 'Name', { required: true, max: 80 })]);
    if ('role' in f) await q.query('update employees set role = $2 where id = $1', [employeeId, text(f.role, 'Role', { max: 60 }) || '']);
    if ('rate_per_day' in f || 'construction_rate' in f) {
      const from = f.effective_from ? date(f.effective_from, 'Effective date')
        : (await q.one(`select ${SHOP_TODAY} as d`)).d;
      const current = await q.one(`select rate_per_day, construction_rate from employee_rates
        where employee_id = $1 and effective_from <= $2 order by effective_from desc limit 1`, [employeeId, from])
        || { rate_per_day: 0, construction_rate: 0 };
      const rate = 'rate_per_day' in f ? money(f.rate_per_day, 'Carwash rate') : current.rate_per_day;
      const cnRate = 'construction_rate' in f ? money(f.construction_rate, 'Construction rate') : current.construction_rate;
      await q.query(`insert into employee_rates (employee_id, effective_from, rate_per_day, construction_rate) values ($1, $2, $3, $4)
        on conflict (employee_id, effective_from) do update set rate_per_day = excluded.rate_per_day, construction_rate = excluded.construction_rate`,
      [employeeId, from, rate, cnRate]);
    }
  });
  res.json(await loadEmployee(db, employeeId));
});

router.delete('/employees/:id', async (req, res) => {
  const changed = await db.tx(req.user.email, q => q.exec('update employees set active = false where id = $1 and active', [id(req.params.id, 'employee')]));
  if (!changed) throw notFound('Employee');
  res.json({ ok: true });
});

// ---------------------------------------------------------------- payroll for a range

function cleanRange(query) {
  const start = date(query.start, 'Start date');
  const end = date(query.end, 'End date');
  if (start > end) throw bad('Start date must be on or before the end date');
  const dates = datesBetween(start, end);
  if (dates.length > MAX_RANGE_DAYS) throw bad(`Pick a range of at most ${MAX_RANGE_DAYS} days`);
  return { start, end, dates };
}

router.get('/payroll', async (req, res) => {
  const { start, end, dates } = cleanRange(req.query);
  const [employees, rates, attendance, adjustments, payouts] = await Promise.all([
    db.many(`${EMPLOYEE_SELECT} where e.active
        or exists (select 1 from attendance a where a.employee_id = e.id and a.work_date between $1 and $2)
        or exists (select 1 from payroll_adjustments p where p.employee_id = e.id and p.adj_date between $1 and $2)
      order by e.id`, [start, end]),
    db.many('select employee_id, effective_from, rate_per_day, construction_rate from employee_rates order by effective_from'),
    db.many('select employee_id, work_date, code, cw_ot_hours, cn_ot_hours from attendance where work_date between $1 and $2', [start, end]),
    db.many('select id, employee_id, adj_date, kind, amount, note from payroll_adjustments where adj_date between $1 and $2 order by adj_date, id', [start, end]),
    db.many(`select id, payout_date, period_start, period_end, side, amount, note, created_by from payroll_payouts
      where period_start <= $2 and period_end >= $1 order by payout_date, id`, [start, end]),
  ]);
  const rows = employees.map(employee => {
    const days = Object.fromEntries(attendance.filter(a => a.employee_id === employee.id)
      .map(a => [a.work_date, { code: a.code, cw_ot_hours: a.cw_ot_hours, cn_ot_hours: a.cn_ot_hours }]));
    const adj = adjustments.filter(a => a.employee_id === employee.id);
    const pay = payrollForRange({ dates, days, rates: rates.filter(r => r.employee_id === employee.id), adjustments: adj });
    return { employee, days, adjustments: adj, pay };
  });
  res.json({ start, end, dates, rows, totalNet: round2(rows.reduce((t, r) => t + r.pay.net, 0)), payouts });
});

router.put('/payroll/attendance/:employeeId/:date', async (req, res) => {
  const employeeId = id(req.params.employeeId, 'employee');
  const day = date(req.params.date, 'Date');
  const code = req.body.code ? oneOf(req.body.code, ATTENDANCE_CODES, 'Attendance code') : null;
  const cwOt = money(req.body.cw_ot_hours, 'Carwash OT hours');
  const cnOt = money(req.body.cn_ot_hours, 'Construction OT hours');
  if (cwOt > 24 || cnOt > 24) throw bad('Overtime cannot be more than 24 hours in a day');
  await db.tx(req.user.email, async q => {
    if (!(await q.one('select 1 from employees where id = $1', [employeeId]))) throw notFound('Employee');
    if (!code && !cwOt && !cnOt) {
      await q.query('delete from attendance where employee_id = $1 and work_date = $2', [employeeId, day]);
    } else {
      await q.query(`insert into attendance (employee_id, work_date, code, cw_ot_hours, cn_ot_hours) values ($1, $2, $3, $4, $5)
        on conflict (employee_id, work_date) do update set code = excluded.code, cw_ot_hours = excluded.cw_ot_hours, cn_ot_hours = excluded.cn_ot_hours`,
      [employeeId, day, code, cwOt, cnOt]);
    }
  });
  res.json({ ok: true });
});

router.post('/payroll/adjustments', async (req, res) => {
  const employeeId = id(req.body.employee_id, 'employee');
  const values = [employeeId, date(req.body.date, 'Date'), oneOf(req.body.kind, ['addition', 'deduction'], 'Type'),
    money(req.body.amount, 'Amount', { min: 0.01 }), text(req.body.note, 'Note', { required: true, max: 200 })];
  const row = await db.tx(req.user.email, async q => {
    if (!(await q.one('select 1 from employees where id = $1', [employeeId]))) throw notFound('Employee');
    return q.one(`insert into payroll_adjustments (employee_id, adj_date, kind, amount, note) values ($1, $2, $3, $4, $5)
      returning id, employee_id, adj_date, kind, amount, note`, values);
  });
  res.status(201).json(row);
});

router.delete('/payroll/adjustments/:id', async (req, res) => {
  const changed = await db.tx(req.user.email, q => q.exec('delete from payroll_adjustments where id = $1', [id(req.params.id, 'adjustment')]));
  if (!changed) throw notFound('Adjustment');
  res.json({ ok: true });
});

// Wages paid out of the drawer: they reduce the expected cash/GCash in that day's EOD.
router.post('/payroll/payouts', async (req, res) => {
  const periodStart = date(req.body.period_start, 'Period start');
  const periodEnd = date(req.body.period_end, 'Period end');
  if (periodStart > periodEnd) throw bad('Period start must be on or before the period end');
  const row = await db.tx(req.user.email, q => q.one(`insert into payroll_payouts (payout_date, period_start, period_end, side, amount, note)
    values ($1, $2, $3, $4, $5, $6) returning *`, [
    date(req.body.payout_date, 'Payout date'), periodStart, periodEnd, oneOf(req.body.side, ['cash', 'gcash'], 'Paid from'),
    money(req.body.amount, 'Amount', { min: 0.01 }), text(req.body.note, 'Note', { max: 200 }),
  ]));
  res.status(201).json(row);
});

router.delete('/payroll/payouts/:id', async (req, res) => {
  const changed = await db.tx(req.user.email, q => q.exec('delete from payroll_payouts where id = $1', [id(req.params.id, 'payout')]));
  if (!changed) throw notFound('Payout');
  res.json({ ok: true });
});

module.exports = { router };
