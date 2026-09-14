const { Pool } = require('pg');

const connectionString = process.env.DATABASE_URL.replace(/[?&]sslmode=[^&]*/, '');
const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false },
  max: Number(process.env.PGPOOL_MAX || 5),
});

const CLASSES = ['S', 'M', 'L', 'XL', 'MOTO', 'BIG_MOTO'];
const mixedCaseColumns = ['price_S', 'price_M', 'price_L', 'price_XL', 'price_MOTO', 'price_BIG_MOTO',
  'comm_S', 'comm_M', 'comm_L', 'comm_XL', 'comm_MOTO', 'comm_BIG_MOTO'];
const numericColumns = new Set([
  'id', 'service_id', 'addon_id', 'employee_id', 'is_custom', 'active', 'day_off',
  'price_S', 'price_M', 'price_L', 'price_XL', 'price_MOTO', 'price_BIG_MOTO',
  'comm_S', 'comm_M', 'comm_L', 'comm_XL', 'comm_MOTO', 'comm_BIG_MOTO',
  'addon_price_override', 'custom_price', 'custom_comm', 'discount', 'tip_gcash',
  'amount', 'cash_float', 'actual_cash', 'actual_gcash', 'gcash_tips_to_distribute',
  'rate_per_day', 'construction_rate', 'days_worked', 'half_days', 'absences',
  'ot_hours', 'cw_ot_hours', 'cn_ot_hours', 'construction_days', 'deductions',
  'c', 't', 'vehicles',
]);

function normalizeRow(row) {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [
    key,
    numericColumns.has(key) && value != null ? Number(value) : value,
  ]));
}

function quoteMixedCaseColumns(sql) {
  return mixedCaseColumns.reduce((text, column) =>
    text.replace(new RegExp(`(?<![\\w\"])${column}(?![\\w\"])`, 'g'), `"${column}"`), sql);
}

function prepare(sql) {
  let text = quoteMixedCaseColumns(sql);
  const named = [];
  text = text.replace(/@([A-Za-z_]\w*)/g, (_, name) => {
    named.push(name);
    return `$${named.length}`;
  });
  let positionalIndex = named.length;
  text = text.replace(/\?/g, () => `$${++positionalIndex}`);

  function parameters(args) {
    return named.length ? named.map(name => args[0]?.[name]) : args;
  }

  return {
    async all(...args) { return (await pool.query(text, parameters(args))).rows.map(normalizeRow); },
    async get(...args) { return (await this.all(...args))[0]; },
    async run(...args) {
      const query = /^\s*insert\b/i.test(text) && !/\breturning\b/i.test(text) ? `${text} RETURNING id` : text;
      const result = await pool.query(query, parameters(args));
      return { changes: result.rowCount, lastInsertRowid: result.rows[0]?.id };
    },
  };
}

async function init() {
  await pool.query('SELECT 1');
}

module.exports = { db: { prepare }, init, CLASSES, pool };