// All money math lives here, as pure functions, so every screen uses the same rules.
//
// Revenue rule (agreed 2026-10-03):
//   * A job counts once it has a vehicle class or at least one line item, and is not voided.
//   * Collected (Gross Sales) = totals of counted jobs the customer has paid.
//   * Receivables            = totals of counted jobs not yet paid.
//   * Commission             = every counted job (detailers are paid at EOD either way).
//   * Net                    = Collected − Commission.
//
// Departments (agreed 2026-10-03):
//   * Carwash jobs are same-day and count on their job date.
//   * Detailing and Tint & PPF jobs are "running": they count (sale + commission) only on their
//     sale date = the later of the day the work was closed and the day they were paid in full.
//   * Money is reconciled on the day it is received: a running job paid before it is done puts
//     cash in that day's drawer, while its sale is booked on the sale date.

// catalog: whether the department sells Pricing Matrix services/add-ons (the parts counter sells
// inventory parts only, and needs no vehicle).
const DEPARTMENTS = [
  { key: 'carwash', label: 'Carwash', prefix: 'CW', running: false, catalog: true },
  { key: 'detailing', label: 'Detailing', prefix: 'DT', running: true, catalog: true },
  { key: 'tint_ppf', label: 'Tint & PPF', prefix: 'TP', running: true, catalog: true },
  { key: 'parts', label: 'Parts counter', prefix: 'PC', running: false, catalog: false },
];
const DEPARTMENT_KEYS = DEPARTMENTS.map(d => d.key);
const department = key => DEPARTMENTS.find(d => d.key === key) || null;
const isRunning = job => Boolean(department(job.department || 'carwash')?.running);

function saleDate(job) {
  if (!isRunning(job)) return job.job_date;
  if (!job.closed_on || !job.paid_on) return null;
  return job.closed_on > job.paid_on ? job.closed_on : job.paid_on;
}

const round2 = n => Math.round((Number(n) || 0) * 100) / 100;
const sum = (list, fn) => round2(list.reduce((total, x) => total + (Number(fn(x)) || 0), 0));

function jobTotals(job) {
  const items = job.items || [];
  const subtotal = sum(items, i => i.price);
  const commission = sum(items, i => i.commission);
  const discount = round2(job.discount);
  const total = round2(subtotal - discount);
  // Cost of parts sold: the per-unit cost frozen on each part line.
  const cost = sum(items.filter(i => i.kind === 'part'), i => (Number(i.unit_cost) || 0) * (Number(i.quantity) || 1));
  return { subtotal, discount, total, commission, net: round2(total - commission), cost };
}

const isCounted = job => !job.voided_at && Boolean(job.vehicle_class || (job.items && job.items.length));

function salesFigures(jobs) {
  const paid = jobs.filter(j => j.payment_received);
  const collected = sum(paid, j => j.totals.total);
  const commission = sum(jobs, j => j.totals.commission);
  return {
    jobs: jobs.length,
    collected,
    receivables: sum(jobs.filter(j => !j.payment_received), j => j.totals.total),
    commission,
    net: round2(collected - commission),
  };
}

