// Inventory: everything the shop stocks (parts for sale, chemicals, towels, machines), its tags,
// deliveries (weighted average cost) and stock counts. Everyone sees stock and can record a count;
// only the owner adds or edits items and tags, receives deliveries and sees costs and history.
// The Parts tab and job orders use /parts: the active items tagged Auto Parts.
const express = require('express');
const { requireOwner } = require('../lib/auth');
const { db } = require('../lib/db');
const { FOR_SALE, loadItems, loadPart, receiveStock, countStock, COUNT_REASONS } = require('../lib/inventory');
const { bad, notFound, money, text, date, oneOf, id, pick } = require('../lib/http');

const router = express.Router();
const TAG_COLORS = ['slate', 'red', 'orange', 'amber', 'green', 'teal', 'blue', 'violet', 'pink'];
const PAID_FROM = ['cash', 'gcash', 'fund', 'none'];
const MAX_IMPORT_ROWS = 500;

// Locks an item's row for the rest of the transaction, so two stock changes never interleave.
const lockItem = (q, partId) => q.query('select 1 from parts where id = $1 for update', [partId]);

// ---------------------------------------------------------------- tags

const loadTags = (q = db) => q.many('select id, name, color, system_key, sort_order from tags order by sort_order, lower(name), id');

router.get('/tags', async (req, res) => {
  res.json(await loadTags());
});

function cleanTag(body, partial) {
  const f = pick(body, ['name', 'color']);
  const out = {};
  if (!partial || 'name' in f) out.name = text(f.name, 'Tag name', { required: true, max: 40 });
  if ('color' in f) out.color = oneOf(f.color, TAG_COLORS, 'Colour');
  return out;
}

const nextTagOrder = async q => (await q.one('select coalesce(max(sort_order), 0) + 10 as n from tags')).n;

router.post('/tags', requireOwner, async (req, res) => {
  const tag = cleanTag(req.body, false);
  const row = await db.tx(req.user.email, async q => q.one(
    'insert into tags (name, color, sort_order) values ($1, $2, $3) returning id, name, color, system_key, sort_order',
    [tag.name, tag.color || 'slate', await nextTagOrder(q)]));
  res.status(201).json(row);
});

router.patch('/tags/:id', requireOwner, async (req, res) => {
  const tagId = id(req.params.id, 'tag');
  const tag = cleanTag(req.body, true);
  const cols = Object.keys(tag);
  if (!cols.length) throw bad('Nothing to save');
  const row = await db.tx(req.user.email, q => q.one(
    `update tags set ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')} where id = $1 returning id, name, color, system_key, sort_order`,
    [tagId, ...cols.map(c => tag[c])]));
  if (!row) throw notFound('Tag');
  res.json(row);
});

// Deleting a tag only removes the label from its items. The built-in Auto Parts tag stays.
router.delete('/tags/:id', requireOwner, async (req, res) => {
  const tagId = id(req.params.id, 'tag');
  await db.tx(req.user.email, async q => {
    const tag = await q.one('select name, system_key from tags where id = $1', [tagId]);
    if (!tag) throw notFound('Tag');
    if (tag.system_key) throw bad(`${tag.name} is built in: it is what puts items on the Parts tab. It can be renamed but not deleted.`);
    await q.query('delete from tags where id = $1', [tagId]);
  });
  res.json({ ok: true });
});

// ---------------------------------------------------------------- items

router.get('/parts', async (req, res) => {
  res.json(await loadItems(db, `p.active and ${FOR_SALE}`));
});

router.get('/inventory', async (req, res) => {
  const all = req.query.all === '1' && req.user.role === 'owner';
  res.json(await loadItems(db, all ? 'true' : 'p.active'));
});

function cleanItem(body, partial) {
  const f = pick(body, ['sku', 'name', 'unit', 'price', 'commission', 'reorder_level', 'active']);
  const out = {};
  if ('sku' in f) out.sku = text(f.sku, 'SKU', { max: 40 });
  if (!partial || 'name' in f) out.name = text(f.name, 'Name', { required: true, max: 120 });
  if ('unit' in f) out.unit = text(f.unit, 'Unit', { max: 12 }) || 'pc';
  if ('price' in f) out.price = money(f.price, 'Selling price');
  if ('commission' in f) out.commission = money(f.commission, 'Commission per unit');
  if ('reorder_level' in f) out.reorder_level = money(f.reorder_level, 'Reorder level');
  if ('active' in f) out.active = Boolean(f.active);
  return out;
}

