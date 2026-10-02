const test = require('node:test');
const assert = require('node:assert/strict');
const { newDriver, closeAllDrivers, loadLegacyData, quiet, legacy } = require('./helpers');
const { migrate, status } = require('../scripts/db');

const one = async (driver, sql, params) => (await driver.query(sql, params)).rows[0];
const all = async (driver, sql, params) => (await driver.query(sql, params)).rows;

test.afterEach(closeAllDrivers);

test('002 converts legacy data without losing anything', async () => {
  const driver = await newDriver();
  await migrate(driver, { ...quiet, to: '001' });
  await loadLegacyData(driver);

  // Edge cases the old app could produce.
  const custom = await one(driver, "select id from services where is_custom = 1");
  await driver.query(`insert into jobs (id, jo_number, job_date, vehicle_class, service_id, addon_id, addon_price_override,
      custom_addon_name, custom_price, custom_comm, payment_method, payment_received)
    values (100, 'JO-091426-019', '2026-09-14', 'm', $1, 1, 999, 'Undercoat', 500, 50, 'gcash', 0),
           (101, null, '2026-09-15', '', null, null, null, null, 0, 0, null, 1)`, [custom.id]);

  await migrate(driver, { ...quiet, to: '002' });
  assert.deepEqual((await status(driver)).map(m => m.state).slice(0, 2), ['applied', 'applied']);

  // Legacy copies are complete.
  assert.equal((await one(driver, 'select count(*)::int n from legacy_v1_jobs')).n, legacy.jobs.length + 2);
  assert.equal((await one(driver, 'select count(*)::int n from legacy_v1_services')).n, legacy.services.length);

  // Catalog: every non-CUSTOM service and every add-on, priced for every class.
  const items = await all(driver, 'select kind, count(*)::int n from catalog_items group by kind order by kind');
  assert.deepEqual(items, [
    { kind: 'addon', n: legacy.addons.length },
    { kind: 'service', n: legacy.services.filter(s => !s.is_custom).length },
  ]);
  const premium = await one(driver, `select p.price, p.commission from catalog_prices p join catalog_items i on i.id = p.item_id
    where i.name = 'Premium Wash' and p.vehicle_class = 'L'`);
  assert.deepEqual(premium, { price: 700, commission: 100 });

  // Each legacy job keeps its exact total and commission as frozen line items.
  const svc = Object.fromEntries(legacy.services.map(s => [s.id, s]));
  const add = Object.fromEntries(legacy.addons.map(a => [a.id, a]));
  for (const job of legacy.jobs) {
    const expectedPrice = (svc[job.service_id]?.[`price_${job.vehicle_class}`] || 0)
      + (job.addon_price_override ?? add[job.addon_id]?.[`price_${job.vehicle_class}`] ?? 0) + (job.custom_price || 0);
    const expectedComm = (svc[job.service_id]?.[`comm_${job.vehicle_class}`] || 0)
      + (add[job.addon_id]?.[`comm_${job.vehicle_class}`] || 0) + (job.custom_comm || 0);
    const got = await one(driver, 'select coalesce(sum(price),0) price, coalesce(sum(commission),0) comm from job_items where job_id = $1', [job.id]);
    assert.deepEqual(got, { price: expectedPrice, comm: expectedComm }, `job ${job.id}`);
  }

  // Edge-case job: override price kept, CUSTOM service became a custom line, class/payment normalised,
  // duplicate JO renumbered to the next free number for that date.
  const edge = await one(driver, 'select jo_number, vehicle_class, payment_method, payment_received from jobs where id = 100');
  assert.deepEqual(edge, { jo_number: 'JO-091426-020', vehicle_class: 'M', payment_method: 'GCash', payment_received: false });
  const lines = await all(driver, 'select kind, name, price, commission from job_items where job_id = 100 order by sort_order');
  assert.deepEqual(lines, [
    { kind: 'addon', name: 'Asphalt Removal', price: 999, commission: 100 },
    { kind: 'custom', name: 'Undercoat', price: 500, commission: 50 },
  ]);
  const blank = await one(driver, 'select vehicle_class, payment_method, job_date from jobs where id = 101');
  assert.deepEqual(blank, { vehicle_class: null, payment_method: 'Cash', job_date: '2026-09-15' });

  // Payroll: weeks snapped to Monday, attendance is JSON, rates frozen from the employee.
  const payroll = await all(driver, `select p.period_start, jsonb_typeof(p.attendance) t, p.rate_per_day = e.rate_per_day same
    from payroll_entries p join employees e on e.id = p.employee_id`);
  assert.ok(payroll.every(p => p.t === 'object' && p.same));
  assert.ok(payroll.some(p => p.period_start === '2026-09-07'), 'Sunday 2026-09-13 snaps to Monday 2026-09-07');

  // The wide pricing tables are gone.
  assert.equal((await one(driver, "select to_regclass('public.services') r")).r, null);
});

