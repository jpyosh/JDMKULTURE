-- 020: a carwash job taken on credit can be paid on a later day.
--   * Until now a carwash job had no pay day: ticking Paid put the money in the drawer of the day of the job,
--     even when the customer paid days later. A closed day then came out short and the day the money really
--     arrived came out over.
--   * A carwash job may now carry paid_on, like the other departments: the sale and its commission stay on
--     the day of the job (sale_date = job_date, unchanged), and the money counts on paid_on.
--   * Constraint only: no existing row changes. A carwash job paid with paid_on empty was paid on its own
--     day, exactly as before.

alter table public.jobs
  drop constraint jobs_running_dates_check,
  add constraint jobs_running_dates_check check (
    (department = 'carwash' and closed_on is null
        and (paid_on is null or (payment_received and paid_on >= job_date)))
    or (department in ('detailing', 'tint_ppf', 'parts')
        and payment_received = (paid_on is not null)
        and (closed_on is null or closed_on >= job_date)
        and (paid_on is null or paid_on >= job_date))
  );
