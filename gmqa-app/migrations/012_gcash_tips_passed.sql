-- 012: GCash tips are given to the crew when someone actually hands them out, not automatically.
--   * daily_meta.gcash_tips_passed: GCash tips given to the crew that day (today's tips or ones still
--     owed from earlier days). Until then the tips stay in GCash and the EOD screen reminds about them.
-- Days before 2026-10-29 keep the old rule (tips given out the same day, TIPS_TRACKED_FROM in
-- lib/calc.js), so existing days need no backfill and their numbers do not change.

alter table public.daily_meta
  add column gcash_tips_passed numeric(12,2) not null default 0 check (gcash_tips_passed >= 0);
