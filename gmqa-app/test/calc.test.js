const test = require('node:test');
const assert = require('node:assert/strict');
const { saleDate, daySummary, jobTotals, tipsOwed, TIPS_TRACKED_FROM, salesReport, DEPARTMENTS, replayAvgCost, periodBuckets, pctChange, serviceTrends } = require('../lib/calc');

// Builds a job with totals the way lib/store.js does.
function job(fields) {
  const j = {
    department: 'carwash', vehicle_class: 'S', payment_method: 'Cash', payment_received: false,
    discount: 0, tip_gcash: 0, voided_at: null, closed_on: null, paid_on: null, items: [], ...fields,
  };
  return { ...j, totals: jobTotals(j) };
}
const line = (price, commission) => ({ kind: 'service', name: 'x', price, commission });

test('departments: carwash (same-day), detailing, tint_ppf and the parts counter (running; parts have no catalog)', () => {
  assert.deepEqual(DEPARTMENTS.map(d => [d.key, d.running, d.catalog]),
    [['carwash', false, true], ['detailing', true, true], ['tint_ppf', true, true], ['parts', true, false]]);
});

test('parts bought for resale leave the drawer like any expense, and are reported separately', () => {
  const expenses = [
    { side: 'cash', amount: 200 }, // soap: a cost
    { side: 'cash', amount: 1000, for_resale: true }, // wipers to sell: money out, not a cost yet
    { side: 'gcash', amount: 300, for_resale: true },
    { side: 'fund', amount: 400, for_resale: true },
    { side: 'fund', amount: 50 },
  ];
  const s = daySummary({ date: '2026-12-01', jobs: [], expenses, meta: { cash_float: 2000 } });
  assert.equal(s.expectedCash, 2000 - 200 - 1000, 'the drawer pays for both');
  assert.equal(s.expectedGcash, -300);
  assert.deepEqual([s.cashExpenses, s.gcashExpenses, s.fundExpenses, s.drawerExpenses], [1200, 300, 450, 1500]);
  assert.deepEqual([s.partsBoughtDrawer, s.partsBoughtFund], [1300, 400]);
});

test('parts: line cost is frozen per unit; cost and parts sales are counted with paid sales', () => {
  const partLine = { kind: 'part', name: 'Wiper blade', quantity: 2, price: 900, commission: 40, unit_cost: 300 };
  const counter = job({ department: 'parts', vehicle_class: null, job_date: '2026-12-01', closed_on: '2026-12-01', paid_on: '2026-12-01', payment_received: true, items: [partLine] });
  assert.deepEqual(counter.totals, { subtotal: 900, discount: 0, total: 900, commission: 40, net: 860, cost: 600 });
  const wash = job({ job_date: '2026-12-01', payment_received: true, items: [line(600, 100), { ...partLine, quantity: 1, price: 450, commission: 20 }] });
  const unpaid = job({ job_date: '2026-12-01', payment_received: false, items: [{ ...partLine, quantity: 1, price: 450 }] });
  const s = daySummary({ date: '2026-12-01', jobs: [counter, wash, unpaid] });
  assert.equal(s.departments.parts.collected, 900, 'counter sale counts on its date without a vehicle');
  assert.equal(s.departments.carwash.collected, 1050);
  assert.equal(s.partsSales, 900 + 450, 'parts revenue across departments (paid only)');
  assert.equal(s.partsCost, 600 + 300, 'cost of parts sold (paid only)');
});

test('parts counter money goes to the drawer or GCash it was paid with, and EOD shows each', () => {
  const partLine = { kind: 'part', name: 'Wiper blade', quantity: 1, price: 450, commission: 20, unit_cost: 300 };
  const counter = fields => job({ department: 'parts', vehicle_class: null, job_date: '2026-12-01', closed_on: '2026-12-01', items: [partLine], ...fields });
  const paidWith = payment_method => counter({ payment_received: true, paid_on: '2026-12-01', payment_method });
  const s = daySummary({ date: '2026-12-01', meta: { cash_float: 1000 }, jobs: [
    paidWith('Cash'),
    paidWith('GCash'),
    paidWith('GCash'),
    counter({ payment_received: false, payment_method: 'Cash' }),
    job({ job_date: '2026-12-01', payment_received: true, payment_method: 'Cash', items: [line(600, 0)] }),
  ] });
  assert.deepEqual([s.partsCashReceived, s.partsGcashReceived], [450, 900], 'paid counter sales only, by how they were paid');
  assert.deepEqual([s.cashReceived, s.gcashReceived], [450 + 600, 900], 'still part of the drawer and GCash totals');
  assert.equal(s.expectedCash, 1000 + 1050 - s.commissionCash);
});

