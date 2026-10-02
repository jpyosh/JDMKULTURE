// Dress rehearsal: migrate a COPY of a database dump (from `npm run db -- backup`) in a throwaway
// in-memory Postgres, then check that every job amount, expense, payroll deduction and overtime hour
// survived. Production is only read (to take the dump); nothing is written to it.
const { PGlite } = require('@electric-sql/pglite');
const { pgliteDriver, parsers } = require('../lib/db');
const { migrate, loadMigrations } = require('./db');

const LEGACY_TABLES = ['services', 'addons', 'jobs', 'expenses', 'daily_meta', 'employees', 'payroll_entries'];
const CODES = new Set(['P', '0.5P', 'CN', '0.5CN', 'A', 'OFF']);
const quiet = { log: () => {} };
const num = v => Number(v) || 0;
const pos = v => Math.max(num(v), 0);
const round2 = n => Math.round(n * 100) / 100;
const same = (a, b) => Math.abs(num(a) - num(b)) < 0.005;

// Each job's amount as the old app computed it (mirrors the backfill rules in migration 002).
function v1JobAmounts(t) {
  const services = new Map((t.services || []).map(s => [Number(s.id), s]));
  const addons = new Map((t.addons || []).map(a => [Number(a.id), a]));
  return new Map((t.jobs || []).map(j => {
    const cls = j.vehicle_class ? String(j.vehicle_class).trim().toUpperCase() : null;
    const s = services.get(Number(j.service_id));
    const a = addons.get(Number(j.addon_id));
    const service = s && !num(s.is_custom) && cls ? pos(s[`price_${cls}`]) : 0;
    const addon = a ? pos(j.addon_price_override ?? (cls ? a[`price_${cls}`] : 0)) : 0;
    return [Number(j.id), round2(service + addon + pos(j.custom_price))];
  }));
}

function v1Payroll(entries = []) {
  const days = new Set();
  let overtime = 0;
  let deductions = 0;
  for (const p of entries) {
    let attendance = {};
    try { attendance = JSON.parse(p.attendance || '{}'); } catch { attendance = {}; }
    for (const [day, code] of Object.entries(attendance)) if (CODES.has(code)) days.add(`${p.employee_id}|${day}`);
    overtime += (num(p.cw_ot_hours) || num(p.ot_hours)) + num(p.cn_ot_hours);
    deductions += num(p.deductions);
  }
  return { days: days.size, overtime: round2(overtime), deductions: round2(deductions) };
}

async function loadDump(driver, tables) {
  for (const table of LEGACY_TABLES) {
    const rows = tables[table] || [];
    for (const row of rows) {
      const cols = Object.keys(row);
      await driver.query(`insert into public.${table} (${cols.map(c => `"${c}"`).join(', ')}) values (${cols.map((_, i) => `$${i + 1}`).join(', ')})`,
        cols.map(c => row[c]));
    }
    if (rows.length && 'id' in rows[0]) {
      await driver.query(`select setval(pg_get_serial_sequence('public.${table}', 'id'), (select max(id) from public.${table}))`);
    }
  }
}

async function rehearse(dump) {
  const t = dump.tables || {};
  const pglite = await PGlite.create({ parsers });
  const driver = pgliteDriver(pglite);
  const rows = async (sql, params) => (await driver.query(sql, params)).rows;
  const report = { ok: false, applied: [], checks: [] };
  let step = 'loading the baseline schema';
  try {
    report.applied.push(...await migrate(driver, { ...quiet, to: '001' }));
    step = 'loading the data copy into the baseline schema';
    await loadDump(driver, t);
    for (const m of loadMigrations().filter(x => x.version > '001')) {
      step = `migration ${m.version}_${m.name}`;
      report.applied.push(...await migrate(driver, { ...quiet, to: m.version }));
    }

    step = 'checking the result';
    const check = (name, before, after, ok = same(before, after)) => report.checks.push({ name, before, after, ok });
    check('jobs', (t.jobs || []).length, (await rows('select count(*)::int n from jobs'))[0].n);

    const v1 = v1JobAmounts(t);
    const v2 = new Map((await rows('select job_id, sum(price) as total from job_items group by job_id')).map(r => [Number(r.job_id), r.total]));
    const mismatched = [...v1].filter(([jobId, amount]) => !same(amount, v2.get(jobId) || 0)).map(([jobId]) => jobId);
    const sumOf = m => round2([...m.values()].reduce((s, x) => s + num(x), 0));
    report.checks.push({ name: 'job amounts', before: sumOf(v1), after: sumOf(v2), ok: mismatched.length === 0,
      ...(mismatched.length ? { mismatchedJobIds: mismatched } : {}) });

    check('expenses', (t.expenses || []).length, (await rows('select count(*)::int n from expenses'))[0].n);
    check('expenses total', round2((t.expenses || []).reduce((s, e) => s + num(e.amount), 0)),
      (await rows('select coalesce(sum(amount), 0) as s from expenses'))[0].s);
    check('daily records', (t.daily_meta || []).length, (await rows('select count(*)::int n from daily_meta'))[0].n);
    check('employees', (t.employees || []).length, (await rows('select count(*)::int n from employees'))[0].n);

    const payroll = v1Payroll(t.payroll_entries);
    check('attendance days', payroll.days, (await rows('select count(*)::int n from attendance where code is not null'))[0].n);
    check('payroll deductions', payroll.deductions,
      (await rows("select coalesce(sum(amount), 0) as s from payroll_adjustments where kind = 'deduction'"))[0].s);
    check('payroll overtime hours', payroll.overtime,
      (await rows('select coalesce(sum(cw_ot_hours + cn_ot_hours), 0) as s from attendance'))[0].s);

    report.ok = report.checks.every(c => c.ok);
  } catch (error) {
    report.error = `${step} failed: ${error.message}`;
  } finally {
    await pglite.close();
  }
  return report;
}

module.exports = { rehearse };
