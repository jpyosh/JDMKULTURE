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
async function computeJob(job) {
  const service = job.service_id ? await db.prepare('SELECT * FROM services WHERE id=?').get(job.service_id) : null;
  const addon = job.addon_id ? await db.prepare('SELECT * FROM addons WHERE id=?').get(job.addon_id) : null;
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

function joNumber(dateStr, seq) {
  // date comes in as YYYY-MM-DD from <input type=date>; sheet format is MMDDYY
  const [y, m, d] = dateStr.split('-');
  return `JO-${m}${d}${y.slice(2)}-${String(seq).padStart(3, '0')}`;
}

const supabaseAuth = process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY)
  : null;

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
  const set = updates.map(f => `${f}=@${f}`).join(', ');
  await db.prepare(`UPDATE services SET ${set} WHERE id=@id`).run({ ...req.body, id: req.params.id });
  res.json(await db.prepare('SELECT * FROM services WHERE id=?').get(req.params.id));
});

app.post('/api/pricing/service', async (req, res) => {
  const s = req.body;
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
  const set = updates.map(f => `${f}=@${f}`).join(', ');
  await db.prepare(`UPDATE addons SET ${set} WHERE id=@id`).run({ ...req.body, id: req.params.id });
  res.json(await db.prepare('SELECT * FROM addons WHERE id=?').get(req.params.id));
});

app.post('/api/pricing/addon', async (req, res) => {
  const a = req.body;
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
  const jobs = await db.prepare('SELECT * FROM jobs WHERE job_date=? ORDER BY id').all(req.params.date);
  const enriched = await Promise.all(jobs.map(async j => ({ ...j, computed: await computeJob(j) })));
  res.json(enriched);
});

app.post('/api/jobs', async (req, res) => {
  const j = req.body;
  if (!j.job_date) return res.status(400).json({ error: 'job_date required' });
  if (j.vehicle_class && !CLASSES.includes(j.vehicle_class)) return res.status(400).json({ error: 'Invalid vehicle class' });
  if (j.payment_method && !['Cash', 'GCash'].includes(j.payment_method)) return res.status(400).json({ error: 'Invalid payment method' });
  for (const field of ['custom_price', 'custom_comm', 'discount', 'tip_gcash']) {
    if (Number(j[field] || 0) < 0) return res.status(400).json({ error: `${field} cannot be negative` });
  }

  const seq = Number((await db.prepare('SELECT COUNT(*) c FROM jobs WHERE job_date=?').get(j.job_date)).c) + 1;
  const jo_number = joNumber(j.job_date, seq);

  const info = await db.prepare(`INSERT INTO jobs
    (jo_number, job_date, time_in, time_out, vehicle_class, plate, service_id, addon_id, addon_price_override,
     custom_addon_name, custom_price, custom_comm, discount, discount_reason, tip_gcash, payment_method, detailer, remarks)
    VALUES (@jo_number,@job_date,@time_in,@time_out,@vehicle_class,@plate,@service_id,@addon_id,@addon_price_override,
     @custom_addon_name,@custom_price,@custom_comm,@discount,@discount_reason,@tip_gcash,@payment_method,@detailer,@remarks)`)
    .run({
      jo_number, job_date: j.job_date, time_in: j.time_in || null, time_out: j.time_out || null, vehicle_class: j.vehicle_class || null,
      plate: j.plate || null, service_id: j.service_id || null, addon_id: j.addon_id || null,
      addon_price_override: j.addon_price_override ?? null, custom_addon_name: j.custom_addon_name || null,
      custom_price: j.custom_price || 0, custom_comm: j.custom_comm || 0, discount: j.discount || 0,
      discount_reason: j.discount_reason || null, tip_gcash: j.tip_gcash || 0,
      payment_method: j.payment_method || 'Cash', detailer: j.detailer || null, remarks: j.remarks || null,
    });

  const job = await db.prepare('SELECT * FROM jobs WHERE id=?').get(info.lastInsertRowid);
  res.json({ ...job, computed: await computeJob(job) });
});

app.put('/api/jobs/:id', async (req, res) => {
  const fields = ['time_in', 'time_out', 'vehicle_class', 'plate', 'service_id', 'addon_id', 'addon_price_override',
    'custom_addon_name', 'custom_price', 'custom_comm', 'discount', 'discount_reason', 'tip_gcash',
    'payment_method', 'detailer', 'remarks'];
  const updates = fields.filter(f => f in req.body);
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
  res.json(meta || { job_date: req.params.date, supervisor: '', cash_float: 0, actual_cash: null, actual_gcash: null, gcash_tips_to_distribute: 0 });
});

