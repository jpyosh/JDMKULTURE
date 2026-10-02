const test = require('node:test');
const assert = require('node:assert/strict');
const { rateOn, payrollForRange, datesBetween, daySummary } = require('../lib/calc');

const rates = [
  { effective_from: '2000-01-01', rate_per_day: 400, construction_rate: 800 },
  { effective_from: '2026-09-17', rate_per_day: 500, construction_rate: 800 },
];

test('datesBetween lists every day inclusive', () => {
  assert.deepEqual(datesBetween('2026-09-28', '2026-10-04'),
    ['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04']);
  assert.equal(datesBetween('2026-09-01', '2026-09-15').length, 15);
});

test('rateOn picks the rate in effect on that day', () => {
  assert.equal(rateOn(rates, '2026-09-16').rate_per_day, 400);
  assert.equal(rateOn(rates, '2026-09-17').rate_per_day, 500);
  assert.equal(rateOn(rates, '2027-01-01').rate_per_day, 500);
  assert.equal(rateOn([], '2026-09-17').rate_per_day, 0);
});

test('payrollForRange pays each day at that day\'s rate, plus dated adjustments', () => {
  const pay = payrollForRange({
    dates: datesBetween('2026-09-14', '2026-09-20'),
    rates,
    days: {
      '2026-09-14': { code: 'P' },
      '2026-09-15': { code: '0.5P' },
      '2026-09-16': { code: 'CN', cn_ot_hours: 1 },
      '2026-09-17': { code: 'P', cw_ot_hours: 2 },
      '2026-09-18': { code: 'A' },
      '2026-09-19': { code: 'OFF' },
      '2026-09-25': { code: 'P' }, // outside the range: ignored
    },
    adjustments: [{ kind: 'addition', amount: 100 }, { kind: 'deduction', amount: 250 }],
  });
  assert.equal(pay.carwashDays, 2.5);
  assert.equal(pay.constructionDays, 1);
  assert.equal(pay.absences, 1);
  assert.equal(pay.daysOff, 1);
  assert.equal(pay.carwashPay, 400 + 200 + 500);
  assert.equal(pay.constructionPay, 800);
  assert.equal(pay.otPay, 800 / 8 * 1.25 * 1 + 500 / 8 * 1.25 * 2);
  assert.equal(pay.otHours, 3);
  assert.equal(pay.additions, 100);
  assert.equal(pay.deductions, 250);
  assert.equal(pay.gross, 1100 + 800 + 125 + 156.25 + 100);
  assert.equal(pay.net, pay.gross - 250);
});

test('payroll paid out of the drawer reduces expected cash/GCash that day', () => {
  const s = daySummary({
    date: '2026-09-20', jobs: [], meta: { cash_float: 5000 },
    outflows: { payrollPayouts: [{ side: 'cash', amount: 3000 }, { side: 'gcash', amount: 500 }] },
  });
  assert.equal(s.payrollCash, 3000);
  assert.equal(s.payrollGcash, 500);
  assert.equal(s.expectedCash, 2000);
  assert.equal(s.expectedGcash, -500);
});
