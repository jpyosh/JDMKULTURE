const test = require('node:test');
const assert = require('node:assert/strict');
const { rateOn, payrollForRange: payWith, datesBetween, daySummary, otRuleOn, otHourly, otRuleNote: noteWith } = require('../lib/calc');

// The shop's overtime rules as migration 011 seeds them (the owner can change them on the Payroll screen).
const SHOP_RULES = [
  { effective_from: '2000-01-01', multiplier: 1.25, carwash_hours: 8, construction_hours: 8 },
  { effective_from: '2026-10-04', multiplier: 1, carwash_hours: 8, construction_hours: 8 },
  { effective_from: '2026-10-05', multiplier: 1, carwash_hours: 11, construction_hours: 8 },
];
const payrollForRange = args => payWith({ otRules: SHOP_RULES, ...args });
const otRuleNote = (start, end) => noteWith(SHOP_RULES, start, end);
const otMultiplierOn = date => otRuleOn(SHOP_RULES, date).multiplier;

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

test('overtime pays ×1.25 for days up to Sat 2026-10-03 and ×1 from Sun 2026-10-04', () => {
  assert.equal(otMultiplierOn('2026-01-01'), 1.25);
  assert.equal(otMultiplierOn('2026-10-03'), 1.25);
  assert.equal(otMultiplierOn('2026-10-04'), 1);
  assert.equal(otMultiplierOn('2026-10-05'), 1);
  assert.equal(otMultiplierOn('2027-06-30'), 1);

  // A range across the change: each day's overtime uses the rule of that day.
  const pay = payrollForRange({
    dates: datesBetween('2026-10-03', '2026-10-06'),
    rates: [{ effective_from: '2000-01-01', rate_per_day: 400, construction_rate: 800 }],
    days: { '2026-10-04': { code: 'CN', cn_ot_hours: 2 }, '2026-10-05': { code: 'CN', cn_ot_hours: 2 }, '2026-10-06': { code: 'P', cw_ot_hours: 4 } },
  });
  // 10-04: 800/8 × 1 × 2 = 200 · 10-05 construction: 800/8 × 2 = 200 · 10-06 carwash: 400/11 × 4 = 145.45
  assert.equal(pay.otPay, 545.45);
  assert.equal(pay.otHours, 8);
});

test('carwash overtime uses an 11-hour day from 2026-10-05; construction stays 8; earlier days unchanged', () => {
  const rates = [{ effective_from: '2000-01-01', rate_per_day: 550, construction_rate: 800 }];
  const ot = (date, day) => payrollForRange({ dates: [date], rates, days: { [date]: day } }).otPay;
  assert.equal(ot('2026-10-05', { code: 'P', cw_ot_hours: 2 }), 100);      // 550 / 11 × 1 × 2
  assert.equal(ot('2026-10-05', { code: 'CN', cn_ot_hours: 2 }), 200);     // 800 / 8 × 1 × 2
  assert.equal(ot('2026-10-04', { code: 'P', cw_ot_hours: 2 }), 137.5);    // Sun Oct 4: already × 1, still an 8-hour carwash day
  assert.equal(ot('2026-10-04', { code: 'CN', cn_ot_hours: 2 }), 200);     // 800 / 8 × 1 × 2
  assert.equal(ot('2026-10-03', { code: 'P', cw_ot_hours: 2 }), 171.88);   // 550 / 8 × 1.25 × 2 (before the change)
  assert.equal(ot('2026-10-03', { code: 'CN', cn_ot_hours: 2 }), 250);     // 800 / 8 × 1.25 × 2
  // Both kinds on one day after the change.
  assert.equal(ot('2026-11-02', { code: 'P', cw_ot_hours: 1, cn_ot_hours: 1 }), 150); // 550/11 + 800/8
});

test('historical payroll is unchanged by the new overtime rule (owner\'s week of Sep 27 - Oct 4)', () => {
  // Menan: CN Mon-Sat at 1,200 with 15h OT on Monday, as on the signed sheet: gross 10,012.50.
  const days = { '2026-09-27': { code: 'OFF' }, '2026-09-28': { code: 'CN', cn_ot_hours: 15 } };
  for (const d of ['2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-03']) days[d] = { code: 'CN' };
  const pay = payrollForRange({
    dates: datesBetween('2026-09-27', '2026-10-04'), days,
    rates: [{ effective_from: '2000-01-01', rate_per_day: 560, construction_rate: 1200 }],
    adjustments: [{ kind: 'deduction', amount: 2000 }],
  });
  assert.equal(pay.gross, 10012.5);
  assert.equal(pay.net, 8012.5);
});