test('a counter sale paid on a later day: the sale stays on its day, the money counts on the day it was paid', () => {
  const partLine = { kind: 'part', name: 'Wiper blade', quantity: 1, price: 2000, commission: 0, unit_cost: 1200 };
  const labor = { kind: 'labor', name: 'Labor', price: 500, commission: 500 };
  const sale = job({ department: 'parts', vehicle_class: null, job_date: '2026-12-01', closed_on: '2026-12-01', paid_on: '2026-12-04',
    payment_received: true, payment_method: 'GCash', tip_gcash: 50, items: [partLine, labor] });
  const sameDay = job({ department: 'parts', vehicle_class: null, job_date: '2026-12-04', closed_on: '2026-12-04', paid_on: '2026-12-04',
    payment_received: true, payment_method: 'Cash', items: [{ ...partLine, price: 1000 }] });
  const jobs = [sale, sameDay];

  const saleDay = daySummary({ date: '2026-12-01', jobs, meta: { cash_float: 1000 } });
  assert.deepEqual([saleDay.collected, saleDay.receivables, saleDay.commission], [2500, 0, 500], 'a sale of that day, now paid');
  assert.deepEqual([saleDay.cashReceived, saleDay.gcashReceived, saleDay.jobTips], [0, 0, 0], 'but no money came in that day');
  assert.equal(saleDay.paidLater, 2500);
  assert.equal(saleDay.expectedCash, 1000 - 500);

  const payDay = daySummary({ date: '2026-12-04', jobs, meta: { cash_float: 1000 } });
  assert.deepEqual([payDay.collected, payDay.commission], [1000, 0], 'the earlier sale is not a sale again');
  assert.deepEqual([payDay.gcashReceived, payDay.partsGcashReceived, payDay.cashReceived, payDay.jobTips], [2500, 2500, 1000, 50]);
  assert.equal(payDay.earlierSalesPaid, 2500, 'shown on its own note');
  assert.equal(payDay.paidLater, 0);
  assert.equal(payDay.expectedGcash, 2500 + 50);
  assert.equal(tipsOwed({ jobs, metas: [], before: '2026-12-05' }), 50, 'the tip came in on the day it was paid');
});

test('an open parts job: no sale and no commission until it is marked done, even when it is paid first', () => {
  const partLine = { kind: 'part', name: 'Mirror', quantity: 1, price: 6000, commission: 0, unit_cost: 4500 };
  const labor = { kind: 'labor', name: 'Labor', price: 1500, commission: 1500 };
  const open = { department: 'parts', vehicle_class: null, job_date: '2026-12-01', payment_method: 'Cash', items: [partLine, labor] };

  assert.equal(saleDate(job(open)), null);
  const waiting = daySummary({ date: '2026-12-01', jobs: [job(open)], meta: { cash_float: 1000 } });
  assert.deepEqual([waiting.vehicles, waiting.collected, waiting.receivables, waiting.commission, waiting.partsCost], [0, 0, 0, 0, 0]);
  assert.equal(waiting.expectedCash, 1000);

  // Paid at the counter on the 1st, installed on the 3rd.
  const prepaid = job({ ...open, paid_on: '2026-12-01', closed_on: '2026-12-03', payment_received: true });
  const payDay = daySummary({ date: '2026-12-01', jobs: [prepaid], meta: { cash_float: 1000 } });
  assert.deepEqual([payDay.cashReceived, payDay.partsCashReceived, payDay.paidInAdvance, payDay.commission], [7500, 7500, 7500, 0]);
  assert.equal(payDay.expectedCash, 8500, 'the money is in the drawer, the labor is not paid out yet');
  const doneDay = daySummary({ date: '2026-12-03', jobs: [prepaid], meta: { cash_float: 1000 } });
  assert.deepEqual([doneDay.collected, doneDay.commission, doneDay.partsCost, doneDay.cashReceived], [7500, 1500, 4500, 0]);
  assert.equal(doneDay.expectedCash, 1000 - 1500, 'the labor goes to the installer when the job is done');
});

