-- 003: departments and running job orders.
--   * Carwash jobs are same-day: they count on job_date (as before).
--   * Detailing and Tint & PPF jobs are "running": job_date is the day they were opened, they stay
--     on the department board until both closed_on (work done) and paid_on (paid in full) are set,
--     and they count as a sale on the later of those two dates (sale_date).
--   * Every catalog item belongs to one department.
-- No existing job total changes.

-- ---------------------------------------------------------------- catalog

alter table public.catalog_items
  add column department text not null default 'carwash'
  constraint catalog_items_department_check check (department in ('carwash', 'detailing', 'tint_ppf'));

-- Best-guess placement of the existing services/add-ons; the owner can move any item in the Pricing Matrix.
update public.catalog_items set department = 'tint_ppf' where name ~* '(tint|ppf|paint protection film)';
update public.catalog_items set department = 'detailing'
where department = 'carwash' and name ~* '(detail|correction|ceramic|glass coat|watermark|headlight)';

alter table public.catalog_items alter column department drop default;

-- ---------------------------------------------------------------- jobs

alter table public.jobs
  add column department text not null default 'carwash',
  add column closed_on date,
  add column paid_on date;

-- An existing job belongs to the department of its (non-carwash) catalog lines.
update public.jobs j set department = d.department
from (
  select i.job_id, max(c.department) filter (where c.department <> 'carwash') as department
  from public.job_items i join public.catalog_items c on c.id = i.catalog_item_id
  group by i.job_id
) d
where d.job_id = j.id and d.department is not null;

-- Existing running-department jobs were same-day records: done on their date, paid if they were paid.
update public.jobs set closed_on = job_date, paid_on = case when payment_received then job_date end
where department <> 'carwash';

alter table public.jobs
  add column sale_date date generated always as (
    case
      when department = 'carwash' then job_date
      when closed_on is not null and paid_on is not null then greatest(closed_on, paid_on)
    end
  ) stored,
  add constraint jobs_department_check check (department in ('carwash', 'detailing', 'tint_ppf')),
  add constraint jobs_running_dates_check check (
    (department = 'carwash' and closed_on is null and paid_on is null)
    or (department <> 'carwash'
        and payment_received = (paid_on is not null)
        and (closed_on is null or closed_on >= job_date)
        and (paid_on is null or paid_on >= job_date))
  );

create index jobs_sale_date_idx on public.jobs (sale_date);
create index jobs_paid_on_idx on public.jobs (paid_on) where paid_on is not null;
create index jobs_active_running_idx on public.jobs (department) where sale_date is null and voided_at is null;
