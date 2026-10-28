// Loads payroll for a date range. Shared by the Payroll screen and the Finance summary so both
// always compute pay the same way.
const { db } = require('./db');
const { payrollForRange, datesBetween, round2, otRuleNote } = require('./calc');

const SHOP_TODAY = "(now() at time zone 'Asia/Manila')::date";

// Employees with the rate (and their own OT hours / multiplier, null = shop rule) in effect today.
const EMPLOYEE_SELECT = `select e.id, e.name, e.role, e.active,
    coalesce(r.rate_per_day, 0) as rate_per_day, coalesce(r.construction_rate, 0) as construction_rate,
    r.carwash_hours, r.ot_multiplier
  from employees e
  left join lateral (
    select rate_per_day, construction_rate, carwash_hours, ot_multiplier from employee_rates
    where employee_id = e.id and effective_from <= ${SHOP_TODAY}
    order by effective_from desc limit 1
  ) r on true`;

const loadOtRules = (q = db) => q.many('select effective_from, multiplier, carwash_hours, construction_hours from ot_rules order by effective_from');

async function loadPayroll(start, end, q = db) {
  const dates = datesBetween(start, end);
  const [employees, rates, attendance, adjustments, payouts, otRules] = await Promise.all([
    q.many(`${EMPLOYEE_SELECT} where e.active
        or exists (select 1 from attendance a where a.employee_id = e.id and a.work_date between $1 and $2)
        or exists (select 1 from payroll_adjustments p where p.employee_id = e.id and p.adj_date between $1 and $2)
      order by e.id`, [start, end]),
    q.many('select employee_id, effective_from, rate_per_day, construction_rate, carwash_hours, ot_multiplier from employee_rates order by effective_from'),
    q.many('select employee_id, work_date, code, cw_ot_hours, cn_ot_hours from attendance where work_date between $1 and $2', [start, end]),
    q.many('select id, employee_id, adj_date, kind, amount, note from payroll_adjustments where adj_date between $1 and $2 order by adj_date, id', [start, end]),
    q.many(`select id, payout_date, period_start, period_end, side, amount, note, created_by from payroll_payouts
      where period_start <= $2 and period_end >= $1 order by payout_date, id`, [start, end]),
    loadOtRules(q),
  ]);
  const rows = employees.map(employee => {
    const days = Object.fromEntries(attendance.filter(a => a.employee_id === employee.id)
      .map(a => [a.work_date, { code: a.code, cw_ot_hours: a.cw_ot_hours, cn_ot_hours: a.cn_ot_hours }]));
    const adj = adjustments.filter(a => a.employee_id === employee.id);
    const own = rates.filter(r => r.employee_id === employee.id).map(({ employee_id, ...r }) => r);
    const pay = payrollForRange({ dates, days, rates: own, adjustments: adj, otRules });
    return { employee, days, adjustments: adj, pay, rates: own };
  });
  return {
    start, end, dates, rows, totalNet: round2(rows.reduce((t, r) => t + r.pay.net, 0)), payouts,
    otRules, otRule: otRuleNote(otRules, start, end),
  };
}

module.exports = { loadPayroll, loadOtRules, EMPLOYEE_SELECT, SHOP_TODAY };
