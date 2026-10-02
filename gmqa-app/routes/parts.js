// Parts & inventory: price list, stock, deliveries (weighted average cost) and stock counts.
// Everyone can see stock and sell; only the owner changes prices, receives or adjusts stock.
const express = require('express');
const { requireOwner } = require('../lib/auth');
const { db } = require('../lib/db');
const { PART_COLUMNS, withLow, loadPart } = require('../lib/inventory');
const { bad, money, text, date, id, pick } = require('../lib/http');

const router = express.Router();

router.get('/parts', async (req, res) => {
  const all = req.query.all === '1' && req.user.role === 'owner';
  const rows = await db.many(`select ${PART_COLUMNS} from parts ${all ? '' : 'where active'} order by active desc, name`);
  res.json(rows.map(withLow));
});

function cleanPart(body, partial) {
  const f = pick(body, ['sku', 'name', 'unit', 'price', 'commission', 'reorder_level', 'active']);
  const out = {};
  if ('sku' in f) out.sku = text(f.sku, 'SKU', { max: 40 });
  if (!partial || 'name' in f) out.name = text(f.name, 'Name', { required: true, max: 120 });
  if ('unit' in f) out.unit = text(f.unit, 'Unit', { max: 12 }) || 'pc';
  if (!partial || 'price' in f) out.price = money(f.price, 'Selling price');
  if ('commission' in f) out.commission = money(f.commission, 'Commission per unit');
  if ('reorder_level' in f) out.reorder_level = money(f.reorder_level, 'Reorder level');
  if ('active' in f) out.active = Boolean(f.active);
  return out;
}

router.post('/parts', requireOwner, async (req, res) => {
  const part = cleanPart(req.body, false);
  const cols = Object.keys(part);
  const row = await db.tx(req.user.email, q => q.one(
    `insert into parts (${cols.join(', ')}) values (${cols.map((_, i) => `$${i + 1}`).join(', ')}) returning ${PART_COLUMNS}`,
    cols.map(c => part[c])));
  res.status(201).json(withLow(row));
});

router.patch('/parts/:id', requireOwner, async (req, res) => {
  const partId = id(req.params.id, 'part');
  const part = cleanPart(req.body, true);
  const cols = Object.keys(part);
  if (!cols.length) throw bad('Nothing to save');
  await db.tx(req.user.email, async q => {
    await loadPart(q, partId);
    await q.query(`update parts set ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')} where id = $1`, [partId, ...cols.map(c => part[c])]);
  });
  res.json(await loadPart(db, partId));
});

// A delivery: stock goes up and the average cost becomes the weighted average of old and new stock.
router.post('/parts/:id/receive', requireOwner, async (req, res) => {
  const partId = id(req.params.id, 'part');
  const day = date(req.body.date, 'Date');
  const quantity = money(req.body.quantity, 'Quantity', { min: 0.01 });
  const unitCost = money(req.body.unit_cost, 'Unit cost');
  await db.tx(req.user.email, async q => {
    const part = await loadPart(q, partId);
    const avgCost = Math.round(((part.stock * part.avg_cost + quantity * unitCost) / (part.stock + quantity)) * 100) / 100;
    await q.query('update parts set stock = stock + $2, avg_cost = $3 where id = $1', [partId, quantity, avgCost]);
    await q.query(`insert into stock_movements (part_id, moved_on, kind, quantity, unit_cost, supplier, note)
      values ($1, $2, 'receive', $3, $4, $5, $6)`,
    [partId, day, quantity, unitCost, text(req.body.supplier, 'Supplier', { max: 120 }), text(req.body.note, 'Note', { max: 200 })]);
  });
  res.json(await loadPart(db, partId));
});

// Stock count correction (damaged, lost, miscounted). Needs a reason; stock can never go below zero.
router.post('/parts/:id/adjust', requireOwner, async (req, res) => {
  const partId = id(req.params.id, 'part');
  const day = date(req.body.date, 'Date');
  const quantity = Number(req.body.quantity);
  if (!Number.isFinite(quantity) || quantity === 0) throw bad('Enter how many to add (+) or remove (−)');
  const note = text(req.body.note, 'Reason', { required: true, max: 200 });
  await db.tx(req.user.email, async q => {
    const part = await loadPart(q, partId);
    if (part.stock + quantity < 0) throw bad(`Only ${part.stock} ${part.unit} in stock; cannot remove ${-quantity}`);
    await q.query('update parts set stock = stock + $2 where id = $1', [partId, quantity]);
    await q.query(`insert into stock_movements (part_id, moved_on, kind, quantity, note) values ($1, $2, 'adjust', $3, $4)`,
      [partId, day, quantity, note]);
  });
  res.json(await loadPart(db, partId));
});

router.get('/parts/:id/movements', requireOwner, async (req, res) => {
  const partId = id(req.params.id, 'part');
  await loadPart(db, partId);
  res.json(await db.many(`select m.id, m.moved_on, m.kind, m.quantity, m.unit_cost, m.supplier, m.note, m.created_by, j.jo_number
    from stock_movements m left join jobs j on j.id = m.job_id where m.part_id = $1 order by m.id`, [partId]));
});

module.exports = { router };