test('the overtime note states the rule for the days shown', () => {
  assert.equal(otRuleNote('2026-09-20', '2026-09-26'), "OT pays the day's rate ÷ 8 × 1.25 per hour.");
  assert.equal(otRuleNote('2026-09-28', '2026-10-04'),
    "OT pays the day's rate ÷ 8 × 1.25 per hour up to Oct 3, 2026, and the day's rate ÷ 8 × 1 from Oct 4, 2026.");
  assert.equal(otRuleNote('2026-10-05', '2026-10-11'), 'OT pays the carwash rate ÷ 11 (construction rate ÷ 8) × 1 per hour.');
  assert.equal(otRuleNote('2026-10-01', '2026-10-15'),
    "OT pays the day's rate ÷ 8 × 1.25 per hour up to Oct 3, 2026; the day's rate ÷ 8 × 1 on Oct 4, 2026; and the carwash rate ÷ 11 (construction rate ÷ 8) × 1 from Oct 5, 2026.");
});

test('an employee can have their own normal hours and OT multiplier, dated like their rate', () => {
  // The GM works a standard 8-hour day while the crew's carwash day is 11 hours.
  const rates = [
    { effective_from: '2000-01-01', rate_per_day: 1100, construction_rate: 800 },
    { effective_from: '2026-10-05', rate_per_day: 1100, construction_rate: 800, carwash_hours: 8, ot_multiplier: null },
    { effective_from: '2026-11-01', rate_per_day: 1100, construction_rate: 800, carwash_hours: 8, ot_multiplier: 1.25 },
  ];
  const ot = (date, day) => payrollForRange({ dates: [date], rates, days: { [date]: day } }).otPay;
  assert.equal(ot('2026-10-04', { code: 'P', cw_ot_hours: 2 }), 275);     // before the override: shop rule 1100 / 8 × 1 × 2
  assert.equal(ot('2026-10-05', { code: 'P', cw_ot_hours: 2 }), 275);     // own 8-hour day, shop multiplier × 1 (crew: ÷ 11)
  assert.equal(ot('2026-11-01', { code: 'P', cw_ot_hours: 2 }), 343.75);  // own × 1.25: 1100 / 8 × 1.25 × 2
  assert.equal(ot('2026-11-01', { code: 'CN', cn_ot_hours: 2 }), 250);    // construction keeps the shop hours, own × 1.25
  // Someone without an override still follows the shop rule.
  const crew = payrollForRange({ dates: ['2026-11-01'], rates: [{ effective_from: '2000-01-01', rate_per_day: 1100, construction_rate: 0 }],
    days: { '2026-11-01': { code: 'P', cw_ot_hours: 2 } } });
  assert.equal(crew.otPay, 200);                                          // 1100 / 11 × 1 × 2
});

test('otHourly gives one OT hour\'s pay on a date, the same figure the pay uses', () => {
  const rates = [
    { effective_from: '2000-01-01', rate_per_day: 1100, construction_rate: 800 },
    { effective_from: '2026-11-01', rate_per_day: 1100, construction_rate: 800, carwash_hours: 8, ot_multiplier: 1.25 },
  ];
  assert.deepEqual(otHourly(rates, SHOP_RULES, '2026-10-20'),
    { carwashHours: 11, constructionHours: 8, multiplier: 1, carwash: 100, construction: 100 });
  assert.deepEqual(otHourly(rates, SHOP_RULES, '2026-11-01'),
    { carwashHours: 8, constructionHours: 8, multiplier: 1.25, carwash: 171.875, construction: 125 });
});

test('the shop overtime rule comes from the rules passed in, so the owner can change it from a date', () => {
  const rules = [...SHOP_RULES, { effective_from: '2027-01-03', multiplier: 1.25, carwash_hours: 10, construction_hours: 8 }];
  const rates = [{ effective_from: '2000-01-01', rate_per_day: 1000, construction_rate: 800 }];
  const ot = date => payWith({ otRules: rules, dates: [date], rates, days: { [date]: { code: 'P', cw_ot_hours: 2 } } }).otPay;
  assert.equal(ot('2027-01-02'), 181.82); // 1000 / 11 × 1 × 2
  assert.equal(ot('2027-01-03'), 250);    // 1000 / 10 × 1.25 × 2
  assert.equal(noteWith(rules, '2027-01-03', '2027-01-09'), 'OT pays the carwash rate ÷ 10 (construction rate ÷ 8) × 1.25 per hour.');
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