test('saleDate: carwash counts on its job date; running jobs on the day they are finished, paid or not', () => {
  assert.equal(saleDate(job({ job_date: '2026-10-05' })), '2026-10-05');
  const running = { department: 'detailing', job_date: '2026-10-05' };
  assert.equal(saleDate(job(running)), null);
  assert.equal(saleDate(job({ ...running, closed_on: '2026-10-07' })), '2026-10-07', 'finished, not paid yet');
  assert.equal(saleDate(job({ ...running, paid_on: '2026-10-06' })), null, 'paid but still in progress');
  assert.equal(saleDate(job({ ...running, closed_on: '2026-10-07', paid_on: '2026-10-08' })), '2026-10-07', 'paid after it was finished');
  assert.equal(saleDate(job({ ...running, closed_on: '2026-10-09', paid_on: '2026-10-06' })), '2026-10-09', 'paid before it was finished');
});

test('a running job counts only on the day it is finished, with its commission', () => {
  const dt = job({
    department: 'detailing', job_date: '2026-10-05', closed_on: '2026-10-07', paid_on: '2026-10-07',
    payment_received: true, payment_method: 'GCash', items: [line(5000, 1000)],
  });
  for (const date of ['2026-10-05', '2026-10-06', '2026-10-08']) {
    const s = daySummary({ date, jobs: [dt] });
    assert.equal(s.collected, 0, date);
    assert.equal(s.commission, 0, date);
  }
  const s = daySummary({ date: '2026-10-07', jobs: [dt] });
  assert.equal(s.collected, 5000);
  assert.equal(s.commission, 1000);
  assert.equal(s.net, 4000);
  assert.equal(s.gcashReceived, 5000);
  assert.deepEqual(s.departments.detailing, { jobs: 1, collected: 5000, receivables: 0, commission: 1000, net: 4000 });
  assert.deepEqual(s.departments.carwash, { jobs: 0, collected: 0, receivables: 0, commission: 0, net: 0 });
});

test('a running job finished before it is paid: a sale of the finish day, the money counts on the day it is paid', () => {
  const unpaid = { department: 'tint_ppf', job_date: '2026-10-05', closed_on: '2026-10-05', payment_method: 'Cash', items: [line(6500, 2500)] };

  // Finished Monday, not paid yet: on Monday's books as a receivable, and the detailer's commission is due.
  const owed = daySummary({ date: '2026-10-05', jobs: [job(unpaid)], meta: { cash_float: 3000 } });
  assert.deepEqual(owed.departments.tint_ppf, { jobs: 1, collected: 0, receivables: 6500, commission: 2500, net: -2500 });
  assert.deepEqual([owed.vehicles, owed.unpaidJobs, owed.cashReceived], [1, 1, 0]);
  assert.equal(owed.expectedCash, 3000 - 2500, 'the detailer is paid at EOD, before the customer pays');

  // Paid Wednesday by GCash with a tip.
  const paid = job({ ...unpaid, paid_on: '2026-10-07', payment_received: true, payment_method: 'GCash', tip_gcash: 100 });
  const saleDay = daySummary({ date: '2026-10-05', jobs: [paid], meta: { cash_float: 3000 } });
  assert.deepEqual([saleDay.collected, saleDay.receivables, saleDay.commission], [6500, 0, 2500], 'still a sale of the finish day, now paid');
  assert.deepEqual([saleDay.cashReceived, saleDay.gcashReceived, saleDay.jobTips], [0, 0, 0], 'no money came in that day');
  assert.equal(saleDay.expectedCash, 3000 - 2500, "Monday's drawer does not change when the customer pays later");
  assert.equal(saleDay.paidLater, 6500);
  assert.equal(saleDay.paidEarlier, 0);

  const payDay = daySummary({ date: '2026-10-07', jobs: [paid], meta: { cash_float: 3000 } });
  assert.deepEqual([payDay.collected, payDay.commission, payDay.vehicles], [0, 0, 0], 'not a sale again');
  assert.deepEqual([payDay.gcashReceived, payDay.jobTips], [6500, 100]);
  assert.equal(payDay.earlierSalesPaid, 6500, 'shown on its own note');
  assert.equal(payDay.paidInAdvance, 0, 'the job is finished, so this is not money in advance');
});

