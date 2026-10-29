const test = require('node:test');
const assert = require('node:assert/strict');
const { saleDate, daySummary, jobTotals, tipsOwed, TIPS_TRACKED_FROM, DEPARTMENTS } = require('../lib/calc');

// Builds a job with totals the way lib/store.js does.
function job(fields) {
  const j = {
    department: 'carwash', vehicle_class: 'S', payment_method: 'Cash', payment_received: false,
    discount: 0, tip_gcash: 0, voided_at: null, closed_on: null, paid_on: null, items: [], ...fields,
  };
  return { ...j, totals: jobTotals(j) };
}
const line = (price, commission) => ({ kind: 'service', name: 'x', price, commission });

test('departments: carwash (same-day), detailing and tint_ppf (running), parts counter (same-day, no catalog)', () => {
  assert.deepEqual(DEPARTMENTS.map(d => [d.key, d.running, d.catalog]),
    [['carwash', false, true], ['detailing', true, true], ['tint_ppf', true, true], ['parts', false, false]]);
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
  const counter = job({ department: 'parts', vehicle_class: null, job_date: '2026-12-01', payment_received: true, items: [partLine] });
  assert.deepEqual(counter.totals, { subtotal: 900, discount: 0, total: 900, commission: 40, net: 860, cost: 600 });
  const wash = job({ job_date: '2026-12-01', payment_received: true, items: [line(600, 100), { ...partLine, quantity: 1, price: 450, commission: 20 }] });
  const unpaid = job({ job_date: '2026-12-01', payment_received: false, items: [{ ...partLine, quantity: 1, price: 450 }] });
  const s = daySummary({ date: '2026-12-01', jobs: [counter, wash, unpaid] });
  assert.equal(s.departments.parts.collected, 900, 'counter sale counts on its date without a vehicle');
  assert.equal(s.departments.carwash.collected, 1050);
  assert.equal(s.partsSales, 900 + 450, 'parts revenue across departments (paid only)');
  assert.equal(s.partsCost, 600 + 300, 'cost of parts sold (paid only)');
});

test('saleDate: carwash counts on its job date; running jobs when both closed and paid', () => {
  assert.equal(saleDate(job({ job_date: '2026-10-05' })), '2026-10-05');
  const running = { department: 'detailing', job_date: '2026-10-05' };
  assert.equal(saleDate(job(running)), null);
  assert.equal(saleDate(job({ ...running, closed_on: '2026-10-07' })), null, 'closed but unpaid');
  assert.equal(saleDate(job({ ...running, paid_on: '2026-10-06' })), null, 'paid but still in progress');
  assert.equal(saleDate(job({ ...running, closed_on: '2026-10-07', paid_on: '2026-10-08' })), '2026-10-08');
  assert.equal(saleDate(job({ ...running, closed_on: '2026-10-09', paid_on: '2026-10-06' })), '2026-10-09');
});

test('a running job counts only on its sale date, with its commission', () => {
  const dt = job({
    department: 'detailing', job_date: '2026-10-05', closed_on: '2026-10-07', paid_on: '2026-10-08',
    payment_received: true, payment_method: 'GCash', items: [line(5000, 1000)],
  });
  for (const date of ['2026-10-05', '2026-10-06', '2026-10-07']) {
    const s = daySummary({ date, jobs: [dt] });
    assert.equal(s.collected, 0, date);
    assert.equal(s.commission, 0, date);
  }
  const s = daySummary({ date: '2026-10-08', jobs: [dt] });
  assert.equal(s.collected, 5000);
  assert.equal(s.commission, 1000);
  assert.equal(s.net, 4000);
  assert.equal(s.gcashReceived, 5000);
  assert.deepEqual(s.departments.detailing, { jobs: 1, collected: 5000, receivables: 0, commission: 1000, net: 4000 });
  assert.deepEqual(s.departments.carwash, { jobs: 0, collected: 0, receivables: 0, commission: 0, net: 0 });
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