test('002 merges two weekly sheets of one employee that fall in the same week (found in production)', async () => {
  const driver = await newDriver();
  await migrate(driver, { ...quiet, to: '001' });
  await loadLegacyData(driver);
  // Menan (id 2): a Monday sheet and a Wednesday sheet for the same week, overlapping on the 22nd/23rd.
  await driver.query(`insert into payroll_entries (id, employee_id, period_label, attendance, ot_hours, cw_ot_hours, cn_ot_hours, deductions, notes)
    values (90, 2, '2026-09-21', '{"2026-09-21":"P","2026-09-22":"","2026-09-23":"CN"}', 1, 0, 0, 50, ''),
           (91, 2, '2026-09-23', '{"2026-09-22":"P","2026-09-23":"0.5CN","2026-09-24":""}', 0, 2, 1, 30, 'Late Tue')`);

  await migrate(driver, quiet);

  const days = await all(driver, `select work_date, code, cw_ot_hours, cn_ot_hours from attendance
    where employee_id = 2 and work_date between '2026-09-21' and '2026-09-27' order by work_date`);
  assert.deepEqual(days, [
    { work_date: '2026-09-21', code: 'P', cw_ot_hours: 3, cn_ot_hours: 1 },
    { work_date: '2026-09-22', code: 'P', cw_ot_hours: 0, cn_ot_hours: 0 },
    { work_date: '2026-09-23', code: '0.5CN', cw_ot_hours: 0, cn_ot_hours: 0 },
  ], 'non-empty codes kept; on a conflict the later sheet wins; overtime added up');
  const deductions = await all(driver, `select adj_date, amount, note from payroll_adjustments where employee_id = 2`);
  assert.deepEqual(deductions, [{ adj_date: '2026-09-21', amount: 80, note: 'Late Tue' }]);
  assert.equal((await one(driver, 'select count(*)::int n from legacy_v1_payroll_entries where employee_id = 2')).n,
    legacy.payroll_entries.filter(p => p.employee_id === 2).length + 2, 'originals kept untouched');
});

test('audit log records the actor and constraints reject bad data', async () => {
  const driver = await newDriver();
  await migrate(driver, quiet);
  await driver.transaction(async c => {
    await c.query("select set_config('app.actor', 'owner@test.ph', true)");
    await c.query("insert into jobs (jo_number, job_date, vehicle_class) values ('JO-010126-001', '2026-01-01', 'S')");
  });
  const log = await one(driver, "select actor, action, table_name from audit_log where table_name = 'jobs'");
  assert.deepEqual(log, { actor: 'owner@test.ph', action: 'INSERT', table_name: 'jobs' });
  const job = await one(driver, 'select created_by from jobs');
  assert.equal(job.created_by, 'owner@test.ph');

  await assert.rejects(driver.query("insert into jobs (jo_number, job_date) values ('JO-010126-001', '2026-01-01')"), /unique/i);
  await assert.rejects(driver.query("insert into jobs (job_date, payment_method) values ('2026-01-01', 'Bitcoin')"), /check/i);
  await assert.rejects(driver.query("insert into jobs (job_date, vehicle_class) values ('2026-01-01', 'TANK')"), /foreign key/i);
  await assert.rejects(driver.query("insert into expenses (expense_date, side, amount) values ('2026-01-01', 'cash', -5)"), /check/i);
});