function tagIds(value) {
  if (!Array.isArray(value)) throw bad('tags must be a list of tag ids');
  return [...new Set(value.map(v => id(v, 'tag')))];
}

async function setTags(q, partId, ids) {
  const found = ids.length ? await q.many('select id from tags where id = any($1::bigint[])', [ids]) : [];
  if (found.length !== ids.length) throw bad('Unknown tag');
  await q.query('delete from part_tags where part_id = $1 and not (tag_id = any($2::bigint[]))', [partId, ids]);
  await q.query('insert into part_tags (part_id, tag_id) select $1, unnest($2::bigint[]) on conflict do nothing', [partId, ids]);
}

// An item for sale needs a selling price (checked after every change, inside the transaction).
async function checkedItem(q, partId) {
  const part = await loadPart(q, partId);
  if (part.for_sale && !(part.price > 0)) throw bad(`Set a selling price for ${part.name} before tagging it as an auto part`);
  return part;
}

async function insertItem(q, item, tags) {
  const cols = Object.keys(item);
  const { id: partId } = await q.one(`insert into parts (${cols.join(', ')}) values (${cols.map((_, i) => `$${i + 1}`).join(', ')}) returning id`,
    cols.map(c => item[c]));
  if (tags.length) await setTags(q, partId, tags);
  return checkedItem(q, partId);
}

router.post('/inventory', requireOwner, async (req, res) => {
  const item = cleanItem(req.body, false);
  const tags = req.body.tags === undefined ? [] : tagIds(req.body.tags);
  res.status(201).json(await db.tx(req.user.email, q => insertItem(q, item, tags)));
});

router.patch('/inventory/:id', requireOwner, async (req, res) => {
  const partId = id(req.params.id, 'item');
  const item = cleanItem(req.body, true);
  const tags = req.body.tags === undefined ? null : tagIds(req.body.tags);
  const cols = Object.keys(item);
  if (!cols.length && !tags) throw bad('Nothing to save');
  res.json(await db.tx(req.user.email, async q => {
    await loadPart(q, partId);
    if (cols.length) await q.query(`update parts set ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')} where id = $1`, [partId, ...cols.map(c => item[c])]);
    if (tags) await setTags(q, partId, tags);
    return checkedItem(q, partId);
  }));
});

router.post('/inventory/:id/receive', requireOwner, async (req, res) => {
  const partId = id(req.params.id, 'item');
  const day = date(req.body.date, 'Date');
  const quantity = money(req.body.quantity, 'Quantity', { min: 0.01 });
  const unitCost = money(req.body.unit_cost, 'Unit cost');
  const paidFrom = oneOf(req.body.paid_from, PAID_FROM, 'Paid with');
  const supplier = text(req.body.supplier, 'Supplier', { max: 120 });
  const note = text(req.body.note, 'Note', { max: 200 });
  res.json(await db.tx(req.user.email, async q => {
    await lockItem(q, partId);
    await receiveStock(q, await loadPart(q, partId), { day, quantity, unitCost, paidFrom, supplier, note });
    return loadPart(q, partId);
  }));
});

// Stock count: anyone can record what is on the shelf (the difference is recorded with its reason).
router.post('/inventory/:id/count', async (req, res) => {
  const partId = id(req.params.id, 'item');
  const day = date(req.body.date, 'Date');
  if (req.body.counted === '' || req.body.counted == null) throw bad('Enter how many are on the shelf');
  const counted = money(req.body.counted, 'Counted');
  const reason = oneOf(req.body.reason, Object.keys(COUNT_REASONS), 'Reason');
  const note = text(req.body.note, 'Note', { max: 160 });
  res.json(await db.tx(req.user.email, async q => {
    await lockItem(q, partId);
    await countStock(q, await loadPart(q, partId), { day, counted, reason, note });
    return loadPart(q, partId);
  }));
});

router.get('/inventory/:id/movements', requireOwner, async (req, res) => {
  const partId = id(req.params.id, 'item');
  await loadPart(db, partId);
  res.json(await db.many(`select m.id, m.moved_on, m.kind, m.quantity, m.unit_cost, m.supplier, m.note, m.created_by, j.jo_number,
      e.side as paid_from, e.amount as paid_amount
    from stock_movements m left join jobs j on j.id = m.job_id left join expenses e on e.id = m.expense_id
    where m.part_id = $1 order by m.id`, [partId]));
});

