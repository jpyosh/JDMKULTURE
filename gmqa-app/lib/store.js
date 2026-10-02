// Shared data-access helpers used by several routes.
const { db } = require('./db');
const { jobTotals } = require('./calc');
const { forbidden } = require('./http');

const JOB_COLUMNS = `id, jo_number, department, job_date, closed_on, paid_on, sale_date, time_in, time_out, vehicle_class, plate, payment_method, payment_received,
  discount, discount_reason, tip_gcash, detailer, remarks, created_by, created_at, voided_at, voided_by, void_reason`;

// Loads jobs with their line items and computed totals. `where` uses $1..$n placeholders.
async function loadJobs(where, params, q = db) {
  const jobs = await q.many(`select ${JOB_COLUMNS} from jobs where ${where} order by job_date, id`, params);
  if (!jobs.length) return [];
  const items = await q.many(`select id, job_id, kind, catalog_item_id, name, price, commission, sort_order
    from job_items where job_id = any($1::bigint[]) order by sort_order, id`, [jobs.map(j => j.id)]);
  const byJob = new Map(jobs.map(j => [j.id, []]));
  for (const item of items) byJob.get(item.job_id)?.push(item);
  return jobs.map(job => {
    const withItems = { ...job, items: byJob.get(job.id) };
    return { ...withItems, totals: jobTotals(withItems) };
  });
}

async function loadJob(jobId, q = db) {
  return (await loadJobs('id = $1', [jobId], q))[0] || null;
}

// Staff cannot change anything on a day that has been closed; the owner can.
async function assertDayOpen(q, date, user) {
  if (user.role === 'owner') return;
  const meta = await q.one('select closed_at from daily_meta where job_date = $1', [date]);
  if (meta?.closed_at) throw forbidden(`${date} has been closed. Ask the owner to reopen it before making changes.`);
}

module.exports = { loadJobs, loadJob, assertDayOpen };
