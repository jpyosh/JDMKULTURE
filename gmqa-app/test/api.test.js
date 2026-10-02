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
  // Legacy data already has JO-091426-001..019 on this date.
  assert.equal(job.jo_number, 'JO-091426-020');
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
  assert.equal(second.jo_number, 'JO-091426-021');
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
  assert.equal(next.jo_number, 'JO-100126-002');
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
  assert.equal(s.cashCollected, 600);
  assert.equal(s.digitalCollected, 500);
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
