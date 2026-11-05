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
//   * Detailing and Tint & PPF jobs are "running": they count (sale + commission) on the day the work is
//     finished, paid or not (agreed 2026-11-05). Until it is paid, a finished job is that day's receivable.
//   * Money is reconciled on the day it is received: a running job paid before it is done puts
//     cash in that day's drawer, and one paid after it is done puts it in the later day's drawer,
//     while its sale stays on the finish day.
//   * The same for a counter sale taken on credit and marked paid later (agreed 2026-11-04): the sale and
//     its labor stay on the day it was made; the money counts on the day it was paid (paid_on).

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
  return isRunning(job) ? job.closed_on || null : job.job_date;
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

// Inventory average cost replayed over stock changes in order, from the stock and average cost just before the
// first one (used to correct the cost of a past delivery). A delivery blends its cost with what is on the shelf;
// sales, counts and returns only move stock. before: the average just before each delivery (what Undo goes back to).
// public/js/views/inventory.js mirrors this to preview a correction.
function replayAvgCost(stock, avg, moves) {
  const before = [];
  for (const m of moves) {
    const qty = Number(m.quantity);
    if (m.kind === 'receive') {
      before.push({ id: m.id, avg });
      avg = stock + qty > 0 ? round2((stock * avg + qty * Number(m.unit_cost)) / (stock + qty)) : round2(m.unit_cost);
    }
    stock = round2(stock + qty);
  }
  return { avg, before };
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

// The day a job's money came in: a running job's payment day; a carwash or counter sale paid when it was
// made, its own day; a counter sale taken on credit and marked paid later (paid_on), that later day.
// The sale itself (and its commission) stays on its sale date either way.
const receivedDate = j => (isRunning(j) ? j.paid_on : j.payment_received ? (j.paid_on || saleDate(j)) : null);
// Money in on `date`.
const receivedOn = (jobs, date) => jobs.filter(j => isCounted(j) && receivedDate(j) === date);

// GCash tips stay in GCash until someone gives them to the crew (daily_meta.gcash_tips_passed); what is
// not given out is carried over to the next days until it is. Before this date tips were taken as given
// out the same day, so earlier EODs keep the numbers they had.
const TIPS_TRACKED_FROM = '2026-10-29';
const tipsReceivedOn = (jobs, date, meta = {}) => round2(sum(receivedOn(jobs, date), j => j.tip_gcash) + round2(meta.gcash_tips_to_distribute));
const tipsGivenOn = (date, tips, meta = {}) => (date < TIPS_TRACKED_FROM ? tips : round2(meta.gcash_tips_passed));

// GCash tips received before `before` and not yet given to the crew. jobs: jobs with tips (any days);
// metas: daily_meta rows. Giving out more than was owed is not kept as credit for later tips.
function tipsOwed({ jobs, metas = [], before }) {
  const metaOn = new Map(metas.map(m => [m.job_date, m]));
  const dates = new Set(metas.map(m => m.job_date));
  for (const j of jobs) dates.add(receivedDate(j));
  let owed = 0;
  for (const date of [...dates].filter(d => d && d >= TIPS_TRACKED_FROM && d < before).sort()) {
    const tips = tipsReceivedOn(jobs, date, metaOn.get(date));
    owed = Math.max(0, round2(owed + tips - tipsGivenOn(date, tips, metaOn.get(date))));
  }
  return owed;
}

// The business day `date`: sales booked that day (by department) and money received that day.
// `jobs` may contain any jobs; only the ones relevant to `date` are used. Jobs carry .totals.
// outflows: money that leaves the drawer for reasons other than expenses/commission, each a list of
// { side: 'cash' | 'gcash', amount }: payrollPayouts, setAsides (to bill funds), billTopUps (the part
// of a bill its fund could not cover). tipsOwedBefore: GCash tips from earlier days not yet given out (tipsOwed).
function daySummary({ date, jobs, expenses = [], meta = {}, outflows = {}, tipsOwedBefore = 0 }) {
  const live = jobs.filter(isCounted);
  const sales = live.filter(j => saleDate(j) === date);
  const departments = Object.fromEntries(DEPARTMENTS.map(d =>
    [d.key, salesFigures(sales.filter(j => (j.department || 'carwash') === d.key))]));
  const { collected, receivables, commission } = salesFigures(sales);

  const runningPaidToday = live.filter(j => isRunning(j) && j.paid_on === date);
  const received = receivedOn(jobs, date);
  const cashReceived = sum(received.filter(j => j.payment_method === 'Cash'), j => j.totals.total);
  const gcashReceived = round2(sum(received, j => j.totals.total) - cashReceived);
  // The parts counter's share of each, shown on its own line in EOD.
  const counterReceived = received.filter(j => j.department === 'parts');
  const partsCashReceived = sum(counterReceived.filter(j => j.payment_method === 'Cash'), j => j.totals.total);
  const partsGcashReceived = round2(sum(counterReceived, j => j.totals.total) - partsCashReceived);
  // Running jobs paid before they were finished: today's money for later sales, and today's sales paid earlier.
  const paidInAdvance = sum(runningPaidToday.filter(j => !saleDate(j) || saleDate(j) > date), j => j.totals.total);
  const paidEarlier = sum(sales.filter(j => isRunning(j) && j.paid_on && j.paid_on < date), j => j.totals.total);
  // Finished jobs and counter sales paid afterwards: today's sales paid on a later day, and earlier sales paid today.
  const paidLater = sum(sales.filter(j => j.payment_received && receivedDate(j) > date), j => j.totals.total);
  const earlierSalesPaid = sum(received.filter(j => saleDate(j) && saleDate(j) < date), j => j.totals.total);

  const cashExpenses = sum(expenses.filter(e => e.side === 'cash'), e => e.amount);
  const gcashExpenses = sum(expenses.filter(e => e.side === 'gcash'), e => e.amount);
  // Bought with the cash fund (abonos): a cost of the day, but the money never passed through the drawer.
  const fundExpenses = sum(expenses.filter(e => e.side === 'fund'), e => e.amount);
  const drawerExpenses = round2(cashExpenses + gcashExpenses);
  // Parts bought to sell (Inventory → Receive): money out like any expense, but not a cost until sold.
  const resale = expenses.filter(e => e.for_resale);
  const partsBoughtDrawer = sum(resale.filter(e => e.side !== 'fund'), e => e.amount);
  const partsBoughtFund = sum(resale.filter(e => e.side === 'fund'), e => e.amount);

  // Tips arrive in GCash and leave it when given to the crew (see TIPS_TRACKED_FROM).
  const jobTips = sum(received, j => j.tip_gcash);

  // Parts sold in today's paid sales (any department), and what they cost.
  const paidSales = sales.filter(j => j.payment_received);
  const partsSales = sum(paidSales.flatMap(j => j.items || []).filter(i => i.kind === 'part'), i => i.price);
  const partsCost = sum(paidSales, j => j.totals.cost);
  const otherTips = round2(meta.gcash_tips_to_distribute);
  const tips = round2(jobTips + otherTips);
  const tipsTracked = date >= TIPS_TRACKED_FROM;
  const tipsGiven = tipsGivenOn(date, tips, meta);
  const owedBefore = tipsTracked ? round2(tipsOwedBefore) : 0;
  const tipsToGive = Math.max(0, round2(owedBefore + tips - tipsGiven));

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
  const expectedGcash = round2(gcashReceived + tips - tipsGiven - commissionGcash - gcashExpenses
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
    cashReceived, gcashReceived, partsCashReceived, partsGcashReceived, paidInAdvance, paidEarlier, paidLater, earlierSalesPaid,
    cashExpenses, gcashExpenses, fundExpenses, drawerExpenses, expenses: round2(drawerExpenses + fundExpenses),
    partsBoughtDrawer, partsBoughtFund,
    jobTips, otherTips, tips, tipsTracked, tipsGiven, tipsOwedBefore: owedBefore, tipsToGive,
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
// using the rule in effect on the day the overtime was worked. The shop's rules live in the ot_rules
// table, set by the owner on the Payroll screen: [{ effective_from, multiplier, carwash_hours,
// construction_hours }], oldest first. Dated like employee rates, so a change never alters days before it.
const NO_OT_RULE = { effective_from: '2000-01-01', multiplier: 1, carwash_hours: 8, construction_hours: 8 };
function otRuleOn(rules, date) {
  let rule = rules[0] || NO_OT_RULE;
  for (const r of rules) if (r.effective_from <= date) rule = r;
  return rule;
}
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const longDate = date => { const [y, m, d] = date.split('-').map(Number); return `${MONTH_NAMES[m - 1]} ${d}, ${y}`; };
// The overtime rule(s) that apply to the days start..end, as one sentence for the screen and the sheet.
function otRuleNote(rules, start, end) {
  const parts = [];
  rules.forEach((rule, i) => {
    const next = rules[i + 1];
    const until = next ? addDays(next.effective_from, -1) : null;
    if ((until && until < start) || (i > 0 && rule.effective_from > end)) return; // no day of the range uses this rule
    parts.push({ rule, until, from: rule.effective_from });
  });
  if (!parts.length) parts.push({ rule: NO_OT_RULE, until: null, from: start });
  const hourly = r => (Number(r.carwash_hours) === Number(r.construction_hours)
    ? `the day's rate ÷ ${Number(r.carwash_hours)}`
    : `the carwash rate ÷ ${Number(r.carwash_hours)} (construction rate ÷ ${Number(r.construction_hours)})`);
  if (parts.length === 1) return `OT pays ${hourly(parts[0].rule)} × ${Number(parts[0].rule.multiplier)} per hour.`;
  const last = parts.length - 1;
  const clauses = parts.map((p, i) => {
    const pay = `${hourly(p.rule)} × ${Number(p.rule.multiplier)}${i === 0 ? ' per hour' : ''}`;
    if (i === 0) return `${pay} up to ${longDate(p.until)}`;
    if (i === last) return `${pay} from ${longDate(p.from)}`;
    return p.from === p.until ? `${pay} on ${longDate(p.from)}` : `${pay} from ${longDate(p.from)} to ${longDate(p.until)}`;
  });
  return parts.length === 2
    ? `OT pays ${clauses[0]}, and ${clauses[1]}.`
    : `OT pays ${clauses.slice(0, last).join('; ')}; and ${clauses[last]}.`;
}

// rates: [{ effective_from, rate_per_day, construction_rate, carwash_hours, ot_multiplier }]; the latest
// one on or before date applies. carwash_hours / ot_multiplier are the employee's own (null = shop rule).
function rateOn(rates, date) {
  let best = null;
  for (const r of rates) if (r.effective_from <= date && (!best || r.effective_from > best.effective_from)) best = r;
  return best || { rate_per_day: 0, construction_rate: 0 };
}

// One overtime hour's pay on a date: the day's rate ÷ the normal hours of that kind of day × the OT
// multiplier. Carwash hours and the multiplier are the employee's own when set, else the shop rule's.
function otHourly(rates, otRules, date) {
  const r = rateOn(rates, date);
  const shop = otRuleOn(otRules, date);
  const carwashHours = Number(r.carwash_hours ?? shop.carwash_hours);
  const constructionHours = Number(shop.construction_hours);
  const multiplier = Number(r.ot_multiplier ?? shop.multiplier);
  return {
    carwashHours, constructionHours, multiplier,
    carwash: (Number(r.rate_per_day) || 0) / carwashHours * multiplier,
    construction: (Number(r.construction_rate) || 0) / constructionHours * multiplier,
  };
}

// Pay for one employee over the given dates. days: { 'YYYY-MM-DD': { code, cw_ot_hours, cn_ot_hours } },
// adjustments: [{ kind: 'addition' | 'deduction', amount }] already limited to the range,
// otRules: the shop's overtime rules (see otRuleOn).
function payrollForRange({ dates, days = {}, rates = [], adjustments = [], otRules = [] }) {
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
    const hourly = otHourly(rates, otRules, date);
    t.otPay += hourly.carwash * cwOt + hourly.construction * cnOt;
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

// ---------------------------------------------------------------- daily sales report (group chat)

// The day's numbers in the boss's format (agreed 2026-10-29): cars = every car of the day, paid or not;
// sales = paid sales; expenses = paid from the drawer (cash and GCash, not the cash fund); Cash / GCash =
// what each side brought in less the commission and expenses paid from it. Float, tips and payouts are left out.
const FULL_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
function salesReport({ date, summary: s }) {
  const r = {
    cars: s.vehicles,
    sales: s.collected,
    commission: s.commission,
    expenses: round2(s.cashExpenses + s.gcashExpenses),
    net: round2(s.collected - s.commission - s.cashExpenses - s.gcashExpenses),
    cash: round2(s.cashReceived - s.commissionCash - s.cashExpenses),
    gcash: round2(s.gcashReceived - s.commissionGcash - s.gcashExpenses),
  };
  // Centavos only when there are any; the Cash and Gcash lines are written without a thousands comma.
  const num = (n, comma = true) => n.toLocaleString('en-US', { useGrouping: comma, minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2 });
  const [y, m, d] = date.split('-').map(Number);
  r.text = [
    `${FULL_MONTHS[m - 1]} ${d}, ${y}`,
    `Total of cars - ${r.cars}`,
    `Total sales - ${num(r.sales)}`,
    `Less comms - ${num(r.commission)}`,
    `Less expenses - ${num(r.expenses)}`,
    `Total net = ${num(r.net)}`,
    '',
    `Cash - ${num(r.cash, false)}`,
    `Gcash - ${num(r.gcash, false)}`,
  ].join('\n');
  return r;
}

// ---------------------------------------------------------------- periods (Finance and Analytics)

// The EOD rules of each day in `dates`, added up. jobs, expenses and metas may cover more days than `dates`.
function periodTotals({ dates, jobs, expenses, metas }) {
  const t = { departments: Object.fromEntries(DEPARTMENT_KEYS.map(k => [k, 0])), gross: 0, commission: 0, receivables: 0, partsSales: 0, partsCost: 0,
    cashIn: 0, gcashIn: 0, drawerExpenses: 0, fundExpenses: 0, partsBoughtDrawer: 0, partsBoughtFund: 0, vehicles: 0, salesDays: [] };
  for (const day of dates) {
    const s = daySummary({
      date: day, jobs,
      expenses: expenses.filter(e => e.expense_date === day),
      meta: metas.find(m => m.job_date === day) || {},
    });
    for (const k of DEPARTMENT_KEYS) t.departments[k] += s.departments[k].collected;
    t.gross += s.collected;
    t.commission += s.commission;
    t.receivables += s.receivables;
    t.partsSales += s.partsSales;
    t.partsCost += s.partsCost;
    t.cashIn += s.cashReceived;
    t.gcashIn += s.gcashReceived;
    t.drawerExpenses += s.drawerExpenses;
    t.fundExpenses += s.fundExpenses;
    t.partsBoughtDrawer += s.partsBoughtDrawer;
    t.partsBoughtFund += s.partsBoughtFund;
    t.vehicles += s.vehicles;
    if (s.vehicles) t.salesDays.push(day);
  }
  return t;
}

// Profit and loss of a period from periodTotals. payroll = net pay for work done in the period (cash
// advances handed out from the drawer already appear under drawer expenses).
function profitAndLoss(t, { payroll, billsTotal }) {
  const r = round2;
  const income = {
    departments: Object.fromEntries(DEPARTMENT_KEYS.map(k => [k, r(t.departments[k])])),
    gross: r(t.gross), commission: r(t.commission), net: r(t.gross - t.commission),
    partsSales: r(t.partsSales), partsCost: r(t.partsCost), receivables: r(t.receivables),
  };
  const opex = {
    payroll,
    billsTotal,
    // Parts bought to sell are stock, not a cost: their cost counts when sold (income.partsCost).
    drawerExpenses: r(t.drawerExpenses - t.partsBoughtDrawer),
    // Abonos bought with the cash fund: costs, but not money out of the drawer.
    fundExpenses: r(t.fundExpenses - t.partsBoughtFund),
    partsBought: r(t.partsBoughtDrawer + t.partsBoughtFund),
  };
  opex.total = r(opex.payroll + opex.billsTotal + opex.drawerExpenses + opex.fundExpenses);
  return { income, opex, netProfit: r(income.net - income.partsCost - opex.total) };
}

// One row of Analytics. staffDays: days someone worked the carwash; such a day without sales may mean
// the jobs were never entered, which would make the period's profit look too low.
function analyticsRow(period, t, { payroll, billsTotal, staffDays }) {
  const { income, opex, netProfit } = profitAndLoss(t, { payroll, billsTotal });
  const salesDays = t.salesDays.length;
  return {
    ...period, salesDays, cars: t.vehicles,
    staffNoSales: datesBetween(period.start, period.end).filter(d => staffDays.has(d) && !t.salesDays.includes(d)),
    sales: income.gross, departments: income.departments, receivables: income.receivables,
    commission: income.commission, expenses: round2(opex.drawerExpenses + opex.fundExpenses),
    payroll: opex.payroll, bills: opex.billsTotal, partsCost: income.partsCost, netProfit,
    perDay: salesDays ? round2(income.gross / salesDays) : 0,
    perCar: t.vehicles ? round2(income.gross / t.vehicles) : 0,
  };
}

// How many periods Analytics shows for each grain.
const PERIOD_COUNTS = { day: 14, week: 8, month: 6, quarter: 4 };
const SHORT_MONTHS = FULL_MONTHS.map(m => m.slice(0, 3));
const SHORT_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function sundayOf(date) {
  return addDays(date, -new Date(`${date}T00:00:00Z`).getUTCDay());
}

// The whole period around `date`. Weeks are the Sunday-to-Saturday pay weeks; quarters are calendar quarters.
function periodAround(grain, date) {
  if (grain === 'day') return { start: date, end: date };
  if (grain === 'week') return { start: sundayOf(date), end: addDays(sundayOf(date), 6) };
  const [y, m] = date.split('-').map(Number);
  const first = grain === 'month' ? m : Math.floor((m - 1) / 3) * 3 + 1;
  const last = grain === 'month' ? m : first + 2;
  return { start: `${y}-${pad2(first)}-01`, end: `${y}-${pad2(last)}-${pad2(lastDayOf(y, last))}` };
}

function periodLabel(grain, { start, end }) {
  const [y, m, d] = start.split('-').map(Number);
  if (grain === 'day') return `${SHORT_DAYS[new Date(`${start}T00:00:00Z`).getUTCDay()]}, ${SHORT_MONTHS[m - 1]} ${d}`;
  if (grain === 'month') return `${SHORT_MONTHS[m - 1]} ${y}`;
  if (grain === 'quarter') return `Q${Math.ceil(m / 3)} ${y}`;
  const [, endMonth, endDay] = end.split('-').map(Number);
  return `${SHORT_MONTHS[m - 1]} ${d}–${endMonth === m ? '' : `${SHORT_MONTHS[endMonth - 1]} `}${endDay}`;
}

// The last `count` periods up to and including `date`, oldest first. The one still running stops at
// `date` and is marked partial, so it is never padded with days that have not happened.
function periodBuckets(grain, date, count = PERIOD_COUNTS[grain]) {
  const out = [];
  let whole = periodAround(grain, date);
  for (let i = 0; i < count; i += 1) {
    const end = whole.end > date ? date : whole.end;
    out.unshift({ label: periodLabel(grain, whole), start: whole.start, end, partial: end !== whole.end });
    whole = periodAround(grain, addDays(whole.start, -1));
  }
  return out;
}

// Percent change to one decimal; null when there is nothing to compare with.
const pctChange = (now, before) => (before ? Math.round((now - before) / before * 1000) / 10 : null);

module.exports = {
  DEPARTMENTS, DEPARTMENT_KEYS, department, isRunning, saleDate,
  round2, jobTotals, replayAvgCost, isCounted, daySummary, TIPS_TRACKED_FROM, tipsOwed, salesReport,
  ATTENDANCE_CODES, otRuleOn, otHourly, otRuleNote, longDate, rateOn, payrollForRange,
  nextDueDate, fundStatus, splitBill,
  isDate, addDays, mondayOf, datesBetween, daysUntil, joPrefix,
  periodTotals, profitAndLoss, analyticsRow, periodBuckets, pctChange, PERIOD_COUNTS,
};
