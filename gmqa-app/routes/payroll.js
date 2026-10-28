// Owner-only: employees and payroll by any date range. Attendance and overtime are recorded per
// day, adjustments (cash advance, bonus) per date, and each day is paid at the rate in effect that
// day (employee_rates), so changing a rate never rewrites earlier periods.
const express = require('express');
const { requireOwner } = require('../lib/auth');
const { db } = require('../lib/db');
const { ATTENDANCE_CODES, datesBetween } = require('../lib/calc');
const { loadPayroll, EMPLOYEE_SELECT, SHOP_TODAY } = require('../lib/payroll-data');
const signoff = require('../lib/signoff-pdf');
const { bad, notFound, money, between, text, date, oneOf, id, pick } = require('../lib/http');

const router = express.Router();
router.use(['/employees', '/payroll'], requireOwner);

const MAX_RANGE_DAYS = 62;
const loadEmployee = (q, employeeId) => q.one(`${EMPLOYEE_SELECT} where e.id = $1`, [employeeId]);
// Normal hours of a day and the OT multiplier: the shop rule's, or an employee's own (blank = shop rule).
const hours = (value, field, opts) => between(value, field, 1, 24, opts);
const multiplier = (value, field, opts) => between(value, field, 1, 3, opts);
const RATE_UPSERT = `insert into employee_rates (employee_id, effective_from, rate_per_day, construction_rate, carwash_hours, ot_multiplier)
  values ($1, $2, $3, $4, $5, $6)
  on conflict (employee_id, effective_from) do update set rate_per_day = excluded.rate_per_day, construction_rate = excluded.construction_rate,
    carwash_hours = excluded.carwash_hours, ot_multiplier = excluded.ot_multiplier`;

router.get('/employees', async (req, res) => {
  res.json(await db.many(`${EMPLOYEE_SELECT} where e.active order by e.id`));
});

router.post('/employees', async (req, res) => {
  const name = text(req.body.name, 'Name', { required: true, max: 80 });
  const role = text(req.body.role, 'Role', { max: 60 }) || '';
  const rate = money(req.body.rate_per_day, 'Carwash rate');
  const cnRate = money(req.body.construction_rate, 'Construction rate');
  const cwHours = hours(req.body.carwash_hours, 'Carwash hours', { allowNull: true });
  const otX = multiplier(req.body.ot_multiplier, 'OT multiplier', { allowNull: true });
  const employeeId = await db.tx(req.user.email, async q => {
    // Re-adding someone who was deactivated brings their old record (and history) back.
    const existing = await q.one('select id from employees where lower(name) = lower($1)', [name]);
    if (existing) {
      await q.query('update employees set active = true, role = $2 where id = $1', [existing.id, role]);
      const today = (await q.one(`select ${SHOP_TODAY} as d`)).d;
      await q.query(RATE_UPSERT, [existing.id, today, rate, cnRate, cwHours, otX]);
      return existing.id;
    }
    const row = await q.one('insert into employees (name, role) values ($1, $2) returning id', [name, role]);
    await q.query(RATE_UPSERT, [row.id, '2000-01-01', rate, cnRate, cwHours, otX]);
    return row.id;
  });
  res.status(201).json(await loadEmployee(db, employeeId));
});

// Rates, and the employee's own carwash hours / OT multiplier (blank = shop rule), change from
// `effective_from` (default: today); earlier days keep what they had.
const RATE_FIELDS = ['rate_per_day', 'construction_rate', 'carwash_hours', 'ot_multiplier'];
router.patch('/employees/:id', async (req, res) => {
  const employeeId = id(req.params.id, 'employee');
  const f = pick(req.body, ['name', 'role', ...RATE_FIELDS, 'effective_from']);
  await db.tx(req.user.email, async q => {
    if (!(await q.one('select 1 from employees where id = $1', [employeeId]))) throw notFound('Employee');
    if ('name' in f) await q.query('update employees set name = $2 where id = $1', [employeeId, text(f.name, 'Name', { required: true, max: 80 })]);
    if ('role' in f) await q.query('update employees set role = $2 where id = $1', [employeeId, text(f.role, 'Role', { max: 60 }) || '']);
    if (RATE_FIELDS.some(k => k in f)) {
      const from = f.effective_from ? date(f.effective_from, 'Effective date')
        : (await q.one(`select ${SHOP_TODAY} as d`)).d;
      const current = await q.one(`select rate_per_day, construction_rate, carwash_hours, ot_multiplier from employee_rates
        where employee_id = $1 and effective_from <= $2 order by effective_from desc limit 1`, [employeeId, from])
        || { rate_per_day: 0, construction_rate: 0, carwash_hours: null, ot_multiplier: null };
      const rate = 'rate_per_day' in f ? money(f.rate_per_day, 'Carwash rate') : current.rate_per_day;
      const cnRate = 'construction_rate' in f ? money(f.construction_rate, 'Construction rate') : current.construction_rate;
      const cwHours = 'carwash_hours' in f ? hours(f.carwash_hours, 'Carwash hours', { allowNull: true }) : current.carwash_hours;
      const otX = 'ot_multiplier' in f ? multiplier(f.ot_multiplier, 'OT multiplier', { allowNull: true }) : current.ot_multiplier;
      await q.query(RATE_UPSERT, [employeeId, from, rate, cnRate, cwHours, otX]);
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
  const { start, end } = cleanRange(req.query);
  res.json(await loadPayroll(start, end));
});

// The shop's overtime rule from a date on (the multiplier and the normal hours of a carwash and a
// construction day). Saving a date that already has a rule changes it; earlier days keep theirs.
router.put('/payroll/ot-rules/:date', async (req, res) => {
  const from = date(req.params.date, 'Effective date');
  const values = [from, multiplier(req.body.multiplier, 'OT multiplier'),
    hours(req.body.carwash_hours, 'Carwash hours'), hours(req.body.construction_hours, 'Construction hours')];
  const row = await db.tx(req.user.email, q => q.one(`insert into ot_rules (effective_from, multiplier, carwash_hours, construction_hours)
    values ($1, $2, $3, $4)
    on conflict (effective_from) do update set multiplier = excluded.multiplier, carwash_hours = excluded.carwash_hours,
      construction_hours = excluded.construction_hours
    returning effective_from, multiplier, carwash_hours, construction_hours`, values));
  res.json(row);
});

// The first rule covers every earlier day, so it stays; a later one can be removed (its days then
// follow the rule before it).
router.delete('/payroll/ot-rules/:date', async (req, res) => {
  const from = date(req.params.date, 'Effective date');
  await db.tx(req.user.email, async q => {
    const first = await q.one('select min(effective_from) as d from ot_rules');
    if (first?.d === from) throw bad('The first overtime rule covers all earlier days and cannot be deleted. Change it instead.');
    if (!(await q.exec('delete from ot_rules where effective_from = $1', [from]))) throw notFound('Overtime rule');
  });
  res.json({ ok: true });
});

// Printable sign-off sheet (PDF) for one pay period, from the same payroll as the screen.
router.get('/payroll/signoff.pdf', async (req, res) => {
  const { start, end, dates } = cleanRange(req.query);
  if (dates.length > signoff.MAX_DAYS) {
    throw bad(`A sign-off sheet covers one pay period of at most ${signoff.MAX_DAYS} days (a week, 1st–15th or 16th–end)`);
  }
  const pdf = await signoff.buildPdf(await loadPayroll(start, end));
  res.set({
    'Content-Type': 'application/pdf',
    'Content-Disposition': `attachment; filename="${signoff.fileName(start, end)}"`,
    'Cache-Control': 'no-store',
  }).send(pdf);
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
