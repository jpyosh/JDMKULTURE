const path = require('path');
const Database = require('better-sqlite3');
const { Pool } = require('pg');

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
const sqlitePath = process.env.SQLITE_PATH || path.join(__dirname, '..', 'data', 'gmqa.sqlite');
const sqlite = new Database(sqlitePath, { readonly: true });
const connectionString = process.env.DATABASE_URL.replace(/[?&]sslmode=[^&]*/, '');
const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });
const tables = [
  ['services', ['id', 'name', 'price_S', 'price_M', 'price_L', 'price_XL', 'price_MOTO', 'price_BIG_MOTO', 'comm_S', 'comm_M', 'comm_L', 'comm_XL', 'comm_MOTO', 'comm_BIG_MOTO', 'is_custom', 'active']],
  ['addons', ['id', 'name', 'price_S', 'price_M', 'price_L', 'price_XL', 'price_MOTO', 'price_BIG_MOTO', 'comm_S', 'comm_M', 'comm_L', 'comm_XL', 'comm_MOTO', 'comm_BIG_MOTO', 'active']],
  ['jobs', ['id', 'jo_number', 'job_date', 'time_in', 'time_out', 'vehicle_class', 'plate', 'service_id', 'addon_id', 'addon_price_override', 'custom_addon_name', 'custom_price', 'custom_comm', 'discount', 'discount_reason', 'tip_gcash', 'payment_method', 'detailer', 'remarks', 'created_at']],
  ['expenses', ['id', 'expense_date', 'side', 'description', 'amount']],
  ['daily_meta', ['job_date', 'supervisor', 'cash_float', 'actual_cash', 'actual_gcash', 'gcash_tips_to_distribute']],
  ['employees', ['id', 'name', 'role', 'rate_per_day', 'construction_rate', 'active']],
  ['payroll_entries', ['id', 'employee_id', 'period_label', 'attendance', 'days_worked', 'half_days', 'absences', 'day_off', 'ot_hours', 'cw_ot_hours', 'cn_ot_hours', 'construction_days', 'deductions', 'notes']],
];
const quote = name => `"${name.replaceAll('"', '""')}"`;

(async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const [table, columns] of tables) {
      const rows = sqlite.prepare(`SELECT ${columns.map(quote).join(', ')} FROM ${table}`).all();
      if (!rows.length) continue;
      const columnSql = columns.map(quote).join(', ');
      for (const row of rows) {
        const values = columns.map(column => row[column]);
        const placeholders = values.map((_, index) => `$${index + 1}`).join(', ');
        await client.query(`INSERT INTO ${table} (${columnSql}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`, values);
      }
      if (['services', 'addons', 'jobs', 'expenses', 'employees', 'payroll_entries'].includes(table)) {
        await client.query(`SELECT setval(pg_get_serial_sequence('public.${table}', 'id'), COALESCE((SELECT MAX(id) FROM public.${table}), 1), true)`);
      }
    }
    await client.query('COMMIT');
    console.log('SQLite data imported successfully.');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
    await pool.end();
    sqlite.close();
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
