const express = require('express');
const fs = require('fs');
const path = require('path');
const { db, init, CLASSES } = require('./db');
const { createClient } = require('@supabase/supabase-js');

fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
const ready = Promise.resolve().then(() => init());

const app = express();
app.use(express.json());
app.use((req, res, next) => ready.then(() => next()).catch(next));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- helpers ----------

function priceFor(row, cls) {
  return row ? (row['price_' + cls] ?? 0) : 0;
}
function commFor(row, cls) {
  return row ? (row['comm_' + cls] ?? 0) : 0;
}

// Computes total price + commission for one job row using live lookups
// (mirrors the sheet's INDEX/MATCH against Pricing Matrix / Commission Matrix).
async function computeJob(job, lookups = {}) {
  const service = job.service_id ? (lookups.services?.get(Number(job.service_id)) || await db.prepare('SELECT * FROM services WHERE id=?').get(job.service_id)) : null;
  const addon = job.addon_id ? (lookups.addons?.get(Number(job.addon_id)) || await db.prepare('SELECT * FROM addons WHERE id=?').get(job.addon_id)) : null;
  const cls = job.vehicle_class;

  const basePrice = priceFor(service, cls);
  const baseComm = commFor(service, cls);
  const addonPrice = job.addon_price_override != null ? Number(job.addon_price_override) : priceFor(addon, cls);
  const addonComm = commFor(addon, cls);
  const customPrice = Number(job.custom_price || 0);
  const customComm = Number(job.custom_comm || 0);
  const discount = Number(job.discount || 0);

  const totalPrice = basePrice + addonPrice + customPrice - discount;
  const detailerComm = baseComm + addonComm + customComm;
  const netRevenue = totalPrice - detailerComm;

  return { totalPrice, detailerComm, netRevenue, basePrice, addonPrice };
}

async function computeJobs(jobs) {
  const [services, addons] = await Promise.all([
    db.prepare('SELECT * FROM services').all(),
    db.prepare('SELECT * FROM addons').all(),
  ]);
  const lookups = {
    services: new Map(services.map(row => [Number(row.id), row])),
    addons: new Map(addons.map(row => [Number(row.id), row])),
  };
  return Promise.all(jobs.map(async job => ({ ...job, computed: await computeJob(job, lookups) })));
}

function joNumber(dateStr, seq) {
  // date comes in as YYYY-MM-DD from <input type=date>; sheet format is MMDDYY
  const [y, m, d] = dateStr.split('-');
  return `JO-${m}${d}${y.slice(2)}-${String(seq).padStart(3, '0')}`;
}

const supabaseAuth = process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY)
  : null;

const pricingFields = ['price_S', 'price_M', 'price_L', 'price_XL', 'price_MOTO', 'price_BIG_MOTO',
  'comm_S', 'comm_M', 'comm_L', 'comm_XL', 'comm_MOTO', 'comm_BIG_MOTO'];
function validatePricingBody(body) {
  if (!body.name || !String(body.name).trim()) return 'Name is required';
  for (const field of pricingFields) {
    if (field in body && (!Number.isFinite(Number(body[field])) || Number(body[field]) < 0)) {
      return `${field} must be a valid non-negative number`;
    }
  }
  return null;
}

async function requireAuth(req, res, next) {
  if (!supabaseAuth) return res.status(503).json({ error: 'Authentication is not configured on the server' });
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) return res.status(401).json({ error: 'Authentication required' });
  const { data, error } = await supabaseAuth.auth.getUser(token);
  if (error || !data.user) return res.status(401).json({ error: 'Invalid or expired session' });
  req.user = data.user;
  next();
}

app.get('/api/auth/config', (req, res) => {
  res.json({ url: process.env.SUPABASE_URL || '', anonKey: process.env.SUPABASE_ANON_KEY || '' });
});

// GET requests remain available for read-only access; every mutation requires a valid Supabase session.
app.use('/api', (req, res, next) => req.method === 'GET' ? next() : requireAuth(req, res, next));

// ---------- Pricing Matrix ----------