test('a running job not finished yet stays out of sales, even when it is unpaid', () => {
  const open = job({ department: 'tint_ppf', job_date: '2026-10-05', items: [line(6500, 2500)] });
  const s = daySummary({ date: '2026-10-05', jobs: [open] });
  assert.deepEqual([s.vehicles, s.collected, s.receivables, s.commission], [0, 0, 0, 0]);
});

test('prepaid running job: cash counts the day it is received, the sale the day it is done', () => {
  const tint = job({
    department: 'tint_ppf', job_date: '2026-10-05', paid_on: '2026-10-05', closed_on: '2026-10-07',
    payment_received: true, payment_method: 'Cash', items: [line(8000, 1200)],
  });
  const payDay = daySummary({ date: '2026-10-05', jobs: [tint], meta: { cash_float: 1000 } });
  assert.equal(payDay.collected, 0, 'not a sale yet');
  assert.equal(payDay.cashReceived, 8000, 'but the money is in the drawer');
  assert.equal(payDay.paidInAdvance, 8000);
  assert.equal(payDay.commission, 0);
  assert.equal(payDay.expectedCash, 1000 + 8000);

  const doneDay = daySummary({ date: '2026-10-07', jobs: [tint], meta: { cash_float: 1000 } });
  assert.equal(doneDay.collected, 8000);
  assert.equal(doneDay.departments.tint_ppf.collected, 8000);
  assert.equal(doneDay.cashReceived, 0, 'money came in on an earlier day');
  assert.equal(doneDay.paidEarlier, 8000);
  assert.equal(doneDay.commission, 1200);
  assert.equal(doneDay.expectedCash, 1000 - 1200, 'commission is paid out from the drawer on the sale day');
});

test('EOD combines all departments and the breakdown adds up', () => {
  const date = '2026-10-08';
  const jobs = [
    job({ job_date: date, payment_received: true, items: [line(600, 100)] }),
    job({ job_date: date, payment_received: false, items: [line(300, 0)] }),
    job({ job_date: date, payment_received: true, payment_method: 'GCash', tip_gcash: 50, items: [line(700, 100)] }),
    job({ department: 'detailing', job_date: '2026-10-01', closed_on: date, paid_on: date, payment_received: true, items: [line(4500, 900)] }),
    job({ department: 'tint_ppf', job_date: '2026-10-06', closed_on: date, paid_on: date, payment_received: true, payment_method: 'GCash', items: [line(9000, 1500)] }),
    job({ job_date: date, payment_received: true, voided_at: '2026-10-08T03:00:00Z', items: [line(999, 99)] }),
  ];
  const s = daySummary({ date, jobs, expenses: [{ side: 'cash', amount: 200 }], meta: { cash_float: 500, commission_gcash_paid: 600 } });

  assert.deepEqual(s.departments.carwash, { jobs: 3, collected: 1300, receivables: 300, commission: 200, net: 1100 });
  assert.deepEqual(s.departments.detailing, { jobs: 1, collected: 4500, receivables: 0, commission: 900, net: 3600 });
  assert.deepEqual(s.departments.tint_ppf, { jobs: 1, collected: 9000, receivables: 0, commission: 1500, net: 7500 });
  assert.equal(s.vehicles, 5);
  assert.equal(s.collected, 1300 + 4500 + 9000);
  assert.equal(s.receivables, 300);
  assert.equal(s.commission, 200 + 900 + 1500);
  assert.equal(s.net, s.collected - s.commission);

  assert.equal(s.cashReceived, 600 + 4500);
  assert.equal(s.gcashReceived, 700 + 9000);
  assert.equal(s.tips, 50);
  assert.equal(s.commissionGcash, 600);
  assert.equal(s.commissionCash, 2600 - 600);
  assert.equal(s.expectedCash, 500 + 5100 - 2000 - 200);
  assert.equal(s.expectedGcash, 9700 + 50 - 50 - 600);
});

