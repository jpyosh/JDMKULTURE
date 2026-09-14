const express = require('express');
const fs = require('fs');
const path = require('path');
const { db, init, CLASSES } = require('./db');

fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
init();

const app = express();
app.use(express.json());
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
function computeJob(job) {
  const service = job.service_id ? db.prepare('SELECT * FROM services WHERE id=?').get(job.service_id) : null;
  const addon = job.addon_id ? db.prepare('SELECT * FROM addons WHERE id=?').get(job.addon_id) : null;
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

// ---------- Pricing Matrix ----------

app.get('/api/pricing', (req, res) => {
  const services = db.prepare('SELECT * FROM services ORDER BY id').all();
  const addons = db.prepare('SELECT * FROM addons ORDER BY id').all();
  res.json({ classes: CLASSES, services, addons });
});

app.put('/api/pricing/service/:id', (req, res) => {
  const fields = ['name', 'price_S', 'price_M', 'price_L', 'price_XL', 'price_MOTO', 'price_BIG_MOTO', 'comm_S', 'comm_M', 'comm_L', 'comm_XL', 'comm_MOTO', 'comm_BIG_MOTO'];
  const updates = fields.filter(f => f in req.body);
  const set = updates.map(f => `${f}=@${f}`).join(', ');
  db.prepare(`UPDATE services SET ${set} WHERE id=@id`).run({ ...req.body, id: req.params.id });
  res.json(db.prepare('SELECT * FROM services WHERE id=?').get(req.params.id));
});

app.post('/api/pricing/service', (req, res) => {
  const s = req.body;
  const info = db.prepare(`INSERT INTO services (name, price_S, price_M, price_L, price_XL, price_MOTO, price_BIG_MOTO, comm_S, comm_M, comm_L, comm_XL, comm_MOTO, comm_BIG_MOTO)
    VALUES (@name,@price_S,@price_M,@price_L,@price_XL,@price_MOTO,@price_BIG_MOTO,@comm_S,@comm_M,@comm_L,@comm_XL,@comm_MOTO,@comm_BIG_MOTO)`).run(s);
  res.json(db.prepare('SELECT * FROM services WHERE id=?').get(info.lastInsertRowid));
});

app.put('/api/pricing/addon/:id', (req, res) => {
  const fields = ['name', 'price_S', 'price_M', 'price_L', 'price_XL', 'price_MOTO', 'price_BIG_MOTO', 'comm_S', 'comm_M', 'comm_L', 'comm_XL', 'comm_MOTO', 'comm_BIG_MOTO'];
  const updates = fields.filter(f => f in req.body);
  const set = updates.map(f => `${f}=@${f}`).join(', ');
  db.prepare(`UPDATE addons SET ${set} WHERE id=@id`).run({ ...req.body, id: req.params.id });
  res.json(db.prepare('SELECT * FROM addons WHERE id=?').get(req.params.id));
});

app.post('/api/pricing/addon', (req, res) => {
  const a = req.body;
  const info = db.prepare(`INSERT INTO addons (name, price_S, price_M, price_L, price_XL, price_MOTO, price_BIG_MOTO, comm_S, comm_M, comm_L, comm_XL, comm_MOTO, comm_BIG_MOTO)
    VALUES (@name,@price_S,@price_M,@price_L,@price_XL,@price_MOTO,@price_BIG_MOTO,@comm_S,@comm_M,@comm_L,@comm_XL,@comm_MOTO,@comm_BIG_MOTO)`).run(a);
  res.json(db.prepare('SELECT * FROM addons WHERE id=?').get(info.lastInsertRowid));
});

// ---------- Daily Log / Jobs ----------

app.get('/api/jobs/:date', (req, res) => {
  const jobs = db.prepare('SELECT * FROM jobs WHERE job_date=? ORDER BY id').all(req.params.date);
  const enriched = jobs.map(j => ({ ...j, computed: computeJob(j) }));
  res.json(enriched);
});

app.post('/api/jobs', (req, res) => {
  const j = req.body;
  if (!j.job_date) return res.status(400).json({ error: 'job_date required' });

  const seq = db.prepare('SELECT COUNT(*) c FROM jobs WHERE job_date=?').get(j.job_date).c + 1;
  const jo_number = j.vehicle_class ? joNumber(j.job_date, seq) : null;

  const info = db.prepare(`INSERT INTO jobs
    (jo_number, job_date, time_in, vehicle_class, plate, service_id, addon_id, addon_price_override,
     custom_addon_name, custom_price, custom_comm, discount, discount_reason, tip_gcash, payment_method, detailer, remarks)
    VALUES (@jo_number,@job_date,@time_in,@vehicle_class,@plate,@service_id,@addon_id,@addon_price_override,
     @custom_addon_name,@custom_price,@custom_comm,@discount,@discount_reason,@tip_gcash,@payment_method,@detailer,@remarks)`)
    .run({
      jo_number, job_date: j.job_date, time_in: j.time_in || null, vehicle_class: j.vehicle_class || null,
      plate: j.plate || null, service_id: j.service_id || null, addon_id: j.addon_id || null,
      addon_price_override: j.addon_price_override ?? null, custom_addon_name: j.custom_addon_name || null,
      custom_price: j.custom_price || 0, custom_comm: j.custom_comm || 0, discount: j.discount || 0,
      discount_reason: j.discount_reason || null, tip_gcash: j.tip_gcash || 0,
      payment_method: j.payment_method || 'Cash', detailer: j.detailer || null, remarks: j.remarks || null,
    });

  const job = db.prepare('SELECT * FROM jobs WHERE id=?').get(info.lastInsertRowid);
  res.json({ ...job, computed: computeJob(job) });
});

app.put('/api/jobs/:id', (req, res) => {
  const fields = ['time_in', 'vehicle_class', 'plate', 'service_id', 'addon_id', 'addon_price_override',
    'custom_addon_name', 'custom_price', 'custom_comm', 'discount', 'discount_reason', 'tip_gcash',
    'payment_method', 'detailer', 'remarks'];
  const updates = fields.filter(f => f in req.body);
  if (updates.length) {
    const set = updates.map(f => `${f}=@${f}`).join(', ');
    db.prepare(`UPDATE jobs SET ${set} WHERE id=@id`).run({ ...req.body, id: req.params.id });
  }
  const job = db.prepare('SELECT * FROM jobs WHERE id=?').get(req.params.id);
  res.json({ ...job, computed: computeJob(job) });
});

app.delete('/api/jobs/:id', (req, res) => {
  db.prepare('DELETE FROM jobs WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ---------- Expenses ----------

app.get('/api/expenses/:date', (req, res) => {
  res.json(db.prepare('SELECT * FROM expenses WHERE expense_date=? ORDER BY id').all(req.params.date));
});

app.post('/api/expenses', (req, res) => {
  const e = req.body;
  const info = db.prepare('INSERT INTO expenses (expense_date, side, description, amount) VALUES (?,?,?,?)')
    .run(e.expense_date, e.side, e.description || '', e.amount || 0);
  res.json(db.prepare('SELECT * FROM expenses WHERE id=?').get(info.lastInsertRowid));
});

app.delete('/api/expenses/:id', (req, res) => {
  db.prepare('DELETE FROM expenses WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ---------- Daily meta (float / actual counts) ----------

app.get('/api/meta/:date', (req, res) => {
  const meta = db.prepare('SELECT * FROM daily_meta WHERE job_date=?').get(req.params.date);
  res.json(meta || { job_date: req.params.date, supervisor: '', cash_float: 0, actual_cash: null, actual_gcash: null, gcash_tips_to_distribute: 0 });
});

app.put('/api/meta/:date', (req, res) => {
  const m = req.body;
  db.prepare(`INSERT INTO daily_meta (job_date, supervisor, cash_float, actual_cash, actual_gcash, gcash_tips_to_distribute)
    VALUES (@job_date,@supervisor,@cash_float,@actual_cash,@actual_gcash,@gcash_tips_to_distribute)
    ON CONFLICT(job_date) DO UPDATE SET supervisor=excluded.supervisor, cash_float=excluded.cash_float,
      actual_cash=excluded.actual_cash, actual_gcash=excluded.actual_gcash,
      gcash_tips_to_distribute=excluded.gcash_tips_to_distribute`)
    .run({ job_date: req.params.date, supervisor: m.supervisor || '', cash_float: m.cash_float || 0,
      actual_cash: m.actual_cash, actual_gcash: m.actual_gcash, gcash_tips_to_distribute: m.gcash_tips_to_distribute || 0 });
  res.json(db.prepare('SELECT * FROM daily_meta WHERE job_date=?').get(req.params.date));
});

// ---------- EOD Dashboard (the fixed reconciliation) ----------

app.get('/api/eod/:date', (req, res) => {
  const date = req.params.date;
  const jobs = db.prepare('SELECT * FROM jobs WHERE job_date=?').all(date).map(j => ({ ...j, computed: computeJob(j) }));
  const expenses = db.prepare('SELECT * FROM expenses WHERE expense_date=?').all(date);
  const meta = db.prepare('SELECT * FROM daily_meta WHERE job_date=?').get(date)
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

  const expectedCashPre = Number(meta.cash_float || 0) + cashSales;
  const expectedCashAfter = expectedCashPre - totalComm - cashExpenses;
  const expectedGcashPre = digitalSales;
  const expectedGcashAfter = expectedGcashPre - gcashExpenses - Number(meta.gcash_tips_to_distribute || 0);
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
    gcashTipsToDistribute: Number(meta.gcash_tips_to_distribute || 0),
  });
});

// ---------- Weekly rollup ----------

app.get('/api/weekly', (req, res) => {
  const { start, end } = req.query;
  const rows = db.prepare(`
    SELECT job_date,
      SUM(CASE WHEN vehicle_class IS NOT NULL AND vehicle_class != '' THEN 1 ELSE 0 END) as vehicles
    FROM jobs WHERE job_date BETWEEN ? AND ? GROUP BY job_date`).all(start, end);

  const days = rows.map(r => {
    const jobs = db.prepare('SELECT * FROM jobs WHERE job_date=?').all(r.job_date)
      .filter(j => j.vehicle_class).map(j => ({ ...j, computed: computeJob(j) }));
    const gross = jobs.reduce((s, j) => s + j.computed.totalPrice, 0);
    const comm = jobs.reduce((s, j) => s + j.computed.detailerComm, 0);
    const expenses = db.prepare('SELECT SUM(amount) t FROM expenses WHERE expense_date=?').get(r.job_date).t || 0;
    return { date: r.job_date, vehicles: r.vehicles, grossSales: gross, commissions: comm, otherExpenses: expenses, netProfit: gross - comm - expenses };
  });

  const totals = days.reduce((a, d) => ({
    vehicles: a.vehicles + d.vehicles, grossSales: a.grossSales + d.grossSales,
    commissions: a.commissions + d.commissions, otherExpenses: a.otherExpenses + d.otherExpenses,
    netProfit: a.netProfit + d.netProfit,
  }), { vehicles: 0, grossSales: 0, commissions: 0, otherExpenses: 0, netProfit: 0 });

  res.json({ days, totals });
});

// ---------- Employees & Payroll ----------

app.get('/api/employees', (req, res) => {
  res.json(db.prepare('SELECT * FROM employees WHERE active=1 ORDER BY id').all());
});

app.post('/api/employees', (req, res) => {
  const e = req.body;
  const info = db.prepare('INSERT INTO employees (name, rate_per_day, construction_rate) VALUES (?,?,?)')
    .run(e.name, e.rate_per_day || 0, e.construction_rate || 0);
  res.json(db.prepare('SELECT * FROM employees WHERE id=?').get(info.lastInsertRowid));
});

app.get('/api/payroll/:periodLabel', (req, res) => {
  const employees = db.prepare('SELECT * FROM employees WHERE active=1 ORDER BY id').all();
  const entries = db.prepare('SELECT * FROM payroll_entries WHERE period_label=?').all(req.params.periodLabel);
  const merged = employees.map(emp => {
    const entry = entries.find(e => e.employee_id === emp.id) || {
      employee_id: emp.id, period_label: req.params.periodLabel, days_worked: 0, day_off: 0,
      construction_days: 0, deductions: 0, notes: '',
    };
    const regularPay = Number(emp.rate_per_day) * Number(entry.days_worked || 0);
    const constructionPay = Number(emp.construction_rate) * Number(entry.construction_days || 0);
    const finalSalary = regularPay + constructionPay - Number(entry.deductions || 0);
    return { employee: emp, entry, regularPay, constructionPay, finalSalary };
  });
  const totalNetPay = merged.reduce((s, m) => s + m.finalSalary, 0);
  res.json({ periodLabel: req.params.periodLabel, rows: merged, totalNetPay });
});

app.put('/api/payroll/:periodLabel/:employeeId', (req, res) => {
  const { periodLabel, employeeId } = req.params;
  const b = req.body;
  db.prepare(`INSERT INTO payroll_entries (employee_id, period_label, days_worked, day_off, construction_days, deductions, notes)
    VALUES (@employee_id,@period_label,@days_worked,@day_off,@construction_days,@deductions,@notes)
    ON CONFLICT(id) DO NOTHING`);
  const existing = db.prepare('SELECT id FROM payroll_entries WHERE employee_id=? AND period_label=?').get(employeeId, periodLabel);
  if (existing) {
    db.prepare(`UPDATE payroll_entries SET days_worked=@days_worked, day_off=@day_off,
      construction_days=@construction_days, deductions=@deductions, notes=@notes WHERE id=@id`)
      .run({ ...b, id: existing.id });
  } else {
    db.prepare(`INSERT INTO payroll_entries (employee_id, period_label, days_worked, day_off, construction_days, deductions, notes)
      VALUES (?,?,?,?,?,?,?)`).run(employeeId, periodLabel, b.days_worked || 0, b.day_off || 0, b.construction_days || 0, b.deductions || 0, b.notes || '');
  }
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`GM QA running on port ${PORT}`));
