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
  assert.equal((await api(STAFF, 'GET', '/payroll/2026-09-14')).status, 403);
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
  assert.deepEqual(r.days[0].departments, { carwash: 1100, detailing: 0, tint_ppf: 0 });
  assert.equal(r.totals.profit, 650);
  assert.equal((await api(OWNER, 'GET', '/reports/range?start=2026-10-05&end=2026-10-01')).status, 400);
});

test('payroll freezes rates per week', async () => {
  const emp = await ok(api(OWNER, 'POST', '/employees', { name: 'Tester', role: 'Detailer', rate_per_day: 400, construction_rate: 800 }));
  const week = await ok(api(OWNER, 'PUT', `/payroll/2026-09-16/${emp.id}`, {
    attendance: { '2026-09-14': 'P', '2026-09-15': '0.5P', '2026-09-16': 'CN', '2026-09-17': 'A' }, cw_ot_hours: 2, deductions: 100,
  }));
  assert.equal(week.weekStart, '2026-09-14', 'any day snaps to its Monday');
  const row = week.rows.find(r => r.employee.id === emp.id);
  // 1.5 days * 400 + 1 CN * 800 + 2h OT at 400/8*1.25 - 100
  assert.equal(row.pay.net, 600 + 800 + 125 - 100);

  await ok(api(OWNER, 'PATCH', `/employees/${emp.id}`, { rate_per_day: 1000 }));
  const again = await ok(api(OWNER, 'GET', '/payroll/2026-09-14'));
  assert.equal(again.rows.find(r => r.employee.id === emp.id).pay.net, 1425, 'old week keeps the old rate');
  const nextWeek = await ok(api(OWNER, 'GET', '/payroll/2026-09-21'));
  assert.equal(nextWeek.rows.find(r => r.employee.id === emp.id).entry.rate_per_day, 1000);

  assert.equal((await api(OWNER, 'PUT', `/payroll/2026-09-14/${emp.id}`, { attendance: { '2026-09-30': 'P' } })).status, 400);
  assert.equal((await api(OWNER, 'PUT', `/payroll/2026-09-14/${emp.id}`, { attendance: { '2026-09-14': 'X' } })).status, 400);
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
  assert.deepEqual(report.days.find(d => d.date === '2026-10-14').departments, { carwash: 0, detailing: 4500, tint_ppf: 0 });
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
