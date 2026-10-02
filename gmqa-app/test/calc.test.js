const test = require('node:test');
const assert = require('node:assert/strict');
const { saleDate, daySummary, jobTotals, DEPARTMENTS } = require('../lib/calc');

// Builds a job with totals the way lib/store.js does.
function job(fields) {
  const j = {
    department: 'carwash', vehicle_class: 'S', payment_method: 'Cash', payment_received: false,
    discount: 0, tip_gcash: 0, voided_at: null, closed_on: null, paid_on: null, items: [], ...fields,
  };
  return { ...j, totals: jobTotals(j) };
}
const line = (price, commission) => ({ kind: 'service', name: 'x', price, commission });

test('departments are carwash (same-day), detailing and tint_ppf (running)', () => {
  assert.deepEqual(DEPARTMENTS.map(d => [d.key, d.running]), [['carwash', false], ['detailing', true], ['tint_ppf', true]]);
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