app.get('/api/pricing', async (req, res) => {
  const services = await db.prepare('SELECT * FROM services WHERE active=1 ORDER BY id').all();
  const addons = await db.prepare('SELECT * FROM addons WHERE active=1 ORDER BY id').all();
  res.json({ classes: CLASSES, services, addons });
});
app.put('/api/pricing/service/:id', async (req, res) => {
  const fields = ['name', 'price_S', 'price_M', 'price_L', 'price_XL', 'price_MOTO', 'price_BIG_MOTO', 'comm_S', 'comm_M', 'comm_L', 'comm_XL', 'comm_MOTO', 'comm_BIG_MOTO'];
  const updates = fields.filter(f => f in req.body);
  if (!updates.length) return res.status(400).json({ error: 'No pricing fields supplied' });
  const pricingError = validatePricingBody(req.body);
  if (pricingError) return res.status(400).json({ error: pricingError });
  const set = updates.map(f => `${f}=@${f}`).join(', ');
  await db.prepare(`UPDATE services SET ${set} WHERE id=@id`).run({ ...req.body, id: req.params.id });
  res.json(await db.prepare('SELECT * FROM services WHERE id=?').get(req.params.id));
});

app.post('/api/pricing/service', async (req, res) => {
  const s = req.body;
  const pricingError = validatePricingBody(s);
  if (pricingError) return res.status(400).json({ error: pricingError });
  const info = await db.prepare(`INSERT INTO services (name, price_S, price_M, price_L, price_XL, price_MOTO, price_BIG_MOTO, comm_S, comm_M, comm_L, comm_XL, comm_MOTO, comm_BIG_MOTO)
    VALUES (@name,@price_S,@price_M,@price_L,@price_XL,@price_MOTO,@price_BIG_MOTO,@comm_S,@comm_M,@comm_L,@comm_XL,@comm_MOTO,@comm_BIG_MOTO)`).run(s);
  res.json(await db.prepare('SELECT * FROM services WHERE id=?').get(info.lastInsertRowid));
});
app.delete('/api/pricing/service/:id', async (req, res) => {
  await db.prepare('UPDATE services SET active=0 WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

app.put('/api/pricing/addon/:id', async (req, res) => {
  const fields = ['name', 'price_S', 'price_M', 'price_L', 'price_XL', 'price_MOTO', 'price_BIG_MOTO', 'comm_S', 'comm_M', 'comm_L', 'comm_XL', 'comm_MOTO', 'comm_BIG_MOTO'];
  const updates = fields.filter(f => f in req.body);
  if (!updates.length) return res.status(400).json({ error: 'No pricing fields supplied' });
  const pricingError = validatePricingBody(req.body);
  if (pricingError) return res.status(400).json({ error: pricingError });
  const set = updates.map(f => `${f}=@${f}`).join(', ');
  await db.prepare(`UPDATE addons SET ${set} WHERE id=@id`).run({ ...req.body, id: req.params.id });
  res.json(await db.prepare('SELECT * FROM addons WHERE id=?').get(req.params.id));
});

app.post('/api/pricing/addon', async (req, res) => {
  const a = req.body;
  const pricingError = validatePricingBody(a);
  if (pricingError) return res.status(400).json({ error: pricingError });
  const info = await db.prepare(`INSERT INTO addons (name, price_S, price_M, price_L, price_XL, price_MOTO, price_BIG_MOTO, comm_S, comm_M, comm_L, comm_XL, comm_MOTO, comm_BIG_MOTO)
    VALUES (@name,@price_S,@price_M,@price_L,@price_XL,@price_MOTO,@price_BIG_MOTO,@comm_S,@comm_M,@comm_L,@comm_XL,@comm_MOTO,@comm_BIG_MOTO)`).run(a);
  res.json(await db.prepare('SELECT * FROM addons WHERE id=?').get(info.lastInsertRowid));
});

app.delete('/api/pricing/addon/:id', async (req, res) => {
  await db.prepare('UPDATE addons SET active=0 WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ---------- Daily Log / Jobs ----------

app.get('/api/jobs/:date', async (req, res) => {
  const filters = [];
  const params = [req.params.date];
  if (req.query.payment && ['Cash', 'GCash'].includes(req.query.payment)) {
    filters.push('payment_method=?'); params.push(req.query.payment);
  }
  if (req.query.paymentStatus === 'paid') filters.push('payment_received=1');
  if (req.query.paymentStatus === 'unpaid') filters.push('payment_received=0');
  const jobs = await db.prepare(`SELECT * FROM jobs WHERE job_date=? ${filters.length ? `AND ${filters.join(' AND ')}` : ''} ORDER BY id`).all(...params);
  const enriched = await computeJobs(jobs);
  res.json(enriched);
});

app.post('/api/jobs', async (req, res) => {
  const j = req.body;
  if (!j.job_date) return res.status(400).json({ error: 'job_date required' });
  if (j.vehicle_class && !CLASSES.includes(j.vehicle_class)) return res.status(400).json({ error: 'Invalid vehicle class' });
  if (j.payment_method && !['Cash', 'GCash'].includes(j.payment_method)) return res.status(400).json({ error: 'Invalid payment method' });
  if (j.commission_payment_method && !['Cash', 'GCash'].includes(j.commission_payment_method)) return res.status(400).json({ error: 'Invalid commission payment method' });
  for (const field of ['custom_price', 'custom_comm', 'discount', 'tip_gcash']) {
    if (!Number.isFinite(Number(j[field] || 0)) || Number(j[field] || 0) < 0) return res.status(400).json({ error: `${field} must be a valid non-negative number` });
  }
  const seq = Number((await db.prepare('SELECT COUNT(*) c FROM jobs WHERE job_date=?').get(j.job_date)).c) + 1;
  const jo_number = joNumber(j.job_date, seq);

  const info = await db.prepare(`INSERT INTO jobs
    (jo_number, job_date, time_in, time_out, vehicle_class, plate, service_id, addon_id, addon_price_override,
    custom_addon_name, custom_price, custom_comm, discount, discount_reason, tip_gcash, payment_method, payment_received,
    commission_paid, commission_payment_method, commission_cash_paid, commission_gcash_paid, detailer, remarks)
    VALUES (@jo_number,@job_date,@time_in,@time_out,@vehicle_class,@plate,@service_id,@addon_id,@addon_price_override,
    @custom_addon_name,@custom_price,@custom_comm,@discount,@discount_reason,@tip_gcash,@payment_method,@payment_received,
    @commission_paid,@commission_payment_method,@commission_cash_paid,@commission_gcash_paid,@detailer,@remarks)`)
    .run({
      jo_number, job_date: j.job_date, time_in: j.time_in || null, time_out: j.time_out || null, vehicle_class: j.vehicle_class || null,
      plate: j.plate || null, service_id: j.service_id || null, addon_id: j.addon_id || null,
      addon_price_override: j.addon_price_override ?? null, custom_addon_name: j.custom_addon_name || null,
      custom_price: j.custom_price || 0, custom_comm: j.custom_comm || 0, discount: j.discount || 0,
      discount_reason: j.discount_reason || null, tip_gcash: j.tip_gcash || 0,
      payment_method: j.payment_method || 'Cash', payment_received: 0, commission_paid: 0,
      commission_payment_method: 'Cash', commission_cash_paid: 0, commission_gcash_paid: Number(j.commission_gcash_paid || 0),
      detailer: j.detailer || null, remarks: j.remarks || null,
    });

  const job = await db.prepare('SELECT * FROM jobs WHERE id=?').get(info.lastInsertRowid);
  res.json({ ...job, computed: await computeJob(job) });
});

app.put('/api/jobs/:id', async (req, res) => {
  const fields = ['time_in', 'time_out', 'vehicle_class', 'plate', 'service_id', 'addon_id', 'addon_price_override',
    'custom_addon_name', 'custom_price', 'custom_comm', 'discount', 'discount_reason', 'tip_gcash',
    'payment_method', 'payment_received', 'commission_paid', 'commission_payment_method', 'commission_cash_paid', 'commission_gcash_paid', 'detailer', 'remarks'];
  if ('payment_received' in req.body) req.body.payment_received = req.body.payment_received ? 1 : 0;
  if ('commission_paid' in req.body) req.body.commission_paid = req.body.commission_paid ? 1 : 0;
  for (const field of ['commission_cash_paid', 'commission_gcash_paid']) {
    if (field in req.body && (!Number.isFinite(Number(req.body[field])) || Number(req.body[field]) < 0)) {
      return res.status(400).json({ error: `${field} cannot be negative` });
    }
  }
  const updates = fields.filter(f => f in req.body);
  const existingJob = await db.prepare('SELECT * FROM jobs WHERE id=?').get(req.params.id);
  if (!existingJob) return res.status(404).json({ error: 'Job not found' });
  const candidate = { ...existingJob, ...req.body };
  if (updates.length) {
    const set = updates.map(f => `${f}=@${f}`).join(', ');
    await db.prepare(`UPDATE jobs SET ${set} WHERE id=@id`).run({ ...req.body, id: req.params.id });
  }
  const job = await db.prepare('SELECT * FROM jobs WHERE id=?').get(req.params.id);
  res.json({ ...job, computed: await computeJob(job) });
});

app.delete('/api/jobs/:id', async (req, res) => {
  await db.prepare('DELETE FROM jobs WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ---------- Expenses ----------

app.get('/api/expenses/:date', async (req, res) => {
  res.json(await db.prepare('SELECT * FROM expenses WHERE expense_date=? ORDER BY id').all(req.params.date));
});

app.post('/api/expenses', async (req, res) => {
  const e = req.body;
  if (!e.expense_date || !['cash', 'gcash'].includes(e.side)) return res.status(400).json({ error: 'Valid expense date and side required' });
  if (!Number.isFinite(Number(e.amount)) || Number(e.amount) <= 0) return res.status(400).json({ error: 'Expense amount must be greater than zero' });
  const info = await db.prepare('INSERT INTO expenses (expense_date, side, description, amount) VALUES (?,?,?,?)')
    .run(e.expense_date, e.side, e.description || '', e.amount || 0);
  res.json(await db.prepare('SELECT * FROM expenses WHERE id=?').get(info.lastInsertRowid));
});

app.delete('/api/expenses/:id', async (req, res) => {
  await db.prepare('DELETE FROM expenses WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ---------- Daily meta (float / actual counts) ----------

app.get('/api/meta/:date', async (req, res) => {
  const meta = await db.prepare('SELECT * FROM daily_meta WHERE job_date=?').get(req.params.date);
  res.json(meta || { job_date: req.params.date, supervisor: '', cash_float: 0, actual_cash: null, actual_gcash: null, gcash_tips_to_distribute: 0, commission_gcash_paid: 0 });
});

app.put('/api/meta/:date', async (req, res) => {
  const m = req.body;
  const commissionGcashPaid = Number(m.commission_gcash_paid || 0);
  if (!Number.isFinite(commissionGcashPaid) || commissionGcashPaid < 0) return res.status(400).json({ error: 'GCash commission must be a valid non-negative amount' });
  await db.prepare(`INSERT INTO daily_meta (job_date, supervisor, cash_float, actual_cash, actual_gcash, gcash_tips_to_distribute, commission_gcash_paid)
    VALUES (@job_date,@supervisor,@cash_float,@actual_cash,@actual_gcash,@gcash_tips_to_distribute,@commission_gcash_paid)
    ON CONFLICT(job_date) DO UPDATE SET supervisor=excluded.supervisor, cash_float=excluded.cash_float,
      actual_cash=excluded.actual_cash, actual_gcash=excluded.actual_gcash,
      gcash_tips_to_distribute=excluded.gcash_tips_to_distribute, commission_gcash_paid=excluded.commission_gcash_paid`)
    .run({ job_date: req.params.date, supervisor: m.supervisor || '', cash_float: m.cash_float || 0,
      actual_cash: m.actual_cash, actual_gcash: m.actual_gcash, gcash_tips_to_distribute: m.gcash_tips_to_distribute || 0,
      commission_gcash_paid: commissionGcashPaid });
  res.json(await db.prepare('SELECT * FROM daily_meta WHERE job_date=?').get(req.params.date));
});

// ---------- EOD Dashboard (the fixed reconciliation) ----------

app.get('/api/eod/:date', async (req, res) => {
  const date = req.params.date;
  const rawJobs = await db.prepare('SELECT * FROM jobs WHERE job_date=?').all(date);
  const jobs = await computeJobs(rawJobs);
  const expenses = await db.prepare('SELECT * FROM expenses WHERE expense_date=?').all(date);
  const meta = await db.prepare('SELECT * FROM daily_meta WHERE job_date=?').get(date)
    || { cash_float: 0, actual_cash: null, actual_gcash: null, gcash_tips_to_distribute: 0, commission_gcash_paid: 0, supervisor: '' };

  const servicedJobs = jobs.filter(j => j.vehicle_class);
  const paidJobs = servicedJobs.filter(j => Number(j.payment_received) === 1);
  const totalVehicles = paidJobs.length;
  const grossSales = paidJobs.reduce((s, j) => s + j.computed.totalPrice, 0);
  const totalComm = servicedJobs.reduce((s, j) => s + j.computed.detailerComm, 0);
  const paidCommissionGcash = Math.min(Number(meta.commission_gcash_paid || 0), totalComm);
  // FIX (audit bug): this is the ONLY subtraction of commission. The old sheet subtracted it once
  // per row (in Net Shop Revenue) AND again here, understating profit by a full day's commission.
  const totalNetRevenue = grossSales - totalComm;

  const cashSales = paidJobs.filter(j => j.payment_method === 'Cash').reduce((s, j) => s + j.computed.totalPrice, 0);
  const digitalSales = grossSales - cashSales; // GCash + Maya + anything not Cash

  const cashExpenses = expenses.filter(e => e.side === 'cash').reduce((s, e) => s + Number(e.amount || 0), 0);
  const gcashExpenses = expenses.filter(e => e.side === 'gcash').reduce((s, e) => s + Number(e.amount || 0), 0);
  const jobGcashTips = paidJobs.reduce((s, j) => s + Number(j.tip_gcash || 0), 0);
  const manualGcashTips = Number(meta.gcash_tips_to_distribute || 0);
  const gcashTipsToDistribute = manualGcashTips + jobGcashTips;
  const gcashTipsReceived = jobGcashTips + manualGcashTips;

  const paidCommissionCash = Math.max(0, totalComm - paidCommissionGcash);
  const expectedCashPre = Number(meta.cash_float || 0) + cashSales;
  const expectedCashAfter = expectedCashPre - paidCommissionCash - cashExpenses;
  // Customer tips are included in the GCash balance first, then removed when distributed.
  const expectedGcashPre = digitalSales + gcashTipsReceived;
  const expectedGcashAfter = expectedGcashPre - paidCommissionGcash - gcashExpenses - gcashTipsToDistribute;
  const expectedTotal = expectedCashAfter + expectedGcashAfter;

  const actualCash = meta.actual_cash;
  const actualGcash = meta.actual_gcash;
  const actualTotal = (actualCash || 0) + (actualGcash || 0);

  const cashVariance = actualCash != null ? actualCash - expectedCashAfter : null;
  const gcashVariance = actualGcash != null ? actualGcash - expectedGcashAfter : null;

  res.json({
    date, supervisor: meta.supervisor, cashFloat: Number(meta.cash_float || 0),
    totalVehicles, grossSales, totalComm, totalNetRevenue,
    cashSales, digitalSales, cashExpenses, gcashExpenses, expenses, paidCommissionCash, paidCommissionGcash,
    commissionGcashPaid: paidCommissionGcash,
    expectedCashPre, expectedCashAfter, expectedGcashPre, expectedGcashAfter, expectedTotal,
    actualCash, actualGcash, actualTotal,
    cashVariance, gcashVariance,
    gcashTipsToDistribute, gcashTipsReceived, jobGcashTips, manualGcashTips,
  });
});

// ---------- Weekly rollup ----------

app.get('/api/weekly', async (req, res) => {
  const { start, end } = req.query;
  if (!start || !end || start > end) return res.status(400).json({ error: 'Valid start and end dates are required' });
  const filters = [];
  const params = [start, end];
  if (req.query.payment && ['Cash', 'GCash'].includes(req.query.payment)) {
    filters.push('payment_method=?'); params.push(req.query.payment);
  }
  if (req.query.paymentStatus === 'paid') filters.push('payment_received=1');
  if (req.query.paymentStatus === 'unpaid') filters.push('payment_received=0');
  const rawJobs = await db.prepare(`SELECT * FROM jobs WHERE job_date BETWEEN ? AND ? ${filters.length ? `AND ${filters.join(' AND ')}` : ''} ORDER BY job_date, id`).all(...params);
  const jobs = (await computeJobs(rawJobs)).filter(j => j.vehicle_class);
  const expenseRows = await db.prepare('SELECT expense_date, SUM(amount) t FROM expenses WHERE expense_date BETWEEN ? AND ? GROUP BY expense_date').all(start, end);
  const expenseByDate = new Map(expenseRows.map(row => [row.expense_date, Number(row.t || 0)]));
  const dates = new Set([...rawJobs.map(job => job.job_date), ...expenseRows.map(row => row.expense_date)]);
  const days = [...dates].sort().map(date => {
    const dayJobs = jobs.filter(job => job.job_date === date);
    const paidJobs = dayJobs.filter(j => Number(j.payment_received) === 1);
    const gross = paidJobs.reduce((s, j) => s + j.computed.totalPrice, 0);
    const comm = dayJobs.filter(j => Number(j.commission_paid) === 1).reduce((s, j) => s + (j.commission_cash_paid == null && j.commission_gcash_paid == null
      ? j.computed.detailerComm : Number(j.commission_cash_paid || 0) + Number(j.commission_gcash_paid || 0)), 0);
    const expenses = expenseByDate.get(date) || 0;
    return { date, vehicles: paidJobs.length, grossSales: gross, commissions: comm, otherExpenses: expenses, netProfit: gross - comm - expenses };
  });

  const totals = days.reduce((a, d) => ({
    vehicles: a.vehicles + d.vehicles, grossSales: a.grossSales + d.grossSales,
    commissions: a.commissions + d.commissions, otherExpenses: a.otherExpenses + d.otherExpenses,
    netProfit: a.netProfit + d.netProfit,
  }), { vehicles: 0, grossSales: 0, commissions: 0, otherExpenses: 0, netProfit: 0 });

  res.json({ days, totals });
});

// ---------- Employees & Payroll ----------

app.get('/api/employees', async (req, res) => {
  res.json(await db.prepare('SELECT * FROM employees WHERE active=1 ORDER BY id').all());
});

app.post('/api/employees', async (req, res) => {
  const e = req.body;
  if (!e.name || !String(e.name).trim()) return res.status(400).json({ error: 'Employee name required' });
  const info = await db.prepare('INSERT INTO employees (name, role, rate_per_day, construction_rate) VALUES (?,?,?,?)')
    .run(String(e.name).trim(), e.role || '', e.rate_per_day || 0, e.construction_rate || 0);
  res.json(await db.prepare('SELECT * FROM employees WHERE id=?').get(info.lastInsertRowid));
});

app.put('/api/employees/:id', async (req, res) => {
  const fields = ['name', 'role', 'rate_per_day', 'construction_rate'];
  const updates = fields.filter(f => f in req.body);
  if (!updates.length) return res.status(400).json({ error: 'No employee fields supplied' });
  const values = { ...req.body, id: req.params.id };
  for (const field of ['rate_per_day', 'construction_rate']) {
    if (field in values) values[field] = Number(values[field] || 0);
  }
  await db.prepare(`UPDATE employees SET ${updates.map(f => `${f}=@${f}`).join(', ')} WHERE id=@id`).run(values);
  res.json(await db.prepare('SELECT * FROM employees WHERE id=?').get(req.params.id));
});

app.delete('/api/employees/:id', async (req, res) => {
  await db.prepare('UPDATE employees SET active=0 WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

function attendanceTotals(entry) {
  let attendance = {};
  try { attendance = JSON.parse(entry.attendance || '{}'); } catch (_) { attendance = {}; }
  const totals = { full: 0, half: 0, construction: 0, constructionHalf: 0, absences: 0, daysOff: 0 };
  for (const code of Object.values(attendance)) {
    if (code === 'P') totals.full += 1;
    else if (code === '0.5P') totals.half += 1;
    else if (code === 'CN') totals.construction += 1;
    else if (code === '0.5CN') totals.constructionHalf += 1;
    else if (code === 'A') totals.absences += 1;
    else if (code === 'OFF') totals.daysOff += 1;
  }
  return totals;
}

function attendanceObject(entry) {
  try { return JSON.parse(entry.attendance || '{}'); } catch (_) { return {}; }
}

function mondayPeriod(periodLabel) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(periodLabel || '');
  if (!match) return periodLabel;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  const day = date.getUTCDay();
  date.setUTCDate(date.getUTCDate() - (day === 0 ? 6 : day - 1));
  return date.toISOString().slice(0, 10);
}

app.get('/api/payroll/:periodLabel', async (req, res) => {
  const periodLabel = mondayPeriod(req.params.periodLabel);
  const employees = await db.prepare('SELECT * FROM employees WHERE active=1 ORDER BY id').all();
  const entries = await db.prepare('SELECT * FROM payroll_entries WHERE period_label=?').all(periodLabel);
  const merged = employees.map(emp => {
    const entry = entries.find(e => e.employee_id === emp.id) || {
      employee_id: emp.id, period_label: periodLabel, attendance: '{}', days_worked: 0, half_days: 0,
      absences: 0, day_off: 0, ot_hours: 0,
      cw_ot_hours: 0, cn_ot_hours: 0, construction_days: 0, deductions: 0, notes: '',
    };
    const attendance = attendanceObject(entry);
    const hasAttendance = Object.keys(attendance).length > 0;
    const totals = attendanceTotals(entry);
    const fullDays = totals.full;
    const halfDays = totals.half;
    const constructionDays = totals.construction;
    const regularPay = Number(emp.rate_per_day) * fullDays;
    const halfDayPay = Number(emp.rate_per_day) * halfDays * 0.5;
    const constructionHalfPay = Number(emp.construction_rate) * totals.constructionHalf * 0.5;
    const cwOtPay = Number(emp.rate_per_day) / 8 * 1.25 * Number(entry.cw_ot_hours || entry.ot_hours || 0);
    const cnOtPay = Number(emp.construction_rate) / 8 * 1.25 * Number(entry.cn_ot_hours || 0);
    const constructionPay = Number(emp.construction_rate) * constructionDays;
    const finalAbsences = totals.absences;
    const finalDaysOff = totals.daysOff;
    const computedEntry = { ...entry, days_worked: fullDays, half_days: halfDays, construction_days: constructionDays, absences: finalAbsences, day_off: finalDaysOff };
    const finalSalary = regularPay + halfDayPay + constructionHalfPay + cwOtPay + cnOtPay + constructionPay - Number(entry.deductions || 0);
    return { employee: emp, entry: computedEntry, regularPay, halfDayPay, constructionHalfPay, cwOtPay, cnOtPay, constructionPay, finalSalary };
  });
  const totalNetPay = merged.reduce((s, m) => s + m.finalSalary, 0);
  res.json({ periodLabel, rows: merged, totalNetPay });
});

app.put('/api/payroll/:periodLabel/:employeeId', async (req, res) => {
  const periodLabel = mondayPeriod(req.params.periodLabel);
  const { employeeId } = req.params;
  const b = req.body;
  const existing = await db.prepare('SELECT id FROM payroll_entries WHERE employee_id=? AND period_label=?').get(employeeId, periodLabel);

  if (existing) {
    await db.prepare(`UPDATE payroll_entries SET attendance=@attendance, days_worked=@days_worked, half_days=@half_days,
      absences=@absences, day_off=@day_off, ot_hours=@ot_hours,
      cw_ot_hours=@cw_ot_hours, cn_ot_hours=@cn_ot_hours,
      construction_days=@construction_days, deductions=@deductions, notes=@notes WHERE id=@id`)
      .run({
        attendance: JSON.stringify(b.attendance || {}),
        days_worked: Number(b.days_worked || 0),
        half_days: Number(b.half_days || 0),
        absences: Number(b.absences || 0),
        day_off: Number(b.day_off || 0),
        ot_hours: Number(b.ot_hours || 0),
        cw_ot_hours: Number(b.cw_ot_hours || 0),
        cn_ot_hours: Number(b.cn_ot_hours || 0),
        construction_days: Number(b.construction_days || 0),
        deductions: Number(b.deductions || 0),
        notes: b.notes || '',
        id: existing.id,
      });
  } else {
    await db.prepare(`INSERT INTO payroll_entries (employee_id, period_label, attendance, days_worked, half_days, absences, day_off, ot_hours, cw_ot_hours, cn_ot_hours, construction_days, deductions, notes)
      VALUES (@employee_id,@period_label,@attendance,@days_worked,@half_days,@absences,@day_off,@ot_hours,@cw_ot_hours,@cn_ot_hours,@construction_days,@deductions,@notes)`).run({
        employee_id: Number(employeeId),
        period_label: periodLabel,
        attendance: JSON.stringify(b.attendance || {}),
        days_worked: Number(b.days_worked || 0),
        half_days: Number(b.half_days || 0),
        absences: Number(b.absences || 0),
        day_off: Number(b.day_off || 0),
        ot_hours: Number(b.ot_hours || 0),
        cw_ot_hours: Number(b.cw_ot_hours || 0),
        cn_ot_hours: Number(b.cn_ot_hours || 0),
        construction_days: Number(b.construction_days || 0),
        deductions: Number(b.deductions || 0),
        notes: b.notes || '',
      });
  }
  res.json({ ok: true });
});

if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`GM QA running on port ${PORT}`));
}

module.exports = app;
