-- 013: 18 tag colours (was 9), and every existing tag gets its own colour.
--   The palette order (red first, for Auto Parts) is also the order the app hands out colours to new
--   tags (routes/inventory.js TAG_COLORS), so neighbouring tags look different.
--   Existing tags are recoloured in their display order; names, order and items are unchanged.
--   The owner can still pick any colour per tag afterwards (Inventory → Tags).

alter table public.tags drop constraint tags_color_check;
alter table public.tags add constraint tags_color_check check (color in (
  'red', 'blue', 'amber', 'green', 'violet', 'orange', 'teal', 'pink', 'lime',
  'indigo', 'coral', 'mint', 'grape', 'sky', 'brown', 'rose', 'olive', 'slate'));

with palette (color, n) as (
  select * from unnest(array['red', 'blue', 'amber', 'green', 'violet', 'orange', 'teal', 'pink', 'lime',
    'indigo', 'coral', 'mint', 'grape', 'sky', 'brown', 'rose', 'olive', 'slate']) with ordinality
), ranked as (
  select id, row_number() over (order by sort_order, lower(name), id) as n from public.tags
)
update public.tags t
   set color = p.color
  from ranked r
  join palette p on p.n = (r.n - 1) % 18 + 1
 where t.id = r.id;
