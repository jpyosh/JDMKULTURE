// Job orders for all departments. Jobs are made of line items whose price/commission is copied
// from the Pricing Matrix when the line is added and never changes afterwards (unless the job's
// vehicle class is changed, which re-prices its catalog lines at the new class).
//
// Carwash jobs are same-day. Detailing and Tint & PPF jobs are "running": they stay on their
// department's board until marked done (complete) and paid (pay), and count on the later date.
const express = require('express');
const { requireOwner } = require('../lib/auth');
const { db } = require('../lib/db');
const { joPrefix, department, DEPARTMENT_KEYS, isRunning } = require('../lib/calc');
const { loadJobs, loadJob, assertDayOpen } = require('../lib/store');
const { loadPart, takeStock, returnStock } = require('../lib/inventory');
const { bad, notFound, money, text, date, oneOf, time, id, pick } = require('../lib/http');

const router = express.Router();
const PAYMENT_METHODS = ['Cash', 'GCash'];
const MAX_LINES = 30;
const JOB_FIELDS = ['vehicle_class', 'plate', 'payment_method', 'payment_received', 'discount', 'discount_reason',
  'tip_gcash', 'time_in', 'time_out', 'detailer', 'remarks'];
// On a paid running job these are locked: the money is already in a drawer count.
const AMOUNT_FIELDS = ['vehicle_class', 'discount', 'tip_gcash', 'payment_method'];

async function cleanJobFields(q, body) {
  const f = pick(body, JOB_FIELDS);
  const out = {};
  if ('vehicle_class' in f) {
    out.vehicle_class = f.vehicle_class || null;
    if (out.vehicle_class && !(await q.one('select 1 from vehicle_classes where code = $1 and active', [out.vehicle_class]))) {
      throw bad(`Unknown vehicle class ${out.vehicle_class}`);
    }
  }
  if ('plate' in f) out.plate = text(f.plate, 'Plate', { max: 20 })?.toUpperCase() ?? null;
  if ('payment_method' in f) out.payment_method = oneOf(f.payment_method, PAYMENT_METHODS, 'Payment method');
  if ('payment_received' in f) out.payment_received = Boolean(f.payment_received);
  if ('discount' in f) out.discount = money(f.discount, 'Discount');
  if ('discount_reason' in f) out.discount_reason = text(f.discount_reason, 'Discount reason', { max: 200 });
  if ('tip_gcash' in f) out.tip_gcash = money(f.tip_gcash, 'GCash tip');
  if ('time_in' in f) out.time_in = time(f.time_in, 'Time in');
  if ('time_out' in f) out.time_out = time(f.time_out, 'Time out');
  if ('detailer' in f) out.detailer = text(f.detailer, 'Detailer', { max: 80 });
  if ('remarks' in f) out.remarks = text(f.remarks, 'Remarks', { max: 500 });
  return out;
}

// inputs: [{ id }] keeps an existing frozen line, [{ catalog_item_id }] adds a priced catalog line,
// [{ name, price, commission }] adds a custom line. Order of the list = display order.
async function buildLines(q, inputs, vehicleClass, dept, existing = []) {
  if (!Array.isArray(inputs)) throw bad('items must be a list');
  if (inputs.length > MAX_LINES) throw bad(`A job can have at most ${MAX_LINES} line items`);
  const existingById = new Map(existing.map(line => [line.id, line]));
  const lines = [];
  for (const [index, input] of inputs.entries()) {
    if (input?.id != null) {
      const line = existingById.get(Number(input.id));
      if (!line) throw bad('Unknown line item');
      lines.push({ ...line, sort_order: index });
    } else if (input?.part_id != null) {
      const part = await loadPart(q, id(input.part_id, 'part'), { activeOnly: true });
      const quantity = money(input.quantity ?? 1, 'Quantity', { min: 0.01 });
      lines.push({
        kind: 'part', part_id: part.id, catalog_item_id: null, name: part.name, quantity, sort_order: index,
        price: Math.round(part.price * quantity * 100) / 100,
        commission: Math.round(part.commission * quantity * 100) / 100,
        unit_cost: part.avg_cost,
      });
    } else if (input?.catalog_item_id != null) {
      if (!vehicleClass) throw bad('Choose a vehicle class before adding services or add-ons');
      const row = await q.one(`select i.id, i.kind, i.name, i.department, coalesce(p.price, 0) as price, coalesce(p.commission, 0) as commission
        from catalog_items i left join catalog_prices p on p.item_id = i.id and p.vehicle_class = $2
        where i.id = $1 and i.active`, [id(input.catalog_item_id, 'service'), vehicleClass]);
      if (!row) throw bad('That service or add-on is no longer available');
      if (row.department !== dept) {
        throw bad(`${row.name} is a ${department(row.department).label} item and cannot be added to a ${department(dept).label} job`);
      }
      lines.push({ kind: row.kind, catalog_item_id: row.id, name: row.name, price: row.price, commission: row.commission, sort_order: index });
    } else {
      lines.push({
        kind: 'custom', catalog_item_id: null, sort_order: index,
        name: text(input?.name, 'Custom item name', { required: true, max: 120 }),
        price: money(input?.price, 'Custom item price'),
        commission: money(input?.commission, 'Custom item commission'),
      });
    }
  }
  return lines;
}