test('status is read-only: it never creates anything', async () => {
  const driver = await newDriver();
  const states = (await status(driver)).map(m => m.state);
  assert.ok(states.length >= 6 && states.every(s => s === 'pending'));
  assert.equal((await one(driver, "select to_regclass('public.schema_migrations') r")).r, null);
});

test('migrate is idempotent', async () => {
  const driver = await newDriver();
  assert.deepEqual(await migrate(driver, quiet), ['001', '002', '003', '004', '005', '006']);
  assert.deepEqual(await migrate(driver, quiet), []);
});

test('003 adds departments and running jobs without changing any historical total', async () => {
  const driver = await newDriver();
  await migrate(driver, { ...quiet, to: '001' });
  await loadLegacyData(driver);
  // Legacy detailing jobs (service 6 = Paint Correction): one paid, one not yet paid.
  await driver.query(`insert into jobs (id, jo_number, job_date, vehicle_class, service_id, payment_method, payment_received)
    values (102, 'JO-091526-001', '2026-09-15', 'M', 6, 'Cash', 1), (103, 'JO-091526-002', '2026-09-15', 'S', 6, 'GCash', 0)`);
  await migrate(driver, { ...quiet, to: '002' });
  const before = await all(driver, `select j.id, coalesce(sum(i.price), 0) total from jobs j left join job_items i on i.job_id = j.id
    group by j.id order by j.id`);

  await migrate(driver, { ...quiet, to: '003' });
  assert.deepEqual((await status(driver)).map(m => m.state).slice(0, 3), ['applied', 'applied', 'applied']);

  const dept = async name => (await one(driver, 'select department from catalog_items where name = $1', [name])).department;
  assert.equal(await dept('Premium Wash'), 'carwash');
  assert.equal(await dept('Wash and Wax: Soft99 Fusso Coat'), 'carwash');
  assert.equal(await dept('Engine Wash'), 'carwash');
  assert.equal(await dept('Paint Correction'), 'detailing');
  assert.equal(await dept('Soft99 H9 Dual Layer Glass Coat'), 'detailing');
  assert.equal(await dept('Ceramic Coating: Motorcycle'), 'detailing');
  assert.equal(await dept('Headlight Restoration'), 'detailing');

  // All dry-run wash jobs stay carwash and still count on their own date.
  const carwash = await one(driver, `select count(*)::int n, count(*) filter (where sale_date = job_date)::int same
    from jobs where department = 'carwash'`);
  assert.equal(carwash.n, legacy.jobs.length);
  assert.equal(carwash.same, carwash.n);

  // Legacy detailing jobs become running jobs already finished on their date.
  const paid = await one(driver, 'select department, closed_on, paid_on, sale_date from jobs where id = 102');
  assert.deepEqual(paid, { department: 'detailing', closed_on: '2026-09-15', paid_on: '2026-09-15', sale_date: '2026-09-15' });
  const unpaid = await one(driver, 'select department, closed_on, paid_on, sale_date from jobs where id = 103');
  assert.deepEqual(unpaid, { department: 'detailing', closed_on: '2026-09-15', paid_on: null, sale_date: null },
    'done but unpaid: waits on the board for payment');

  const after = await all(driver, `select j.id, coalesce(sum(i.price), 0) total from jobs j left join job_items i on i.job_id = j.id
    group by j.id order by j.id`);
  assert.deepEqual(after, before, 'no job total changed');

  // Rules enforced by the database.
  await assert.rejects(driver.query("insert into jobs (job_date, department, closed_on) values ('2026-10-01', 'carwash', '2026-10-01')"), /check/i);
  await assert.rejects(driver.query("insert into jobs (job_date, department, payment_received) values ('2026-10-01', 'detailing', true)"), /check/i);
  await assert.rejects(driver.query("insert into jobs (job_date, department, closed_on) values ('2026-10-05', 'detailing', '2026-10-01')"), /check/i);
  await assert.rejects(driver.query("insert into jobs (job_date, department) values ('2026-10-05', 'bakery')"), /check/i);
  const running = await one(driver, `insert into jobs (job_date, department, closed_on, paid_on, payment_received)
    values ('2026-10-01', 'tint_ppf', '2026-10-03', '2026-10-02', true) returning sale_date`);
  assert.equal(running.sale_date, '2026-10-03');
});

