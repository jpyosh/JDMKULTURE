-- A counter sale taken on credit can be marked paid on a later day (Parts → Mark paid). The sale and its
-- labor stay on the day it was made (sale_date = job_date, unchanged); paid_on is the day the money came in,
-- so it counts in that day's drawer or GCash. Carwash keeps its Paid checkbox (no paid_on).
-- Constraint only: no existing row changes (every parts job has paid_on null).
alter table public.jobs
  drop constraint jobs_running_dates_check,
  add constraint jobs_running_dates_check check (
    (department = 'carwash' and closed_on is null and paid_on is null)
    or (department = 'parts' and closed_on is null
        and (paid_on is null or (payment_received and paid_on >= job_date)))
    or (department in ('detailing', 'tint_ppf')
        and payment_received = (paid_on is not null)
        and (closed_on is null or closed_on >= job_date)
        and (paid_on is null or paid_on >= job_date))
  );