test('a running job not yet done and not paid does not touch any day', () => {
  const open = job({ department: 'detailing', job_date: '2026-10-05', items: [line(3000, 600)] });
  const s = daySummary({ date: '2026-10-05', jobs: [open] });
  assert.equal(s.vehicles, 0);
  assert.equal(s.collected + s.receivables + s.commission + s.cashReceived + s.gcashReceived, 0);
});

test('GCash tips: kept in GCash until given to the crew, and carried over until they are', () => {
  assert.equal(TIPS_TRACKED_FROM, '2026-10-29');
  const tipJob = (date, tip) => job({ job_date: date, payment_received: true, payment_method: 'GCash', tip_gcash: tip, items: [line(500, 0)] });
  const day1 = '2026-11-02';
  const day2 = '2026-11-03';
  const jobs = [tipJob(day1, 50), tipJob(day2, 20)];

  // Day 1: a ₱50 tip came in and has not been given out yet: it is still in GCash and still owed.
  const held = daySummary({ date: day1, jobs, meta: { gcash_tips_to_distribute: 30 } });
  assert.equal(held.tips, 80, 'job tips + other tips');
  assert.equal(held.tipsGiven, 0);
  assert.equal(held.tipsToGive, 80);
  assert.equal(held.expectedGcash, 500 + 80);
  // Given out: it leaves GCash and nothing is owed.
  const given = daySummary({ date: day1, jobs, meta: { gcash_tips_to_distribute: 30, gcash_tips_passed: 80 } });
  assert.equal(given.tipsToGive, 0);
  assert.equal(given.expectedGcash, 500);

  // Day 1 closed with ₱50 of the ₱80 given: ₱30 is still owed on day 2.
  const metas = [{ job_date: day1, gcash_tips_to_distribute: 30, gcash_tips_passed: 50 }];
  assert.equal(tipsOwed({ jobs, metas, before: day1 }), 0);
  assert.equal(tipsOwed({ jobs, metas, before: day2 }), 30);
  const next = daySummary({ date: day2, jobs, meta: {}, tipsOwedBefore: 30 });
  assert.equal(next.tipsOwedBefore, 30);
  assert.equal(next.tipsToGive, 30 + 20);
  const paidOut = daySummary({ date: day2, jobs, meta: { gcash_tips_passed: 50 }, tipsOwedBefore: 30 });
  assert.equal(paidOut.tipsToGive, 0);
  assert.equal(paidOut.expectedGcash, 500 + 20 - 50, 'giving out earlier tips takes them out of today\'s GCash');
  // Giving out more than was owed is not a credit for later tips.
  assert.equal(tipsOwed({ jobs, metas: [{ job_date: day1, gcash_tips_passed: 500 }], before: '2026-11-04' }), 20);

  // Days before tracking started keep the old rule: tips were given out the same day.
  const old = '2026-10-08';
  const legacy = daySummary({ date: old, jobs: [tipJob(old, 50)], meta: { gcash_tips_passed: 0 } });
  assert.equal(legacy.tipsGiven, 50);
  assert.equal(legacy.tipsToGive, 0);
  assert.equal(legacy.expectedGcash, 500);
  assert.equal(tipsOwed({ jobs: [tipJob(old, 50)], metas: [], before: day1 }), 0, 'old tips are never owed');
});

