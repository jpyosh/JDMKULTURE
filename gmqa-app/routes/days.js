// EOD: one record per business day (float, counts, GCash commission, tips) + expenses + closing.
const express = require('express');
const { requireOwner } = require('../lib/auth');
const { db } = require('../lib/db');
const { daySummary, tipsOwed, salesReport, TIPS_TRACKED_FROM } = require('../lib/calc');
const { loadJobs, assertDayOpen } = require('../lib/store');
const { bad, notFound, conflict, money, text, date, oneOf, id, pick } = require('../lib/http');
const { assertFundCovers } = require('../lib/cash-fund');

const router = express.Router();
const EMPTY_META = { supervisor: '', cash_float: 0, actual_cash: null, actual_gcash: null,
  gcash_tips_to_distribute: 0, gcash_tips_passed: 0, commission_gcash_paid: 0, closed_at: null, closed_by: null };

async function loadDay(day, q = db) {
  const [meta, expenses, jobs, payrollPayouts, setAsides, billTopUps, tipJobs, tipMetas] = await Promise.all([
    q.one('select * from daily_meta where job_date = $1', [day]),
    // from_stock: recorded by Inventory → Receive (undone from there, not here).
    q.many(`select e.id, e.side, e.description, e.amount, e.topup_id, e.for_resale, e.created_by, e.created_at,
      exists (select 1 from stock_movements m where m.expense_id = e.id) as from_stock
      from expenses e where e.expense_date = $1 order by e.id`, [day]),
    // Sales booked today (carwash by job date, running jobs by sale date) + running jobs paid today.
    loadJobs('sale_date = $1 or paid_on = $1', [day], q),
    q.many('select id, side, amount, period_start, period_end, note from payroll_payouts where payout_date = $1 order by id', [day]),
    q.many(`select s.id, s.fund_id, f.name, s.side, s.amount from fund_set_asides s join funds f on f.id = s.fund_id
      where s.entry_date = $1 order by s.id`, [day]),
    q.many(`select b.id, f.name, b.drawer_side as side, b.from_drawer as amount from bill_payments b join funds f on f.id = b.fund_id
      where b.paid_on = $1 and b.from_drawer > 0 order by b.id`, [day]),
    // GCash tips of earlier days that may not have been given to the crew yet.
    loadJobs('tip_gcash > 0 and voided_at is null and (job_date >= $1 or paid_on >= $1) and (job_date < $2 or paid_on < $2)', [TIPS_TRACKED_FROM, day], q),
    q.many(`select job_date, gcash_tips_to_distribute, gcash_tips_passed from daily_meta where job_date >= $1 and job_date < $2
      and (gcash_tips_to_distribute > 0 or gcash_tips_passed > 0)`, [TIPS_TRACKED_FROM, day]),
  ]);
  const m = { ...EMPTY_META, ...meta, job_date: day };
  const summary = daySummary({ date: day, jobs, expenses, meta: m, outflows: { payrollPayouts, setAsides, billTopUps },
    tipsOwedBefore: tipsOwed({ jobs: tipJobs, metas: tipMetas, before: day }) });
  return { date: day, meta: m, expenses, payrollPayouts, setAsides, billTopUps, summary,
    report: salesReport({ date: day, summary }) };
}

router.get('/days/:date', async (req, res) => {
  res.json(await loadDay(date(req.params.date)));
});

router.put('/days/:date', async (req, res) => {
  const day = date(req.params.date);
  const f = pick(req.body, ['supervisor', 'cash_float', 'gcash_tips_to_distribute', 'gcash_tips_passed', 'commission_gcash_paid', 'actual_cash', 'actual_gcash']);
  const clean = {};
  if ('supervisor' in f) clean.supervisor = text(f.supervisor, 'Supervisor', { max: 80 }) || '';
  for (const key of ['cash_float', 'gcash_tips_to_distribute', 'gcash_tips_passed', 'commission_gcash_paid']) {
    if (key in f) clean[key] = money(f[key], key.replace(/_/g, ' '));
  }
  for (const key of ['actual_cash', 'actual_gcash']) {
    if (key in f) clean[key] = money(f[key], key.replace(/_/g, ' '), { allowNull: true });
  }
  const cols = Object.keys(clean);
  if (!cols.length) throw bad('Nothing to save');
  await db.tx(req.user.email, async q => {
    await assertDayOpen(q, day, req.user);
    await q.query(`insert into daily_meta (job_date, ${cols.join(', ')}) values ($1, ${cols.map((_, i) => `$${i + 2}`).join(', ')})
      on conflict (job_date) do update set ${cols.map(c => `${c} = excluded.${c}`).join(', ')}`,
    [day, ...cols.map(c => clean[c])]);
  });
  res.json(await loadDay(day));
});

// GCash tips not given to the crew yet stop the close until they are given out, or until whoever closes
// says they will be given later (tips_later); then they are carried over to the next day's EOD.
router.post('/days/:date/close', async (req, res) => {
  const day = date(req.params.date);
  const { meta, summary } = await loadDay(day);
  if (!meta.closed_at && summary.tipsToGive > 0 && req.body?.tips_later !== true) {
    throw conflict(`₱${summary.tipsToGive.toFixed(2)} in GCash tips has not been given to the crew yet. Give it out first, or close and give it later.`);
  }
  await db.tx(req.user.email, q => q.query(`insert into daily_meta (job_date, closed_at, closed_by) values ($1, now(), $2)
    on conflict (job_date) do update set closed_at = coalesce(daily_meta.closed_at, now()), closed_by = coalesce(daily_meta.closed_by, $2)`,
  [day, req.user.email]));
  res.json(await loadDay(day));
});

router.post('/days/:date/reopen', requireOwner, async (req, res) => {
  const day = date(req.params.date);
  await db.tx(req.user.email, q => q.query('update daily_meta set closed_at = null, closed_by = null where job_date = $1', [day]));
  res.json(await loadDay(day));
});

router.post('/days/:date/expenses', async (req, res) => {
  const day = date(req.params.date);
  // cash / gcash: paid from the drawer. fund: paid from the cash fund (an abono), the drawer is not touched.
  const side = oneOf(req.body.side, ['cash', 'gcash', 'fund'], 'Paid from');
  const amount = money(req.body.amount, 'Amount', { min: 0.01 });
  const description = text(req.body.description, 'Description', { required: true, max: 200 });
  await db.tx(req.user.email, async q => {
    await assertDayOpen(q, day, req.user);
    if (side === 'fund') await assertFundCovers(q, amount);
    await q.query('insert into expenses (expense_date, side, description, amount) values ($1, $2, $3, $4)', [day, side, description, amount]);
  });
  res.status(201).json(await loadDay(day));
});

router.delete('/expenses/:id', async (req, res) => {
  const expenseId = id(req.params.id, 'expense');
  const day = await db.tx(req.user.email, async q => {
    const expense = await q.one('select expense_date, topup_id from expenses where id = $1', [expenseId]);
    if (!expense) throw notFound('Expense');
    if (await q.one('select 1 from stock_movements where expense_id = $1', [expenseId])) {
      throw bad("This was recorded by Inventory → Receive. Undo the delivery from the item's stock history instead.");
    }
    if (expense.topup_id) throw bad('This cash fund purchase was already replenished. Undo that replenishment (Cash fund tab) before deleting it.');
    await assertDayOpen(q, expense.expense_date, req.user);
    await q.query('delete from expenses where id = $1', [expenseId]);
    return expense.expense_date;
  });
  res.json(await loadDay(day));
});

module.exports = { router, loadDay };
