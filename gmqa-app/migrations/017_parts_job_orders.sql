-- 017: the parts counter becomes a running department like Detailing and Tint & PPF (agreed 2026-11-05).
--   * A part can stay with the shop for days until it is installed, so a parts job can be open: on the board,
--     stock held, no sale and no commission until it is marked done.
--   * Every existing counter sale was finished on the day it was made. It gets closed_on = job_date, and if it
--     was paid then, paid_on = job_date, so its sale day and its money day stay exactly what they were.
--   * A sale paid on a later day keeps that paid_on. Unpaid sales stay unpaid. Voided sales stay voided.

alter table public.jobs drop constraint jobs_running_dates_check;

update public.jobs
set closed_on = job_date,
    paid_on = coalesce(paid_on, case when payment_received then job_date end)
where department = 'parts';

drop index public.jobs_sale_date_idx;
drop index public.jobs_active_running_idx;

alter table public.jobs drop column sale_date;

alter table public.jobs
  add column sale_date date generated always as (
    case when department = 'carwash' then job_date else closed_on end
  ) stored,
  add constraint jobs_running_dates_check check (
    (department = 'carwash' and closed_on is null and paid_on is null)
    or (department in ('detailing', 'tint_ppf', 'parts')
        and payment_received = (paid_on is not null)
        and (closed_on is null or closed_on >= job_date)
        and (paid_on is null or paid_on >= job_date))
  );

create index jobs_sale_date_idx on public.jobs (sale_date);
create index jobs_active_running_idx on public.jobs (department)
  where (closed_on is null or not payment_received) and voided_at is null;
