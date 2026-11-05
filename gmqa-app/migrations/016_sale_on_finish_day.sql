-- 016: a running job (Detailing, Tint & PPF) is a sale on the day it is finished (agreed 2026-11-05).
--   * sale_date was the later of done and paid. It is now closed_on, paid or not: like an unpaid carwash job,
--     a job finished and not paid yet is that day's receivable, and its commission is due that day.
--   * The money still counts on the day it was received (paid_on), so no drawer count changes because of this.
--   * The running board used to be "sale_date is null". A finished job stays on the board until it is paid,
--     so its index now says that directly.
-- Only sale_date is worked out differently; no stored field changes.

drop index public.jobs_sale_date_idx;
drop index public.jobs_active_running_idx;

alter table public.jobs drop column sale_date;

alter table public.jobs
  add column sale_date date generated always as (
    case when department in ('carwash', 'parts') then job_date else closed_on end
  ) stored;

create index jobs_sale_date_idx on public.jobs (sale_date);
create index jobs_active_running_idx on public.jobs (department)
  where (closed_on is null or not payment_received) and voided_at is null;