async function saveLines(q, jobId, lines, existing) {
  const keep = new Set(lines.filter(l => l.id).map(l => l.id));
  const removed = existing.filter(l => !keep.has(l.id)).map(l => l.id);
  for (const line of existing.filter(l => !keep.has(l.id) && l.kind === 'part')) {
    await returnStock(q, line.part_id, line.quantity, jobId, 'Removed from job');
  }
  if (removed.length) await q.query('delete from job_items where id = any($1::bigint[])', [removed]);
  for (const line of lines) {
    if (line.id) {
      await q.query(`update job_items set sort_order = $2, price = $3, commission = $4
        where id = $1 and (sort_order, price, commission) is distinct from ($2::int, $3::numeric, $4::numeric)`,
      [line.id, line.sort_order, line.price, line.commission]);
    } else {
      if (line.kind === 'part') await takeStock(q, line.part_id, line.quantity, jobId);
      await q.query(`insert into job_items (job_id, kind, catalog_item_id, part_id, quantity, unit_cost, name, price, commission, sort_order)
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [jobId, line.kind, line.catalog_item_id, line.part_id ?? null, line.quantity ?? 1, line.unit_cost ?? null,
        line.name, line.price, line.commission, line.sort_order]);
    }
  }
}

function assertDiscount(discount, lines) {
  const subtotal = lines.reduce((s, l) => s + Number(l.price), 0);
  if (discount > subtotal + 0.001) throw bad(`Discount (₱${discount}) cannot be more than the job subtotal (₱${subtotal})`);
}

async function nextJoNumber(q, jobDate, dept) {
  // Serialises JO numbering per department and date, so two people adding jobs at once never collide.
  await q.query('select pg_advisory_xact_lock(hashtext($1))', [`jo:${dept}:${jobDate}`]);
  const prefix = joPrefix(jobDate, department(dept).prefix);
  const { n } = await q.one(`select coalesce(max(substring(jo_number from '(\\d+)$')::int), 0) + 1 as n
    from jobs where job_date = $1 and jo_number like $2`, [jobDate, `${prefix}%`]);
  return prefix + String(n).padStart(3, '0');
}

function runningDepartment(value) {
  const dept = oneOf(value, DEPARTMENT_KEYS, 'Department');
  if (!department(dept).running) throw bad(`${department(dept).label} jobs are same-day; use the date view instead`);
  return dept;
}

// Days whose totals a change to this job would affect (staff cannot touch closed days).
const affectedDays = job => (isRunning(job) ? [job.sale_date, job.paid_on] : [job.job_date]).filter(Boolean);

async function assertDaysOpen(q, days, user) {
  for (const day of new Set(days)) await assertDayOpen(q, day, user);
}

// ---------------------------------------------------------------- reads

router.get('/jobs', async (req, res) => {
  const day = date(req.query.date);
  if (req.query.department) {
    res.json(await loadJobs('job_date = $1 and department = $2', [day, oneOf(req.query.department, DEPARTMENT_KEYS, 'Department')]));
  } else {
    res.json(await loadJobs('job_date = $1', [day]));
  }
});

// The running board: every job of the department that has not been both finished and paid.
router.get('/jobs/active', async (req, res) => {
  const dept = runningDepartment(req.query.department);
  const voided = req.query.include_voided === '1' ? '' : 'and voided_at is null';
  res.json(await loadJobs(`department = $1 and sale_date is null ${voided}`, [dept]));
});

router.get('/jobs/completed', async (req, res) => {
  res.json(await loadJobs('department = $1 and sale_date = $2', [runningDepartment(req.query.department), date(req.query.date)]));
});

// ---------------------------------------------------------------- create / edit

router.post('/jobs', async (req, res) => {
  const jobDate = date(req.body.job_date, 'Job date');
  const dept = oneOf(req.body.department ?? 'carwash', DEPARTMENT_KEYS, 'Department');
  const running = department(dept).running;
  const jobId = await db.tx(req.user.email, async q => {
    if (!running) await assertDayOpen(q, jobDate, req.user);
    const fields = await cleanJobFields(q, req.body);
    if (!fields.vehicle_class && department(dept).catalog) throw bad('Choose a vehicle class');
    if (running && fields.payment_received) throw bad('Record payment for this job with "Mark paid" once the customer pays');
    const lines = await buildLines(q, req.body.items || [], fields.vehicle_class, dept);
    if (!lines.length) throw bad('Add at least one service, add-on or custom item');
    assertDiscount(fields.discount || 0, lines);
    const values = {
      payment_method: 'Cash', payment_received: false, ...fields,
      department: dept, jo_number: await nextJoNumber(q, jobDate, dept), job_date: jobDate,
    };
    const cols = Object.keys(values);
    const job = await q.one(`insert into jobs (${cols.join(', ')}) values (${cols.map((_, i) => `$${i + 1}`).join(', ')}) returning id`,
      cols.map(c => values[c]));
    await saveLines(q, job.id, lines, []);
    return job.id;
  });
  res.status(201).json(await loadJob(jobId));
});

router.patch('/jobs/:id', async (req, res) => {
  const jobId = id(req.params.id, 'job');
  await db.tx(req.user.email, async q => {
    const job = await loadJob(jobId, q);
    if (!job) throw notFound('Job');
    if (job.voided_at) throw bad('This job is voided. Restore it before editing.');
    await assertDaysOpen(q, affectedDays(job), req.user);
    const fields = await cleanJobFields(q, req.body);
    if (isRunning(job)) {
      if ('payment_received' in fields) throw bad('Use "Mark paid" / "Undo payment" for detailing and tint/PPF jobs');
      const changesAmount = Array.isArray(req.body.items) || AMOUNT_FIELDS.some(f => f in fields && fields[f] !== job[f]);
      if (job.paid_on && changesAmount) throw bad('This job is already paid, so its amount is locked. Undo the payment first to change it.');
    }
    const vehicleClass = 'vehicle_class' in fields ? fields.vehicle_class : job.vehicle_class;
    const classChanged = vehicleClass !== job.vehicle_class;

    let lines = job.items;
    if (Array.isArray(req.body.items) || classChanged) {
      let inputs = Array.isArray(req.body.items) ? req.body.items : job.items.map(l => ({ id: l.id }));
      if (classChanged) {
        // Re-price catalog lines at the new class; custom lines keep their price.
        inputs = inputs.map(input => {
          const line = input?.id != null && job.items.find(l => l.id === Number(input.id));
          return line && line.catalog_item_id ? { catalog_item_id: line.catalog_item_id } : input;
        });
      }
      lines = await buildLines(q, inputs, vehicleClass, job.department, job.items);
      if (!lines.length) throw bad('A job needs at least one line item. Void the job instead.');
    }
    assertDiscount('discount' in fields ? fields.discount : job.discount, lines);

    const cols = Object.keys(fields);
    if (cols.length) {
      await q.query(`update jobs set ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')} where id = $1`,
        [jobId, ...cols.map(c => fields[c])]);
    }
    if (lines !== job.items) await saveLines(q, jobId, lines, job.items);
  });
  res.json(await loadJob(jobId));
});

