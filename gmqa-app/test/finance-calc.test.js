const test = require('node:test');
const assert = require('node:assert/strict');
const { nextDueDate, fundStatus, setAsidePeriod, closedDates, openDatesWithEntries, splitBill, daySummary } = require('../lib/calc');

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
  const s = fundStatus({ fund, balance: 2000, setAsideThisPeriod: 500, today: '2026-10-03' });
  assert.equal(s.nextDue, '2026-10-23');
  assert.equal(s.daysLeft, 20);
  assert.equal(s.periodWord, 'week', 'a bill with no choice saved is weekly');
  assert.equal(s.periodsLeft, 3);
  assert.equal(s.target, Math.ceil((8000 - 1500) / 3));
  assert.equal(s.remaining, s.target - 500);
  assert.equal(s.shortBy, 6000);

  const funded = fundStatus({ fund, balance: 9000, setAsideThisPeriod: 0, today: '2026-10-03' });
  assert.deepEqual([funded.target, funded.remaining, funded.shortBy], [0, 0, 0]);
  const dueToday = fundStatus({ fund, balance: 0, setAsideThisPeriod: 0, today: '2026-10-23' });
  assert.equal(dueToday.periodsLeft, 1);
  assert.equal(dueToday.target, 8000);
});

test('fundStatus: a bill saved monthly spreads what is needed over the calendar months left', () => {
  const fund = { amount: 8000, frequency: 'monthly', due_day: 25, set_aside_every: 'monthly' };
  const dueThisMonth = fundStatus({ fund, balance: 0, setAsideThisPeriod: 0, today: '2026-11-09' });
  assert.deepEqual([dueThisMonth.periodWord, dueThisMonth.periodsLeft, dueThisMonth.target, dueThisMonth.remaining], ['month', 1, 8000, 8000]);

  // The target stays put during the month; only what is left of it goes down.
  const partWay = fundStatus({ fund, balance: 3000, setAsideThisPeriod: 3000, today: '2026-11-20' });
  assert.deepEqual([partWay.target, partWay.remaining, partWay.shortBy], [8000, 5000, 5000]);

  // After this month's due date the next bill is in December: November and December share it.
  const nextBill = fundStatus({ fund, balance: 0, setAsideThisPeriod: 0, today: '2026-11-26' });
  assert.deepEqual([nextBill.nextDue, nextBill.periodsLeft, nextBill.target], ['2026-12-25', 2, 4000]);

  // Across a new year: November, December and January.
  const permit = { amount: 9000, frequency: 'yearly', due_day: 20, due_month: 1, set_aside_every: 'monthly' };
  const yearly = fundStatus({ fund: permit, balance: 0, setAsideThisPeriod: 0, today: '2026-11-09' });
  assert.deepEqual([yearly.nextDue, yearly.periodsLeft, yearly.target], ['2027-01-20', 3, 3000]);
});

// The week is the pay week on every screen: Sunday to Saturday (wages are paid on Saturday).
test('setAsidePeriod: the Sunday-to-Saturday pay week for a weekly bill, the calendar month for a monthly one', () => {
  assert.deepEqual(setAsidePeriod({ set_aside_every: 'weekly' }, '2026-11-09'), { start: '2026-11-08', end: '2026-11-14' });
  assert.deepEqual(setAsidePeriod({}, '2026-11-08'), { start: '2026-11-08', end: '2026-11-14' }, 'Sunday starts the week');
  assert.deepEqual(setAsidePeriod({}, '2026-11-14'), { start: '2026-11-08', end: '2026-11-14' }, 'Saturday ends it');
  assert.deepEqual(setAsidePeriod({}, '2026-11-15'), { start: '2026-11-15', end: '2026-11-21' });
  // The same seven days as a week of Analytics.
  const [week] = require('../lib/calc').periodBuckets('week', '2026-11-14', 1);
  assert.deepEqual([week.start, week.end], ['2026-11-08', '2026-11-14']);
  assert.deepEqual(setAsidePeriod({ set_aside_every: 'monthly' }, '2027-02-10'), { start: '2027-02-01', end: '2027-02-28' });
});

test('closedDates keeps only closed days; openDatesWithEntries names the open days that have something on them', () => {
  const dates = ['2026-11-07', '2026-11-08', '2026-11-09', '2026-11-10'];
  const metas = [{ job_date: '2026-11-07', closed_at: '2026-11-07T12:00:00Z' }, { job_date: '2026-11-08', closed_at: null }];
  assert.deepEqual(closedDates(dates, metas), ['2026-11-07']);
  assert.deepEqual(openDatesWithEntries(dates, metas, ['2026-11-09', '2026-11-07', '2026-11-08', '2026-11-09', '2026-12-01']),
    ['2026-11-08', '2026-11-09'], 'closed days, empty days and days outside the period are left out');
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
