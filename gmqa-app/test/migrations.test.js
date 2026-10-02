const test = require('node:test');
const assert = require('node:assert/strict');
const { newDriver, loadLegacyData, quiet, legacy } = require('./helpers');
const { migrate, status } = require('../scripts/db');

const one = async (driver, sql, params) => (await driver.query(sql, params)).rows[0];
const all = async (driver, sql, params) => (await driver.query(sql, params)).rows;

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

test('migrate is idempotent', async () => {
  const driver = await newDriver();
  assert.deepEqual(await migrate(driver, quiet), ['001', '002', '003']);
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

  await migrate(driver, quiet);
  assert.deepEqual((await status(driver)).map(m => m.state), ['applied', 'applied', 'applied']);

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
