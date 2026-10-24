// Stock changes. Every change is one stock update plus one stock_movements row, inside the caller's
// transaction, so stock and its history can never disagree. The database refuses negative stock.
// The parts table holds every inventory item; the ones tagged Auto Parts (system tag) are for sale.
const { bad, notFound } = require('./http');
const { round2 } = require('./calc');
const { assertFundCovers } = require('./cash-fund');

const SHOP_TODAY = "(now() at time zone 'Asia/Manila')::date";
const AUTO_PARTS = 'auto_parts';
const FOR_SALE = `exists (select 1 from part_tags pt join tags t on t.id = pt.tag_id where pt.part_id = p.id and t.system_key = '${AUTO_PARTS}')`;
const ITEM_SELECT = `select p.id, p.sku, p.name, p.unit, p.price, p.commission, p.avg_cost, p.stock, p.reorder_level, p.active,
  coalesce((select json_agg(pt.tag_id order by pt.tag_id) from part_tags pt where pt.part_id = p.id), '[]'::json) as tags,
  ${FOR_SALE} as for_sale
  from parts p`;

const withLow = part => part && { ...part, low: Number(part.stock) <= Number(part.reorder_level) };

// where: a condition on p (alias of parts), with $1..$n placeholders.
async function loadItems(q, where = 'true', params = []) {
  return (await q.many(`${ITEM_SELECT} where ${where} order by p.active desc, lower(p.name)`, params)).map(withLow);
}

async function loadPart(q, partId, { activeOnly = false, forSale = false } = {}) {
  const [part] = await loadItems(q, `p.id = $1 ${activeOnly ? 'and p.active' : ''}`, [partId]);
  if (!part) throw notFound('Item');
  if (forSale && !part.for_sale) throw bad(`${part.name} is not for sale. Tag it as an auto part in Inventory to sell it.`);
  return part;
}

// Takes `quantity` out of stock for a sale; fails with a clear message if there is not enough.
async function takeStock(q, partId, quantity, jobId) {
  const row = await q.one('update parts set stock = stock - $2 where id = $1 and stock >= $2 returning avg_cost', [partId, quantity]);
  if (!row) {
    const part = await loadPart(q, partId);
    throw bad(`Only ${part.stock} ${part.unit} of ${part.name} in stock. Receive the delivery first.`);
  }
  await q.query(`insert into stock_movements (part_id, moved_on, kind, quantity, unit_cost, job_id)
    values ($1, ${SHOP_TODAY}, 'sale', $2, $3, $4)`, [partId, -quantity, row.avg_cost, jobId]);
}

async function returnStock(q, partId, quantity, jobId, note) {
  await q.query('update parts set stock = stock + $2 where id = $1', [partId, quantity]);
  await q.query(`insert into stock_movements (part_id, moved_on, kind, quantity, job_id, note)
    values ($1, ${SHOP_TODAY}, 'return', $2, $3, $4)`, [partId, quantity, jobId, note]);
}

// A delivery: stock goes up and the average cost becomes the weighted average of old and new stock.
// paidFrom 'cash' | 'gcash' | 'fund' records what was paid as that day's expense (a part bought to sell
// is marked for_resale: money out, but its cost counts when sold). 'none': opening stock / paid elsewhere.
async function receiveStock(q, part, { day, quantity, unitCost, paidFrom, supplier = null, note = null }) {
  let expenseId = null;
  if (paidFrom !== 'none') {
    const amount = round2(quantity * unitCost);
    if (!(amount > 0)) throw bad('Enter the cost per unit, so the amount paid can be recorded');
    if (paidFrom === 'fund') await assertFundCovers(q, amount);
    const qty = Number.isInteger(quantity) ? quantity : quantity.toFixed(2);
    const description = `Stock: ${qty} ${part.unit} ${part.name}${supplier ? ` (${supplier})` : ''}`.slice(0, 200);
    expenseId = (await q.one(`insert into expenses (expense_date, side, description, amount, for_resale)
      values ($1, $2, $3, $4, $5) returning id`, [day, paidFrom, description, amount, part.for_sale])).id;
  }
  const avgCost = round2((part.stock * part.avg_cost + quantity * unitCost) / (part.stock + quantity));
  await q.query('update parts set stock = stock + $2, avg_cost = $3 where id = $1', [part.id, quantity, avgCost]);
  await q.query(`insert into stock_movements (part_id, moved_on, kind, quantity, unit_cost, prev_avg_cost, supplier, note, expense_id)
    values ($1, $2, 'receive', $3, $4, $5, $6, $7, $8)`, [part.id, day, quantity, unitCost, part.avg_cost, supplier, note, expenseId]);
}

// A stock count: what is on the shelf now. The difference is recorded as used (counting is how usage of
// chemicals and supplies is tracked), or as damaged / lost / a recount correction.
const COUNT_REASONS = { used: 'Used', damaged: 'Damaged', lost: 'Lost', recount: 'Recount' };

async function countStock(q, part, { day, counted, reason, note = null }) {
  const change = round2(counted - part.stock);
  if (change === 0) throw bad(`That matches the ${part.stock} ${part.unit} on record; nothing to change.`);
  if (reason !== 'recount' && change > 0) throw bad(`${counted} is more than the ${part.stock} ${part.unit} on record. Choose “Recount” to correct it upwards.`);
  const label = COUNT_REASONS[reason];
  await q.query('update parts set stock = $2 where id = $1', [part.id, counted]);
  await q.query('insert into stock_movements (part_id, moved_on, kind, quantity, note) values ($1, $2, $3, $4, $5)',
    [part.id, day, reason === 'used' ? 'use' : 'adjust', change, note ? `${label}: ${note}` : label]);
}

module.exports = { AUTO_PARTS, FOR_SALE, withLow, loadItems, loadPart, takeStock, returnStock, receiveStock, countStock, COUNT_REASONS };
