// Remittances (owner): the money taken to the bank, as it shows in the passbook, matched against the days whose
// money it carried. What each day leaves for the bank follows the EOD rules (loadDayMoney): the expected drawer
// less the float, and the expected GCash, less wages handed out that day. The matching is remittanceReport in lib/calc.js.
const express = require('express');
const { requireOwner } = require('../lib/auth');
const { db } = require('../lib/db');
const { remittanceReport, passbookExpected, datesBetween, addDays } = require('../lib/calc');
const { loadDayMoney } = require('../lib/store');
const { bad, notFound, money, text, date, oneOf, id } = require('../lib/http');
const { shopToday, assertNotAfterToday } = require('../lib/clock');

const router = express.Router();
const MAX_DAYS = 400;
const DEFAULT_DAYS = 30;
const SOURCES = ['cash', 'gcash', 'both'];
const COLUMNS = 'id, deposit_date, amount, source, covers_from, covers_to, note, created_by, created_at';

// The passbook's printed balance (null until the owner sets it) and what the passbook should say since.
async function loadBank() {
  const row = await db.one('select start_date, balance from bank_start where id = 1');
  if (!row) return null;
  const since = await db.many('select deposit_date, amount from remittances where deposit_date > $1', [row.start_date]);
  return passbookExpected({ startDate: row.start_date, startBalance: row.balance, remittances: since });
}

router.get('/remittances', requireOwner, async (req, res) => {
  const end = req.query.end ? date(req.query.end, 'End date') : await shopToday();
  const bank = await loadBank();
  let start;
  if (req.query.start) start = date(req.query.start, 'Start date');
  else {
    // With no range picked: from the day the passbook balance was set (everything before it is settled), else
    // from the first day any deposit covers, so nothing earlier is listed as still to deposit.
    const first = bank?.startDate || (await db.one('select min(covers_from) as d from remittances where covers_from <= $1', [end]))?.d;
    start = first && first <= end && datesBetween(first, end).length <= MAX_DAYS ? first : addDays(end, -DEFAULT_DAYS);
  }
  if (start > end) throw bad('Start date must be on or before the end date');
  if (datesBetween(start, end).length > MAX_DAYS) throw bad(`Pick a range of at most ${MAX_DAYS} days`);

  // Deposits made in the range, and deposits for days in the range (made later).
  const remittances = await db.many(`select ${COLUMNS} from remittances
    where deposit_date between $1 and $2 or (covers_from <= $2 and covers_to >= $1) order by deposit_date, id`, [start, end]);
  const covered = remittances.filter(r => r.covers_from);
  const loadFrom = covered.reduce((d, r) => (r.covers_from < d ? r.covers_from : d), start);
  const loadTo = covered.reduce((d, r) => (r.covers_to > d ? r.covers_to : d), end);
  const days = await loadDayMoney(loadFrom, loadTo);
  res.json({ start, end, bank, ...remittanceReport({ days, remittances, start, end }) });
});

// The passbook's balance as printed on a day. Setting it again replaces it.
router.put('/remittances/start', requireOwner, async (req, res) => {
  const startDate = date(req.body.start_date, 'Passbook date');
  const balance = money(req.body.balance, 'Passbook balance');
  await db.tx(req.user.email, async q => {
    await assertNotAfterToday(q, startDate, 'Passbook date');
    await q.query(`insert into bank_start (id, start_date, balance) values (1, $1, $2)
      on conflict (id) do update set start_date = excluded.start_date, balance = excluded.balance`, [startDate, balance]);
  });
  res.json({ startDate, startBalance: balance });
});

router.post('/remittances', requireOwner, async (req, res) => {
  const depositDate = date(req.body.deposit_date, 'Date deposited');
  const amount = money(req.body.amount, 'Amount', { min: 0.01 });
  const source = oneOf(req.body.source, SOURCES, 'Money from');
  const from = req.body.covers_from ? date(req.body.covers_from, 'First day') : null;
  const to = req.body.covers_to ? date(req.body.covers_to, 'Last day') : null;
  if (Boolean(from) !== Boolean(to)) throw bad('Pick both the first and the last day this deposit covers, or neither');
  if (from && from > to) throw bad('The first day must be on or before the last day');
  if (to && to > depositDate) throw bad(`A deposit made on ${depositDate} cannot carry money from ${to}. Check the dates.`);
  const note = text(req.body.note, 'Note', { max: 200 });
  const row = await db.tx(req.user.email, async q => {
    await assertNotAfterToday(q, depositDate, 'Date deposited');
    return q.one(`insert into remittances (deposit_date, amount, source, covers_from, covers_to, note)
      values ($1, $2, $3, $4, $5, $6) returning ${COLUMNS}`, [depositDate, amount, source, from, to, note]);
  });
  res.status(201).json(row);
});

// Undo a deposit recorded by mistake: its days are waiting to be deposited again.
router.delete('/remittances/:id', requireOwner, async (req, res) => {
  const changed = await db.tx(req.user.email, q => q.exec('delete from remittances where id = $1', [id(req.params.id, 'deposit')]));
  if (!changed) throw notFound('Deposit');
  res.json({ ok: true });
});

module.exports = { router };
