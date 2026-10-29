const test = require('node:test');
const assert = require('node:assert/strict');
const { migratedDb, closeAllDrivers } = require('./helpers');
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
test.after(async () => {
  server.close();
  await closeAllDrivers();
});

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
  assert.match(stranger.data.error, /does not have access to GM Operations Console/);
  assert.doesNotMatch(stranger.data.error, /\bQA\b/);

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
  // The rate history comes with each row, so the Edit form can compare against the rate on any day.
  assert.deepEqual(after.rates.map(r => [r.effective_from, r.rate_per_day, r.construction_rate]),
    [['2000-01-01', 400, 800], ['2026-09-17', 1000, 800]]);

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

// Text of a PDF as lines (items grouped by height on the page, left to right), one array per page.
async function pdfLines(buffer) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buffer), useSystemFonts: false }).promise;
  const pages = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const items = (await (await doc.getPage(p)).getTextContent()).items.filter(i => i.str.trim());
    const rows = [];
    for (const item of items) {
      const y = item.transform[5];
      const row = rows.find(r => Math.abs(r.y - y) <= 2) || rows[rows.push({ y, items: [] }) - 1];
      row.items.push(item);
    }
    pages.push(rows.sort((a, b) => b.y - a.y).map(r => r.items.sort((a, b) => a.transform[4] - b.transform[4]).map(i => i.str.trim()).join(' | ')));
  }
  await doc.destroy();
  return pages;
}
async function download(as, path) {
  const res = await fetch(base + path, { headers: as ? { Authorization: `Bearer ${as}` } : {} });
  return { res, body: Buffer.from(await res.arrayBuffer()) };
}

