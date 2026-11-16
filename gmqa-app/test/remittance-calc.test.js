// Remittances: bank deposits matched against the days whose money they carry (remittanceReport in lib/calc.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const { remittanceReport, passbookExpected } = require('../lib/calc');

// The shop's real Nov 9-15, 2026: what each day's drawer and GCash held after commission and expenses (GCash after tips
// given out), what was counted at EOD, and payroll handed out that day from the money saved during the week: on Sunday
// Nov 15, the wages for Nov 8-14. Payroll leaves the money for the bank on the day it is handed out.
const day = (date, cash, gcash, { countedCash = cash, countedGcash = gcash, closed = true, payrollCash = 0, payrollGcash = 0 } = {}) =>
  ({ date, closed, cash, gcash, countedCash, countedGcash, payrollCash, payrollGcash });
const DAYS = [
  day('2026-11-09', 5580, 5890),
  day('2026-11-10', 7350, 20335, { countedCash: 6350 }), // ₱1,000 short in the drawer
  day('2026-11-11', 26885, 6900),
  day('2026-11-12', 3120, 5570),
  day('2026-11-13', 16665, 12540),
  day('2026-11-14', 12100, 6340),
  day('2026-11-15', 10500, 6350, { payrollCash: 22929.06 }),
];
let nextId = 1;
const deposit = (deposit_date, amount, source, covers_from = null, covers_to = covers_from, note = null) =>
  ({ id: nextId++, deposit_date, amount, source, covers_from, covers_to, note });

const PASSBOOK = [
  deposit('2026-11-11', 5580, 'cash', '2026-11-09'),
  deposit('2026-11-11', 6350, 'cash', '2026-11-10'),
  deposit('2026-11-11', 26225, 'gcash', '2026-11-09', '2026-11-10'),
  deposit('2026-11-11', 4750, 'cash', null, null, 'not sure yet'),
  deposit('2026-11-12', 26885, 'cash', '2026-11-11'),
  deposit('2026-11-12', 6900, 'gcash', '2026-11-11'),
];

test('each deposit is checked against the days it covers; days not deposited yet are what is still to deposit', () => {
  const r = remittanceReport({ days: DAYS, remittances: PASSBOOK, start: '2026-11-09', end: '2026-11-15' });

  assert.deepEqual(r.groups.map(g => [g.source, g.from, g.to, g.deposited, g.due, g.difference]), [
    ['cash', '2026-11-09', '2026-11-09', 5580, 5580, 0],
    ['gcash', '2026-11-09', '2026-11-10', 26225, 26225, 0], // two days' GCash in one transfer
    ['cash', '2026-11-10', '2026-11-10', 6350, 7350, -1000], // the drawer was short, so the deposit is too
    ['cash', '2026-11-11', '2026-11-11', 26885, 26885, 0],
    ['gcash', '2026-11-11', '2026-11-11', 6900, 6900, 0],
  ]);
  assert.ok(r.groups.every(g => !g.overlaps && g.openDays.length === 0));
  // A deposit not tied to any day is listed on its own, never mixed into a day's money.
  assert.deepEqual(r.unlinked.map(d => [d.amount, d.note]), [[4750, 'not sure yet']]);

  // Nov 12-15 are still to deposit. Nov 15's payroll came out of the cash saved since Nov 12, so the cash adds up to
  // what is really left: ₱19,455.94.
  assert.equal(r.toDeposit.cash.amount, 19455.94);
  assert.deepEqual(r.toDeposit.cash.days.map(d => [d.date, d.amount]),
    [['2026-11-12', 3120], ['2026-11-13', 16665], ['2026-11-14', 12100], ['2026-11-15', -12429.06]]);
  assert.equal(r.toDeposit.gcash.amount, 30800);
  assert.deepEqual(r.toDeposit.gcash.days.map(d => [d.date, d.amount]),
    [['2026-11-12', 5570], ['2026-11-13', 12540], ['2026-11-14', 6340], ['2026-11-15', 6350]]);

  assert.deepEqual(r.totals, { deposited: 71940, due: 72940, difference: -1000, unlinked: 4750 });

  // Each day says which deposit took its cash and its GCash.
  const nov10 = r.days.find(d => d.date === '2026-11-10');
  assert.deepEqual([nov10.cashGroup, nov10.gcashGroup], [r.groups[2].key, r.groups[1].key]);
  assert.deepEqual([r.days.at(-1).cashGroup, r.days.at(-1).gcashGroup], [null, null]);
});

