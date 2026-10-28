-- 011: the owner sets overtime on the Payroll screen instead of it being fixed in code.
--   * ot_rules: the shop rule (OT multiplier, normal hours of a carwash and of a construction day), dated
--     like rates, so a change applies from its date and earlier days keep theirs. Seeded with the rules
--     the app had in lib/calc.js, so no pay changes.
--   * employee_rates.carwash_hours / ot_multiplier: one employee's own normal carwash hours and OT
--     multiplier (e.g. the GM works 8 hours while the crew's carwash day is 11). Null = the shop rule.

create table public.ot_rules (
  effective_from date primary key,
  multiplier numeric(4,2) not null check (multiplier between 1 and 3),
  carwash_hours numeric(4,2) not null check (carwash_hours between 1 and 24),
  construction_hours numeric(4,2) not null check (construction_hours between 1 and 24)
);

insert into public.ot_rules (effective_from, multiplier, carwash_hours, construction_hours) values
  ('2000-01-01', 1.25, 8, 8),
  ('2026-10-04', 1, 8, 8),   -- owner's decision: OT at the plain hourly rate
  ('2026-10-05', 1, 11, 8);  -- owner's decision: a carwash day is 11 hours

create trigger audit after insert or update or delete on public.ot_rules for each row execute function public.audit_row('effective_from');
alter table public.ot_rules enable row level security;

alter table public.employee_rates
  add column carwash_hours numeric(4,2) check (carwash_hours between 1 and 24),
  add column ot_multiplier numeric(4,2) check (ot_multiplier between 1 and 3);
