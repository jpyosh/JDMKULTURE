if (process.env.DATABASE_URL) {
  module.exports = require('./pg-db');
} else {
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const dataDir = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(dataDir, { recursive: true });

const dbPath = path.join(dataDir, 'gmqa.sqlite');
const bundledDbPath = path.join(__dirname, 'data', 'gmqa.sqlite');
if (process.env.DATA_DIR && !fs.existsSync(dbPath) && fs.existsSync(bundledDbPath)) {
  fs.copyFileSync(bundledDbPath, dbPath);
}

// SQLite file lives next to the app so it persists on disk (Render/Railway with a
// persistent volume, or just the local filesystem in dev).
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

const CLASSES = ['S', 'M', 'L', 'XL', 'MOTO', 'BIG_MOTO'];

function init() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS services (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      price_S REAL DEFAULT 0, price_M REAL DEFAULT 0, price_L REAL DEFAULT 0,
      price_XL REAL DEFAULT 0, price_MOTO REAL DEFAULT 0, price_BIG_MOTO REAL DEFAULT 0,
      comm_S REAL DEFAULT 0, comm_M REAL DEFAULT 0, comm_L REAL DEFAULT 0,
      comm_XL REAL DEFAULT 0, comm_MOTO REAL DEFAULT 0, comm_BIG_MOTO REAL DEFAULT 0,
      is_custom INTEGER DEFAULT 0,
      active INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS addons (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      price_S REAL DEFAULT 0, price_M REAL DEFAULT 0, price_L REAL DEFAULT 0,
      price_XL REAL DEFAULT 0, price_MOTO REAL DEFAULT 0, price_BIG_MOTO REAL DEFAULT 0,
      comm_S REAL DEFAULT 0, comm_M REAL DEFAULT 0, comm_L REAL DEFAULT 0,
      comm_XL REAL DEFAULT 0, comm_MOTO REAL DEFAULT 0, comm_BIG_MOTO REAL DEFAULT 0,
      active INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      jo_number TEXT,
      job_date TEXT NOT NULL,
      time_in TEXT,
      time_out TEXT,
      vehicle_class TEXT,
      plate TEXT,
      service_id INTEGER,
      addon_id INTEGER,
      addon_price_override REAL,
      custom_addon_name TEXT,
      custom_price REAL DEFAULT 0,
      custom_comm REAL DEFAULT 0,
      discount REAL DEFAULT 0,
      discount_reason TEXT,
      tip_gcash REAL DEFAULT 0,
      payment_method TEXT DEFAULT 'Cash',
      payment_received INTEGER DEFAULT 1,
      commission_paid INTEGER DEFAULT 1,
      commission_payment_method TEXT DEFAULT 'Cash',
      commission_cash_paid REAL,
      commission_gcash_paid REAL,
      detailer TEXT,
      remarks TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS expenses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      expense_date TEXT NOT NULL,
      side TEXT NOT NULL, -- 'cash' or 'gcash'
      description TEXT,
      amount REAL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS daily_meta (
      job_date TEXT PRIMARY KEY,
      supervisor TEXT,
      cash_float REAL DEFAULT 0,
      actual_cash REAL,
      actual_gcash REAL,
      gcash_tips_to_distribute REAL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS employees (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      role TEXT DEFAULT '',
      rate_per_day REAL DEFAULT 0,
      construction_rate REAL DEFAULT 700,
      active INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS payroll_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_id INTEGER NOT NULL,
      period_label TEXT NOT NULL,
      attendance TEXT DEFAULT '{}',
      days_worked REAL DEFAULT 0,
      half_days REAL DEFAULT 0,
      absences REAL DEFAULT 0,
      day_off INTEGER DEFAULT 0,
      ot_hours REAL DEFAULT 0,
      cw_ot_hours REAL DEFAULT 0,
      cn_ot_hours REAL DEFAULT 0,
      construction_days REAL DEFAULT 0,
      deductions REAL DEFAULT 0,
      notes TEXT
    );
  `);

  ensureSchemaColumns();
  db.exec(`
    CREATE INDEX IF NOT EXISTS jobs_job_date_idx ON jobs(job_date);
    CREATE INDEX IF NOT EXISTS jobs_service_idx ON jobs(service_id);
    CREATE INDEX IF NOT EXISTS jobs_addon_idx ON jobs(addon_id);
    CREATE INDEX IF NOT EXISTS jobs_commission_paid_idx ON jobs(commission_paid);
    CREATE INDEX IF NOT EXISTS jobs_payment_received_idx ON jobs(payment_received);
    CREATE INDEX IF NOT EXISTS expenses_expense_date_idx ON expenses(expense_date);
  `);
  seedIfEmpty();
}

function ensureSchemaColumns() {
  const addColumnIfMissing = (table, column, type) => {
    const exists = db.prepare(`PRAGMA table_info(${table})`).all().some(col => col.name === column);
    if (!exists) {
      db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`).run();
    }
  };

  addColumnIfMissing('services', 'price_BIG_MOTO', 'REAL DEFAULT 0');
  addColumnIfMissing('services', 'comm_BIG_MOTO', 'REAL DEFAULT 0');
  addColumnIfMissing('addons', 'price_BIG_MOTO', 'REAL DEFAULT 0');
  addColumnIfMissing('addons', 'comm_BIG_MOTO', 'REAL DEFAULT 0');
  addColumnIfMissing('jobs', 'time_out', 'TEXT');
  addColumnIfMissing('jobs', 'payment_received', 'INTEGER DEFAULT 1');
  addColumnIfMissing('jobs', 'commission_paid', 'INTEGER DEFAULT 1');
  addColumnIfMissing('jobs', 'commission_payment_method', "TEXT DEFAULT 'Cash'");
  addColumnIfMissing('jobs', 'commission_cash_paid', 'REAL');
  addColumnIfMissing('jobs', 'commission_gcash_paid', 'REAL');
  addColumnIfMissing('payroll_entries', 'half_days', 'REAL DEFAULT 0');
  addColumnIfMissing('payroll_entries', 'absences', 'REAL DEFAULT 0');
  addColumnIfMissing('payroll_entries', 'ot_hours', 'REAL DEFAULT 0');
  addColumnIfMissing('payroll_entries', 'attendance', "TEXT DEFAULT '{}' ");
  addColumnIfMissing('payroll_entries', 'cw_ot_hours', 'REAL DEFAULT 0');
  addColumnIfMissing('payroll_entries', 'cn_ot_hours', 'REAL DEFAULT 0');
  addColumnIfMissing('employees', 'role', "TEXT DEFAULT ''");
}