// ---------------------------------------------------------------- running jobs: done / paid

async function runningAction(req, fn) {
  const jobId = id(req.params.id, 'job');
  await db.tx(req.user.email, async q => {
    const job = await loadJob(jobId, q);
    if (!job) throw notFound('Job');
    if (!isRunning(job)) throw bad('Carwash jobs are not marked done; use the Paid checkbox');
    if (job.voided_at) throw bad('This job is voided. Restore it first.');
    await fn(q, job);
  });
  return loadJob(jobId);
}

const later = (a, b) => (a && b ? (a > b ? a : b) : null);

router.post('/jobs/:id/complete', async (req, res) => {
  res.json(await runningAction(req, async (q, job) => {
    if (job.closed_on) throw bad(`Already marked done on ${job.closed_on}`);
    const day = date(req.body.date, 'Done date');
    if (day < job.job_date) throw bad(`Done date cannot be before the job was opened (${job.job_date})`);
    await assertDaysOpen(q, [day, later(day, job.paid_on)].filter(Boolean), req.user);
    await q.query('update jobs set closed_on = $2 where id = $1', [job.id, day]);
  }));
});

router.post('/jobs/:id/reopen', async (req, res) => {
  res.json(await runningAction(req, async (q, job) => {
    if (!job.closed_on) throw bad('This job is not marked done');
    await assertDaysOpen(q, [job.sale_date].filter(Boolean), req.user);
    await q.query('update jobs set closed_on = null where id = $1', [job.id]);
  }));
});

