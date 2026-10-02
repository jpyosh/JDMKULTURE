// Daily Log: job orders made of line items. A line's price/commission is copied from the
// Pricing Matrix when the line is added and never changes afterwards (unless the job's vehicle
// class is changed, which re-prices its catalog lines at the new class).
const express = require('express');
const { requireOwner } = require('../lib/auth');
const { db } = require('../lib/db');
const { joPrefix } = require('../lib/calc');
const { loadJobs, loadJob, assertDayOpen } = require('../lib/store');
const { bad, notFound, money, text, date, oneOf, time, id, pick } = require('../lib/http');

const router = express.Router();
const PAYMENT_METHODS = ['Cash', 'GCash'];
const MAX_LINES = 30;
const JOB_FIELDS = ['vehicle_class', 'plate', 'payment_method', 'payment_received', 'discount', 'discount_reason',
  'tip_gcash', 'time_in', 'time_out', 'detailer', 'remarks'];

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
async function buildLines(q, inputs, vehicleClass, existing = []) {
  if (!Array.isArray(inputs)) throw bad('items must be a list');
  if (inputs.length > MAX_LINES) throw bad(`A job can have at most ${MAX_LINES} line items`);
  const existingById = new Map(existing.map(line => [line.id, line]));
  const lines = [];
  for (const [index, input] of inputs.entries()) {
    if (input?.id != null) {
      const line = existingById.get(Number(input.id));
      if (!line) throw bad('Unknown line item');
      lines.push({ ...line, sort_order: index });
    } else if (input?.catalog_item_id != null) {
      if (!vehicleClass) throw bad('Choose a vehicle class before adding services or add-ons');
      const row = await q.one(`select i.id, i.kind, i.name, coalesce(p.price, 0) as price, coalesce(p.commission, 0) as commission
        from catalog_items i left join catalog_prices p on p.item_id = i.id and p.vehicle_class = $2
        where i.id = $1 and i.active`, [id(input.catalog_item_id, 'service'), vehicleClass]);
      if (!row) throw bad('That service or add-on is no longer available');
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
  if (removed.length) await q.query('delete from job_items where id = any($1::bigint[])', [removed]);
  for (const line of lines) {
    if (line.id) {
      await q.query(`update job_items set sort_order = $2, price = $3, commission = $4
        where id = $1 and (sort_order, price, commission) is distinct from ($2::int, $3::numeric, $4::numeric)`,
      [line.id, line.sort_order, line.price, line.commission]);
    } else {
      await q.query(`insert into job_items (job_id, kind, catalog_item_id, name, price, commission, sort_order)
        values ($1, $2, $3, $4, $5, $6, $7)`,
      [jobId, line.kind, line.catalog_item_id, line.name, line.price, line.commission, line.sort_order]);
    }
  }
}

function assertDiscount(discount, lines) {
  const subtotal = lines.reduce((s, l) => s + Number(l.price), 0);
  if (discount > subtotal + 0.001) throw bad(`Discount (₱${discount}) cannot be more than the job subtotal (₱${subtotal})`);
}

async function nextJoNumber(q, jobDate) {
  // Serialises JO numbering per date, so two people adding jobs at once never collide.
  await q.query('select pg_advisory_xact_lock(hashtext($1))', [`jo:${jobDate}`]);
  const prefix = joPrefix(jobDate);
  const { n } = await q.one(`select coalesce(max(substring(jo_number from '(\\d+)$')::int), 0) + 1 as n
    from jobs where job_date = $1 and jo_number like $2`, [jobDate, `${prefix}%`]);
  return prefix + String(n).padStart(3, '0');
}

router.get('/jobs', async (req, res) => {
  res.json(await loadJobs('job_date = $1', [date(req.query.date)]));
});

router.post('/jobs', async (req, res) => {
  const jobDate = date(req.body.job_date, 'Job date');
  const jobId = await db.tx(req.user.email, async q => {
    await assertDayOpen(q, jobDate, req.user);
    const fields = await cleanJobFields(q, req.body);
    if (!fields.vehicle_class) throw bad('Choose a vehicle class');
    const lines = await buildLines(q, req.body.items || [], fields.vehicle_class);
    if (!lines.length) throw bad('Add at least one service, add-on or custom item');
    assertDiscount(fields.discount || 0, lines);
    const values = { payment_method: 'Cash', payment_received: false, ...fields, jo_number: await nextJoNumber(q, jobDate), job_date: jobDate };
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
    await assertDayOpen(q, job.job_date, req.user);
    const fields = await cleanJobFields(q, req.body);
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
      lines = await buildLines(q, inputs, vehicleClass, job.items);
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

// Voiding keeps the record (and its JO number) but removes it from every total.
router.post('/jobs/:id/void', requireOwner, async (req, res) => {
  const jobId = id(req.params.id, 'job');
  const reason = text(req.body.reason, 'Reason', { required: true, max: 200 });
  const changed = await db.tx(req.user.email, q => q.exec(
    'update jobs set voided_at = now(), voided_by = $2, void_reason = $3 where id = $1 and voided_at is null',
    [jobId, req.user.email, reason]));
  if (!changed) throw notFound('Active job');
  res.json(await loadJob(jobId));
});

router.post('/jobs/:id/restore', requireOwner, async (req, res) => {
  const jobId = id(req.params.id, 'job');
  const changed = await db.tx(req.user.email, q => q.exec(
    'update jobs set voided_at = null, voided_by = null, void_reason = null where id = $1 and voided_at is not null', [jobId]));
  if (!changed) throw notFound('Voided job');
  res.json(await loadJob(jobId));
});

module.exports = { router, PAYMENT_METHODS };