function seedIfEmpty() {
  const svcCount = db.prepare('SELECT COUNT(*) c FROM services').get().c;
  if (svcCount === 0) {
    const insertSvc = db.prepare(`INSERT INTO services
      (name, price_S, price_M, price_L, price_XL, price_MOTO, price_BIG_MOTO, comm_S, comm_M, comm_L, comm_XL, comm_MOTO, comm_BIG_MOTO, is_custom)
      VALUES (@name, @price_S, @price_M, @price_L, @price_XL, @price_MOTO, @price_BIG_MOTO, @comm_S, @comm_M, @comm_L, @comm_XL, @comm_MOTO, @comm_BIG_MOTO, @is_custom)`);

    const services = [
      { name: 'Standard Wash', price: [250, 300, 350, 400, 150, 220], comm: [0, 0, 0, 0, 0, 0] },
      { name: 'Premium Wash', price: [600, 650, 700, 750, 400, 500], comm: [100, 100, 100, 100, 50, 60] },
      { name: 'Wash and Wax: MTX NanoSil', price: [600, 750, 900, 1050, 550, 650], comm: [100, 100, 100, 100, 100, 120] },
      { name: 'Wash and Wax: Soft99 Fusso Coat', price: [800, 950, 1100, 1250, 550, 700], comm: [150, 150, 150, 150, 100, 120] },
      { name: 'Quick Ext. Detail', price: [2500, 3000, 3500, 4000, 2000, 2800], comm: [500, 600, 700, 800, 400, 520] },
      { name: 'Paint Correction', price: [4500, 5000, 5500, 6000, 0, 0], comm: [900, 1000, 1100, 1200, 0, 0] },
      { name: 'Glass Watermarks Removal', price: [2500, 3000, 3500, 4000, 0, 0], comm: [500, 600, 700, 800, 0, 0] },
      { name: 'Full Exterior Detailing', price: [6500, 7500, 8500, 9500, 0, 0], comm: [1300, 1500, 1700, 1900, 0, 0] },
      { name: 'Interior Detailing', price: [3000, 3500, 4000, 4500, 0, 0], comm: [600, 700, 800, 900, 0, 0] },
      { name: 'Full Interior Detailing', price: [5500, 6000, 6500, 7000, 0, 0], comm: [1100, 1200, 1300, 1400, 0, 0] },
      { name: 'Soft99 H9 Dual Layer Glass Coat', price: [20000, 23000, 26000, 31000, 0, 0], comm: [3000, 3500, 4000, 4500, 0, 0] },
      { name: 'Graphene Ceramic Coating', price: [15000, 18000, 21000, 24000, 0, 0], comm: [3000, 3500, 4000, 4500, 0, 0] },
      { name: 'Ceramic Coating: Motorcycle', price: [3000, 4000, 5000, 0, 3000, 4200], comm: [600, 800, 1000, 0, 600, 800] },
      { name: 'Ceramic Coating w/o maintenance', price: [10000, 12000, 14000, 16000, 0, 0], comm: [2000, 2500, 3000, 3500, 0, 0] },
      { name: 'CUSTOM', price: [0, 0, 0, 0, 0, 0], comm: [0, 0, 0, 0, 0, 0], is_custom: 1 },
    ];

    const tx = db.transaction((rows) => {
      for (const s of rows) {
        insertSvc.run({
          name: s.name,
          price_S: s.price[0], price_M: s.price[1], price_L: s.price[2], price_XL: s.price[3], price_MOTO: s.price[4], price_BIG_MOTO: s.price[5],
          comm_S: s.comm[0], comm_M: s.comm[1], comm_L: s.comm[2], comm_XL: s.comm[3], comm_MOTO: s.comm[4], comm_BIG_MOTO: s.comm[5],
          is_custom: s.is_custom || 0,
        });
      }
    });
    tx(services);
  }

  const addonCount = db.prepare('SELECT COUNT(*) c FROM addons').get().c;
  if (addonCount === 0) {
    const insertAddon = db.prepare(`INSERT INTO addons
      (name, price_S, price_M, price_L, price_XL, price_MOTO, price_BIG_MOTO, comm_S, comm_M, comm_L, comm_XL, comm_MOTO, comm_BIG_MOTO)
      VALUES (@name, @price_S, @price_M, @price_L, @price_XL, @price_MOTO, @price_BIG_MOTO, @comm_S, @comm_M, @comm_L, @comm_XL, @comm_MOTO, @comm_BIG_MOTO)`);

    const addons = [
      { name: 'Asphalt Removal', price: [300, 400, 500, 600, 0, 0], comm: [100, 100, 100, 150, 0, 0] },
      { name: 'Headlight Restoration', price: [2000, 2000, 2000, 2000, 0, 0], comm: [400, 400, 400, 400, 0, 0] },
      { name: 'Waterless Engine Detail', price: [2500, 2500, 2500, 2500, 0, 0], comm: [500, 500, 500, 500, 0, 0] },
      { name: 'Engine Wash', price: [800, 800, 800, 800, 300, 500], comm: [150, 150, 150, 150, 0, 0] },
      { name: 'Bac 2 Zero', price: [600, 600, 600, 600, 600, 800], comm: [100, 100, 100, 100, 0, 0] },
    ];

    const tx = db.transaction((rows) => {
      for (const a of rows) {
        insertAddon.run({
          name: a.name,
          price_S: a.price[0], price_M: a.price[1], price_L: a.price[2], price_XL: a.price[3], price_MOTO: a.price[4], price_BIG_MOTO: a.price[5],
          comm_S: a.comm[0], comm_M: a.comm[1], comm_L: a.comm[2], comm_XL: a.comm[3], comm_MOTO: a.comm[4], comm_BIG_MOTO: a.comm[5],
        });
      }
    });
    tx(addons);
  }

  const empCount = db.prepare('SELECT COUNT(*) c FROM employees').get().c;
  if (empCount === 0) {
    const insertEmp = db.prepare('INSERT INTO employees (name, rate_per_day, construction_rate) VALUES (?, ?, ?)');
    const tx = db.transaction((rows) => {
      for (const e of rows) insertEmp.run(e.name, e.rate, e.construction_rate);
    });
    tx([
      { name: 'JP', rate: 700, construction_rate: 0 },
      { name: 'Menan', rate: 560, construction_rate: 1000 },
      { name: 'Ernesto', rate: 300, construction_rate: 700 },
      { name: 'Jokjok', rate: 250, construction_rate: 700 },
      { name: 'Aljane', rate: 250, construction_rate: 700 },
      { name: 'Michael', rate: 250, construction_rate: 700 },
      { name: 'Joy', rate: 200, construction_rate: 0 },
    ]);
  }
}

module.exports = { db, init, CLASSES };
}
