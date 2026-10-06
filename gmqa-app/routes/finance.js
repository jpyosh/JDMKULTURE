// Bill funds (weekly set-asides for Meralco, Maynilad, rent, ...) and the owner's in/out summary
// for any period (week, month, ...).
const express = require('express');
const { requireOwner } = require('../lib/auth');
const { db } = require('../lib/db');
const { fundStatus, splitBill, daySummary, datesBetween, mondayOf, addDays, round2, DEPARTMENT_KEYS } = require('../lib/calc');
const { loadJobs, assertDayOpen } = require('../lib/store');
const { loadPayroll } = require('../lib/payroll-data');
const { bad, notFound, money, text, date, oneOf, id, pick } = require('../lib/http');

const router = express.Router();
const MAX_SUMMARY_DAYS = 400;
const SIDES = ['cash', 'gcash'];

const FUND_BALANCES = `select f.id, f.name, f.amount, f.frequency, f.due_day, f.due_month, f.active, f.sort_order,
    round(coalesce(sa.total, 0) - coalesce(bp.total, 0), 2) as balance
  from funds f
  left join (select fund_id, sum(amount) as total from fund_set_asides group by fund_id) sa on sa.fund_id = f.id
  left join (select fund_id, sum(from_fund) as total from bill_payments group by fund_id) bp on bp.fund_id = f.id`;

async function shopToday(q = db) {
  return (await q.one("select (now() at time zone 'Asia/Manila')::date as d")).d;
}

async function fundBalance(q, fundId) {
  const row = await q.one(`${FUND_BALANCES} where f.id = $1`, [fundId]);
  if (!row) throw notFound('Fund');
  return row;
}

// Funds with balance and this week's set-aside target, as of `date` (default: today).
router.get('/funds', async (req, res) => {
  const day = req.query.date ? date(req.query.date) : await shopToday();
  const weekStart = mondayOf(day);
  const [funds, week, onDay] = await Promise.all([
    db.many(`${FUND_BALANCES} where f.active order by f.sort_order, f.id`),
    db.many('select fund_id, sum(amount) as total from fund_set_asides where entry_date between $1 and $2 group by fund_id',
      [weekStart, addDays(weekStart, 6)]),
    db.many('select id, fund_id, side, amount, note from fund_set_asides where entry_date = $1 order by id', [day]),
  ]);
  res.json(funds.map(fund => {
    const setAsideThisWeek = week.find(w => w.fund_id === fund.id)?.total || 0;
    return {
      ...fund, setAsideThisWeek,
      setAsidesOnDate: onDay.filter(s => s.fund_id === fund.id),
      ...fundStatus({ fund, balance: fund.balance, setAsideThisWeek, today: day }),
    };
  }));
});

function cleanFund(body, partial) {
  const f = pick(body, ['name', 'amount', 'frequency', 'due_day', 'due_month', 'active']);
  const out = {};
  if (!partial || 'name' in f) out.name = text(f.name, 'Name', { required: true, max: 80 });
  if (!partial || 'amount' in f) out.amount = money(f.amount, 'Usual bill amount');
  if (!partial || 'frequency' in f) out.frequency = oneOf(f.frequency, ['monthly', 'quarterly', 'yearly'], 'Frequency');
  if (!partial || 'due_day' in f) {
    out.due_day = Number(f.due_day);
    if (!Number.isInteger(out.due_day) || out.due_day < 1 || out.due_day > 31) throw bad('Due day must be 1 to 31');
  }
  if ('due_month' in f) {
    out.due_month = f.due_month === '' || f.due_month == null ? null : Number(f.due_month);
    if (out.due_month !== null && (!Number.isInteger(out.due_month) || out.due_month < 1 || out.due_month > 12)) throw bad('Due month must be 1 to 12');
  }
  if ('active' in f) out.active = Boolean(f.active);
  return out;
}