app.put('/api/meta/:date', async (req, res) => {
  const m = req.body;
  await db.prepare(`INSERT INTO daily_meta (job_date, supervisor, cash_float, actual_cash, actual_gcash, gcash_tips_to_distribute)
    VALUES (@job_date,@supervisor,@cash_float,@actual_cash,@actual_gcash,@gcash_tips_to_distribute)
    ON CONFLICT(job_date) DO UPDATE SET supervisor=excluded.supervisor, cash_float=excluded.cash_float,
      actual_cash=excluded.actual_cash, actual_gcash=excluded.actual_gcash,
      gcash_tips_to_distribute=excluded.gcash_tips_to_distribute`)
    .run({ job_date: req.params.date, supervisor: m.supervisor || '', cash_float: m.cash_float || 0,
      actual_cash: m.actual_cash, actual_gcash: m.actual_gcash, gcash_tips_to_distribute: m.gcash_tips_to_distribute || 0 });
  res.json(await db.prepare('SELECT * FROM daily_meta WHERE job_date=?').get(req.params.date));
});

// ---------- EOD Dashboard (the fixed reconciliation) ----------

app.get('/api/eod/:date', async (req, res) => {
  const date = req.params.date;
  const rawJobs = await db.prepare('SELECT * FROM jobs WHERE job_date=?').all(date);
  const jobs = await Promise.all(rawJobs.map(async j => ({ ...j, computed: await computeJob(j) })));
  const expenses = await db.prepare('SELECT * FROM expenses WHERE expense_date=?').all(date);
  const meta = await db.prepare('SELECT * FROM daily_meta WHERE job_date=?').get(date)
    || { cash_float: 0, actual_cash: null, actual_gcash: null, gcash_tips_to_distribute: 0, supervisor: '' };

  const servicedJobs = jobs.filter(j => j.vehicle_class);
  const totalVehicles = servicedJobs.length; // native dynamic count — replaces the broken COUNTUNIQUEIFS
  const grossSales = servicedJobs.reduce((s, j) => s + j.computed.totalPrice, 0);
  const totalComm = servicedJobs.reduce((s, j) => s + j.computed.detailerComm, 0);
  // FIX (audit bug): this is the ONLY subtraction of commission. The old sheet subtracted it once
  // per row (in Net Shop Revenue) AND again here, understating profit by a full day's commission.
  const totalNetRevenue = grossSales - totalComm;

  const cashSales = servicedJobs.filter(j => j.payment_method === 'Cash').reduce((s, j) => s + j.computed.totalPrice, 0);
  const digitalSales = grossSales - cashSales; // GCash + Maya + anything not Cash

  const cashExpenses = expenses.filter(e => e.side === 'cash').reduce((s, e) => s + Number(e.amount || 0), 0);
  const gcashExpenses = expenses.filter(e => e.side === 'gcash').reduce((s, e) => s + Number(e.amount || 0), 0);
  const jobGcashTips = servicedJobs.reduce((s, j) => s + Number(j.tip_gcash || 0), 0);
  const manualGcashTips = Number(meta.gcash_tips_to_distribute || 0);
  const gcashTipsToDistribute = manualGcashTips + jobGcashTips;

  const expectedCashPre = Number(meta.cash_float || 0) + cashSales;
  const expectedCashAfter = expectedCashPre - totalComm - cashExpenses;
  const expectedGcashPre = digitalSales;
  const expectedGcashAfter = expectedGcashPre - gcashExpenses - gcashTipsToDistribute;
  const expectedTotal = expectedCashAfter + expectedGcashAfter;

  const actualCash = meta.actual_cash;
  const actualGcash = meta.actual_gcash;
  const actualTotal = (actualCash || 0) + (actualGcash || 0);

  const cashVariance = actualCash != null ? actualCash - expectedCashAfter : null;
  const gcashVariance = actualGcash != null ? actualGcash - expectedGcashAfter : null;

  res.json({
    date, supervisor: meta.supervisor, cashFloat: Number(meta.cash_float || 0),
    totalVehicles, grossSales, totalComm, totalNetRevenue,
    cashSales, digitalSales, cashExpenses, gcashExpenses, expenses,
    expectedCashPre, expectedCashAfter, expectedGcashPre, expectedGcashAfter, expectedTotal,
    actualCash, actualGcash, actualTotal,
    cashVariance, gcashVariance,
    gcashTipsToDistribute, jobGcashTips, manualGcashTips,
  });
});

// ---------- Weekly rollup ----------

app.get('/api/weekly', async (req, res) => {
  const { start, end } = req.query;
  const rows = await db.prepare(`
    SELECT job_date FROM jobs WHERE job_date BETWEEN ? AND ?
    UNION SELECT expense_date AS job_date FROM expenses WHERE expense_date BETWEEN ? AND ?
    ORDER BY job_date`).all(start, end, start, end);

  const days = await Promise.all(rows.map(async r => {
    const dayJobs = await db.prepare('SELECT * FROM jobs WHERE job_date=?').all(r.job_date);
    const jobs = (await Promise.all(dayJobs
      .filter(j => j.vehicle_class).map(async j => ({ ...j, computed: await computeJob(j) }))));
    const gross = jobs.reduce((s, j) => s + j.computed.totalPrice, 0);
    const comm = jobs.reduce((s, j) => s + j.computed.detailerComm, 0);
    const expenses = (await db.prepare('SELECT SUM(amount) t FROM expenses WHERE expense_date=?').get(r.job_date)).t || 0;
    return { date: r.job_date, vehicles: jobs.length, grossSales: gross, commissions: comm, otherExpenses: expenses, netProfit: gross - comm - expenses };
  }));

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