// Undo a delivery entered by mistake. Only an item's latest stock change, so the average cost and stock
// go back exactly; the expense it recorded (drawer or cash fund) is removed with it.
router.post('/inventory/movements/:id/undo', requireOwner, async (req, res) => {
  const movementId = id(req.params.id, 'stock change');
  res.json(await db.tx(req.user.email, async q => {
    const move = await q.one('select id, part_id, kind, quantity, prev_avg_cost, expense_id from stock_movements where id = $1', [movementId]);
    if (!move) throw notFound('Stock change');
    if (move.kind !== 'receive') throw bad('Only a delivery can be undone. Record a stock count to correct anything else.');
    await lockItem(q, move.part_id);
    const latest = await q.one('select max(id) as id from stock_movements where part_id = $1', [move.part_id]);
    if (latest.id !== move.id) throw bad('Only the latest stock change of an item can be undone. Record a stock count to correct an earlier one.');
    await q.query('update parts set stock = stock - $2, avg_cost = coalesce($3, avg_cost) where id = $1', [move.part_id, move.quantity, move.prev_avg_cost]);
    await q.query('delete from stock_movements where id = $1', [move.id]);
    if (move.expense_id) {
      const expense = await q.one('select topup_id from expenses where id = $1', [move.expense_id]);
      if (expense.topup_id) throw bad('This delivery was paid from the cash fund and already replenished. Undo that replenishment (Cash fund tab) first.');
      await q.query('delete from expenses where id = $1', [move.expense_id]);
    }
    return loadPart(q, move.part_id);
  }));
});

// ---------------------------------------------------------------- import (rows pasted from Excel / Sheets)
// All rows or none. Tags are given by name; names not yet in use become new tags. A stock figure is
// entered as opening stock at its cost (no money is recorded: it is already on the shelf).

function cleanImportRow(row, n) {
  const at = fn => {
    try { return fn(); } catch (error) { error.message = `Row ${n}: ${error.message}`; throw error; }
  };
  const item = at(() => cleanItem({ ...row, active: true }, false));
  const tags = at(() => {
    if (row.tags == null) return [];
    if (!Array.isArray(row.tags)) throw bad('tags must be a list of tag names');
    return [...new Set(row.tags.map(t => text(t, 'Tag name', { max: 40 })).filter(Boolean))];
  });
  const stock = at(() => money(row.stock, 'Stock'));
  const unitCost = at(() => money(row.unit_cost, 'Cost'));
  return { n, item, tags, stock, unitCost };
}

router.post('/inventory/import', requireOwner, async (req, res) => {
  const day = date(req.body.date, 'Date');
  const input = req.body.rows;
  if (!Array.isArray(input) || !input.length) throw bad('Nothing to import');
  if (input.length > MAX_IMPORT_ROWS) throw bad(`Import at most ${MAX_IMPORT_ROWS} rows at a time`);
  const rows = input.map((row, i) => cleanImportRow(row || {}, i + 1));

  const created = await db.tx(req.user.email, async q => {
    const existing = await q.many('select lower(name) as name, lower(sku) as sku from parts where active');
    const names = new Set(existing.map(p => p.name));
    const skus = new Set(existing.map(p => p.sku).filter(Boolean));
    for (const { n, item } of rows) {
      if (names.has(item.name.toLowerCase())) throw bad(`Row ${n}: ${item.name} already exists. Edit it in the sheet instead.`);
      if (item.sku && skus.has(item.sku.toLowerCase())) throw bad(`Row ${n}: SKU ${item.sku} already exists`);
      names.add(item.name.toLowerCase());
      if (item.sku) skus.add(item.sku.toLowerCase());
    }

    const tagByName = new Map((await loadTags(q)).map(t => [t.name.toLowerCase(), t.id]));
    for (const name of new Set(rows.flatMap(r => r.tags))) {
      if (tagByName.has(name.toLowerCase())) continue;
      const tag = await q.one('insert into tags (name, sort_order) values ($1, $2) returning id', [name, await nextTagOrder(q)]);
      tagByName.set(name.toLowerCase(), tag.id);
    }

    for (const { n, item, tags, stock, unitCost } of rows) {
      let part;
      try {
        part = await insertItem(q, item, [...new Set(tags.map(t => tagByName.get(t.toLowerCase())))]);
      } catch (error) {
        error.message = `Row ${n}: ${error.message}`;
        throw error;
      }
      if (stock > 0) await receiveStock(q, part, { day, quantity: stock, unitCost, paidFrom: 'none', note: 'Opening stock' });
    }
    return rows.length;
  });
  res.status(201).json({ created });
});

module.exports = { router };