test('004 turns weekly payroll sheets into daily records and rate history', async () => {
  const driver = await newDriver();
  await migrate(driver, { ...quiet, to: '001' });
  await loadLegacyData(driver);
  await migrate(driver, { ...quiet, to: '003' });
  // Ernesto (id 3, rate now 300): a week paid at an older rate of 280, with OT and a cash advance.
  await driver.query(`insert into payroll_entries (employee_id, period_start, attendance, cw_ot_hours, cn_ot_hours, deductions, notes,
      rate_per_day, construction_rate)
    values (3, '2026-09-21', '{"2026-09-21":"P","2026-09-22":"CN","2026-09-23":""}', 2, 0, 150, 'CA', 280, 700)`);

  await migrate(driver, quiet);

  const attendance = await all(driver, 'select employee_id, work_date, code, cw_ot_hours, cn_ot_hours from attendance order by employee_id, work_date');
  assert.deepEqual(attendance, [
    { employee_id: 1, work_date: '2026-09-12', code: 'P', cw_ot_hours: 0, cn_ot_hours: 0 },
    { employee_id: 3, work_date: '2026-09-21', code: 'P', cw_ot_hours: 2, cn_ot_hours: 0 },
    { employee_id: 3, work_date: '2026-09-22', code: 'CN', cw_ot_hours: 0, cn_ot_hours: 0 },
  ]);
  const adjustments = await all(driver, 'select employee_id, adj_date, kind, amount, note from payroll_adjustments');
  assert.deepEqual(adjustments, [{ employee_id: 3, adj_date: '2026-09-21', kind: 'deduction', amount: 150, note: 'CA' }]);

  const ratesFor = id => all(driver, 'select effective_from, rate_per_day, construction_rate from employee_rates where employee_id = $1 order by effective_from', [id]);
  assert.deepEqual(await ratesFor(3), [
    { effective_from: '2000-01-01', rate_per_day: 280, construction_rate: 700 },
    { effective_from: '2026-09-28', rate_per_day: 300, construction_rate: 700 },
  ], 'old week keeps 280; current 300 applies from the week after');
  assert.deepEqual(await ratesFor(1), [{ effective_from: '2000-01-01', rate_per_day: 700, construction_rate: 0 }]);
  assert.deepEqual(await ratesFor(4), [{ effective_from: '2000-01-01', rate_per_day: 250, construction_rate: 700 }]);

  assert.equal((await one(driver, "select count(*)::int n from information_schema.columns where table_name = 'employees' and column_name = 'rate_per_day'")).n, 0,
    'rates live only in employee_rates');
  assert.equal((await one(driver, 'select count(*)::int n from legacy_v2_payroll_entries')).n, legacy.payroll_entries.length + 1);
  assert.equal((await one(driver, "select to_regclass('public.payroll_entries') r")).r, null);

  await assert.rejects(driver.query("insert into attendance (employee_id, work_date, code) values (1, '2026-10-01', 'X')"), /check/i);
  await assert.rejects(driver.query("insert into payroll_adjustments (employee_id, adj_date, kind, amount, note) values (1, '2026-10-01', 'deduction', -5, 'x')"), /check/i);
  await assert.rejects(driver.query("insert into payroll_payouts (payout_date, period_start, period_end, side, amount) values ('2026-10-04', '2026-10-05', '2026-09-28', 'cash', 100)"), /check/i);
});

