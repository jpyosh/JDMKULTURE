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

const DEPARTMENTS = [
  { key: 'carwash', label: 'Carwash', prefix: 'CW', running: false },
  { key: 'detailing', label: 'Detailing', prefix: 'DT', running: true },
  { key: 'tint_ppf', label: 'Tint & PPF', prefix: 'TP', running: true },
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
  return { subtotal, discount, total, commission, net: round2(total - commission) };
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
function daySummary({ date, jobs, expenses = [], meta = {} }) {
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

  // Tips arrive in GCash and are passed on to the crew, so they net to zero in the GCash count.
  const jobTips = sum(received, j => j.tip_gcash);
  const otherTips = round2(meta.gcash_tips_to_distribute);
  const tips = round2(jobTips + otherTips);

  const commissionGcash = Math.min(round2(meta.commission_gcash_paid), commission);
  const commissionCash = round2(commission - commissionGcash);
  const cashFloat = round2(meta.cash_float);

  const expectedCash = round2(cashFloat + cashReceived - commissionCash - cashExpenses);
  const expectedGcash = round2(gcashReceived + tips - commissionGcash - gcashExpenses - tips);
  const actualCash = meta.actual_cash ?? null;
  const actualGcash = meta.actual_gcash ?? null;

  return {
    vehicles: sales.length,
    paidJobs: sales.filter(j => j.payment_received).length,
    unpaidJobs: sales.filter(j => !j.payment_received).length,
    departments,
    collected, receivables, commission,
    net: round2(collected - commission),
    cashReceived, gcashReceived, paidInAdvance, paidEarlier,
    cashExpenses, gcashExpenses, expenses: round2(cashExpenses + gcashExpenses),
    jobTips, otherTips, tips,
    cashFloat, commissionCash, commissionGcash,
    expectedCash, expectedGcash, expectedTotal: round2(expectedCash + expectedGcash),
    actualCash, actualGcash,
    cashVariance: actualCash == null ? null : round2(actualCash - expectedCash),
    gcashVariance: actualGcash == null ? null : round2(actualGcash - expectedGcash),
  };
}

// ---------------------------------------------------------------- payroll

const ATTENDANCE_CODES = ['P', '0.5P', 'CN', '0.5CN', 'A', 'OFF'];
const OT_MULTIPLIER = 1.25;
const HOURS_PER_DAY = 8;

function attendanceCounts(attendance = {}) {
  const counts = { P: 0, '0.5P': 0, CN: 0, '0.5CN': 0, A: 0, OFF: 0 };
  for (const code of Object.values(attendance)) if (code in counts) counts[code] += 1;
  return counts;
}

// entry: { attendance, cw_ot_hours, cn_ot_hours, deductions, rate_per_day, construction_rate }
function payrollPay(entry) {
  const c = attendanceCounts(entry.attendance);
  const cwRate = Number(entry.rate_per_day) || 0;
  const cnRate = Number(entry.construction_rate) || 0;
  const carwashDays = c.P + c['0.5P'] * 0.5;
  const constructionDays = c.CN + c['0.5CN'] * 0.5;
  const carwashPay = round2(cwRate * carwashDays);
  const constructionPay = round2(cnRate * constructionDays);
  const cwOtPay = round2(cwRate / HOURS_PER_DAY * OT_MULTIPLIER * (Number(entry.cw_ot_hours) || 0));
  const cnOtPay = round2(cnRate / HOURS_PER_DAY * OT_MULTIPLIER * (Number(entry.cn_ot_hours) || 0));
  const gross = round2(carwashPay + constructionPay + cwOtPay + cnOtPay);
  const deductions = round2(entry.deductions);
  return {
    carwashDays, constructionDays, absences: c.A, daysOff: c.OFF,
    carwashPay, constructionPay, cwOtPay, cnOtPay, gross, deductions, net: round2(gross - deductions),
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
function joPrefix(date, prefix = 'JO') {
  const [y, m, d] = date.split('-');
  return `${prefix}-${m}${d}${y.slice(2)}-`;
}

module.exports = {
  DEPARTMENTS, DEPARTMENT_KEYS, department, isRunning, saleDate,
  round2, jobTotals, isCounted, daySummary,
  ATTENDANCE_CODES, attendanceCounts, payrollPay,
  isDate, addDays, mondayOf, joPrefix,
};
