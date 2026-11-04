-- 014: a job can have a labor line. The labor is typed per sale (an easy install costs less than a hard one),
--   the customer pays it on top of the parts, and all of it is the installer's commission
--   (job_items.price = commission). Existing lines are unchanged.

alter table public.job_items
  drop constraint job_items_kind_check,
  add constraint job_items_kind_check check (kind in ('service', 'addon', 'custom', 'part', 'labor'));