test('one transfer for cash and GCash together, split over several deposits', () => {
  const days = [day('2026-11-07', 7200, 9650, { payrollCash: 18164.22 }), day('2026-11-08', 6250, 35410)];
  const rows = [deposit('2026-11-09', 30000, 'both', '2026-11-07', '2026-11-08'), deposit('2026-11-09', 10345.78, 'both', '2026-11-07', '2026-11-08')];
  const r = remittanceReport({ days, remittances: rows, start: '2026-11-07', end: '2026-11-08' });
  assert.equal(r.groups.length, 1, 'deposits for the same days are added together');
  assert.deepEqual([r.groups[0].deposits.length, r.groups[0].deposited, r.groups[0].due, r.groups[0].difference], [2, 40345.78, 40345.78, 0]);
  assert.equal(r.toDeposit.cash.amount, 0);
  assert.equal(r.toDeposit.gcash.amount, 0);
});

test('a day deposited twice is flagged; a day still open is named and never counted as still to deposit', () => {
  const days = [day('2026-11-12', 3120, 5570), day('2026-11-13', 16665, 12540, { countedCash: null, countedGcash: null, closed: false })];
  const rows = [deposit('2026-11-14', 3120, 'cash', '2026-11-12'), deposit('2026-11-14', 19785, 'cash', '2026-11-12', '2026-11-13')];
  const r = remittanceReport({ days, remittances: rows, start: '2026-11-12', end: '2026-11-13' });
  assert.deepEqual(r.groups.map(g => g.overlaps), [true, true]);
  assert.deepEqual(r.groups[1].openDays, ['2026-11-13']);
  assert.deepEqual(r.openDays, ['2026-11-13']);
  assert.deepEqual(r.toDeposit.gcash.days.map(d => d.date), ['2026-11-12'], 'the open day waits until it is closed');
});

test('what the passbook should say: its printed balance plus every deposit made after that day', () => {
  // The real passbook, printed through Nov 12 at ₱244,607.86; the GCash transfers of Nov 12-14 arrive later.
  const rows = [
    deposit('2026-11-12', 6900, 'gcash', '2026-11-11'), // already in the printed balance
    deposit('2026-11-13', 5570, 'gcash', '2026-11-12'),
    deposit('2026-11-14', 12540, 'gcash', '2026-11-13'),
    deposit('2026-11-15', 6340, 'gcash', '2026-11-14'),
    deposit('2026-11-15', 4750, 'cash'), // not tied to any day still counts: it is in the bank
  ];
  assert.deepEqual(passbookExpected({ startDate: '2026-11-12', startBalance: 244607.86, remittances: rows }),
    { startDate: '2026-11-12', startBalance: 244607.86, depositedSince: 29200, count: 4, expected: 273807.86 });
  assert.equal(passbookExpected({ startDate: '2026-11-15', startBalance: 100, remittances: rows }).expected, 100, 'nothing after the day it was printed');
});

test('days with nothing to deposit are left off the list', () => {
  const r = remittanceReport({ days: [day('2026-11-01', 0, 0), day('2026-11-02', 4270, 0)], remittances: [], start: '2026-11-01', end: '2026-11-02' });
  assert.deepEqual(r.toDeposit.cash.days.map(d => d.date), ['2026-11-02']);
  assert.deepEqual(r.toDeposit.gcash.days, []);
  assert.deepEqual(r.groups, []);
});
