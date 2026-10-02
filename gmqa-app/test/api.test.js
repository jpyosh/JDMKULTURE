const test = require('node:test');
const assert = require('node:assert/strict');
const { migratedDb } = require('./helpers');
const { createApp } = require('../server');
const { clearUserCache } = require('../lib/auth');
const crypto = require('crypto');

// Test tokens are just the email; the fake verifier maps them to identities.
const uid = email => crypto.createHash('md5').update(email).digest('hex').replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');
const verifyToken = async token => (token.includes('@') ? { id: uid(token), email: token } : null);
const OWNER = 'owner@test.ph';
const STAFF = 'staff@test.ph';

let server, base, driver;

test.before(async () => {
  driver = await migratedDb();
  await driver.query("insert into app_users (email, role) values ($1, 'owner'), ($2, 'staff')", [OWNER, STAFF]);
  server = createApp({ verifyToken }).listen(0);
  base = `http://127.0.0.1:${server.address().port}/api`;
});
test.after(() => server.close());

async function api(as, method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(as ? { Authorization: `Bearer ${as}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json();
  return { status: res.status, data };
}
const ok = async promise => {
  const r = await promise;
  assert.ok(r.status < 300, `expected success, got ${r.status}: ${JSON.stringify(r.data)}`);
  return r.data;
};

async function catalogItem(name) {
  const { items } = await ok(api(OWNER, 'GET', '/catalog'));
  return items.find(i => i.name === name);
}

test('authentication and roles', async () => {
  assert.equal((await api(null, 'GET', '/catalog')).status, 401);
  assert.equal((await api('bogus-token', 'GET', '/catalog')).status, 401);
  const stranger = await api('stranger@test.ph', 'GET', '/catalog');
  assert.equal(stranger.status, 403);
  assert.match(stranger.data.error, /does not have access/);

  assert.deepEqual(await ok(api(STAFF, 'GET', '/me')), { id: uid(STAFF), email: STAFF, role: 'staff', name: 'staff' });
  assert.equal((await api(STAFF, 'GET', '/catalog')).status, 200);
  assert.equal((await api(STAFF, 'GET', '/reports/range?start=2026-09-01&end=2026-09-30')).status, 403);
  assert.equal((await api(STAFF, 'GET', '/payroll?start=2026-09-14&end=2026-09-20')).status, 403);
  assert.equal((await api(STAFF, 'GET', '/users')).status, 403);
  const premium = await catalogItem('Premium Wash');
  assert.equal((await api(STAFF, 'PATCH', `/catalog/${premium.id}`, { prices: { S: { price: 1, commission: 0 } } })).status, 403);
});

test('jobs: line items, frozen prices, JO numbers, repricing, validation', async () => {
  const premium = await catalogItem('Premium Wash');
  const engine = await catalogItem('Engine Wash');

  const job = await ok(api(STAFF, 'POST', '/jobs', {
    job_date: '2026-09-14', vehicle_class: 'M', plate: 'abc 123', payment_method: 'GCash', tip_gcash: 50,
    items: [{ catalog_item_id: premium.id }, { catalog_item_id: engine.id }, { name: 'Tire black', price: 100, commission: 20 }],
  }));
  // Carwash has its own JO series (CW-); legacy JO- numbers on this date do not affect it.
  assert.equal(job.jo_number, 'CW-091426-001');
  assert.equal(job.department, 'carwash');
  assert.equal(job.plate, 'ABC 123');
  assert.equal(job.payment_received, false);
  assert.deepEqual(job.items.map(i => [i.kind, i.name, i.price, i.commission]), [
    ['service', 'Premium Wash', 650, 100], ['addon', 'Engine Wash', 800, 150], ['custom', 'Tire black', 100, 20],
  ]);
  // Staff response: no cost field (costs are owner-only).
  assert.deepEqual(job.totals, { subtotal: 1550, discount: 0, total: 1550, commission: 270, net: 1280 });

  // Changing the matrix does not touch the existing job.
  await ok(api(OWNER, 'PATCH', `/catalog/${premium.id}`, { prices: { M: { price: 999, commission: 111 } } }));
  const after = (await ok(api(STAFF, 'GET', '/jobs?date=2026-09-14'))).find(j => j.id === job.id);
  assert.equal(after.totals.total, 1550);

  // Changing the vehicle class re-prices catalog lines at today's prices; custom line kept.
  const repriced = await ok(api(STAFF, 'PATCH', `/jobs/${job.id}`, { vehicle_class: 'L' }));
  assert.deepEqual(repriced.items.map(i => i.price), [700, 800, 100]);

  // Replace the item list: keep the service, drop the add-on, add a new custom line.
  const edited = await ok(api(STAFF, 'PATCH', `/jobs/${job.id}`, {
    items: [{ id: repriced.items[0].id }, { name: 'Wax top-up', price: 200, commission: 0 }],
  }));
  assert.deepEqual(edited.items.map(i => i.name), ['Premium Wash', 'Wax top-up']);
  assert.equal(edited.items[0].id, repriced.items[0].id);

  const tooMuch = await api(STAFF, 'PATCH', `/jobs/${job.id}`, { discount: 5000 });
  assert.equal(tooMuch.status, 400);
  assert.match(tooMuch.data.error, /Discount/);
  assert.equal((await api(STAFF, 'POST', '/jobs', { job_date: '2026-09-14', items: [{ catalog_item_id: premium.id }] })).status, 400);
  assert.equal((await api(STAFF, 'POST', '/jobs', { job_date: '2026-02-30', vehicle_class: 'S', items: [{ catalog_item_id: premium.id }] })).status, 400);
  assert.equal((await api(STAFF, 'POST', '/jobs', { job_date: '2026-09-14', vehicle_class: 'S', items: [] })).status, 400);

  const second = await ok(api(STAFF, 'POST', '/jobs', { job_date: '2026-09-14', vehicle_class: 'S', items: [{ catalog_item_id: premium.id }] }));
  assert.equal(second.jo_number, 'CW-091426-002');
});

test('void is owner-only and removes the job from totals; JO numbers are never reused', async () => {
  const premium = await catalogItem('Premium Wash');
  const day = '2026-10-01';
  const job = await ok(api(STAFF, 'POST', '/jobs', { job_date: day, vehicle_class: 'S', payment_received: true, items: [{ catalog_item_id: premium.id }] }));
  assert.equal((await api(STAFF, 'POST', `/jobs/${job.id}/void`, { reason: 'test' })).status, 403);
  assert.equal((await api(OWNER, 'POST', `/jobs/${job.id}/void`, {})).status, 400);
  const voided = await ok(api(OWNER, 'POST', `/jobs/${job.id}/void`, { reason: 'Entered twice' }));
  assert.ok(voided.voided_at);
  assert.equal((await ok(api(STAFF, 'GET', `/days/${day}`))).summary.vehicles, 0);
  const next = await ok(api(STAFF, 'POST', '/jobs', { job_date: day, vehicle_class: 'S', items: [{ catalog_item_id: premium.id }] }));
  assert.equal(next.jo_number, 'CW-100126-002');
  await ok(api(OWNER, 'POST', `/jobs/${job.id}/restore`));
  assert.equal((await ok(api(STAFF, 'GET', `/days/${day}`))).summary.vehicles, 2);
});

test('EOD summary follows the agreed revenue rule and reconciles', async () => {
  const premium = await catalogItem('Premium Wash');
  const day = '2026-10-02';
  // Paid cash job: S Premium = 600 / comm 100.
  await ok(api(STAFF, 'POST', '/jobs', { job_date: day, vehicle_class: 'S', payment_received: true, items: [{ catalog_item_id: premium.id }] }));
  // Paid GCash job with a 50 tip and a 100 discount.
  await ok(api(STAFF, 'POST', '/jobs', { job_date: day, vehicle_class: 'S', payment_method: 'GCash', payment_received: true, tip_gcash: 50, discount: 100, items: [{ catalog_item_id: premium.id }] }));
  // Unpaid job: counts as receivable, commission still owed.
  await ok(api(STAFF, 'POST', '/jobs', { job_date: day, vehicle_class: 'S', items: [{ catalog_item_id: premium.id }] }));
  await ok(api(STAFF, 'POST', `/days/${day}/expenses`, { side: 'cash', description: 'Soap', amount: 150 }));
  const eod = await ok(api(STAFF, 'PUT', `/days/${day}`, { cash_float: 1000, commission_gcash_paid: 100, actual_cash: 1250, actual_gcash: 400 }));

  const s = eod.summary;
  assert.equal(s.vehicles, 3);
  assert.equal(s.collected, 1100);
  assert.equal(s.cashReceived, 600);
  assert.equal(s.gcashReceived, 500);
  assert.deepEqual(s.departments.carwash, { jobs: 3, collected: 1100, receivables: 600, commission: 300, net: 800 });
  assert.equal(s.receivables, 600);
  assert.equal(s.commission, 300);
  assert.equal(s.net, 800);
  assert.equal(s.commissionGcash, 100);
  assert.equal(s.commissionCash, 200);
  assert.equal(s.expectedCash, 1000 + 600 - 200 - 150);
  assert.equal(s.expectedGcash, 500 - 100);
  assert.equal(s.cashVariance, 0);
  assert.equal(s.gcashVariance, 0);
  assert.equal(s.tips, 50);
});

test('closing a day locks it for staff until the owner reopens it', async () => {
  const premium = await catalogItem('Premium Wash');
  const day = '2026-10-03';
  const job = await ok(api(STAFF, 'POST', '/jobs', { job_date: day, vehicle_class: 'S', items: [{ catalog_item_id: premium.id }] }));
  const closed = await ok(api(STAFF, 'POST', `/days/${day}/close`));
  assert.ok(closed.meta.closed_at);
  assert.equal((await api(STAFF, 'PATCH', `/jobs/${job.id}`, { payment_received: true })).status, 403);
  assert.equal((await api(STAFF, 'POST', `/days/${day}/expenses`, { side: 'cash', description: 'x', amount: 5 })).status, 403);
  assert.equal((await api(STAFF, 'POST', `/days/${day}/reopen`)).status, 403);
  await ok(api(OWNER, 'PATCH', `/jobs/${job.id}`, { payment_received: true }));
  await ok(api(OWNER, 'POST', `/days/${day}/reopen`));
  await ok(api(STAFF, 'PATCH', `/jobs/${job.id}`, { remarks: 'ok now' }));
});

test('range report sums days with the same rule', async () => {
  const r = await ok(api(OWNER, 'GET', '/reports/range?start=2026-10-02&end=2026-10-02'));
  assert.deepEqual(r.days.map(d => [d.date, d.collected, d.commission, d.expenses, d.profit]), [['2026-10-02', 1100, 300, 150, 650]]);
  assert.deepEqual(r.days[0].departments, { carwash: 1100, detailing: 0, tint_ppf: 0, parts: 0 });
  assert.equal(r.totals.profit, 650);
  assert.equal((await api(OWNER, 'GET', '/reports/range?start=2026-10-05&end=2026-10-01')).status, 400);
});

test('payroll: any date range, daily records, dated rates, adjustments and payouts', async () => {
  const emp = await ok(api(OWNER, 'POST', '/employees', { name: 'Tester', role: 'Detailer', rate_per_day: 400, construction_rate: 800 }));
  assert.equal(emp.rate_per_day, 400);
  const mark = (date, body) => ok(api(OWNER, 'PUT', `/payroll/attendance/${emp.id}/${date}`, body));
  await mark('2026-09-14', { code: 'P' });
  await mark('2026-09-15', { code: '0.5P' });
  await mark('2026-09-16', { code: 'CN' });
  await mark('2026-09-17', { code: 'P', cw_ot_hours: 2 });
  await mark('2026-09-18', { code: 'A' });
  const adj = await ok(api(OWNER, 'POST', '/payroll/adjustments', {
    employee_id: emp.id, date: '2026-09-16', kind: 'deduction', amount: 100, note: 'Cash advance',
  }));

  const rowFor = async (start, end) => {
    const r = await ok(api(OWNER, 'GET', `/payroll?start=${start}&end=${end}`));
    return { range: r, row: r.rows.find(x => x.employee.id === emp.id) };
  };
  const { range, row } = await rowFor('2026-09-14', '2026-09-20');
  assert.equal(range.dates.length, 7);
  assert.deepEqual([range.dates[0], range.dates[6]], ['2026-09-14', '2026-09-20']);
  assert.equal(row.days['2026-09-17'].cw_ot_hours, 2);
  assert.equal(row.adjustments.length, 1);
  // 2.5 carwash days * 400 + 1 CN * 800 + 2h OT at 400/8*1.25 - 100
  assert.equal(row.pay.net, 1000 + 800 + 125 - 100);

  // A raise effective the 17th: the 14th-16th keep the old rate.
  await ok(api(OWNER, 'PATCH', `/employees/${emp.id}`, { rate_per_day: 1000, effective_from: '2026-09-17' }));
  const after = (await rowFor('2026-09-14', '2026-09-20')).row;
  assert.equal(after.pay.net, 400 + 200 + 1000 + 800 + 1000 / 8 * 1.25 * 2 - 100);
  assert.equal((await ok(api(OWNER, 'GET', '/employees'))).find(e => e.id === emp.id).rate_per_day, 1000);

  // Ranges do not have to be whole weeks (e.g. 16th to 30th).
  const half = await rowFor('2026-09-16', '2026-09-30');
  assert.equal(half.range.dates.length, 15);
  assert.equal(half.row.pay.carwashDays, 1);
  assert.equal(half.row.pay.constructionDays, 1);

  // Clearing a day and removing an adjustment.
  await mark('2026-09-18', { code: '' });
  await ok(api(OWNER, 'DELETE', `/payroll/adjustments/${adj.id}`));
  const cleared = (await rowFor('2026-09-14', '2026-09-20')).row;
  assert.equal(cleared.days['2026-09-18'], undefined);
  assert.equal(cleared.pay.net, after.pay.net + 100);

  // Weekly payout from the drawer appears in that day's EOD and in the payroll range.
  await ok(api(OWNER, 'POST', '/payroll/payouts', {
    payout_date: '2026-09-20', period_start: '2026-09-14', period_end: '2026-09-20', side: 'cash', amount: 2712.5,
  }));
  assert.equal((await ok(api(OWNER, 'GET', '/days/2026-09-20'))).summary.payrollCash, 2712.5);
  const withPayout = (await rowFor('2026-09-14', '2026-09-20')).range;
  assert.equal(withPayout.payouts.length, 1);
  await ok(api(OWNER, 'DELETE', `/payroll/payouts/${withPayout.payouts[0].id}`));
  assert.equal((await ok(api(OWNER, 'GET', '/days/2026-09-20'))).summary.payrollCash, 0);

  // Validation.
  assert.equal((await api(OWNER, 'PUT', `/payroll/attendance/${emp.id}/2026-09-14`, { code: 'X' })).status, 400);
  assert.equal((await api(OWNER, 'GET', '/payroll?start=2026-09-20&end=2026-09-14')).status, 400);
  assert.equal((await api(OWNER, 'GET', '/payroll?start=2026-01-01&end=2026-04-01')).status, 400);
  assert.equal((await api(OWNER, 'POST', '/payroll/adjustments', { employee_id: emp.id, date: '2026-09-16', kind: 'deduction', amount: 0, note: 'x' })).status, 400);
  assert.equal((await api(OWNER, 'POST', '/payroll/adjustments', { employee_id: emp.id, date: '2026-09-16', kind: 'deduction', amount: 50 })).status, 400);
  assert.equal((await api(OWNER, 'POST', '/payroll/payouts', { payout_date: '2026-09-20', period_start: '2026-09-20', period_end: '2026-09-14', side: 'cash', amount: 10 })).status, 400);
});

test('users: invite staff, keep at least one owner; audit log records who did what', async () => {
  await ok(api(OWNER, 'POST', '/users', { email: 'New.Staff@Test.ph', role: 'staff' }));
  clearUserCache();
  assert.equal((await ok(api('new.staff@test.ph', 'GET', '/me'))).role, 'staff');
  assert.equal((await api(OWNER, 'PATCH', `/users/${OWNER}`, { role: 'staff' })).status, 400);
  await ok(api(OWNER, 'PATCH', '/users/new.staff@test.ph', { active: false }));
  clearUserCache();
  assert.equal((await api('new.staff@test.ph', 'GET', '/me')).status, 403);

  const log = await ok(api(OWNER, 'GET', '/audit?table=jobs&limit=500'));
  assert.ok(log.some(e => e.actor === STAFF && e.action === 'INSERT'));
  assert.ok(log.some(e => e.actor === OWNER && e.action === 'UPDATE' && e.new_row.voided_at));
});

test('vehicle classes are data: adding one works everywhere', async () => {
  await ok(api(OWNER, 'POST', '/classes', { code: 'van', label: 'Van' }));
  const premium = await catalogItem('Premium Wash');
  await ok(api(OWNER, 'PATCH', `/catalog/${premium.id}`, { prices: { VAN: { price: 900, commission: 150 } } }));
  const job = await ok(api(STAFF, 'POST', '/jobs', { job_date: '2026-10-04', vehicle_class: 'VAN', items: [{ catalog_item_id: premium.id }] }));
  assert.equal(job.totals.total, 900);
  assert.equal((await api(OWNER, 'PATCH', `/catalog/${premium.id}`, { prices: { TRUCK: { price: 1, commission: 0 } } })).status, 400);
});

test('catalog items belong to a department', async () => {
  const { items } = await ok(api(OWNER, 'GET', '/catalog'));
  assert.equal(items.find(i => i.name === 'Premium Wash').department, 'carwash');
  assert.equal(items.find(i => i.name === 'Paint Correction').department, 'detailing');
  assert.equal((await api(OWNER, 'POST', '/catalog', { kind: 'service', name: 'No dept' })).status, 400);
  const tint = await ok(api(OWNER, 'POST', '/catalog', {
    kind: 'service', department: 'tint_ppf', name: 'Full Tint 3M', prices: { S: { price: 7000, commission: 1000 } },
  }));
  assert.equal(tint.department, 'tint_ppf');
  const moved = await ok(api(OWNER, 'PATCH', `/catalog/${tint.id}`, { department: 'detailing' }));
  assert.equal(moved.department, 'detailing');
  await ok(api(OWNER, 'PATCH', `/catalog/${tint.id}`, { department: 'tint_ppf' }));
  assert.equal((await api(OWNER, 'PATCH', `/catalog/${tint.id}`, { department: 'bakery' })).status, 400);
});

test('running job (detailing): carried over until done and paid, counted on the later date', async () => {
  const paint = await catalogItem('Paint Correction');
  const premium = await catalogItem('Premium Wash');

  // Department-specific items only.
  const wrong = await api(STAFF, 'POST', '/jobs', { job_date: '2026-10-10', department: 'detailing', vehicle_class: 'M', items: [{ catalog_item_id: premium.id }] });
  assert.equal(wrong.status, 400);
  assert.match(wrong.data.error, /Carwash/);

  const job = await ok(api(STAFF, 'POST', '/jobs', {
    job_date: '2026-10-10', department: 'detailing', vehicle_class: 'M', plate: 'dtl 1', items: [{ catalog_item_id: paint.id }],
  }));
  assert.equal(job.jo_number, 'DT-101026-001');
  assert.deepEqual([job.department, job.closed_on, job.paid_on, job.sale_date, job.payment_received], ['detailing', null, null, null, false]);
  assert.equal(job.totals.total, 5000);

  const active = await ok(api(STAFF, 'GET', '/jobs/active?department=detailing'));
  assert.ok(active.some(j => j.id === job.id), 'shows on the detailing board');
  assert.ok(!(await ok(api(STAFF, 'GET', '/jobs/active?department=tint_ppf'))).some(j => j.id === job.id));
  assert.ok(!(await ok(api(STAFF, 'GET', '/jobs?date=2026-10-10&department=carwash'))).some(j => j.id === job.id), 'not on the carwash tab');
  assert.equal((await ok(api(STAFF, 'GET', '/days/2026-10-10'))).summary.vehicles, 0, 'opening day: nothing counted');

  // Payment is recorded with /pay, not the carwash checkbox.
  assert.equal((await api(STAFF, 'PATCH', `/jobs/${job.id}`, { payment_received: true })).status, 400);
  assert.equal((await api(STAFF, 'POST', `/jobs/${job.id}/pay`, { date: '2026-10-09', payment_method: 'Cash' })).status, 400, 'cannot pay before opening');

  // Paid in advance on the 11th (cash): money in the drawer that day, not a sale yet.
  const paid = await ok(api(STAFF, 'POST', `/jobs/${job.id}/pay`, { date: '2026-10-11', payment_method: 'Cash' }));
  assert.deepEqual([paid.paid_on, paid.payment_received, paid.sale_date], ['2026-10-11', true, null]);
  const payDay = (await ok(api(STAFF, 'GET', '/days/2026-10-11'))).summary;
  assert.equal(payDay.collected, 0);
  assert.equal(payDay.cashReceived, 5000);
  assert.equal(payDay.paidInAdvance, 5000);
  assert.ok((await ok(api(STAFF, 'GET', '/jobs/active?department=detailing'))).some(j => j.id === job.id), 'still on the board until done');

  // Once paid, the amount is locked (it is already in a drawer count).
  const locked = await api(STAFF, 'PATCH', `/jobs/${job.id}`, { discount: 100 });
  assert.equal(locked.status, 400);
  assert.match(locked.data.error, /paid/i);
  await ok(api(STAFF, 'PATCH', `/jobs/${job.id}`, { remarks: 'second coat tomorrow', detailer: 'Menan' }));

  assert.equal((await api(STAFF, 'POST', `/jobs/${job.id}/complete`, { date: '2026-10-09' })).status, 400, 'cannot finish before opening');
  const done = await ok(api(STAFF, 'POST', `/jobs/${job.id}/complete`, { date: '2026-10-12' }));
  assert.deepEqual([done.closed_on, done.sale_date], ['2026-10-12', '2026-10-12']);
  assert.ok(!(await ok(api(STAFF, 'GET', '/jobs/active?department=detailing'))).some(j => j.id === job.id), 'off the board');
  assert.ok((await ok(api(STAFF, 'GET', '/jobs/completed?department=detailing&date=2026-10-12'))).some(j => j.id === job.id));

  const doneDay = (await ok(api(STAFF, 'GET', '/days/2026-10-12'))).summary;
  assert.deepEqual(doneDay.departments.detailing, { jobs: 1, collected: 5000, receivables: 0, commission: 1000, net: 4000 });
  assert.equal(doneDay.cashReceived, 0);
  assert.equal(doneDay.paidEarlier, 5000);

  // Reopen puts it back on the board and removes the sale; unpay clears the payment.
  const reopened = await ok(api(STAFF, 'POST', `/jobs/${job.id}/reopen`));
  assert.deepEqual([reopened.closed_on, reopened.sale_date], [null, null]);
  assert.equal((await ok(api(STAFF, 'GET', '/days/2026-10-12'))).summary.departments.detailing.collected, 0);
  const unpaid = await ok(api(STAFF, 'POST', `/jobs/${job.id}/unpay`));
  assert.deepEqual([unpaid.paid_on, unpaid.payment_received], [null, false]);
  await ok(api(STAFF, 'PATCH', `/jobs/${job.id}`, { discount: 500 }));

  // Done first, paid later: counts on the payment day.
  await ok(api(STAFF, 'POST', `/jobs/${job.id}/complete`, { date: '2026-10-12' }));
  const later = await ok(api(STAFF, 'POST', `/jobs/${job.id}/pay`, { date: '2026-10-14', payment_method: 'GCash' }));
  assert.equal(later.sale_date, '2026-10-14');
  const s14 = (await ok(api(OWNER, 'GET', '/days/2026-10-14'))).summary;
  assert.equal(s14.departments.detailing.collected, 4500);
  assert.equal(s14.gcashReceived, 4500);

  const report = await ok(api(OWNER, 'GET', '/reports/range?start=2026-10-10&end=2026-10-14'));
  assert.deepEqual(report.days.find(d => d.date === '2026-10-14').departments, { carwash: 0, detailing: 4500, tint_ppf: 0, parts: 0 });
  assert.equal(report.totals.departments.detailing, 4500);
});

test('running jobs respect closed days and roles', async () => {
  const paint = await catalogItem('Paint Correction');
  const job = await ok(api(STAFF, 'POST', '/jobs', { job_date: '2026-10-15', department: 'detailing', vehicle_class: 'S', items: [{ catalog_item_id: paint.id }] }));
  await ok(api(STAFF, 'POST', '/days/2026-10-16/close'));
  assert.equal((await api(STAFF, 'POST', `/jobs/${job.id}/complete`, { date: '2026-10-16' })).status, 403);
  assert.equal((await api(STAFF, 'POST', `/jobs/${job.id}/pay`, { date: '2026-10-16', payment_method: 'Cash' })).status, 403);
  await ok(api(STAFF, 'POST', `/jobs/${job.id}/complete`, { date: '2026-10-17' }));
  await ok(api(STAFF, 'POST', `/jobs/${job.id}/pay`, { date: '2026-10-17', payment_method: 'Cash' }));
  await ok(api(STAFF, 'POST', '/days/2026-10-17/close'));
  assert.equal((await api(STAFF, 'POST', `/jobs/${job.id}/reopen`)).status, 403, 'its sale day is closed');
  assert.equal((await api(STAFF, 'POST', `/jobs/${job.id}/unpay`)).status, 403);
  await ok(api(OWNER, 'POST', `/jobs/${job.id}/reopen`));

  // Carwash jobs cannot use running-job actions.
  const premium = await catalogItem('Premium Wash');
  const wash = await ok(api(STAFF, 'POST', '/jobs', { job_date: '2026-10-15', vehicle_class: 'S', items: [{ catalog_item_id: premium.id }] }));
  assert.equal((await api(STAFF, 'POST', `/jobs/${wash.id}/complete`, { date: '2026-10-15' })).status, 400);
  assert.equal((await api(STAFF, 'POST', `/jobs/${wash.id}/pay`, { date: '2026-10-15', payment_method: 'Cash' })).status, 400);
});

test('tint & PPF jobs have their own JO series and board', async () => {
  const { items } = await ok(api(OWNER, 'GET', '/catalog'));
  const tint = items.find(i => i.name === 'Full Tint 3M');
  const job = await ok(api(STAFF, 'POST', '/jobs', { job_date: '2026-10-10', department: 'tint_ppf', vehicle_class: 'S', items: [{ catalog_item_id: tint.id }] }));
  assert.equal(job.jo_number, 'TP-101026-001');
  assert.ok((await ok(api(STAFF, 'GET', '/jobs/active?department=tint_ppf'))).some(j => j.id === job.id));
  assert.equal((await api(STAFF, 'POST', '/jobs', { job_date: '2026-10-10', department: 'bakery', vehicle_class: 'S', items: [{ name: 'x', price: 1 }] })).status, 400);
  assert.equal((await api(STAFF, 'GET', '/jobs/active?department=carwash')).status, 400, 'carwash has no running board');
});

test('finance: funds, set-asides at EOD, bills with drawer top-up, and the month in/out summary', async () => {
  const funds = await ok(api(STAFF, 'GET', '/funds?date=2026-11-02'));
  assert.deepEqual(funds.map(f => f.name), ['Meralco', 'Maynilad', 'Internet', 'Rent', 'Business permit']);
  const meralco = funds.find(f => f.name === 'Meralco');
  assert.equal((await api(STAFF, 'PATCH', `/funds/${meralco.id}`, { amount: 8000 })).status, 403);
  await ok(api(OWNER, 'PATCH', `/funds/${meralco.id}`, { amount: 8000, due_day: 25 }));

  // Supervisor sets money aside at EOD: it leaves the drawer that day.
  const sa = await ok(api(STAFF, 'POST', `/funds/${meralco.id}/set-asides`, { date: '2026-11-02', side: 'cash', amount: 1500 }));
  const day2 = (await ok(api(STAFF, 'GET', '/days/2026-11-02'))).summary;
  assert.equal(day2.setAsideCash, 1500);
  assert.equal(day2.expectedCash, -1500);
  let status = (await ok(api(STAFF, 'GET', '/funds?date=2026-11-02'))).find(f => f.id === meralco.id);
  assert.equal(status.balance, 1500);
  assert.equal(status.setAsideThisWeek, 1500);
  assert.equal(status.nextDue, '2026-11-25');
  assert.equal(status.weeklyTarget, Math.ceil(8000 / 4));

  await ok(api(STAFF, 'POST', `/funds/${meralco.id}/set-asides`, { date: '2026-11-09', side: 'gcash', amount: 4500 }));
  const extra = await ok(api(STAFF, 'POST', `/funds/${meralco.id}/set-asides`, { date: '2026-11-09', side: 'cash', amount: 1 }));
  await ok(api(STAFF, 'DELETE', `/fund-set-asides/${extra.id}`));
  await ok(api(STAFF, 'POST', '/days/2026-11-03/close'));
  assert.equal((await api(STAFF, 'POST', `/funds/${meralco.id}/set-asides`, { date: '2026-11-03', side: 'cash', amount: 100 })).status, 403);
  assert.ok(sa.id);

  // The bill: 8000 due, 6000 in the fund, so 2000 comes from that day's drawer.
  assert.equal((await api(STAFF, 'POST', `/funds/${meralco.id}/bills`, { date: '2026-11-25', amount: 8000, drawer_side: 'cash' })).status, 403);
  assert.equal((await api(OWNER, 'POST', `/funds/${meralco.id}/bills`, { date: '2026-11-25', amount: 8000 })).status, 400, 'shortfall needs a drawer side');
  const bill = await ok(api(OWNER, 'POST', `/funds/${meralco.id}/bills`, { date: '2026-11-25', amount: 8000, drawer_side: 'cash', note: 'Oct bill' }));
  assert.deepEqual([bill.from_fund, bill.from_drawer, bill.drawer_side], [6000, 2000, 'cash']);
  assert.equal((await ok(api(STAFF, 'GET', '/days/2026-11-25'))).summary.billTopUpCash, 2000);
  status = (await ok(api(STAFF, 'GET', '/funds?date=2026-11-26'))).find(f => f.id === meralco.id);
  assert.equal(status.balance, 0);
  assert.equal(status.nextDue, '2026-12-25');

  // Some trading in November.
  const premium = await catalogItem('Premium Wash');
  await ok(api(STAFF, 'POST', '/jobs', { job_date: '2026-11-10', vehicle_class: 'S', payment_received: true, items: [{ catalog_item_id: premium.id }] }));
  await ok(api(STAFF, 'POST', '/days/2026-11-10/expenses', { side: 'cash', description: 'Soap', amount: 150 }));
  const worker = await ok(api(OWNER, 'POST', '/employees', { name: 'Finance Tester', rate_per_day: 500, construction_rate: 0 }));
  await ok(api(OWNER, 'PUT', `/payroll/attendance/${worker.id}/2026-11-10`, { code: 'P' }));
  await ok(api(OWNER, 'PUT', `/payroll/attendance/${worker.id}/2026-11-11`, { code: 'P' }));
  await ok(api(OWNER, 'POST', '/payroll/payouts', { payout_date: '2026-11-15', period_start: '2026-11-09', period_end: '2026-11-15', side: 'cash', amount: 1000 }));

  assert.equal((await api(STAFF, 'GET', '/finance/summary?start=2026-11-01&end=2026-11-30')).status, 403);
  const f = await ok(api(OWNER, 'GET', '/finance/summary?start=2026-11-01&end=2026-11-30'));
  assert.deepEqual(f.income, {
    departments: { carwash: 600, detailing: 0, tint_ppf: 0, parts: 0 }, gross: 600, commission: 100, net: 500,
    partsSales: 0, partsCost: 0, receivables: 0,
  });
  assert.equal(f.opex.payroll, 1000);
  assert.deepEqual(f.opex.bills, [{ fund_id: meralco.id, name: 'Meralco', amount: 8000 }]);
  assert.equal(f.opex.drawerExpenses, 150);
  assert.equal(f.opex.total, 1000 + 8000 + 150);
  assert.equal(f.netProfit, 500 - 9150);
  assert.deepEqual(f.cashflow, {
    cashIn: 600, gcashIn: 0, commissionPaid: 100, drawerExpenses: 150, payrollPayouts: 1000,
    setAsides: 6000, billTopUps: 2000, net: 600 - 100 - 150 - 1000 - 6000 - 2000,
  });
  const fundRow = f.funds.find(x => x.id === meralco.id);
  assert.deepEqual([fundRow.setAside, fundRow.paid, fundRow.balance], [6000, 8000, 0]);
});

test('parts: inventory, average cost, selling on jobs and over the counter, stock never negative', async () => {
  // Owner sets up a part; staff can see it but not change it.
  assert.equal((await api(STAFF, 'POST', '/parts', { name: 'Nope', price: 1 })).status, 403);
  const part = await ok(api(OWNER, 'POST', '/parts', { sku: 'WB-18', name: 'Wiper blade 18in', unit: 'pc', price: 450, commission: 20, reorder_level: 3 }));
  assert.deepEqual([part.stock, part.avg_cost, part.low], [0, 0, true]);
  assert.equal((await api(OWNER, 'POST', '/parts', { sku: 'wb-18', name: 'Another', price: 1 })).status, 409, 'SKU must be unique');

  // Deliveries update the weighted average cost.
  assert.equal((await api(STAFF, 'POST', `/parts/${part.id}/receive`, { date: '2026-12-01', quantity: 10, unit_cost: 200 })).status, 403);
  await ok(api(OWNER, 'POST', `/parts/${part.id}/receive`, { date: '2026-12-01', quantity: 10, unit_cost: 200, supplier: 'Bosch PH' }));
  const received = await ok(api(OWNER, 'POST', `/parts/${part.id}/receive`, { date: '2026-12-02', quantity: 10, unit_cost: 260 }));
  assert.deepEqual([received.stock, received.avg_cost, received.low], [20, 230, false]);

  // Sold on a carwash job: price x quantity, commission per unit, cost frozen at the average.
  const premium = await catalogItem('Premium Wash');
  const job = await ok(api(OWNER, 'POST', '/jobs', {
    job_date: '2026-12-03', vehicle_class: 'S', payment_received: true,
    items: [{ catalog_item_id: premium.id }, { part_id: part.id, quantity: 2 }],
  }));
  const partLine = job.items.find(i => i.kind === 'part');
  assert.deepEqual([partLine.name, partLine.quantity, partLine.price, partLine.commission, partLine.unit_cost], ['Wiper blade 18in', 2, 900, 40, 230]);
  assert.deepEqual(job.totals, { subtotal: 1500, discount: 0, total: 1500, commission: 140, net: 1360, cost: 460 });
  assert.equal((await ok(api(STAFF, 'GET', '/parts'))).find(p => p.id === part.id).stock, 18);

  // Selling more than in stock is blocked; nothing changes.
  const tooMany = await api(STAFF, 'POST', '/jobs', { job_date: '2026-12-03', vehicle_class: 'S', items: [{ part_id: part.id, quantity: 19 }] });
  assert.equal(tooMany.status, 400);
  assert.match(tooMany.data.error, /Only 18 .*in stock/);
  assert.equal((await ok(api(STAFF, 'GET', '/parts'))).find(p => p.id === part.id).stock, 18);

  // Removing the part from the job returns it to stock; voiding returns it; restoring takes it again.
  await ok(api(STAFF, 'PATCH', `/jobs/${job.id}`, { items: [{ id: job.items.find(i => i.kind === 'service').id }] }));
  assert.equal((await ok(api(STAFF, 'GET', '/parts'))).find(p => p.id === part.id).stock, 20);
  const counter = await ok(api(STAFF, 'POST', '/jobs', {
    job_date: '2026-12-03', department: 'parts', payment_received: true, payment_method: 'GCash', items: [{ part_id: part.id, quantity: 3 }],
  }));
  assert.equal(counter.jo_number, 'PC-120326-001');
  assert.equal(counter.vehicle_class, null, 'counter sales need no vehicle');
  assert.equal((await ok(api(STAFF, 'GET', '/parts'))).find(p => p.id === part.id).stock, 17);
  await ok(api(OWNER, 'POST', `/jobs/${counter.id}/void`, { reason: 'Customer returned it' }));
  assert.equal((await ok(api(STAFF, 'GET', '/parts'))).find(p => p.id === part.id).stock, 20);
  await ok(api(OWNER, 'POST', `/jobs/${counter.id}/restore`));
  assert.equal((await ok(api(STAFF, 'GET', '/parts'))).find(p => p.id === part.id).stock, 17);
  assert.equal((await api(STAFF, 'POST', '/jobs', { job_date: '2026-12-03', department: 'parts', items: [{ catalog_item_id: premium.id }] })).status, 400,
    'services are not sold at the parts counter');

  // Owner stock count adjustment, with a reason; cannot go below zero.
  assert.equal((await api(OWNER, 'POST', `/parts/${part.id}/adjust`, { date: '2026-12-04', quantity: -1 })).status, 400, 'reason required');
  assert.equal((await api(OWNER, 'POST', `/parts/${part.id}/adjust`, { date: '2026-12-04', quantity: -100, note: 'count' })).status, 400);
  const adjusted = await ok(api(OWNER, 'POST', `/parts/${part.id}/adjust`, { date: '2026-12-04', quantity: -1, note: 'Damaged' }));
  assert.equal(adjusted.stock, 16);
  const moves = await ok(api(OWNER, 'GET', `/parts/${part.id}/movements`));
  assert.deepEqual(moves.map(m => [m.kind, m.quantity]).slice(-3), [['return', 3], ['sale', -3], ['adjust', -1]]);

  // EOD shows the parts counter as its own department; Finance subtracts the cost of parts sold.
  const eod = (await ok(api(OWNER, 'GET', '/days/2026-12-03'))).summary;
  assert.equal(eod.departments.parts.collected, 1350);
  assert.equal(eod.gcashReceived, 1350);
  const f = await ok(api(OWNER, 'GET', '/finance/summary?start=2026-12-01&end=2026-12-31'));
  assert.equal(f.income.partsSales, 1350);
  assert.equal(f.income.partsCost, 690);
  assert.equal(f.netProfit, f.income.net - f.income.partsCost - f.opex.total);

  // Costs and margins are owner-only, also in the API (not just hidden on screen).
  const staffPart = (await ok(api(STAFF, 'GET', '/parts'))).find(p => p.id === part.id);
  assert.equal('avg_cost' in staffPart, false);
  assert.equal((await ok(api(OWNER, 'GET', '/parts'))).find(p => p.id === part.id).avg_cost, 230);
  const staffSale = (await ok(api(STAFF, 'GET', '/jobs?date=2026-12-03&department=parts')))[0];
  assert.equal('cost' in staffSale.totals, false);
  assert.ok(staffSale.items.every(i => !('unit_cost' in i)));
  const staffNew = await ok(api(STAFF, 'POST', '/jobs', { job_date: '2026-12-05', department: 'parts', items: [{ part_id: part.id, quantity: 1 }] }));
  assert.equal('cost' in staffNew.totals, false);
  const staffDay = (await ok(api(STAFF, 'GET', '/days/2026-12-03'))).summary;
  assert.equal('partsCost' in staffDay, false);
  assert.equal((await ok(api(OWNER, 'GET', '/jobs?date=2026-12-03&department=parts')))[0].totals.cost, 690);
});
