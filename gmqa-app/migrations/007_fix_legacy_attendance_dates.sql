-- 007: put converted attendance on the day it was worked.
--
-- The old app worked out its dates in UTC, so in the Philippines every weekly sheet was saved one day
-- early: the week of Monday 09-14 stored Mon..Sun under Sun 09-13 .. Sat 09-19. 004 copied those dates
-- as they were, so each converted day sits one day before the day it was worked (Monday's attendance
-- shows on Sunday). This moves the attendance codes of those sheets one day later.
--
--   * Only sheets saved the old way move: their first day is the Sunday before their Monday. Sheets
--     already keyed Monday..Sunday stay where they are.
--   * Overtime and deductions are untouched: 004 put the week's overtime and deductions on the Monday,
--     which is already right. Only the day codes move.
--   * Hand corrections win. If anyone changed a day a sheet was saved on (it is in the change history),
--     that whole sheet is left exactly as it is and nothing is written onto any of its days; nothing is
--     ever written onto a day changed in the app. The legacy_v2_payroll_entries copy is not changed.
--   * Changes are written with the audit trigger on, so they appear in Settings -> Change history.

create temporary table _sheets on commit drop as
select s.id, s.employee_id, s.period_start
from public.legacy_v2_payroll_entries s
where jsonb_typeof(s.attendance) = 'object'
  and (select min(k::date) from jsonb_object_keys(s.attendance) k) = s.period_start - 1;

-- Days changed in the app since 004 (they are in the change history).
create temporary table _touched on commit drop as
select r ->> 'employee_id' as employee_id, (r ->> 'work_date')::date as work_date
from public.audit_log l, lateral (values (l.new_row), (l.old_row)) v(r)
where l.table_name = 'attendance' and r is not null;

-- A sheet was corrected by hand if any day it was saved on (Sunday before .. Saturday) was changed.
create temporary table _fixed_sheets on commit drop as
select s.* from _sheets s
where not exists (
  select 1 from _touched t
  where t.employee_id = s.employee_id::text and t.work_date between s.period_start - 1 and s.period_start + 5);

-- Days nothing is written onto: every day of a sheet corrected by hand (its saved days and the Sunday
-- after), and any single day changed in the app.
create temporary table _kept_days on commit drop as
select s.employee_id, d::date as work_date
from _sheets s, generate_series(s.period_start - 1, s.period_start + 6, interval '1 day') d
where s.id not in (select id from _fixed_sheets)
union
select employee_id::bigint, work_date from _touched;

-- Each saved day of a sheet being fixed, with where it belongs.
create temporary table _moves on commit drop as
select s.employee_id, a.key::date as saved_on, a.key::date + 1 as worked_on, a.value as code
from _fixed_sheets s
join public.legacy_v2_payroll_entries p on p.id = s.id,
     jsonb_each_text(p.attendance) a
where a.value in ('P', '0.5P', 'CN', '0.5CN', 'A', 'OFF');

-- 1. Take the codes off the days they were saved on (unless that day was changed by hand). A row holding
--    only the code goes; a row that also holds the week's overtime (the Monday) keeps the overtime.
delete from public.attendance a
using _moves m
where a.employee_id = m.employee_id and a.work_date = m.saved_on and a.code = m.code
  and a.cw_ot_hours = 0 and a.cn_ot_hours = 0
  and not exists (select 1 from _touched t where t.employee_id = a.employee_id::text and t.work_date = a.work_date);

update public.attendance a set code = null
from _moves m
where a.employee_id = m.employee_id and a.work_date = m.saved_on and a.code = m.code
  and not exists (select 1 from _touched t where t.employee_id = a.employee_id::text and t.work_date = a.work_date);

-- 2. Put each code on the day it was worked.
insert into public.attendance (employee_id, work_date, code)
select m.employee_id, m.worked_on, m.code from _moves m
where not exists (select 1 from _kept_days k where k.employee_id = m.employee_id and k.work_date = m.worked_on)
on conflict (employee_id, work_date) do update set code = excluded.code;
