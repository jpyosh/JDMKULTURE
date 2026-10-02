const test = require('node:test');
const assert = require('node:assert/strict');
const { nextDueDate, fundStatus, splitBill, daySummary } = require('../lib/calc');

test('nextDueDate: monthly, clamped to short months', () => {
  const meralco = { frequency: 'monthly', due_day: 25 };
  assert.equal(nextDueDate(meralco, '2026-10-03'), '2026-10-25');
  assert.equal(nextDueDate(meralco, '2026-10-25'), '2026-10-25', 'due today is still this cycle');
  assert.equal(nextDueDate(meralco, '2026-10-26'), '2026-11-25');
  assert.equal(nextDueDate({ frequency: 'monthly', due_day: 31 }, '2027-02-10'), '2027-02-28');
  assert.equal(nextDueDate({ frequency: 'monthly', due_day: 31 }, '2026-12-31'), '2026-12-31');
});

test('nextDueDate: yearly and quarterly', () => {
  const permit = { frequency: 'yearly', due_month: 1, due_day: 20 };
  assert.equal(nextDueDate(permit, '2026-10-03'), '2027-01-20');
  assert.equal(nextDueDate(permit, '2027-01-05'), '2027-01-20');
  const quarterly = { frequency: 'quarterly', due_month: 1, due_day: 15 };
  assert.equal(nextDueDate(quarterly, '2026-10-03'), '2026-10-15');
  assert.equal(nextDueDate(quarterly, '2026-10-16'), '2027-01-15');
  assert.equal(nextDueDate(quarterly, '2026-02-01'), '2026-04-15');
});

test('fundStatus: weekly target spreads what is still needed over the weeks left', () => {
  const fund = { amount: 8000, frequency: 'monthly', due_day: 23 };
  // Today Sat 2026-10-03, due 2026-10-23 (20 days -> 3 weeks). Balance 2000, of which 500 set aside this week.
  const s = fundStatus({ fund, balance: 2000, setAsideThisWeek: 500, today: '2026-10-03' });
  assert.equal(s.nextDue, '2026-10-23');
  assert.equal(s.daysLeft, 20);
  assert.equal(s.weeksLeft, 3);
  assert.equal(s.weeklyTarget, Math.ceil((8000 - 1500) / 3));
  assert.equal(s.remainingThisWeek, s.weeklyTarget - 500);
  assert.equal(s.shortBy, 6000);

  const funded = fundStatus({ fund, balance: 9000, setAsideThisWeek: 0, today: '2026-10-03' });
  assert.deepEqual([funded.weeklyTarget, funded.remainingThisWeek, funded.shortBy], [0, 0, 0]);
  const dueToday = fundStatus({ fund, balance: 0, setAsideThisWeek: 0, today: '2026-10-23' });
  assert.equal(dueToday.weeksLeft, 1);
  assert.equal(dueToday.weeklyTarget, 8000);
});

test('splitBill pays from the fund first and the drawer covers any shortfall', () => {
  assert.deepEqual(splitBill(8000, 6000), { fromFund: 6000, fromDrawer: 2000 });
  assert.deepEqual(splitBill(5000, 6000), { fromFund: 5000, fromDrawer: 0 });
  assert.deepEqual(splitBill(5000, -100), { fromFund: 0, fromDrawer: 5000 });
});

test('set-asides and bill shortfalls leave the drawer that day', () => {
  const s = daySummary({
    date: '2026-10-03', jobs: [], meta: { cash_float: 10000 },
    outflows: {
      setAsides: [{ side: 'cash', amount: 1500 }, { side: 'gcash', amount: 700 }],
      billTopUps: [{ side: 'cash', amount: 2000 }],
    },
  });
  assert.equal(s.setAsideCash, 1500);
  assert.equal(s.setAsideGcash, 700);
  assert.equal(s.billTopUpCash, 2000);
  assert.equal(s.expectedCash, 10000 - 1500 - 2000);
  assert.equal(s.expectedGcash, -700);
});
