// Loads payroll for a date range. Shared by the Payroll screen and the Finance summary so both
// always compute pay the same way.
const { db } = require('./db');
const { payrollForRange, datesBetween, round2, otRuleNote, otHourly, rateOn, addDays, longDate } = require('./calc');

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
const RATES_SQL = 'select employee_id, effective_from, rate_per_day, construction_rate, carwash_hours, ot_multiplier from employee_rates order by effective_from';

// An employee's rate row from a date: the fields given, the rest as they were on that date (like PATCH).
const RATE_DEFAULTS = { rate_per_day: 0, construction_rate: 0, carwash_hours: null, ot_multiplier: null };
const RATE_FIELDS = Object.keys(RATE_DEFAULTS);
function rateRowFrom(current, fields, from) {
  const row = { effective_from: from };
  for (const k of RATE_FIELDS) row[k] = fields[k] !== undefined ? fields[k] : (current[k] ?? RATE_DEFAULTS[k]);
  return row;
}
const byDate = (a, b) => (a.effective_from < b.effective_from ? -1 : 1);

// What a change would do before it is saved, so the owner sees it and mistakes are caught:
//   change = { kind: 'ot-rule', effective_from, multiplier, carwash_hours, construction_hours, remove? }
//         or { kind: 'employee', employee_id?, name?, effective_from, ...rate fields } (no id: a new employee)
// It covers the days from its date until the next change of the same thing, and returns whose pay
// changes, one OT hour's pay as an example, and the payouts already recorded for weeks whose pay changes.
async function previewChange(change, q = db) {
  const from = change.effective_from;
  const [rules, rates, employees] = await Promise.all([loadOtRules(q), q.many(RATES_SQL), q.many('select id, name, active from employees order by id')]);
  const ownRates = id => rates.filter(r => r.employee_id === id);
  let newRules = rules;
  let newOwn = null; // the changed employee's new rate rows
  let next;
  if (change.kind === 'ot-rule') {
    const others = rules.filter(r => r.effective_from !== from);
    newRules = change.remove ? others : [...others, { effective_from: from, multiplier: change.multiplier,
      carwash_hours: change.carwash_hours, construction_hours: change.construction_hours }].sort(byDate);
    next = rules.find(r => r.effective_from > from)?.effective_from;
  } else {
    const own = change.employee_id ? ownRates(change.employee_id) : [];
    newOwn = [...own.filter(r => r.effective_from !== from), rateRowFrom(rateOn(own, from), change, own.length ? from : '2000-01-01')].sort(byDate);
    next = own.find(r => r.effective_from > from)?.effective_from;
  }
  const until = next ? addDays(next, -1) : null;
  const ids = change.kind === 'employee' ? [change.employee_id || 0] : employees.map(e => e.id);
  const attendance = await q.many(`select employee_id, work_date, code, cw_ot_hours, cn_ot_hours from attendance
    where work_date >= $1 and ($2::date is null or work_date <= $2) and employee_id = any($3::bigint[])`, [from, until, ids]);
  const last = attendance.reduce((m, a) => (a.work_date > m ? a.work_date : m), from);
  const dates = datesBetween(from, last);
  const payOn = (id, ds, which) => {
    const days = Object.fromEntries(attendance.filter(a => a.employee_id === id).map(a => [a.work_date, a]));
    const own = which === 'after' && newOwn ? newOwn : ownRates(id);
    return payrollForRange({ dates: ds, days, rates: own, otRules: which === 'after' ? newRules : rules });
  };
  const affected = [...new Set(attendance.map(a => a.employee_id))];
  const changes = affected.map(id => {
    const before = payOn(id, dates, 'before');
    const after = payOn(id, dates, 'after');
    return { employee_id: id, name: employees.find(e => e.id === id)?.name, otHours: before.otHours,
      before: { otPay: before.otPay, gross: before.gross }, after: { otPay: after.otPay, gross: after.gross } };
  }).filter(c => c.before.gross !== c.after.gross).sort((a, b) => a.employee_id - b.employee_id);

  // A payout is only flagged when pay inside its own period changes.
  const payouts = await q.many(`select payout_date, period_start, period_end from payroll_payouts
    where period_end >= $1 and ($2::date is null or period_start <= $2) order by period_start, id`, [from, until]);
  const paidOut = payouts.filter(p => {
    const ds = datesBetween(p.period_start < from ? from : p.period_start, until && p.period_end > until ? until : p.period_end);
    return changes.some(c => payOn(c.employee_id, ds, 'before').gross !== payOn(c.employee_id, ds, 'after').gross);
  });

  let example = null;
  if (change.kind === 'employee') {
    const h = otHourly(newOwn, newRules, from);
    example = { name: change.employee_id ? employees.find(e => e.id === change.employee_id)?.name : (change.name || 'This employee'),
      rate: Number(rateOn(newOwn, from).rate_per_day), hours: h.carwashHours, multiplier: h.multiplier, perHour: round2(h.carwash) };
  } else {
    // Someone on the shop rule that day, to show what one OT hour pays.
    const onShop = employees.filter(e => e.active).map(e => ({ e, r: rateOn(ownRates(e.id), from) }))
      .find(({ r }) => Number(r.rate_per_day) > 0 && r.carwash_hours == null && r.ot_multiplier == null);
    if (onShop) {
      const h = otHourly(ownRates(onShop.e.id), newRules, from);
      example = { name: onShop.e.name, rate: Number(onShop.r.rate_per_day), hours: h.carwashHours, multiplier: h.multiplier, perHour: round2(h.carwash) };
    }
  }
  return { from, until, changes, paidOut, example };
}

// The message when a change would alter pay already handed out (the UI asks for a second confirm).
const paidOutMessage = paidOut => `This changes pay for weeks already paid out (${paidOut
  .map(p => `${longDate(p.period_start)} – ${longDate(p.period_end)}`).join(', ')}). Confirm to go ahead.`;

async function loadPayroll(start, end, q = db) {
  const dates = datesBetween(start, end);
  const [employees, rates, attendance, adjustments, payouts, otRules] = await Promise.all([
    q.many(`${EMPLOYEE_SELECT} where e.active
        or exists (select 1 from attendance a where a.employee_id = e.id and a.work_date between $1 and $2)
        or exists (select 1 from payroll_adjustments p where p.employee_id = e.id and p.adj_date between $1 and $2)
      order by e.id`, [start, end]),
    q.many(RATES_SQL),
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

module.exports = { loadPayroll, loadOtRules, previewChange, paidOutMessage, rateRowFrom, RATE_FIELDS, EMPLOYEE_SELECT, SHOP_TODAY };