test('daily sales report for the group chat: the boss\'s format, matching Oct 29, 2026', () => {
  const date = '2026-10-29';
  const paid = (method, price, commission) => job({ job_date: date, payment_received: true, payment_method: method, items: [line(price, commission)] });
  const jobs = [
    // The 19 paid cars of Oct 29 (after the Cash/GCash fix): ₱7,750 cash and ₱3,850 GCash, ₱1,520 commission.
    ...[[800, 150], [350, 0], [500, 0], [300, 0], [400, 0], [450, 0], [1500, 300], [300, 0], [850, 150], [300, 0], [850, 170], [850, 150], [300, 0]]
      .map(([p, c]) => paid('Cash', p, c)),
    ...[[250, 0], [850, 150], [700, 130], [800, 150], [850, 170]].map(([p, c]) => paid('GCash', p, c)),
    job({ job_date: date, payment_received: true, payment_method: 'GCash', tip_gcash: 50, items: [line(400, 0)] }), // the tip is not in the report
    // Not paid yet: counts as a car, not as a sale.
    job({ job_date: date, items: [line(300, 0)] }),
  ];
  const s = daySummary({
    date, jobs,
    expenses: [{ side: 'cash', amount: 100 }, { side: 'gcash', amount: 1509 }, { side: 'cash', amount: 100 }, { side: 'cash', amount: 150 },
      { side: 'cash', amount: 1000 }, { side: 'fund', amount: 400 }], // the abono is not in the report
    meta: { cash_float: 1000, gcash_tips_passed: 50 },
    outflows: { payrollPayouts: [{ side: 'cash', amount: 2000 }] }, // payouts are not in the report
  });
  const r = salesReport({ date, summary: s });
  assert.deepEqual(r, { cars: 20, sales: 11600, commission: 1520, expenses: 2859, net: 7221,
    cash: null, gcash: null, cashVariance: null, gcashVariance: null,
    text: 'October 29, 2026\nTotal of cars - 20\nTotal sales - 11,600\nLess comms - 1,520\nLess expenses - 2,859\nTotal net = 7,221\n\nCash - not counted yet\nGcash - not counted yet' });

  // Centavos are shown only when there are any; nothing is made up for a side that was not counted.
  const odd = salesReport({ date, summary: daySummary({ date, jobs: [paid('GCash', 1000.5, 100)], meta: { commission_gcash_paid: 100, actual_gcash: 900.5 } }) });
  assert.equal(odd.text, 'October 29, 2026\nTotal of cars - 1\nTotal sales - 1,000.50\nLess comms - 100\nLess expenses - 0\nTotal net = 900.50\n\nCash - not counted yet\nGcash - 900.50\nGcash variance = 0');
});

test('sales report: the cash and GCash actually counted at EOD, and each side\'s variance', () => {
  const date = '2026-10-29';
  const jobs = [
    job({ job_date: date, payment_received: true, payment_method: 'Cash', items: [line(1000, 100)] }),
    job({ job_date: date, payment_received: true, payment_method: 'GCash', items: [line(500, 0)] }),
  ];
  const report = meta => salesReport({ date, summary: daySummary({ date, jobs, meta: { cash_float: 2000, ...meta } }) });

  // Expected: cash 2,000 + 1,000 − 100 = 2,900; GCash 500.
  const short = report({ actual_cash: 2850, actual_gcash: 500 });
  assert.deepEqual([short.cash, short.gcash, short.cashVariance, short.gcashVariance], [2850, 500, -50, 0]);
  assert.match(short.text, /\n\nCash - 2850\nGcash - 500\nCash variance = -50\nGcash variance = 0$/);

  const over = report({ actual_cash: 2900.5, actual_gcash: 520 });
  assert.match(over.text, /\n\nCash - 2900\.50\nGcash - 520\nCash variance = \+0\.50\nGcash variance = \+20$/);

  // A count of ₱0 is a count, not "not counted".
  assert.match(report({ actual_cash: 0, actual_gcash: 0 }).text, /Cash - 0\nGcash - 0\nCash variance = -2,900\nGcash variance = -500$/);
});

test('average cost replayed from a delivery: weighted by what is on the shelf at each delivery; sales and counts only move stock', () => {
  const moves = [
    { id: 1, kind: 'receive', quantity: 10, unit_cost: 800 },
    { id: 2, kind: 'sale', quantity: -3, unit_cost: 0 },
    { id: 3, kind: 'receive', quantity: 5, unit_cost: 900 },
    { id: 4, kind: 'use', quantity: -12 },
    { id: 5, kind: 'receive', quantity: 2, unit_cost: 1000 },
  ];
  const { avg, before } = replayAvgCost(0, 0, moves);
  assert.equal(avg, 1000, 'an empty shelf takes the new cost');
  assert.deepEqual(before, [{ id: 1, avg: 0 }, { id: 3, avg: 800 }, { id: 5, avg: 841.67 }], 'the average just before each delivery');
  assert.equal(replayAvgCost(7, 500, moves.slice(2, 3)).avg, 666.67, 'starts from the stock and average before the first change');
});

