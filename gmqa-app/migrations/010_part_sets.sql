-- 010: a part can be sold per piece or as a set (e.g. a pair of bulbs ₱3,500, one bulb ₱2,000).
--   * parts.set_size (pieces in a set), set_price and set_commission (per set). Stock stays in pieces.
--     The set is offered for sale once it has both a size and a price.
--   * job_items.pack_size: pieces taken from stock per unit of the line (a set line: set_size; otherwise 1),
--     so removing, voiding or restoring a line moves exactly the pieces it took.
-- Existing items have no set; existing lines are per piece (pack_size 1). Nothing else changes.

alter table public.parts
  add column set_size numeric(12,2) check (set_size > 1),
  add column set_price numeric(12,2) check (set_price >= 0),
  add column set_commission numeric(12,2) not null default 0 check (set_commission >= 0);

alter table public.job_items
  add column pack_size numeric(12,2) not null default 1 check (pack_size > 0);