test('payroll sign-off sheet: a PDF of the range with every day, totals and signature boxes', async () => {
  // A week shaped like the owner's Sep 27 - Oct 4 sheet: Sunday to Sunday, 8 days.
  const add = body => ok(api(OWNER, 'POST', '/employees', body));
  const menan = await add({ name: 'Signoff Menan', role: '', rate_per_day: 560, construction_rate: 1200 });
  const rene = await add({ name: 'Signoff Rene', role: 'Construction', rate_per_day: 250, construction_rate: 850 });
  const joy = await add({ name: 'Signoff Joy', role: '', rate_per_day: 200, construction_rate: 0 });
  await add({ name: 'Signoff Idle', role: '', rate_per_day: 300, construction_rate: 0 }); // nothing to pay: not listed
  const mark = (emp, date, body) => ok(api(OWNER, 'PUT', `/payroll/attendance/${emp.id}/${date}`, body));
  // (Before 2026-10-05, so overtime is ×1.25 as on the owner's sheet.)
  await mark(menan, '2026-08-16', { code: 'OFF' });
  await mark(menan, '2026-08-17', { code: 'CN', cn_ot_hours: 15 });
  for (const d of ['2026-08-18', '2026-08-19', '2026-08-20', '2026-08-21', '2026-08-22']) await mark(menan, d, { code: 'CN' });
  await mark(rene, '2026-08-16', { code: 'CN' });
  const reneOt = { '2026-08-17': 2, '2026-08-18': 2, '2026-08-19': 5, '2026-08-20': 4, '2026-08-21': 4, '2026-08-22': 2 };
  for (const [d, h] of Object.entries(reneOt)) await mark(rene, d, { code: 'CN', cn_ot_hours: h });
  for (const d of ['2026-08-17', '2026-08-18', '2026-08-19', '2026-08-20', '2026-08-21']) await mark(joy, d, { code: 'P' });
  await ok(api(OWNER, 'POST', '/payroll/adjustments', { employee_id: menan.id, date: '2026-08-17', kind: 'deduction', amount: 2000, note: 'Cash advance' }));
  await ok(api(OWNER, 'POST', '/payroll/adjustments', { employee_id: joy.id, date: '2026-08-17', kind: 'deduction', amount: 500, note: 'Cash advance' }));

  const range = 'start=2026-08-16&end=2026-08-23';
  assert.equal((await download(STAFF, `/payroll/signoff.pdf?${range}`)).res.status, 403, 'owner only, like payroll');
  assert.equal((await download(null, `/payroll/signoff.pdf?${range}`)).res.status, 401);
  assert.equal((await download(OWNER, '/payroll/signoff.pdf?start=2026-08-23&end=2026-08-16')).res.status, 400);
  assert.equal((await download(OWNER, '/payroll/signoff.pdf?start=2026-01-01&end=2026-04-01')).res.status, 400);
  // One pay period per sheet: up to 16 days (a week, 1st-15th, 16th-31st) so every day stays readable.
  assert.equal((await download(OWNER, '/payroll/signoff.pdf?start=2027-03-16&end=2027-03-31')).res.status, 200);
  const tooLong = await download(OWNER, '/payroll/signoff.pdf?start=2027-03-01&end=2027-03-17');
  assert.equal(tooLong.res.status, 400);
  assert.match(JSON.parse(tooLong.body).error, /at most 16 days/);

  const { res, body } = await download(OWNER, `/payroll/signoff.pdf?${range}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/pdf');
  assert.equal(res.headers.get('content-disposition'), 'attachment; filename="Payroll_Signoff_Aug16-Aug23_2026.pdf"');
  assert.equal(body.subarray(0, 5).toString(), '%PDF-');

  const pages = await pdfLines(body);
  assert.equal(pages.length, 1);
  const text = pages[0].join('\n');
  const line = re => pages[0].find(l => re.test(l)) || '';
  // Header, matching the screen's numbers.
  const screen = await ok(api(OWNER, 'GET', `/payroll?${range}`));
  assert.equal(screen.totalNet, 16985.94);
  assert.equal(screen.otRule, "OT pays the day's rate ÷ 8 × 1.25 per hour.");
  assert.match(text, /JDM Kulture Auto Salon — Payroll Sign-off Sheet/);
  assert.match(text, /Pay period: \| Aug 16 – Aug 23, 2026/);
  assert.match(text, /Total net pay: \| ₱16,985\.94/);
  assert.match(text, /Each employee signs to confirm they received the net pay shown\./);
  // One column per day, Sunday to Sunday, then the totals and the signature columns.
  assert.match(line(/^SUN/), /^SUN \| MON \| TUE \| WED \| THU \| FRI \| SAT \| SUN \| CW \| CN \| DATE$/);
  assert.match(line(/^# \| EMPLOYEE/), /^# \| EMPLOYEE \| 08-16 \| 08-17 \| 08-18 \| 08-19 \| 08-20 \| 08-21 \| 08-22 \| 08-23 \| days \| days \| OT \| OT PAY \(₱\) \| GROSS \(₱\) \| ADJUST\. \(₱\) \| NET PAY \(₱\) \| SIGNATURE \| RECEIVED$/);
  // Rows: everyone with pay, in the screen's order; nobody with nothing to pay.
  for (const name of ['Signoff Idle', 'JP']) assert.ok(!text.includes(name), `${name} has nothing to pay and is not listed`);
  assert.ok(text.indexOf('Signoff Menan') < text.indexOf('Signoff Rene') && text.indexOf('Signoff Rene') < text.indexOf('Signoff Joy'));
  // Menan: OFF Sunday, CN Mon-Sat with 15h OT on Monday, 2,000 cash advance.
  assert.match(line(/Signoff Menan/), /Signoff Menan/);
  assert.match(text, /₱560 \/ 1,200/);
  assert.match(text, /\| OFF \| CN \| CN \| CN \| CN \| CN \| CN \| 0 \| 6 \| 15h \| 2,812\.50 \| 10,012\.50 \| −2,000\.00 \| 8,012\.50/); // OT pay 1,200/8 × 1.25 × 15
  // Rene: construction, CN all seven working days, overtime shown under each day.
  assert.match(text, /Construction · ₱250 \/ 850/);
  assert.match(text, /CN \| CN \| CN \| CN \| CN \| CN \| CN \| 0 \| 7 \| 19h \| 2,523\.44 \| 8,473\.44 \| 8,473\.44/); // OT pay 850/8 × 1.25 × 19
  assert.match(text, /\+2h \| \+2h \| \+5h \| \+4h \| \+4h \| \+2h/);
  // Joy: five carwash days, 500 deducted.
  assert.match(text, /Signoff Joy \| P \| P \| P \| P \| P \| 5 \| 0 \| 0h \| 1,000\.00 \| −500\.00 \| 500\.00/);
  // Footer: total, legend, OT rule and the four sign-off boxes.
  assert.match(text, /TOTAL NET PAY \| ₱16,985\.94/);
  assert.match(text, /P = Carwash day · 0\.5P = Half carwash · CN = Construction · 0\.5CN = Half construction · A = Absent · OFF = Day off · \+h = overtime hours\./);
  assert.match(text, /OT pays the day's rate ÷ 8 × 1\.25 per hour\./);
  assert.match(text, /Prepared by \| \(Name & signature\) \| Checked by \| \(Name & signature\) \| Approved by \| \(Owner \/ Manager\) \| Released by \| \(Cash \/ GCash\)/);
  assert.equal((text.match(/Date: ______________/g) || []).length, 4);
});

test('overtime pays ×1 from 2026-10-04 on screen and on the sign-off sheet; earlier days keep ×1.25', async () => {
  const worker = await ok(api(OWNER, 'POST', '/employees', { name: 'OT Rule Worker', role: '', rate_per_day: 400, construction_rate: 800 }));
  const mark = (date, body) => ok(api(OWNER, 'PUT', `/payroll/attendance/${worker.id}/${date}`, body));
  await mark('2027-05-03', { code: 'CN', cn_ot_hours: 2 }); // after the change: 800 + 800/8 × 1 × 2 = 1,000
  const after = await ok(api(OWNER, 'GET', '/payroll?start=2027-05-02&end=2027-05-09'));
  assert.equal(after.rows.find(r => r.employee.id === worker.id).pay.gross, 1000);
  assert.equal(after.otRule, 'OT pays the carwash rate ÷ 11 (construction rate ÷ 8) × 1 per hour.');
  const pdf = (await pdfLines((await download(OWNER, '/payroll/signoff.pdf?start=2027-05-02&end=2027-05-09')).body))[0].join('\n');
  assert.match(pdf, /OT Rule Worker/);
  assert.match(pdf, /2h \| 200\.00 \| 1,000\.00 \| 1,000\.00/); // OT pay 800/8 × 1 × 2
  assert.match(pdf, /OT pays the carwash rate ÷ 11 \(construction rate ÷ 8\) × 1 per hour\./);

  // Carwash overtime after the change uses an 11-hour day: 400 + 400/11 × 2 = 472.73.
  await mark('2027-05-04', { code: 'P', cw_ot_hours: 2 });
  const cw = await ok(api(OWNER, 'GET', '/payroll?start=2027-05-04&end=2027-05-04'));
  assert.equal(cw.rows.find(r => r.employee.id === worker.id).pay.otPay, 72.73);
  assert.equal(cw.rows.find(r => r.employee.id === worker.id).pay.gross, 472.73);

  // A range across the change shows both rules; each day is paid by its own rule.
  await mark('2026-10-03', { code: 'CN', cn_ot_hours: 2 }); // before: 800 + 800/8 × 1.25 × 2 = 1,050
  await mark('2026-10-04', { code: 'CN', cn_ot_hours: 2 }); // Sun Oct 4, ×1: 800 + 200 = 1,000
  await mark('2026-10-05', { code: 'CN', cn_ot_hours: 2 }); // after: 800 + 200 = 1,000
  const across = await ok(api(OWNER, 'GET', '/payroll?start=2026-10-03&end=2026-10-05'));
  assert.equal(across.rows.find(r => r.employee.id === worker.id).pay.gross, 3050);
  assert.equal(across.otRule, "OT pays the day's rate ÷ 8 × 1.25 per hour up to Oct 3, 2026; the day's rate ÷ 8 × 1 on Oct 4, 2026; and the carwash rate ÷ 11 (construction rate ÷ 8) × 1 from Oct 5, 2026.");
});

test('the owner sets the shop overtime rule from a date; earlier days keep theirs', async () => {
  const worker = await ok(api(OWNER, 'POST', '/employees', { name: 'Shop Rule Worker', role: '', rate_per_day: 1000, construction_rate: 800 }));
  await ok(api(OWNER, 'PUT', `/payroll/attendance/${worker.id}/2028-01-01`, { code: 'P', cw_ot_hours: 2 })); // Sat, before the change
  await ok(api(OWNER, 'PUT', `/payroll/attendance/${worker.id}/2028-01-02`, { code: 'P', cw_ot_hours: 2 })); // Sun, from the change
  const payOf = async range => (await ok(api(OWNER, 'GET', `/payroll?${range}`)));

  const before = await payOf('start=2028-01-01&end=2028-01-02');
  assert.deepEqual(before.otRules.map(r => r.effective_from), ['2000-01-01', '2026-10-04', '2026-10-05'], 'the screen gets the rules to edit');
  assert.equal(before.rows.find(r => r.employee.id === worker.id).pay.otPay, 363.64); // 1000 / 11 × 2, twice

  const rule = { multiplier: 1.25, carwash_hours: 10, construction_hours: 8 };
  assert.equal((await api(STAFF, 'PUT', '/payroll/ot-rules/2028-01-02', rule)).status, 403, 'owner only');
  for (const bad of [{ ...rule, multiplier: 0 }, { ...rule, multiplier: 4 }, { ...rule, carwash_hours: 0 }, { ...rule, construction_hours: 30 }, { ...rule, carwash_hours: '' }]) {
    assert.equal((await api(OWNER, 'PUT', '/payroll/ot-rules/2028-01-02', bad)).status, 400, JSON.stringify(bad));
  }
  assert.equal((await api(OWNER, 'PUT', '/payroll/ot-rules/not-a-date', rule)).status, 400);
  await ok(api(OWNER, 'PUT', '/payroll/ot-rules/2028-01-02', rule));

  const after = await payOf('start=2028-01-01&end=2028-01-02');
  assert.equal(after.rows.find(r => r.employee.id === worker.id).pay.otPay, 181.82 + 250); // Sat: 1000/11 × 2 · Sun: 1000/10 × 1.25 × 2
  assert.equal(after.otRule, 'OT pays the carwash rate ÷ 11 (construction rate ÷ 8) × 1 per hour up to Jan 1, 2028, and the carwash rate ÷ 10 (construction rate ÷ 8) × 1.25 from Jan 2, 2028.');
  // Saving the same date again changes that rule instead of adding another.
  await ok(api(OWNER, 'PUT', '/payroll/ot-rules/2028-01-02', { ...rule, multiplier: 1.5 }));
  assert.equal((await payOf('start=2028-01-02&end=2028-01-02')).rows.find(r => r.employee.id === worker.id).pay.otPay, 300);

  // The first rule covers every earlier day, so it cannot be deleted; a later one can.
  assert.equal((await api(OWNER, 'DELETE', '/payroll/ot-rules/2000-01-01')).status, 400);
  assert.equal((await api(STAFF, 'DELETE', '/payroll/ot-rules/2028-01-02')).status, 403);
  await ok(api(OWNER, 'DELETE', '/payroll/ot-rules/2028-01-02'));
  assert.equal((await api(OWNER, 'DELETE', '/payroll/ot-rules/2028-01-02')).status, 404);
  assert.equal((await payOf('start=2028-01-01&end=2028-01-02')).rows.find(r => r.employee.id === worker.id).pay.otPay, 363.64);
});

test('an employee can have their own normal hours and OT multiplier from a date (the GM works 8 hours, the crew 11)', async () => {
  const gm = await ok(api(OWNER, 'POST', '/employees', { name: 'Own Hours GM', role: 'General manager', rate_per_day: 1100, construction_rate: 0 }));
  assert.equal(gm.carwash_hours, null, 'new employees follow the shop rule');
  assert.equal(gm.ot_multiplier, null);
  for (const d of ['2028-02-06', '2028-02-13']) await ok(api(OWNER, 'PUT', `/payroll/attendance/${gm.id}/${d}`, { code: 'P', cw_ot_hours: 2 }));
  const otOn = async d => (await ok(api(OWNER, 'GET', `/payroll?start=${d}&end=${d}`))).rows.find(r => r.employee.id === gm.id).pay.otPay;
  assert.equal(await otOn('2028-02-06'), 200); // shop rule: 1100 / 11 × 1 × 2

  for (const bad of [{ carwash_hours: 0 }, { carwash_hours: 25 }, { ot_multiplier: 0.5 }, { ot_multiplier: 4 }]) {
    assert.equal((await api(OWNER, 'PATCH', `/employees/${gm.id}`, { ...bad, effective_from: '2028-02-13' })).status, 400, JSON.stringify(bad));
  }
  const saved = await ok(api(OWNER, 'PATCH', `/employees/${gm.id}`, { carwash_hours: 8, ot_multiplier: 1.25, effective_from: '2028-02-13' }));
  assert.equal(saved.rate_per_day, 1100, 'the rate stays as it was');
  assert.equal(await otOn('2028-02-06'), 200, 'days before the change keep the shop rule');
  assert.equal(await otOn('2028-02-13'), 343.75); // own: 1100 / 8 × 1.25 × 2
  const screen = await ok(api(OWNER, 'GET', '/payroll?start=2028-02-13&end=2028-02-13'));
  assert.deepEqual(screen.rows.find(r => r.employee.id === gm.id).rates.at(-1),
    { effective_from: '2028-02-13', rate_per_day: 1100, construction_rate: 0, carwash_hours: 8, ot_multiplier: 1.25 });

  // A later raise keeps their own hours and multiplier.
  await ok(api(OWNER, 'PATCH', `/employees/${gm.id}`, { rate_per_day: 1200, effective_from: '2028-02-20' }));
  await ok(api(OWNER, 'PUT', `/payroll/attendance/${gm.id}/2028-02-20`, { code: 'P', cw_ot_hours: 2 }));
  assert.equal(await otOn('2028-02-20'), 375); // 1200 / 8 × 1.25 × 2
  // Clearing them (blank) goes back to the shop rule from that date.
  await ok(api(OWNER, 'PATCH', `/employees/${gm.id}`, { carwash_hours: '', ot_multiplier: '', effective_from: '2028-02-20' }));
  assert.equal(await otOn('2028-02-20'), 218.18); // 1200 / 11 × 1 × 2
  assert.equal(await otOn('2028-02-13'), 343.75, 'the week before keeps its own rule');
});

test('an OT change is previewed first: per-hour example, whose pay changes, and weeks already paid out', async () => {
  const crew = await ok(api(OWNER, 'POST', '/employees', { name: 'Preview Crew', role: '', rate_per_day: 1100, construction_rate: 800 }));
  const other = await ok(api(OWNER, 'POST', '/employees', { name: 'Preview Other', role: '', rate_per_day: 500, construction_rate: 0 }));
  await ok(api(OWNER, 'PUT', `/payroll/attendance/${crew.id}/2028-03-05`, { code: 'P', cw_ot_hours: 2 }));
  await ok(api(OWNER, 'PUT', `/payroll/attendance/${crew.id}/2028-03-13`, { code: 'P', cw_ot_hours: 1 }));
  await ok(api(OWNER, 'PUT', `/payroll/attendance/${other.id}/2028-03-06`, { code: 'P' })); // no OT: pay does not change

  const rule = { kind: 'ot-rule', effective_from: '2028-03-05', carwash_hours: 8, construction_hours: 8, multiplier: 1.25 };
  assert.equal((await api(STAFF, 'POST', '/payroll/preview', rule)).status, 403);
  assert.equal((await api(OWNER, 'POST', '/payroll/preview', { ...rule, multiplier: 9 })).status, 400);
  assert.equal((await api(OWNER, 'POST', '/payroll/preview', { kind: 'nope' })).status, 400);
  const p = await ok(api(OWNER, 'POST', '/payroll/preview', rule));
  assert.equal(p.from, '2028-03-05');
  const mine = p.changes.find(c => c.employee_id === crew.id);
  assert.deepEqual(mine, { employee_id: crew.id, name: 'Preview Crew', otHours: 3,
    before: { otPay: 300, gross: 2500 }, after: { otPay: 515.63, gross: 2715.63 } }); // 1100/11 × 3 → 1100/8 × 1.25 × 3
  assert.ok(!p.changes.some(c => c.employee_id === other.id), 'nobody whose pay stays the same');
  assert.deepEqual(p.paidOut, []);
  assert.ok(p.example.rate > 0 && p.example.hours === 8 && p.example.multiplier === 1.25, 'an example employee on the shop rule');
  assert.equal(p.example.perHour, Math.round(p.example.rate / 8 * 1.25 * 100) / 100);

  // Wages for Mar 5-11 are already paid: the preview says so, and saving needs a second confirm.
  const payout = await ok(api(OWNER, 'POST', '/payroll/payouts', { payout_date: '2028-03-11', period_start: '2028-03-05', period_end: '2028-03-11', side: 'cash', amount: 1000 }));
  const paid = await ok(api(OWNER, 'POST', '/payroll/preview', rule));
  assert.deepEqual(paid.paidOut, [{ payout_date: '2028-03-11', period_start: '2028-03-05', period_end: '2028-03-11' }]);
  const { kind, effective_from, ...body } = rule;
  const refused = await api(OWNER, 'PUT', '/payroll/ot-rules/2028-03-05', body);
  assert.equal(refused.status, 409);
  assert.match(refused.data.error, /already paid out.*Mar 5.*Mar 11, 2028/);
  await ok(api(OWNER, 'PUT', '/payroll/ot-rules/2028-03-05', { ...body, confirm_paid: true }));
  // Starting after the paid week touches nothing paid: no confirm needed.
  await ok(api(OWNER, 'PUT', '/payroll/ot-rules/2028-03-12', body));
  assert.equal((await api(OWNER, 'DELETE', '/payroll/ot-rules/2028-03-05')).status, 409, 'undoing it changes the paid week too');
  await ok(api(OWNER, 'DELETE', '/payroll/ot-rules/2028-03-05?confirm_paid=1'));
  await ok(api(OWNER, 'DELETE', '/payroll/ot-rules/2028-03-12'));

  // One employee's own work day: only their pay, with their own per-hour figure.
  const own = { kind: 'employee', employee_id: crew.id, effective_from: '2028-03-05', carwash_hours: 8, ot_multiplier: '' };
  const e = await ok(api(OWNER, 'POST', '/payroll/preview', own));
  assert.deepEqual(e.changes.map(c => [c.name, c.before.otPay, c.after.otPay]), [['Preview Crew', 300, 412.5]]); // 1100/8 × 1 × 3
  assert.deepEqual(e.example, { name: 'Preview Crew', rate: 1100, hours: 8, multiplier: 1, perHour: 137.5 });
  assert.equal(e.paidOut.length, 1);
  assert.equal((await api(OWNER, 'PATCH', `/employees/${crew.id}`, { carwash_hours: 8, effective_from: '2028-03-05' })).status, 409);
  await ok(api(OWNER, 'PATCH', `/employees/${crew.id}`, { carwash_hours: 8, effective_from: '2028-03-05', confirm_paid: true }));
  // A change to someone with nothing in the paid week goes through without the confirm.
  await ok(api(OWNER, 'PATCH', `/employees/${other.id}`, { rate_per_day: 600, effective_from: '2028-03-12' }));
  await ok(api(OWNER, 'DELETE', `/payroll/payouts/${payout.id}`));
});

test('own hours and OT multiplier show next to the rate on the sign-off sheet', async () => {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(new Date());
  const gm = await ok(api(OWNER, 'POST', '/employees', { name: 'Sheet GM', role: 'GM', rate_per_day: 1100, construction_rate: 0 }));
  const saved = await ok(api(OWNER, 'PATCH', `/employees/${gm.id}`, { carwash_hours: 8, ot_multiplier: 1.25 })); // from today
  assert.equal(saved.carwash_hours, 8);
  assert.equal(saved.ot_multiplier, 1.25);
  await ok(api(OWNER, 'PUT', `/payroll/attendance/${gm.id}/${today}`, { code: 'P' }));
  const pdf = (await pdfLines((await download(OWNER, `/payroll/signoff.pdf?start=${today}&end=${today}`)).body)).flat().join('\n');
  assert.match(pdf, /GM · ₱1,100 \/ 0 · 8h day · OT \+25%/);
});

test('payroll sign-off sheet: long lists continue on more pages with the header repeated', async () => {
  const names = [];
  for (let i = 1; i <= 30; i++) {
    const e = await ok(api(OWNER, 'POST', '/employees', { name: `Crew ${String(i).padStart(2, '0')}`, role: '', rate_per_day: 100 + i, construction_rate: 0 }));
    await ok(api(OWNER, 'PUT', `/payroll/attendance/${e.id}/2027-04-13`, { code: 'P' }));
    names.push(e.name);
  }
  const { res, body } = await download(OWNER, '/payroll/signoff.pdf?start=2027-04-12&end=2027-04-18');
  assert.equal(res.status, 200);
  const pages = await pdfLines(body);
  assert.ok(pages.length >= 2, `30 employees need more than one page (got ${pages.length})`);
  for (const page of pages) assert.ok(page.some(l => /^# \| EMPLOYEE/.test(l)), 'every page has the column header');
  const all = pages.flat().join('\n');
  for (const name of names) assert.equal(all.split(name).length - 1, 1, `${name} listed exactly once`);
  const expected = names.reduce((t, _, i) => t + 100 + i + 1, 0); // one carwash day each at 101..130
  assert.match(pages.at(-1).join('\n'), new RegExp(`TOTAL NET PAY \\| ₱${expected.toLocaleString('en-PH')}\\.00`));
  assert.ok(pages.at(-1).some(l => /Prepared by/.test(l)), 'sign-off boxes on the last page');
  assert.ok(!pages[0].some(l => /Prepared by/.test(l)), 'not repeated on earlier pages');
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

test('price changes never rewrite past jobs or past reports', async () => {
  const standard = await catalogItem('Standard Wash');
  await ok(api(OWNER, 'PATCH', `/catalog/${standard.id}`, { prices: { S: { price: 250, commission: 0 } } }));
  const lastMonth = await ok(api(STAFF, 'POST', '/jobs', {
    job_date: '2026-08-12', vehicle_class: 'S', payment_received: true, items: [{ catalog_item_id: standard.id }],
  }));
  assert.equal(lastMonth.totals.total, 250);
  const before = (await ok(api(STAFF, 'GET', '/days/2026-08-12'))).summary;

  // This month the price goes up.
  await ok(api(OWNER, 'PATCH', `/catalog/${standard.id}`, { prices: { S: { price: 300, commission: 0 } } }));

  const thisMonth = await ok(api(STAFF, 'POST', '/jobs', {
    job_date: '2026-09-12', vehicle_class: 'S', items: [{ catalog_item_id: standard.id }],
  }));
  assert.equal(thisMonth.totals.total, 300, 'new jobs use the new price');
  const old = (await ok(api(STAFF, 'GET', '/jobs?date=2026-08-12'))).find(j => j.id === lastMonth.id);
  assert.equal(old.totals.total, 250, 'last month keeps the price it was charged');
  assert.deepEqual((await ok(api(STAFF, 'GET', '/days/2026-08-12'))).summary, before, 'last month\'s day totals are unchanged');
  const report = await ok(api(OWNER, 'GET', '/reports/range?start=2026-08-12&end=2026-08-12'));
  assert.equal(report.days[0].departments.carwash, before.collected);

  // Editing something else on the old job (not the class) keeps its frozen price.
  const edited = await ok(api(STAFF, 'PATCH', `/jobs/${lastMonth.id}`, { plate: 'old 001' }));
  assert.equal(edited.totals.total, 250);
});

test('add-ons are shared by every department; services stay in their own department', async () => {
  const engine = await catalogItem('Engine Wash');        // was a carwash add-on
  const headlight = await catalogItem('Headlight Restoration'); // was a detailing add-on
  const paint = await catalogItem('Paint Correction');
  const premium = await catalogItem('Premium Wash');

  const detailing = await ok(api(STAFF, 'POST', '/jobs', {
    job_date: '2026-10-11', department: 'detailing', vehicle_class: 'M',
    items: [{ catalog_item_id: paint.id }, { catalog_item_id: engine.id }],
  }));
  assert.deepEqual(detailing.items.map(i => i.name), ['Paint Correction', 'Engine Wash']);

  const carwash = await ok(api(STAFF, 'POST', '/jobs', {
    job_date: '2026-10-11', department: 'carwash', vehicle_class: 'M',
    items: [{ catalog_item_id: premium.id }, { catalog_item_id: headlight.id }],
  }));
  assert.deepEqual(carwash.items.map(i => i.name), ['Premium Wash', 'Headlight Restoration']);

  const tint = await ok(api(STAFF, 'POST', '/jobs', {
    job_date: '2026-10-11', department: 'tint_ppf', vehicle_class: 'M', items: [{ catalog_item_id: engine.id }],
  }));
  assert.equal(tint.items[0].name, 'Engine Wash');

  // A new add-on is offered everywhere too.
  const added = await ok(api(OWNER, 'POST', '/catalog', {
    kind: 'addon', department: 'tint_ppf', name: 'Tire Shine', prices: { M: { price: 150, commission: 20 } },
  }));
  const onCarwash = await ok(api(STAFF, 'POST', '/jobs', {
    job_date: '2026-10-11', vehicle_class: 'M', items: [{ catalog_item_id: premium.id }, { catalog_item_id: added.id }],
  }));
  assert.equal(onCarwash.items[1].price, 150);

  // Services are still department-only.
  const wrong = await api(STAFF, 'POST', '/jobs', {
    job_date: '2026-10-11', department: 'carwash', vehicle_class: 'M', items: [{ catalog_item_id: paint.id }],
  });
  assert.equal(wrong.status, 400);
  assert.match(wrong.data.error, /Detailing/);
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
  // "Since" lists every sale from that day on, including ones dated after it, so none can drop out of sight.
  assert.ok((await ok(api(STAFF, 'GET', '/jobs/completed?department=detailing&since=2026-10-06'))).some(j => j.id === job.id));
  assert.ok(!(await ok(api(STAFF, 'GET', '/jobs/completed?department=detailing&since=2026-10-13'))).some(j => j.id === job.id));

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

  // Every bill paid in the period is listed, so one recorded by mistake can be found and undone in full.
  assert.deepEqual(f.billPayments.map(b => [b.fund_id, b.name, b.paid_on, b.amount, b.from_fund, b.from_drawer, b.drawer_side, b.note]),
    [[meralco.id, 'Meralco', '2026-11-25', 8000, 6000, 2000, 'cash', 'Oct bill']]);
  const oops = await ok(api(OWNER, 'POST', `/funds/${meralco.id}/bills`, { date: '2026-11-26', amount: 500, drawer_side: 'gcash' }));
  assert.equal((await ok(api(STAFF, 'GET', '/days/2026-11-26'))).summary.billTopUpGcash, 500);
  assert.equal((await api(STAFF, 'DELETE', `/bill-payments/${oops.id}`)).status, 403);
  await ok(api(OWNER, 'DELETE', `/bill-payments/${oops.id}`));
  assert.equal((await api(OWNER, 'DELETE', `/bill-payments/${oops.id}`)).status, 404);
  assert.equal((await ok(api(STAFF, 'GET', '/days/2026-11-26'))).summary.billTopUpGcash, 0, 'drawer on that day is restored');
  const undone = await ok(api(OWNER, 'GET', '/finance/summary?start=2026-11-01&end=2026-11-30'));
  assert.deepEqual(undone.opex.bills, f.opex.bills);
  assert.deepEqual(undone.billPayments.map(b => b.id), [bill.id]);
  assert.equal(undone.netProfit, f.netProfit);
  assert.equal(undone.cashflow.billTopUps, 2000);
});

test('cash fund: abonos are costs that never touch the drawer; replenishment closes out an itemized list', async () => {
  const D = '2027-06-07';
  const empty = await ok(api(STAFF, 'GET', '/cash-fund'));
  assert.deepEqual([empty.target, empty.balance, empty.pending, empty.pendingTotal, empty.toReplenish], [0, 0, [], 0, 0]);

  // Nothing can be spent from an empty fund.
  const noMoney = await api(STAFF, 'POST', `/days/${D}/expenses`, { side: 'fund', description: 'Chemicals', amount: 100 });
  assert.equal(noMoney.status, 400);
  assert.match(noMoney.data.error, /cash fund/i);

  // Owner sets the fund size and records the money the boss handed over.
  assert.equal((await api(STAFF, 'PUT', '/cash-fund', { target: 50000 })).status, 403);
  await ok(api(OWNER, 'PUT', '/cash-fund', { target: 50000 }));
  assert.equal((await api(STAFF, 'POST', '/cash-fund/topups', { date: D, amount: 50000 })).status, 403);
  assert.equal((await api(OWNER, 'POST', '/cash-fund/topups', { date: D, amount: 0 })).status, 400);
  const start = await ok(api(OWNER, 'POST', '/cash-fund/topups', { date: D, amount: 50000, note: 'Starting fund' }));
  assert.deepEqual([start.amount, start.items.length], [50000, 0]);

  // Staff record abonos at EOD as "paid from the cash fund".
  await ok(api(STAFF, 'POST', `/days/${D}/expenses`, { side: 'fund', description: 'Chemicals: Soft99 5L', amount: 1500 }));
  await ok(api(STAFF, 'POST', `/days/${D}/expenses`, { side: 'cash', description: 'Ice', amount: 50 }));
  const day = await ok(api(STAFF, 'POST', '/days/2027-06-08/expenses', { side: 'fund', description: 'Crew lunch', amount: 300 }));
  assert.equal(day.summary.fundExpenses, 300);
  assert.equal(day.summary.cashExpenses, 0);
  assert.equal(day.summary.expectedCash, 0, 'the drawer is not touched by a cash-fund purchase');
  assert.equal(day.summary.expenses, 300, 'but it is still a cost of the day');
  const d1 = (await ok(api(STAFF, 'GET', `/days/${D}`))).summary;
  assert.deepEqual([d1.cashExpenses, d1.fundExpenses, d1.drawerExpenses, d1.expenses, d1.expectedCash], [50, 1500, 50, 1550, -50]);

  // More than the fund holds is refused.
  const tooMuch = await api(STAFF, 'POST', `/days/${D}/expenses`, { side: 'fund', description: 'Pressure washer', amount: 48201 });
  assert.equal(tooMuch.status, 400);
  assert.match(tooMuch.data.error, /48,200|48200/);

  let fund = await ok(api(STAFF, 'GET', '/cash-fund'));
  assert.deepEqual([fund.target, fund.balance, fund.pendingTotal, fund.toReplenish], [50000, 48200, 1800, 1800]);
  assert.deepEqual(fund.pending.map(e => [e.expense_date, e.description, e.amount]),
    [[D, 'Chemicals: Soft99 5L', 1500], ['2027-06-08', 'Crew lunch', 300]]);

  // Finance: the abonos are operating costs, but not money out of the drawer.
  const f = await ok(api(OWNER, 'GET', `/finance/summary?start=${D}&end=2027-06-13`));
  assert.deepEqual([f.opex.drawerExpenses, f.opex.fundExpenses, f.opex.total], [50, 1800, 1850]);
  assert.equal(f.cashflow.drawerExpenses, 50);
  assert.equal((await ok(api(OWNER, 'GET', `/reports/range?start=${D}&end=2027-06-08`))).totals.expenses, 1850);

  // The itemized list for the boss, before replenishing.
  const pendingPdf = await download(OWNER, '/cash-fund/sheet.pdf');
  assert.equal(pendingPdf.res.status, 200);
  assert.match(pendingPdf.res.headers.get('content-type'), /pdf/);
  const pendingText = (await pdfLines(pendingPdf.body)).flat().join('\n');
  for (const words of [/Cash fund/i, /Chemicals: Soft99 5L/, /1,500\.00/, /Crew lunch/, /1,800\.00/, /Received by/]) assert.match(pendingText, words);
  assert.equal((await download(STAFF, '/cash-fund/sheet.pdf')).res.status, 403);

  // The boss replenishes: every pending item is closed out by that replenishment.
  const top = await ok(api(OWNER, 'POST', '/cash-fund/topups', { date: '2027-06-13', amount: 1800, note: 'Week of Jun 7' }));
  assert.deepEqual(top.items.map(e => e.description), ['Chemicals: Soft99 5L', 'Crew lunch']);
  fund = await ok(api(STAFF, 'GET', '/cash-fund'));
  assert.deepEqual([fund.balance, fund.pendingTotal, fund.toReplenish, fund.pending.length], [50000, 0, 0, 0]);
  assert.deepEqual(fund.topups.map(t => [t.entry_date, t.amount, t.itemsTotal]), [['2027-06-13', 1800, 1800], [D, 50000, 0]]);
  const sheet = (await pdfLines((await download(OWNER, `/cash-fund/sheet.pdf?topup=${top.id}`)).body)).flat().join('\n');
  assert.match(sheet, /Crew lunch/);
  assert.match(sheet, /Week of Jun 7/);

  // A replenished purchase cannot be deleted until its replenishment is undone.
  const lunch = top.items.find(e => e.description === 'Crew lunch');
  const blocked = await api(OWNER, 'DELETE', `/expenses/${lunch.id}`);
  assert.equal(blocked.status, 400);
  assert.match(blocked.data.error, /replenish/i);
  assert.equal((await api(STAFF, 'DELETE', `/cash-fund/topups/${top.id}`)).status, 403);
  await ok(api(OWNER, 'DELETE', `/cash-fund/topups/${top.id}`));
  fund = await ok(api(STAFF, 'GET', '/cash-fund'));
  assert.deepEqual([fund.balance, fund.pendingTotal], [48200, 1800], 'undoing a replenishment puts its items back on the list');
  await ok(api(STAFF, 'DELETE', `/expenses/${lunch.id}`));
  assert.equal((await ok(api(STAFF, 'GET', '/cash-fund'))).balance, 48500);

  // Closed days stay locked for staff.
  await ok(api(STAFF, 'POST', `/days/${D}/close`));
  assert.equal((await api(STAFF, 'POST', `/days/${D}/expenses`, { side: 'fund', description: 'x', amount: 1 })).status, 403);
});

test('parts: inventory, average cost, selling on jobs and over the counter, stock never negative', async () => {
  // Owner sets up a part (an inventory item tagged Auto Parts); staff can see it but not change it.
  const autoParts = (await ok(api(STAFF, 'GET', '/tags'))).find(t => t.system_key === 'auto_parts');
  assert.equal((await api(STAFF, 'POST', '/inventory', { name: 'Nope', price: 1, tags: [autoParts.id] })).status, 403);
  const part = await ok(api(OWNER, 'POST', '/inventory', {
    sku: 'WB-18', name: 'Wiper blade 18in', unit: 'pc', price: 450, commission: 20, reorder_level: 3, tags: [autoParts.id],
  }));
  assert.deepEqual([part.stock, part.avg_cost, part.low, part.for_sale], [0, 0, true, true]);
  assert.equal((await api(OWNER, 'POST', '/inventory', { sku: 'wb-18', name: 'Another', price: 1 })).status, 409, 'SKU must be unique');

  // Deliveries update the weighted average cost.
  assert.equal((await api(STAFF, 'POST', `/inventory/${part.id}/receive`, { date: '2026-12-01', quantity: 10, unit_cost: 200, paid_from: 'none' })).status, 403);
  await ok(api(OWNER, 'POST', `/inventory/${part.id}/receive`, { date: '2026-12-01', quantity: 10, unit_cost: 200, supplier: 'Bosch PH', paid_from: 'none' }));
  const received = await ok(api(OWNER, 'POST', `/inventory/${part.id}/receive`, { date: '2026-12-02', quantity: 10, unit_cost: 260, paid_from: 'none' }));
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

  // Stock count, with a reason; can never go below zero.
  assert.equal((await api(OWNER, 'POST', `/inventory/${part.id}/count`, { date: '2026-12-04', counted: 16 })).status, 400, 'reason required');
  assert.equal((await api(OWNER, 'POST', `/inventory/${part.id}/count`, { date: '2026-12-04', counted: -1, reason: 'recount' })).status, 400);
  const adjusted = await ok(api(OWNER, 'POST', `/inventory/${part.id}/count`, { date: '2026-12-04', counted: 16, reason: 'damaged' }));
  assert.equal(adjusted.stock, 16);
  const moves = await ok(api(OWNER, 'GET', `/inventory/${part.id}/movements`));
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

test('inventory: tags decide what is sold, staff count usage, deliveries paid from the drawer or cash fund', async () => {
  const D = '2026-12-15';
  const tags = await ok(api(STAFF, 'GET', '/tags'));
  const autoParts = tags.find(t => t.system_key === 'auto_parts');
  const chem = tags.find(t => t.name === 'Carwash chemicals');

  // Tags: owner-only changes; the built-in Auto Parts tag can be renamed but never deleted.
  assert.equal((await api(STAFF, 'POST', '/tags', { name: 'Wax' })).status, 403);
  const wax = await ok(api(OWNER, 'POST', '/tags', { name: 'Wax & sealants', color: 'amber' }));
  assert.equal((await api(OWNER, 'POST', '/tags', { name: 'wax & SEALANTS' })).status, 409, 'tag names are unique');
  await ok(api(OWNER, 'PATCH', `/tags/${autoParts.id}`, { name: 'Car Parts' }));
  assert.equal((await api(OWNER, 'DELETE', `/tags/${autoParts.id}`)).status, 400);
  const spare = await ok(api(OWNER, 'POST', '/tags', { name: 'Spare tag' }));
  await ok(api(OWNER, 'DELETE', `/tags/${spare.id}`));

  // A supply needs no price and is never offered for sale; Auto Parts items need a selling price.
  const foam = await ok(api(OWNER, 'POST', '/inventory', { name: 'Snow foam', unit: 'gal', reorder_level: 1, tags: [chem.id, wax.id] }));
  assert.deepEqual([foam.for_sale, [...foam.tags].sort()], [false, [chem.id, wax.id].sort()]);
  assert.match((await api(OWNER, 'POST', '/inventory', { name: 'Horn', tags: [autoParts.id] })).data.error, /selling price/i);
  const horn = await ok(api(OWNER, 'POST', '/inventory', { name: 'Horn', price: 1200, tags: [autoParts.id] }));
  assert.equal(horn.for_sale, true);
  assert.equal((await api(OWNER, 'PATCH', `/inventory/${horn.id}`, { price: 0 })).status, 400, 'a part for sale keeps a price');
  assert.equal((await api(OWNER, 'PATCH', `/inventory/${foam.id}`, { tags: [999999] })).status, 400, 'unknown tag');
  assert.equal((await api(STAFF, 'PATCH', `/inventory/${foam.id}`, { reorder_level: 2 })).status, 403);

  // The parts list (Parts tab, job editor) holds only Auto Parts items; Inventory holds everything.
  const sellable = (await ok(api(STAFF, 'GET', '/parts'))).map(p => p.name);
  assert.ok(sellable.includes('Horn') && !sellable.includes('Snow foam'));
  const everything = await ok(api(STAFF, 'GET', '/inventory'));
  assert.ok(everything.some(p => p.name === 'Snow foam') && everything.some(p => p.name === 'Horn'));
  assert.ok(everything.every(p => !('avg_cost' in p)), 'staff never see costs');
  const notForSale = await api(STAFF, 'POST', '/jobs', { job_date: D, department: 'parts', items: [{ part_id: foam.id, quantity: 1 }] });
  assert.equal(notForSale.status, 400);
  assert.match(notForSale.data.error, /not for sale/i);

  // Deliveries: opening stock (no money), then paid from the drawer. A supply bought is a cost of that day;
  // a part bought for resale is stock (its cost counts when sold). Both leave the drawer.
  await ok(api(OWNER, 'POST', `/inventory/${foam.id}/receive`, { date: D, quantity: 4, unit_cost: 300, paid_from: 'none' }));
  assert.equal((await api(OWNER, 'POST', `/inventory/${foam.id}/receive`, { date: D, quantity: 1, unit_cost: 0, paid_from: 'cash' })).status, 400,
    'a paid delivery needs its cost');
  const foamPaid = await ok(api(OWNER, 'POST', `/inventory/${foam.id}/receive`, { date: D, quantity: 2, unit_cost: 350, supplier: 'Meguiars PH', paid_from: 'cash' }));
  assert.deepEqual([foamPaid.stock, foamPaid.avg_cost], [6, 316.67]);
  await ok(api(OWNER, 'POST', `/inventory/${horn.id}/receive`, { date: D, quantity: 3, unit_cost: 700, paid_from: 'gcash' }));
  let day = await ok(api(OWNER, 'GET', `/days/${D}`));
  assert.deepEqual(day.expenses.map(e => [e.side, e.amount, e.for_resale, e.from_stock]), [['cash', 700, false, true], ['gcash', 2100, true, true]]);
  assert.match(day.expenses[0].description, /2 gal Snow foam/);
  assert.deepEqual([day.summary.cashExpenses, day.summary.gcashExpenses], [700, 2100]);
  assert.match((await api(OWNER, 'DELETE', `/expenses/${day.expenses[0].id}`)).data.error, /Inventory/, 'undo it from Inventory, not EOD');
  let f = await ok(api(OWNER, 'GET', `/finance/summary?start=${D}&end=${D}`));
  assert.deepEqual([f.opex.drawerExpenses, f.opex.partsBought, f.cashflow.drawerExpenses], [700, 2100, 2800]);

  // Paid from the cash fund: refused beyond what the fund holds; otherwise it is on the fund's list.
  assert.match((await api(OWNER, 'POST', `/inventory/${horn.id}/receive`, { date: D, quantity: 1000, unit_cost: 1000, paid_from: 'fund' })).data.error, /cash fund/i);
  await ok(api(OWNER, 'POST', '/cash-fund/topups', { date: D, amount: 5000 }));
  await ok(api(OWNER, 'POST', `/inventory/${horn.id}/receive`, { date: D, quantity: 1, unit_cost: 700, paid_from: 'fund' }));
  assert.ok((await ok(api(OWNER, 'GET', '/cash-fund'))).pending.some(e => /Horn/.test(e.description) && e.amount === 700));
  f = await ok(api(OWNER, 'GET', `/finance/summary?start=${D}&end=${D}`));
  assert.deepEqual([f.opex.fundExpenses, f.opex.partsBought], [0, 2800], 'a part bought with the fund is stock, not a cost');

  // Undo: only an item's latest stock change; stock, average cost and the expense all go back.
  let moves = await ok(api(OWNER, 'GET', `/inventory/${foam.id}/movements`));
  assert.equal((await api(OWNER, 'POST', `/inventory/movements/${moves[0].id}/undo`)).status, 400, 'not the latest change');
  assert.equal((await api(STAFF, 'POST', `/inventory/movements/${moves.at(-1).id}/undo`)).status, 403);
  const undone = await ok(api(OWNER, 'POST', `/inventory/movements/${moves.at(-1).id}/undo`));
  assert.deepEqual([undone.stock, undone.avg_cost], [4, 300]);
  day = await ok(api(OWNER, 'GET', `/days/${D}`));
  assert.equal(day.expenses.some(e => /Snow foam/.test(e.description)), false, 'its expense is gone too');

  // Staff count what is left. Lower = used (or damaged/lost); a recount can go either way.
  assert.equal((await api(STAFF, 'POST', `/inventory/${foam.id}/count`, { date: D, counted: 5, reason: 'used' })).status, 400, 'cannot use more than you had');
  assert.equal((await api(STAFF, 'POST', `/inventory/${foam.id}/count`, { date: D, counted: 4, reason: 'used' })).status, 400, 'matches: nothing to record');
  assert.equal((await api(STAFF, 'POST', `/inventory/${foam.id}/count`, { date: D, counted: 3, reason: 'stolen' })).status, 400);
  assert.equal((await ok(api(STAFF, 'POST', `/inventory/${foam.id}/count`, { date: D, counted: 2.5, reason: 'used' }))).stock, 2.5);
  assert.equal((await ok(api(STAFF, 'POST', `/inventory/${foam.id}/count`, { date: D, counted: 3, reason: 'recount', note: 'Found one in the back' }))).stock, 3);
  moves = await ok(api(OWNER, 'GET', `/inventory/${foam.id}/movements`));
  assert.deepEqual(moves.slice(-2).map(m => [m.kind, m.quantity, m.note]), [['use', -1.5, 'Used'], ['adjust', 0.5, 'Recount: Found one in the back']]);
  assert.equal((await api(STAFF, 'GET', `/inventory/${foam.id}/movements`)).status, 403);

  // Import (paste from Excel): all rows or none, errors name the row; new tag names are created.
  assert.equal((await api(STAFF, 'POST', '/inventory/import', { date: D, rows: [{ name: 'x' }] })).status, 403);
  assert.match((await api(OWNER, 'POST', '/inventory/import', { date: D, rows: [{ name: 'Microfiber 40x40' }, { name: '' }] })).data.error, /Row 2/);
  assert.match((await api(OWNER, 'POST', '/inventory/import', { date: D, rows: [{ name: 'snow FOAM' }] })).data.error, /already/i);
  assert.equal((await ok(api(OWNER, 'GET', '/inventory'))).some(p => p.name === 'Microfiber 40x40'), false, 'nothing imported');
  const imported = await ok(api(OWNER, 'POST', '/inventory/import', { date: D, rows: [
    { sku: 'MF-4040', name: 'Microfiber 40x40', unit: 'pc', tags: ['Microfiber', 'Polishing pads'], stock: 24, unit_cost: 45, reorder_level: 10 },
    { name: 'Air freshener', price: 150, commission: 10, tags: ['car parts'], stock: 10, unit_cost: 60 },
  ] }));
  assert.equal(imported.created, 2);
  const list = await ok(api(OWNER, 'GET', '/inventory'));
  const mf = list.find(p => p.name === 'Microfiber 40x40');
  const pads = (await ok(api(OWNER, 'GET', '/tags'))).find(t => t.name === 'Polishing pads');
  assert.ok(pads, 'new tag created');
  assert.deepEqual([mf.stock, mf.avg_cost, mf.reorder_level, mf.for_sale, mf.tags.includes(pads.id)], [24, 45, 10, false, true]);
  assert.equal(list.find(p => p.name === 'Air freshener').for_sale, true);
  const opening = await ok(api(OWNER, 'GET', `/inventory/${mf.id}/movements`));
  assert.deepEqual(opening.map(m => [m.kind, m.quantity, m.unit_cost, m.note]), [['receive', 24, 45, 'Opening stock']]);
});

test('sets: stock is counted in pieces; a part sells per piece or as a set', async () => {
  const D = '2026-12-20';
  const autoParts = (await ok(api(OWNER, 'GET', '/tags'))).find(t => t.system_key === 'auto_parts');
  assert.match((await api(OWNER, 'POST', '/inventory', { name: 'Odd set', price: 10, set_size: 1, tags: [autoParts.id] })).data.error, /more than 1/);
  const bulb = await ok(api(OWNER, 'POST', '/inventory', {
    name: 'Lazertech 2in', unit: 'pc', price: 2000, commission: 50, set_size: 2, set_price: 3500, set_commission: 80, tags: [autoParts.id],
  }));
  assert.deepEqual([bulb.set_size, bulb.set_price, bulb.set_commission], [2, 3500, 80]);
  await ok(api(OWNER, 'POST', `/inventory/${bulb.id}/receive`, { date: D, quantity: 5, unit_cost: 1200, paid_from: 'none' }));
  const staffBulb = (await ok(api(STAFF, 'GET', '/parts'))).find(p => p.id === bulb.id);
  assert.deepEqual([staffBulb.set_size, staffBulb.set_price], [2, 3500], 'staff see set prices (not costs)');

  // One set (2 pieces at the set price) and one piece, from the same stock.
  const sale = await ok(api(STAFF, 'POST', '/jobs', {
    job_date: D, department: 'parts', payment_received: true,
    items: [{ part_id: bulb.id, quantity: 1, as_set: true }, { part_id: bulb.id, quantity: 1 }],
  }));
  const [setLine, pieceLine] = sale.items;
  assert.deepEqual([setLine.name, setLine.quantity, setLine.pack_size, setLine.price, setLine.commission],
    ['Lazertech 2in (set of 2)', 1, 2, 3500, 80]);
  assert.deepEqual([pieceLine.name, pieceLine.quantity, pieceLine.pack_size, pieceLine.price, pieceLine.commission],
    ['Lazertech 2in', 1, 1, 2000, 50]);
  assert.deepEqual([sale.totals.total, sale.totals.commission], [5500, 130]);
  const stockOf = async () => (await ok(api(STAFF, 'GET', '/inventory'))).find(p => p.id === bulb.id).stock;
  assert.equal(await stockOf(), 2, '5 pieces − a set of 2 − 1 piece');
  const owned = (await ok(api(OWNER, 'GET', `/jobs?date=${D}&department=parts`))).find(j => j.id === sale.id);
  assert.equal(owned.items[0].unit_cost, 2400, 'a set costs its pieces');
  assert.equal(owned.totals.cost, 3600);

  // Two more sets need 4 pieces; only 2 are left.
  const short = await api(STAFF, 'POST', '/jobs', { job_date: D, department: 'parts', items: [{ part_id: bulb.id, quantity: 2, as_set: true }] });
  assert.equal(short.status, 400);
  assert.match(short.data.error, /Only 2 pc/);

  // Removing the set puts its 2 pieces back; voiding and restoring move the rest.
  await ok(api(STAFF, 'PATCH', `/jobs/${sale.id}`, { items: [{ id: pieceLine.id }] }));
  assert.equal(await stockOf(), 4);
  const again = await ok(api(STAFF, 'POST', '/jobs', { job_date: D, department: 'parts', items: [{ part_id: bulb.id, quantity: 2, as_set: true }] }));
  assert.equal(await stockOf(), 0);
  await ok(api(OWNER, 'POST', `/jobs/${again.id}/void`, { reason: 'Wrong item' }));
  assert.equal(await stockOf(), 4);
  await ok(api(OWNER, 'POST', `/jobs/${again.id}/restore`));
  assert.equal(await stockOf(), 0);
  const moves = await ok(api(OWNER, 'GET', `/inventory/${bulb.id}/movements`));
  assert.deepEqual(moves.slice(-3).map(m => [m.kind, m.quantity]), [['sale', -4], ['return', 4], ['sale', -4]], 'stock moves in pieces');

  // A part with no set (or a set with no price) cannot be sold as one.
  const horn = await ok(api(OWNER, 'POST', '/inventory', { name: 'Plain horn', price: 500, tags: [autoParts.id] }));
  await ok(api(OWNER, 'POST', `/inventory/${horn.id}/receive`, { date: D, quantity: 3, unit_cost: 200, paid_from: 'none' }));
  assert.match((await api(STAFF, 'POST', '/jobs', { job_date: D, department: 'parts', items: [{ part_id: horn.id, quantity: 1, as_set: true }] })).data.error,
    /not sold as a set/);
  await ok(api(OWNER, 'PATCH', `/inventory/${horn.id}`, { set_size: 2 }));
  assert.match((await api(STAFF, 'POST', '/jobs', { job_date: D, department: 'parts', items: [{ part_id: horn.id, quantity: 1, as_set: true }] })).data.error,
    /not sold as a set/, 'a set needs its price too');
  const cleared = await ok(api(OWNER, 'PATCH', `/inventory/${bulb.id}`, { set_size: null, set_price: null }));
  assert.deepEqual([cleared.set_size, cleared.set_price], [null, null]);
});

test('GCash tips: closing a day with tips not given to the crew needs a decision, and what is left carries over', async () => {
  const premium = await catalogItem('Premium Wash');
  const day1 = '2027-02-01';
  const day2 = '2027-02-02';
  await ok(api(STAFF, 'POST', '/jobs', { job_date: day1, vehicle_class: 'S', payment_method: 'GCash', payment_received: true, tip_gcash: 50, items: [{ catalog_item_id: premium.id }] }));

  let s = (await ok(api(STAFF, 'GET', `/days/${day1}`))).summary;
  assert.deepEqual([s.tips, s.tipsGiven, s.tipsOwedBefore, s.tipsToGive], [50, 0, 0, 50]);
  assert.equal(s.expectedGcash, 600 + 50, 'a tip not given out yet is still in GCash');

  // Closing is refused until the tips are given out or the closer says they will be given later.
  const refused = await api(STAFF, 'POST', `/days/${day1}/close`);
  assert.equal(refused.status, 409);
  assert.match(refused.data.error, /₱50\.00.*tips/i);
  assert.equal((await ok(api(STAFF, 'GET', `/days/${day1}`))).meta.closed_at, null);

  // Part given out, the rest later: the day closes and ₱20 shows up on the next day.
  s = (await ok(api(STAFF, 'PUT', `/days/${day1}`, { gcash_tips_passed: 30 }))).summary;
  assert.deepEqual([s.tipsGiven, s.tipsToGive, s.expectedGcash], [30, 20, 600 + 20]);
  assert.equal((await api(STAFF, 'POST', `/days/${day1}/close`)).status, 409);
  assert.ok((await ok(api(STAFF, 'POST', `/days/${day1}/close`, { tips_later: true }))).meta.closed_at);

  s = (await ok(api(STAFF, 'GET', `/days/${day2}`))).summary;
  assert.deepEqual([s.tips, s.tipsOwedBefore, s.tipsToGive], [0, 20, 20]);
  assert.equal(s.expectedGcash, 0);
  assert.equal((await api(STAFF, 'PUT', `/days/${day2}`, { gcash_tips_passed: -5 })).status, 400);
  s = (await ok(api(STAFF, 'PUT', `/days/${day2}`, { gcash_tips_passed: 20 }))).summary;
  assert.deepEqual([s.tipsToGive, s.expectedGcash], [0, -20], 'tips from yesterday given out today leave today\'s GCash');
  assert.ok((await ok(api(STAFF, 'POST', `/days/${day2}/close`))).meta.closed_at, 'nothing owed: closes as before');
  assert.equal((await ok(api(STAFF, 'GET', '/days/2027-02-03'))).summary.tipsToGive, 0);
});

test('EOD gives the daily sales report for the group chat, for staff and owner', async () => {
  const day = '2027-02-15';
  await ok(api(STAFF, 'POST', '/jobs', { job_date: day, vehicle_class: 'S', payment_received: true, items: [{ name: 'Wash', price: 800, commission: 150 }] }));
  await ok(api(STAFF, 'POST', '/jobs', { job_date: day, vehicle_class: 'S', payment_method: 'GCash', payment_received: true, items: [{ name: 'Wash', price: 1200, commission: 0 }] }));
  await ok(api(STAFF, 'POST', '/jobs', { job_date: day, vehicle_class: 'S', items: [{ name: 'Wash', price: 300, commission: 0 }] }));
  await ok(api(STAFF, 'POST', `/days/${day}/expenses`, { side: 'cash', description: 'Soap', amount: 100 }));
  for (const who of [STAFF, OWNER]) {
    const { report } = await ok(api(who, 'GET', `/days/${day}`));
    assert.equal(report.text, 'February 15, 2027\nTotal of cars - 3\nTotal sales - 2,000\nLess comms - 150\nLess expenses - 100\nTotal net = 1,750\n\nCash - 550\nGcash - 1200');
  }
});