// Analytics periods: weeks are the Sunday-to-Saturday pay weeks, quarters are calendar quarters, and the
// period still running stops at the chosen day so it is never padded with days that have not happened.
test('periodBuckets: day, week, month and quarter, oldest first, the running one cut at the date', () => {
  const pick = list => list.map(p => [p.label, p.start, p.end, p.partial]);
  assert.deepEqual(pick(periodBuckets('day', '2026-11-05', 2)), [
    ['Wed, Nov 4', '2026-11-04', '2026-11-04', false],
    ['Thu, Nov 5', '2026-11-05', '2026-11-05', false],
  ]);
  assert.deepEqual(pick(periodBuckets('week', '2026-11-05', 2)), [
    ['Oct 25–31', '2026-10-25', '2026-10-31', false],
    ['Nov 1–7', '2026-11-01', '2026-11-05', true],
  ]);
  assert.deepEqual(pick(periodBuckets('week', '2026-11-07', 1)), [['Nov 1–7', '2026-11-01', '2026-11-07', false]]);
  assert.deepEqual(pick(periodBuckets('week', '2027-01-02', 1)), [['Dec 27–Jan 2', '2026-12-27', '2027-01-02', false]]);
  assert.deepEqual(pick(periodBuckets('month', '2027-01-15', 2)), [
    ['Dec 2026', '2026-12-01', '2026-12-31', false],
    ['Jan 2027', '2027-01-01', '2027-01-15', true],
  ]);
  assert.deepEqual(pick(periodBuckets('month', '2028-02-29', 1)), [['Feb 2028', '2028-02-01', '2028-02-29', false]]);
  assert.deepEqual(pick(periodBuckets('quarter', '2027-02-10', 2)), [
    ['Q4 2026', '2026-10-01', '2026-12-31', false],
    ['Q1 2027', '2027-01-01', '2027-02-10', true],
  ]);
  assert.equal(periodBuckets('day', '2026-11-05').length, 14);
  assert.equal(periodBuckets('week', '2026-11-05').length, 8);
  assert.equal(periodBuckets('month', '2026-11-05').length, 6);
  assert.equal(periodBuckets('quarter', '2026-11-05').length, 4);
});

test('pctChange: rounded percent, nothing to compare with gives null', () => {
  assert.equal(pctChange(150, 100), 50);
  assert.equal(pctChange(75, 100), -25);
  assert.equal(pctChange(1, 3), -66.7);
  assert.equal(pctChange(100, 0), null);
});

// Lines are grouped by the name on the sale. Standard Wash is the old name of Regular Wash, so they are one service.
test('serviceTrends: a renamed service stays one row, and empty periods are skipped when comparing', () => {
  const line = (name, price, kind = 'service') => ({ kind, name, price, quantity: 1 });
  const job = (job_date, ...items) => ({ job_date, vehicle_class: 'S', payment_received: true, discount: 0, items });
  const periods = [
    { label: 'A', start: '2026-01-01', end: '2026-01-07', salesDays: 2 },
    { label: 'B', start: '2026-01-08', end: '2026-01-14', salesDays: 1 },
    { label: 'C', start: '2026-01-15', end: '2026-01-15', salesDays: 0 },
  ];
  const { items, compare } = serviceTrends(periods, [
    job('2026-01-02', line('Standard Wash', 300)),
    job('2026-01-03', line(' regular wash', 400), line('Regular Wash', 400, 'addon')),
    job('2026-01-09', line('Regular Wash', 400)),
  ]);
  assert.deepEqual(compare, { now: 'B', before: 'A' }, 'a day with no sales yet is not a fall');
  assert.deepEqual(items.map(s => [s.kind, s.name, s.sold, s.sales]), [['service', 'Regular Wash', 3, 1100], ['addon', 'Regular Wash', 1, 400]]);
  assert.deepEqual(items[0].periods.map(p => p.sold), [2, 1, 0]);
  assert.deepEqual([items[0].change, items[0].trend], [0, 'flat']);
  assert.deepEqual([items[1].change, items[1].trend], [-100, 'down']);

  const lonely = serviceTrends(periods.slice(0, 1), [job('2026-01-02', line('Regular Wash', 400))]);
  assert.equal(lonely.compare, null);
  assert.deepEqual([lonely.items[0].change, lonely.items[0].trend], [null, null]);
});
