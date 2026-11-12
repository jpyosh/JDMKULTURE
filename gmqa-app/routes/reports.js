// Owner-only reporting: per-day rollup over any date range, with sales split by department.
const express = require('express');
const { requireOwner } = require('../lib/auth');
const { db } = require('../lib/db');
const { daySummary, tradingProfit, round2, DEPARTMENT_KEYS } = require('../lib/calc');
const { loadJobs } = require('../lib/store');
const { bad, date } = require('../lib/http');

const router = express.Router();
const MAX_DAYS = 400;
const FIELDS = ['vehicles', 'collected', 'cashReceived', 'gcashReceived', 'receivables', 'commission', 'tips'];
// Profit follows Finance (tradingProfit in lib/calc.js): expenses leave out parts bought to sell, and the
// cost of the parts sold comes off. Payroll and bills are not in this report; Finance takes those off too.
const COSTS = ['expenses', 'partsBought', 'partsCost', 'profit'];

router.get('/reports/range', requireOwner, async (req, res) => {
  const start = date(req.query.start, 'Start date');
  const end = date(req.query.end, 'End date');
  if (start > end) throw bad('Start date must be before end date');
  if ((new Date(end) - new Date(start)) / 86400000 > MAX_DAYS) throw bad(`Pick a range of at most ${MAX_DAYS} days`);

  const [jobs, expenses, metas] = await Promise.all([
    loadJobs('sale_date between $1 and $2 or paid_on between $1 and $2', [start, end]),
    db.many('select expense_date, side, amount, for_resale from expenses where expense_date between $1 and $2', [start, end]),
    db.many('select * from daily_meta where job_date between $1 and $2', [start, end]),
  ]);
  const inRange = d => d && d >= start && d <= end;
  const dates = [...new Set([
    ...jobs.flatMap(j => [j.sale_date, j.paid_on]).filter(inRange),
    ...expenses.map(e => e.expense_date),
  ])].sort();

  const days = dates.map(day => {
    const meta = metas.find(m => m.job_date === day) || {};
    const s = daySummary({ date: day, jobs, expenses: expenses.filter(e => e.expense_date === day), meta });
    const row = Object.fromEntries(FIELDS.map(f => [f, s[f]]));
    const departments = Object.fromEntries(DEPARTMENT_KEYS.map(k => [k, s.departments[k].collected]));
    const { costs, partsBought, partsCost, profit } = tradingProfit(s);
    // Every day with something on it is listed, closed at EOD or not (Finance waits for a day to be closed).
    return { date: day, closed: Boolean(meta.closed_at), ...row, departments, expenses: costs, partsBought, partsCost, profit };
  });
  const total = f => round2(days.reduce((t, d) => t + f(d), 0));
  const totals = Object.fromEntries([...FIELDS, ...COSTS].map(f => [f, total(d => d[f])]));
  totals.departments = Object.fromEntries(DEPARTMENT_KEYS.map(k => [k, total(d => d.departments[k])]));
  res.json({ start, end, days, totals, openDays: days.filter(d => !d.closed).map(d => d.date) });
});

module.exports = { router };