test('005 adds bill funds, set-asides and bill payments', async () => {
  const driver = await newDriver();
  await migrate(driver, quiet);
  const funds = await all(driver, 'select name, frequency, due_month, amount from funds order by sort_order');
  assert.deepEqual(funds.map(f => [f.name, f.frequency]), [
    ['Meralco', 'monthly'], ['Maynilad', 'monthly'], ['Internet', 'monthly'], ['Rent', 'monthly'], ['Business permit', 'yearly'],
  ]);
  assert.ok(funds.every(f => f.amount === 0), 'amounts are left for the owner to fill in');
  const meralco = (await one(driver, "select id from funds where name = 'Meralco'")).id;

  await assert.rejects(driver.query("insert into funds (name, frequency, due_day) values ('Permit 2', 'yearly', 20)"), /check/i);
  await assert.rejects(driver.query("insert into fund_set_asides (fund_id, entry_date, side, amount) values ($1, '2026-10-01', 'cash', 0)", [meralco]), /check/i);
  await assert.rejects(driver.query(`insert into bill_payments (fund_id, paid_on, amount, from_fund, from_drawer, drawer_side)
    values ($1, '2026-10-25', 8000, 6000, 1000, 'cash')`, [meralco]), /check/i, 'parts must add up to the bill');
  await assert.rejects(driver.query(`insert into bill_payments (fund_id, paid_on, amount, from_fund, from_drawer, drawer_side)
    values ($1, '2026-10-25', 8000, 6000, 2000, null)`, [meralco]), /check/i, 'a drawer top-up needs a side');
  await driver.query(`insert into bill_payments (fund_id, paid_on, amount, from_fund, from_drawer, drawer_side)
    values ($1, '2026-10-25', 8000, 8000, 0, null)`, [meralco]);
});

test('006 adds parts inventory, part line items and the parts counter department', async () => {
  const driver = await newDriver();
  await migrate(driver, { ...quiet, to: '001' });
  await loadLegacyData(driver);
  await migrate(driver, { ...quiet, to: '005' });
  const before = await all(driver, 'select id, sale_date from jobs order by id');
  await migrate(driver, quiet);
  assert.deepEqual(await all(driver, 'select id, sale_date from jobs order by id'), before, 'sale dates unchanged');
  assert.equal((await one(driver, 'select count(*)::int n from job_items where quantity <> 1')).n, 0, 'existing lines are quantity 1');

  const part = await one(driver, "insert into parts (sku, name, price, avg_cost, stock) values ('WB-18', 'Wiper blade 18in', 450, 300, 5) returning id");
  await assert.rejects(driver.query("insert into parts (name) values ('wiper blade 18in')"), /unique/i);
  await assert.rejects(driver.query('update parts set stock = -1 where id = $1', [part.id]), /check/i, 'stock can never go below zero');
  await assert.rejects(driver.query("insert into stock_movements (part_id, moved_on, kind, quantity) values ($1, '2026-12-01', 'sale', 2)", [part.id]), /check/i);

  const counter = await one(driver, "insert into jobs (job_date, department, jo_number) values ('2026-12-01', 'parts', 'PC-120126-001') returning id, sale_date");
  assert.equal(counter.sale_date, '2026-12-01', 'counter sales count on their date like carwash');
  await assert.rejects(driver.query("insert into jobs (job_date, department, closed_on) values ('2026-12-01', 'parts', '2026-12-01')"), /check/i);
  await driver.query(`insert into job_items (job_id, kind, part_id, name, quantity, price, commission, unit_cost)
    values ($1, 'part', $2, 'Wiper blade 18in', 2, 900, 0, 300)`, [counter.id, part.id]);
  await assert.rejects(driver.query("insert into job_items (job_id, kind, name, price) values ($1, 'part', 'No part id', 1)", [counter.id]), /check/i);
  await assert.rejects(driver.query("insert into job_items (job_id, kind, name, price, quantity) values ($1, 'custom', 'x', 1, 0)", [counter.id]), /check/i);
});
