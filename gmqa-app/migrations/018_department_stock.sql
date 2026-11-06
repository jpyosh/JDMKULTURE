-- 018: department containers in Inventory (agreed 2026-11-06). A tag only labels a whole item, so it cannot split
-- stock; the shop keeps four containers instead: Overall, Carwash, Detailing and Tint & PPF.
--   * parts.stock stays what it has always been: Overall, where deliveries land and auto parts are sold from.
--   * department_stock: what each department holds of an item. An item's total is Overall plus these.
--   * stock_movements.department: where the change happened (null = Overall). Kind 'transfer' is a move, written
--     as two lines that cancel out (out of one container, into another), so a move neither adds nor removes stock
--     and every container still equals the sum of its history. No money: a move is never a cost.
-- Existing items keep all their stock in Overall, and no existing row changes.

create table public.department_stock (
  part_id bigint not null references public.parts (id),
  department text not null check (department in ('carwash', 'detailing', 'tint_ppf')),
  stock numeric(12,2) not null default 0 check (stock >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (part_id, department)
);

alter table public.stock_movements
  drop constraint stock_movements_kind_check,
  drop constraint stock_movements_check,
  add constraint stock_movements_kind_check check (kind in ('receive', 'sale', 'return', 'adjust', 'use', 'transfer')),
  add constraint stock_movements_check check (
    (kind in ('receive', 'return') and quantity > 0) or (kind in ('sale', 'use') and quantity < 0) or kind in ('adjust', 'transfer')),
  add column department text check (department in ('carwash', 'detailing', 'tint_ppf')),
  add constraint stock_movements_department_kind_check check (department is null or kind in ('transfer', 'use', 'adjust'));

create trigger set_updated_at before update on public.department_stock for each row execute function public.set_updated_at();
create trigger audit after insert or update or delete on public.department_stock for each row execute function public.audit_row('part_id');

alter table public.department_stock enable row level security;