// The business day `date`: sales booked that day (by department) and money received that day.
// `jobs` may contain any jobs; only the ones relevant to `date` are used. Jobs carry .totals.
// outflows: money that leaves the drawer for reasons other than expenses/commission, each a list of
// { side: 'cash' | 'gcash', amount }: payrollPayouts, setAsides (to bill funds), billTopUps (the part
// of a bill its fund could not cover).
function daySummary({ date, jobs, expenses = [], meta = {}, outflows = {} }) {
  const live = jobs.filter(isCounted);
  const sales = live.filter(j => saleDate(j) === date);
  const departments = Object.fromEntries(DEPARTMENTS.map(d =>
    [d.key, salesFigures(sales.filter(j => (j.department || 'carwash') === d.key))]));
  const { collected, receivables, commission } = salesFigures(sales);

  // Money in today: paid carwash jobs of today + running jobs paid today (finished or not).
  const runningPaidToday = live.filter(j => isRunning(j) && j.paid_on === date);
  const received = [...sales.filter(j => !isRunning(j) && j.payment_received), ...runningPaidToday];
  const cashReceived = sum(received.filter(j => j.payment_method === 'Cash'), j => j.totals.total);
  const gcashReceived = round2(sum(received, j => j.totals.total) - cashReceived);
  const paidInAdvance = sum(runningPaidToday.filter(j => saleDate(j) !== date), j => j.totals.total);
  const paidEarlier = sum(sales.filter(j => isRunning(j) && j.paid_on !== date), j => j.totals.total);

  const cashExpenses = sum(expenses.filter(e => e.side === 'cash'), e => e.amount);
  const gcashExpenses = sum(expenses.filter(e => e.side === 'gcash'), e => e.amount);
  // Bought with the cash fund (abonos): a cost of the day, but the money never passed through the drawer.
  const fundExpenses = sum(expenses.filter(e => e.side === 'fund'), e => e.amount);
  const drawerExpenses = round2(cashExpenses + gcashExpenses);

  // Tips arrive in GCash and are passed on to the crew, so they net to zero in the GCash count.
  const jobTips = sum(received, j => j.tip_gcash);

  // Parts sold in today's paid sales (any department), and what they cost.
  const paidSales = sales.filter(j => j.payment_received);
  const partsSales = sum(paidSales.flatMap(j => j.items || []).filter(i => i.kind === 'part'), i => i.price);
  const partsCost = sum(paidSales, j => j.totals.cost);
  const otherTips = round2(meta.gcash_tips_to_distribute);
  const tips = round2(jobTips + otherTips);

  const commissionGcash = Math.min(round2(meta.commission_gcash_paid), commission);
  const commissionCash = round2(commission - commissionGcash);
  const cashFloat = round2(meta.cash_float);

  const bySide = (list = [], side) => sum(list.filter(x => x.side === side), x => x.amount);
  const payrollCash = bySide(outflows.payrollPayouts, 'cash');
  const payrollGcash = bySide(outflows.payrollPayouts, 'gcash');
  const setAsideCash = bySide(outflows.setAsides, 'cash');
  const setAsideGcash = bySide(outflows.setAsides, 'gcash');
  const billTopUpCash = bySide(outflows.billTopUps, 'cash');
  const billTopUpGcash = bySide(outflows.billTopUps, 'gcash');

  const expectedCash = round2(cashFloat + cashReceived - commissionCash - cashExpenses
    - payrollCash - setAsideCash - billTopUpCash);
  const expectedGcash = round2(gcashReceived + tips - commissionGcash - gcashExpenses - tips
    - payrollGcash - setAsideGcash - billTopUpGcash);
  const actualCash = meta.actual_cash ?? null;
  const actualGcash = meta.actual_gcash ?? null;

  return {
    vehicles: sales.length,
    paidJobs: sales.filter(j => j.payment_received).length,
    unpaidJobs: sales.filter(j => !j.payment_received).length,
    departments,
    collected, receivables, commission, partsSales, partsCost,
    net: round2(collected - commission),
    cashReceived, gcashReceived, paidInAdvance, paidEarlier,
    cashExpenses, gcashExpenses, fundExpenses, drawerExpenses, expenses: round2(drawerExpenses + fundExpenses),
    jobTips, otherTips, tips,
    cashFloat, commissionCash, commissionGcash, payrollCash, payrollGcash,
    setAsideCash, setAsideGcash, billTopUpCash, billTopUpGcash,
    expectedCash, expectedGcash, expectedTotal: round2(expectedCash + expectedGcash),
    actualCash, actualGcash,
    cashVariance: actualCash == null ? null : round2(actualCash - expectedCash),
    gcashVariance: actualGcash == null ? null : round2(actualGcash - expectedGcash),
  };
}

// ---------------------------------------------------------------- payroll

