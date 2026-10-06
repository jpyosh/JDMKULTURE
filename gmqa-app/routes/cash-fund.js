// Cash fund (abonos). Staff spend from it at EOD (an expense with side 'fund', see routes/days.js) and can
// see its balance; the owner sets its size, records the money the boss hands over, and prints the list.
const express = require('express');
const { requireOwner } = require('../lib/auth');
const { db } = require('../lib/db');
const { loadCashFund, topupItems, buildSheet, sheetFileName, peso } = require('../lib/cash-fund');
const { bad, notFound, money, text, date, id } = require('../lib/http');

const router = express.Router();

async function shopToday(q = db) {
  return (await q.one("select (now() at time zone 'Asia/Manila')::date as d")).d;
}

router.get('/cash-fund', async (req, res) => {
  res.json(await loadCashFund());
});

router.put('/cash-fund', requireOwner, async (req, res) => {
  const target = money(req.body.target, 'Fund size');
  await db.tx(req.user.email, q => q.query('update cash_fund set target = $1 where id = 1', [target]));
  res.json(await loadCashFund());
});

// Money from the boss. It replenishes every purchase made on or before its date that was still waiting.
router.post('/cash-fund/topups', requireOwner, async (req, res) => {
  const day = date(req.body.date, 'Date');
  const amount = money(req.body.amount, 'Amount', { min: 0.01 });
  const note = text(req.body.note, 'Note', { max: 200 });
  const topup = await db.tx(req.user.email, async q => {
    await q.query("select pg_advisory_xact_lock(hashtext('cash_fund'))");
    const row = await q.one('insert into cash_fund_topups (entry_date, amount, note) values ($1, $2, $3) returning id, entry_date, amount, note',
      [day, amount, note]);
    await q.query("update expenses set topup_id = $1 where side = 'fund' and topup_id is null and expense_date <= $2", [row.id, day]);
    return { ...row, items: await topupItems(q, row.id) };
  });
  res.status(201).json(topup);
});

// Undo: the money is taken back out and its purchases are waiting to be replenished again.
router.delete('/cash-fund/topups/:id', requireOwner, async (req, res) => {
  const changed = await db.tx(req.user.email, q => q.exec('delete from cash_fund_topups where id = $1', [id(req.params.id, 'replenishment')]));
  if (!changed) throw notFound('Replenishment');
  res.json(await loadCashFund());
});

// Itemized list for the boss: what is waiting to be replenished (default), or what one replenishment paid back.
router.get('/cash-fund/sheet.pdf', requireOwner, async (req, res) => {
  const fund = await loadCashFund();
  let sheet;
  if (req.query.topup) {
    const topupId = id(req.query.topup, 'replenishment');
    const topup = await db.one('select id, entry_date, amount, note from cash_fund_topups where id = $1', [topupId]);
    if (!topup) throw notFound('Replenishment');
    const items = await topupItems(db, topupId);
    const total = items.reduce((s, e) => s + e.amount, 0);
    sheet = {
      date: topup.entry_date, note: topup.note, items, total,
      heading: 'Purchases paid back by this replenishment',
      facts: [['Money received', peso(topup.amount)], ['Purchases on this list', peso(total)], ['Fund size', peso(fund.target)]],
    };
  } else {
    sheet = {
      date: await shopToday(), items: fund.pending, total: fund.pendingTotal,
      heading: 'Bought with the cash fund, waiting to be replenished',
      facts: [['Fund size', peso(fund.target)], ['Cash in the fund now', peso(fund.balance)], ['Amount to replenish', peso(fund.toReplenish)]],
    };
  }
  if (sheet.items.length > 500) throw bad('Too many items for one sheet');
  const pdf = await buildSheet(sheet);
  res.set({
    'Content-Type': 'application/pdf',
    'Content-Disposition': `attachment; filename="${sheetFileName(sheet.date)}"`,
    'Cache-Control': 'no-store',
  }).send(pdf);
});

module.exports = { router };