router.post('/funds', requireOwner, async (req, res) => {
  const fund = cleanFund(req.body, false);
  if (fund.frequency !== 'monthly' && !fund.due_month) throw bad('Pick the due month for a quarterly or yearly bill');
  const row = await db.tx(req.user.email, async q => {
    const { next } = await q.one('select coalesce(max(sort_order), 0) + 10 as next from funds');
    const cols = [...Object.keys(fund), 'sort_order'];
    const values = [...Object.values(fund), next];
    return q.one(`insert into funds (${cols.join(', ')}) values (${cols.map((_, i) => `$${i + 1}`).join(', ')}) returning id`, values);
  });
  res.status(201).json(await fundBalance(db, row.id));
});

router.patch('/funds/:id', requireOwner, async (req, res) => {
  const fundId = id(req.params.id, 'fund');
  const fund = cleanFund(req.body, true);
  const cols = Object.keys(fund);
  if (!cols.length) throw bad('Nothing to save');
  await db.tx(req.user.email, async q => {
    const changed = await q.exec(`update funds set ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')} where id = $1`,
      [fundId, ...cols.map(c => fund[c])]);
    if (!changed) throw notFound('Fund');
  });
  res.json(await fundBalance(db, fundId));
});

// Set-asides are taken out of the drawer at EOD, so they follow the closed-day rule.
router.post('/funds/:id/set-asides', async (req, res) => {
  const fundId = id(req.params.id, 'fund');
  const day = date(req.body.date, 'Date');
  const row = await db.tx(req.user.email, async q => {
    await fundBalance(q, fundId);
    await assertDayOpen(q, day, req.user);
    return q.one(`insert into fund_set_asides (fund_id, entry_date, side, amount, note) values ($1, $2, $3, $4, $5)
      returning id, fund_id, entry_date, side, amount, note`,
    [fundId, day, oneOf(req.body.side, SIDES, 'Taken from'), money(req.body.amount, 'Amount', { min: 0.01 }), text(req.body.note, 'Note', { max: 200 })]);
  });
  res.status(201).json(row);
});

router.delete('/fund-set-asides/:id', async (req, res) => {
  const setAsideId = id(req.params.id, 'set-aside');
  await db.tx(req.user.email, async q => {
    const row = await q.one('select entry_date from fund_set_asides where id = $1', [setAsideId]);
    if (!row) throw notFound('Set-aside');
    await assertDayOpen(q, row.entry_date, req.user);
    await q.query('delete from fund_set_asides where id = $1', [setAsideId]);
  });
  res.json({ ok: true });
});

router.post('/funds/:id/bills', requireOwner, async (req, res) => {
  const fundId = id(req.params.id, 'fund');
  const day = date(req.body.date, 'Payment date');
  const amount = money(req.body.amount, 'Bill amount', { min: 0.01 });
  const row = await db.tx(req.user.email, async q => {
    const { balance } = await fundBalance(q, fundId);
    const { fromFund, fromDrawer } = splitBill(amount, balance);
    if (fromDrawer > 0 && !SIDES.includes(req.body.drawer_side)) {
      throw bad(`The fund only has ₱${balance}. Choose whether the remaining ₱${fromDrawer} comes from the Cash or GCash drawer.`);
    }
    const side = fromDrawer > 0 ? req.body.drawer_side : null;
    return q.one(`insert into bill_payments (fund_id, paid_on, amount, from_fund, from_drawer, drawer_side, note)
      values ($1, $2, $3, $4, $5, $6, $7) returning *`,
    [fundId, day, amount, fromFund, fromDrawer, side, text(req.body.note, 'Note', { max: 200 })]);
  });
  res.status(201).json(row);
});

router.delete('/bill-payments/:id', requireOwner, async (req, res) => {
  const changed = await db.tx(req.user.email, q => q.exec('delete from bill_payments where id = $1', [id(req.params.id, 'bill payment')]));
  if (!changed) throw notFound('Bill payment');
  res.json({ ok: true });
});

// ---------------------------------------------------------------- in/out summary for a period