const ATTENDANCE_CODES = ['P', '0.5P', 'CN', '0.5CN', 'A', 'OFF'];
// Overtime pays the hourly rate (the day's rate ÷ the normal hours of that kind of day) × a multiplier,
// using the rule in effect on the day the overtime was worked. Dated like employee rates, so a change
// never alters days before it. Newest last.
const OT_RULES = [
  { from: '2000-01-01', multiplier: 1.25, carwashHours: 8, constructionHours: 8 },
  // Owner's decisions from Mon Oct 5, 2026: OT at the plain hourly rate, and a carwash day is 11 hours.
  { from: '2026-10-05', multiplier: 1, carwashHours: 11, constructionHours: 8 },
];
function otRuleOn(date) {
  let rule = OT_RULES[0];
  for (const r of OT_RULES) if (r.from <= date) rule = r;
  return rule;
}
const otMultiplierOn = date => otRuleOn(date).multiplier;
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const longDate = date => { const [y, m, d] = date.split('-').map(Number); return `${MONTH_NAMES[m - 1]} ${d}, ${y}`; };
// The overtime rule(s) that apply to the days start..end, as one sentence for the screen and the sheet.
function otRuleNote(start, end) {
  const parts = [];
  OT_RULES.forEach((rule, i) => {
    const next = OT_RULES[i + 1];
    const until = next ? addDays(next.from, -1) : null;
    if ((until && until < start) || rule.from > end) return; // no day of the range uses this rule
    parts.push({ rule, until, from: rule.from });
  });
  const hourly = r => (r.carwashHours === r.constructionHours
    ? `the day's rate ÷ ${r.carwashHours}`
    : `the carwash rate ÷ ${r.carwashHours} (construction rate ÷ ${r.constructionHours})`);
  if (parts.length === 1) return `OT pays ${hourly(parts[0].rule)} × ${parts[0].rule.multiplier} per hour.`;
  return `OT pays ${parts.map((p, i) => i === 0
    ? `${hourly(p.rule)} × ${p.rule.multiplier} per hour up to ${longDate(p.until)}`
    : `${hourly(p.rule)} × ${p.rule.multiplier} from ${longDate(p.from)}`).join(', and ')}.`;
}

// rates: [{ effective_from, rate_per_day, construction_rate }]; the latest one on or before date applies.
function rateOn(rates, date) {
  let best = null;
  for (const r of rates) if (r.effective_from <= date && (!best || r.effective_from > best.effective_from)) best = r;
  return best || { rate_per_day: 0, construction_rate: 0 };
}

// Pay for one employee over the given dates. days: { 'YYYY-MM-DD': { code, cw_ot_hours, cn_ot_hours } },
// adjustments: [{ kind: 'addition' | 'deduction', amount }] already limited to the range.
function payrollForRange({ dates, days = {}, rates = [], adjustments = [] }) {
  const t = { carwashDays: 0, constructionDays: 0, absences: 0, daysOff: 0, carwashPay: 0, constructionPay: 0, otPay: 0, otHours: 0 };
  for (const date of dates) {
    const d = days[date];
    if (!d) continue;
    const r = rateOn(rates, date);
    const cw = Number(r.rate_per_day) || 0;
    const cn = Number(r.construction_rate) || 0;
    if (d.code === 'P') { t.carwashDays += 1; t.carwashPay += cw; }
    if (d.code === '0.5P') { t.carwashDays += 0.5; t.carwashPay += cw * 0.5; }
    if (d.code === 'CN') { t.constructionDays += 1; t.constructionPay += cn; }
    if (d.code === '0.5CN') { t.constructionDays += 0.5; t.constructionPay += cn * 0.5; }
    if (d.code === 'A') t.absences += 1;
    if (d.code === 'OFF') t.daysOff += 1;
    const cwOt = Number(d.cw_ot_hours) || 0;
    const cnOt = Number(d.cn_ot_hours) || 0;
    t.otHours += cwOt + cnOt;
    const ot = otRuleOn(date);
    t.otPay += (cw / ot.carwashHours * cwOt + cn / ot.constructionHours * cnOt) * ot.multiplier;
  }
  const additions = sum(adjustments.filter(a => a.kind === 'addition'), a => a.amount);
  const deductions = sum(adjustments.filter(a => a.kind === 'deduction'), a => a.amount);
  const gross = round2(t.carwashPay + t.constructionPay + t.otPay + additions);
  return {
    ...t, carwashPay: round2(t.carwashPay), constructionPay: round2(t.constructionPay), otPay: round2(t.otPay),
    additions, deductions, gross, net: round2(gross - deductions),
  };
}

