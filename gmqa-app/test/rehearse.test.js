const test = require('node:test');
const assert = require('node:assert/strict');
const { rehearse } = require('../scripts/rehearse');
const legacy = require('./fixtures/legacy-data.json');

// A dump in the same shape `npm run db -- backup` writes.
const dumpOf = tables => ({ taken_at: '2026-10-03T00:00:00Z', label: 'test', tables: structuredClone(tables) });

test('rehearsal migrates a copy of the data and confirms nothing was lost', async () => {
  const report = await rehearse(dumpOf(legacy));
  assert.equal(report.ok, true, JSON.stringify(report, null, 1));
  assert.deepEqual(report.applied, ['001', '002', '003', '004', '005', '006', '007']);
  const names = report.checks.map(c => c.name);
  for (const n of ['jobs', 'job amounts', 'expenses total', 'daily records', 'employees', 'payroll deductions', 'payroll overtime hours']) {
    assert.ok(names.includes(n), `missing check ${n}`);
  }
  assert.ok(report.checks.every(c => c.ok));
});

test('rehearsal reports a migration failure instead of hiding it', async () => {
  const broken = structuredClone(legacy);
  broken.jobs[0].job_date = '14/09/2026'; // not a date the migration can convert
  const report = await rehearse(dumpOf(broken));
  assert.equal(report.ok, false);
  assert.match(report.error, /002/);
});

test('rehearsal handles two sheets in the same week (the production case)', async () => {
  const data = structuredClone(legacy);
  data.payroll_entries.push(
    { id: 90, employee_id: 2, period_label: '2026-09-21', attendance: '{"2026-09-21":"P"}', days_worked: 0, half_days: 0, absences: 0,
      day_off: 0, ot_hours: 0, cw_ot_hours: 1, cn_ot_hours: 0, construction_days: 0, deductions: 20, notes: '' },
    { id: 91, employee_id: 2, period_label: '2026-09-23', attendance: '{"2026-09-23":"CN"}', days_worked: 0, half_days: 0, absences: 0,
      day_off: 0, ot_hours: 0, cw_ot_hours: 2, cn_ot_hours: 0, construction_days: 0, deductions: 30, notes: '' },
  );
  const report = await rehearse(dumpOf(data));
  assert.equal(report.ok, true, JSON.stringify(report, null, 1));
});