router.get('/finance/summary', requireOwner, async (req, res) => {
  const start = date(req.query.start, 'Start date');
  const end = date(req.query.end, 'End date');
  if (start > end) throw bad('Start date must be on or before the end date');
  const dates = datesBetween(start, end);
  if (dates.length > MAX_SUMMARY_DAYS) throw bad(`Pick a range of at most ${MAX_SUMMARY_DAYS} days`);

  const between = [start, end];
  const [jobs, expenses, metas, payouts, setAsides, bills, funds, payroll] = await Promise.all([
    loadJobs('sale_date between $1 and $2 or paid_on between $1 and $2', between),
    db.many('select expense_date, side, amount from expenses where expense_date between $1 and $2', between),
    db.many('select * from daily_meta where job_date between $1 and $2', between),
    db.many('select payout_date, side, amount from payroll_payouts where payout_date between $1 and $2', between),
    db.many('select fund_id, entry_date, side, amount from fund_set_asides where entry_date between $1 and $2', between),
    db.many(`select b.id, b.fund_id, f.name, b.paid_on, b.amount, b.from_fund, b.from_drawer, b.drawer_side, b.note
      from bill_payments b join funds f on f.id = b.fund_id where b.paid_on between $1 and $2 order by f.sort_order, f.id, b.paid_on, b.id`, between),
    db.many(`${FUND_BALANCES} order by f.sort_order, f.id`),
    loadPayroll(start, end),
  ]);

  // Same per-day rules as EOD, added up over the period.
  const t = { departments: Object.fromEntries(DEPARTMENT_KEYS.map(k => [k, 0])), gross: 0, commission: 0, receivables: 0, partsSales: 0, partsCost: 0,
    cashIn: 0, gcashIn: 0, drawerExpenses: 0, fundExpenses: 0 };
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
  }
  const r = n => round2(n);
  const income = {
    departments: Object.fromEntries(DEPARTMENT_KEYS.map(k => [k, r(t.departments[k])])),
    gross: r(t.gross), commission: r(t.commission), net: r(t.gross - t.commission),
    partsSales: r(t.partsSales), partsCost: r(t.partsCost), receivables: r(t.receivables),
  };

  const billsByFund = [];
  for (const b of bills) {
    const existing = billsByFund.find(x => x.fund_id === b.fund_id);
    if (existing) existing.amount = r(existing.amount + b.amount);
    else billsByFund.push({ fund_id: b.fund_id, name: b.name, amount: b.amount });
  }
  // Payroll = net pay for work done in the period (cash advances handed out from the drawer
  // already appear under drawer expenses).
  const opex = {
    payroll: payroll.totalNet,
    bills: billsByFund,
    billsTotal: r(bills.reduce((s, b) => s + b.amount, 0)),
    drawerExpenses: r(t.drawerExpenses),
    // Abonos bought with the cash fund: costs, but not money out of the drawer.
    fundExpenses: r(t.fundExpenses),
  };
  opex.total = r(opex.payroll + opex.billsTotal + opex.drawerExpenses + opex.fundExpenses);

  const sumOf = list => r(list.reduce((s, x) => s + x.amount, 0));
  const cashflow = {
    cashIn: r(t.cashIn), gcashIn: r(t.gcashIn), commissionPaid: income.commission, drawerExpenses: opex.drawerExpenses,
    payrollPayouts: sumOf(payouts), setAsides: sumOf(setAsides), billTopUps: r(bills.reduce((s, b) => s + b.from_drawer, 0)),
  };
  cashflow.net = r(cashflow.cashIn + cashflow.gcashIn - cashflow.commissionPaid - cashflow.drawerExpenses
    - cashflow.payrollPayouts - cashflow.setAsides - cashflow.billTopUps);

  res.json({
    start, end, income, opex, netProfit: r(income.net - income.partsCost - opex.total), cashflow,
    // Each bill paid in the period, so one recorded by mistake can be found and undone.
    billPayments: bills,
    funds: funds.map(f => ({
      id: f.id, name: f.name, amount: f.amount, balance: f.balance, active: f.active,
      setAside: sumOf(setAsides.filter(s => s.fund_id === f.id)),
      paid: sumOf(bills.filter(b => b.fund_id === f.id)),
    })),
  });
});

module.exports = { router };