// ---------------------------------------------------------------- dates (business dates are 'YYYY-MM-DD')

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function isDate(value) {
  if (!DATE_RE.test(value || '')) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}
function addDays(date, days) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
function mondayOf(date) {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  return addDays(date, day === 0 ? -6 : 1 - day);
}
function datesBetween(start, end) {
  const out = [];
  for (let d = start; d <= end; d = addDays(d, 1)) out.push(d);
  return out;
}
const daysUntil = (from, to) => Math.round((new Date(`${to}T00:00:00Z`) - new Date(`${from}T00:00:00Z`)) / 86400000);

// ---------------------------------------------------------------- bill funds

const pad2 = n => String(n).padStart(2, '0');
const lastDayOf = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();

// fund: { frequency: 'monthly' | 'quarterly' | 'yearly', due_day, due_month }. Returns the first due
// date on or after `from`; a due day past the end of a month falls on that month's last day.
function nextDueDate(fund, from) {
  const [y, m] = from.split('-').map(Number);
  const anchor = fund.due_month || 1;
  const dueMonths = fund.frequency === 'monthly' ? null
    : fund.frequency === 'quarterly' ? [0, 3, 6, 9].map(k => ((anchor - 1 + k) % 12) + 1)
      : [anchor];
  for (let i = 0; i <= 24; i += 1) {
    const month = ((m - 1 + i) % 12) + 1;
    const year = y + Math.floor((m - 1 + i) / 12);
    if (dueMonths && !dueMonths.includes(month)) continue;
    const candidate = `${year}-${pad2(month)}-${pad2(Math.min(fund.due_day, lastDayOf(year, month)))}`;
    if (candidate >= from) return candidate;
  }
  return null;
}

// How much to set aside per week so the fund holds the bill amount by its next due date.
// balance includes this week's set-asides; the target is based on the balance at the start of the week.
function fundStatus({ fund, balance, setAsideThisWeek = 0, today }) {
  const amount = Number(fund.amount) || 0;
  const nextDue = nextDueDate(fund, today);
  const daysLeft = daysUntil(today, nextDue);
  const weeksLeft = Math.max(1, Math.ceil(daysLeft / 7));
  const needed = Math.max(0, amount - (balance - setAsideThisWeek));
  const weeklyTarget = Math.ceil(needed / weeksLeft);
  return {
    nextDue, daysLeft, weeksLeft, weeklyTarget,
    remainingThisWeek: Math.max(0, round2(weeklyTarget - setAsideThisWeek)),
    shortBy: Math.max(0, round2(amount - balance)),
  };
}

// A bill is paid from its fund first; whatever the fund cannot cover comes from the drawer.
function splitBill(amount, fundBalance) {
  const fromFund = round2(Math.max(0, Math.min(amount, fundBalance)));
  return { fromFund, fromDrawer: round2(amount - fromFund) };
}

function joPrefix(date, prefix = 'JO') {
  const [y, m, d] = date.split('-');
  return `${prefix}-${m}${d}${y.slice(2)}-`;
}

module.exports = {
  DEPARTMENTS, DEPARTMENT_KEYS, department, isRunning, saleDate,
  round2, jobTotals, isCounted, daySummary,
  ATTENDANCE_CODES, OT_RULES, otMultiplierOn, otRuleNote, rateOn, payrollForRange,
  nextDueDate, fundStatus, splitBill,
  isDate, addDays, mondayOf, datesBetween, daysUntil, joPrefix,
};
