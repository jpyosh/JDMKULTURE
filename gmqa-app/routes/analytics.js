// Owner-only analytics: the same figures as Finance, by day, pay week, month or quarter.
const express = require('express');
const { requireOwner } = require('../lib/auth');
const { db } = require('../lib/db');
const { analyticsRow, closedDates, datesBetween, openDatesWithEntries, periodBuckets, periodTotals, pctChange, round2, saleDate, serviceTrends, PERIOD_COUNTS } = require('../lib/calc');
const { loadJobs } = require('../lib/store');
const { loadPayroll, payrollNetOn, payrollEntryDates, carwashWorkDays, SHOP_TODAY } = require('../lib/payroll-data');
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
  const entryDates = [
    ...jobs.filter(j => !j.voided_at).flatMap(j => [j.sale_date, j.paid_on]),
    ...expenses.map(e => e.expense_date), ...bills.map(b => b.paid_on), ...payrollEntryDates(payroll),
  ];

  // Like Finance, a day counts only once it is closed at EOD.
  const periods = buckets.map(period => {
    const dates = datesBetween(period.start, period.end);
    const countedDates = closedDates(dates, metas);
    return analyticsRow(period, periodTotals({ dates: countedDates, jobs, expenses, metas }), {
      payroll: payrollNetOn(payroll, countedDates),
      billsTotal: round2(bills.filter(b => countedDates.includes(b.paid_on)).reduce((t, b) => t + b.amount, 0)),
      staffDays, countedDates,
      openDays: openDatesWithEntries(dates, metas, entryDates),
    });
  });
  const closed = new Set(closedDates(datesBetween(...between), metas));
  const [before, now] = periods.slice(-2);
  res.json({
    grain, date: day, periods,
    // Per day with sales and per car, so a period still running is compared fairly with a finished one.
    change: { perDay: pctChange(now.perDay, before.perDay), perCar: pctChange(now.perCar, before.perCar) },
    services: serviceTrends(periods, jobs.filter(job => closed.has(saleDate(job)))),
  });
});

module.exports = { router };