router.post('/jobs/:id/pay', async (req, res) => {
  res.json(await runningAction(req, async (q, job) => {
    if (job.paid_on) throw bad(`Already paid on ${job.paid_on}`);
    const day = date(req.body.date, 'Payment date');
    if (day < job.job_date) throw bad(`Payment date cannot be before the job was opened (${job.job_date})`);
    const method = oneOf(req.body.payment_method, PAYMENT_METHODS, 'Payment method');
    const tip = 'tip_gcash' in (req.body || {}) ? money(req.body.tip_gcash, 'GCash tip') : job.tip_gcash;
    await assertDaysOpen(q, [day, later(day, job.closed_on)].filter(Boolean), req.user);
    await q.query('update jobs set paid_on = $2, payment_received = true, payment_method = $3, tip_gcash = $4 where id = $1',
      [job.id, day, method, tip]);
  }));
});

router.post('/jobs/:id/unpay', async (req, res) => {
  res.json(await runningAction(req, async (q, job) => {
    if (!job.paid_on) throw bad('This job has no payment recorded');
    await assertDaysOpen(q, [job.paid_on, job.sale_date].filter(Boolean), req.user);
    await q.query('update jobs set paid_on = null, payment_received = false where id = $1', [job.id]);
  }));
});

// ---------------------------------------------------------------- void / restore (owner)

// Voiding keeps the record (and its JO number) but removes it from every total.
router.post('/jobs/:id/void', requireOwner, async (req, res) => {
  const jobId = id(req.params.id, 'job');
  const reason = text(req.body.reason, 'Reason', { required: true, max: 200 });
  await db.tx(req.user.email, async q => {
    const changed = await q.exec('update jobs set voided_at = now(), voided_by = $2, void_reason = $3 where id = $1 and voided_at is null',
      [jobId, req.user.email, reason]);
    if (!changed) throw notFound('Active job');
    for (const line of (await loadJob(jobId, q)).items.filter(l => l.kind === 'part')) {
      await returnStock(q, line.part_id, line.quantity, jobId, 'Job voided');
    }
  });
  res.json(await loadJob(jobId));
});

router.post('/jobs/:id/restore', requireOwner, async (req, res) => {
  const jobId = id(req.params.id, 'job');
  await db.tx(req.user.email, async q => {
    const changed = await q.exec('update jobs set voided_at = null, voided_by = null, void_reason = null where id = $1 and voided_at is not null', [jobId]);
    if (!changed) throw notFound('Voided job');
    for (const line of (await loadJob(jobId, q)).items.filter(l => l.kind === 'part')) {
      await takeStock(q, line.part_id, line.quantity, jobId);
    }
  });
  res.json(await loadJob(jobId));
});

module.exports = { router, PAYMENT_METHODS };
