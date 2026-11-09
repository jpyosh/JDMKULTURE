-- 019: the owner chooses, bill by bill, whether its money is put aside every week or every month.
-- Every existing bill stays weekly, so nothing changes until the owner picks otherwise.

alter table public.funds
  add column set_aside_every text not null default 'weekly' check (set_aside_every in ('weekly', 'monthly'));
