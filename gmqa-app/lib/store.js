// Shared data-access helpers used by several routes.
const { db } = require('./db');
const { jobTotals, daySummary, datesBetween, round2 } = require('./calc');
const { forbidden } = require('./http');

const JOB_COLUMNS = `id, jo_number, department, job_date, closed_on, paid_on, sale_date, time_in, time_out, vehicle_class, plate, payment_method, payment_received,
  discount, discount_reason, tip_gcash, detailer, remarks, created_by, created_at, voided_at, voided_by, void_reason`;

// Loads jobs with their line items and computed totals. `where` uses $1..$n placeholders.
async function loadJobs(where, params, q = db) {
  const jobs = await q.many(`select ${JOB_COLUMNS} from jobs where ${where} order by job_date, id`, params);
  if (!jobs.length) return [];
  const items = await q.many(`select id, job_id, kind, catalog_item_id, part_id, quantity, pack_size, unit_cost, name, price, commission, sort_order
    from job_items where job_id = any($1::bigint[]) order by sort_order, id`, [jobs.map(j => j.id)]);
  const byJob = new Map(jobs.map(j => [j.id, []]));
  for (const item of items) byJob.get(item.job_id)?.push(item);
  return jobs.map(job => {
    const withItems = { ...job, items: byJob.get(job.id) };
    return { ...withItems, totals: jobTotals(withItems) };
  });
}

async function loadJob(jobId, q = db) {
  return (await loadJobs('id = $1', [jobId], q))[0] || null;
}

// Staff cannot change anything on a day that has been closed; the owner can.
async function assertDayOpen(q, date, user) {
  if (user.role === 'owner') return;
  const meta = await q.one('select closed_at from daily_meta where job_date = $1', [date]);
  if (meta?.closed_at) throw forbidden(`${date} has been closed. Ask the owner to reopen it before making changes.`);
}

// Each day from start to end by the EOD rules (daySummary): its money after commission and expenses (the expected drawer
// less the float, which stays for the next day, and the expected GCash), what was counted, and wages handed out that day.
async function loadDayMoney(start, end, q = db) {
  const between = [start, end];
  const [jobs, expenses, metas, payrollPayouts, setAsides, billTopUps] = await Promise.all([
    loadJobs('sale_date between $1 and $2 or paid_on between $1 and $2', between, q),
    q.many('select expense_date, side, amount, for_resale from expenses where expense_date between $1 and $2', between),
    q.many('select * from daily_meta where job_date between $1 and $2', between),
    q.many('select payout_date, side, amount from payroll_payouts where payout_date between $1 and $2', between),
    q.many('select entry_date, side, amount, week_start from fund_set_asides where entry_date between $1 and $2', between),
    q.many(`select paid_on, drawer_side as side, from_drawer as amount from bill_payments
      where paid_on between $1 and $2 and from_drawer > 0`, between),
  ]);
  const metaOn = new Map(metas.map(m => [m.job_date, m]));
  const on = (list, key, day) => list.filter(x => x[key] === day);
  // Weekly envelopes come out of the week's money, not the day's drawer (like payroll); older daily ones out of their day.
  const daily = setAsides.filter(s => !s.week_start);
  const weekly = setAsides.filter(s => s.week_start);
  const bySide = (list, side) => round2(list.filter(x => x.side === side).reduce((t, x) => t + Number(x.amount), 0));
  return datesBetween(start, end).map(day => {
    const meta = metaOn.get(day) || {};
    const s = daySummary({
      date: day, jobs, expenses: on(expenses, 'expense_date', day), meta,
      outflows: { payrollPayouts: on(payrollPayouts, 'payout_date', day), setAsides: on(daily, 'entry_date', day), billTopUps: on(billTopUps, 'paid_on', day) },
    });
    const envelopes = on(weekly, 'entry_date', day);
    return {
      date: day, closed: Boolean(meta.closed_at),
      cash: round2(s.expectedCash - s.cashFloat), gcash: s.expectedGcash,
      countedCash: s.actualCash == null ? null : round2(s.actualCash - s.cashFloat), countedGcash: s.actualGcash,
      payrollCash: s.payrollCash, payrollGcash: s.payrollGcash,
      envelopeCash: bySide(envelopes, 'cash'), envelopeGcash: bySide(envelopes, 'gcash'),
    };
  });
}

module.exports = { loadJobs, loadJob, assertDayOpen, loadDayMoney };
