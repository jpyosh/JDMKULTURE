// Owner-only analytics: the same figures as Finance, by day, pay week, month or quarter.
const express = require('express');
const { requireOwner } = require('../lib/auth');
const { db } = require('../lib/db');
const { analyticsRow, datesBetween, periodBuckets, periodTotals, pctChange, round2, PERIOD_COUNTS } = require('../lib/calc');
const { loadJobs } = require('../lib/store');
const { loadPayroll, payrollNetBetween, carwashWorkDays, SHOP_TODAY } = require('../lib/payroll-data');
const { date, oneOf } = require('../lib/http');

const router = express.Router();

router.get('/analytics', requireOwner, async (req, res) => {
  const grain = oneOf(req.query.grain, Object.keys(PERIOD_COUNTS), 'Period');
  const day = req.query.date ? date(req.query.date, 'Date') : (await db.one(`select ${SHOP_TODAY} as d`)).d;
  const buckets = periodBuckets(grain, day);
  const between = [buckets[0].start, day];

  const [jobs, expenses, metas, bills, payroll] = await Promise.all([
    loadJobs('sale_date between $1 and $2 or paid_on between $1 and $2', between),
    db.many('select expense_date, side, amount, for_resale from expenses where expense_date between $1 and $2', between),
    db.many('select * from daily_meta where job_date between $1 and $2', between),
    db.many('select paid_on, amount from bill_payments where paid_on between $1 and $2', between),
    loadPayroll(...between),
  ]);
  const staffDays = carwashWorkDays(payroll);

  const periods = buckets.map(period => analyticsRow(
    period,
    periodTotals({ dates: datesBetween(period.start, period.end), jobs, expenses, metas }),
    {
      payroll: payrollNetBetween(payroll, period.start, period.end),
      billsTotal: round2(bills.filter(b => b.paid_on >= period.start && b.paid_on <= period.end).reduce((t, b) => t + b.amount, 0)),
      staffDays,
    },
  ));
  const [before, now] = periods.slice(-2);
  res.json({
    grain, date: day, periods,
    // Per day with sales and per car, so a period still running is compared fairly with a finished one.
    change: { perDay: pctChange(now.perDay, before.perDay), perCar: pctChange(now.perCar, before.perCar) },
  });
});

module.exports = { router };
