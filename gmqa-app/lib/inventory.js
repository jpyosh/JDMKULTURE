// Stock changes. Every change is one stock update plus one stock_movements row, inside the caller's
// transaction, so stock and its history can never disagree. The database refuses negative stock.
const { bad, notFound } = require('./http');

const SHOP_TODAY = "(now() at time zone 'Asia/Manila')::date";
const PART_COLUMNS = 'id, sku, name, unit, price, commission, avg_cost, stock, reorder_level, active';

const withLow = part => part && { ...part, low: Number(part.stock) <= Number(part.reorder_level) };

async function loadPart(q, partId, { activeOnly = false } = {}) {
  const part = await q.one(`select ${PART_COLUMNS} from parts where id = $1 ${activeOnly ? 'and active' : ''}`, [partId]);
  if (!part) throw notFound('Part');
  return withLow(part);
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

module.exports = { PART_COLUMNS, withLow, loadPart, takeStock, returnStock };
