// Suppliers (owner): who each item comes from, what its parts sold for and cost in any date range, and for a supplier
// paid as its parts sell, what is still owed (supplierReport in lib/calc.js). Paying a supplier records a supplier
// payment at EOD (an expense with for_resale): the money leaves the drawer, GCash or cash fund, but the parts' cost
// already counted when they sold, so it is not a second cost.
const express = require('express');
const { requireOwner } = require('../lib/auth');
const { db } = require('../lib/db');
const { supplierReport, datesBetween } = require('../lib/calc');
const { assertDayOpen } = require('../lib/store');
const { assertFundCovers } = require('../lib/cash-fund');
const { shopToday, assertNotFarAhead } = require('../lib/clock');
const { bad, notFound, money, text, date, oneOf, id, pick } = require('../lib/http');

const router = express.Router();
router.use('/suppliers', requireOwner);
const MAX_DAYS = 400;
const COLUMNS = 'id, name, pays_when_sold, owed_from, note, active';

const loadSuppliers = (q = db) => q.many(`select ${COLUMNS},
    (select count(*)::int from parts p where p.supplier_id = s.id and p.active) as item_count
  from suppliers s where s.active order by lower(s.name), s.id`);

async function loadSupplier(q, supplierId) {
  const row = await q.one(`select ${COLUMNS} from suppliers where id = $1 and active`, [supplierId]);
  if (!row) throw notFound('Supplier');
  return row;
}

function cleanSupplier(body, partial) {
  const f = pick(body, ['name', 'pays_when_sold', 'owed_from', 'note', 'active']);
  const out = {};
  if (!partial || 'name' in f) out.name = text(f.name, 'Name', { required: true, max: 80 });
  if ('pays_when_sold' in f) out.pays_when_sold = Boolean(f.pays_when_sold);
  if ('owed_from' in f && f.owed_from) out.owed_from = date(f.owed_from, 'Count what is owed from');
  if ('note' in f) out.note = text(f.note, 'Note', { max: 200 });
  if ('active' in f) out.active = Boolean(f.active);
  return out;
}

async function assertNameFree(q, name, exceptId = null) {
  if (await q.one('select 1 from suppliers where active and lower(name) = lower($1) and id is distinct from $2', [name, exceptId])) {
    throw bad(`${name} is already a supplier`);
  }
}

router.get('/suppliers', async (req, res) => {
  res.json(await loadSuppliers());
});

router.post('/suppliers', async (req, res) => {
  const s = cleanSupplier(req.body, false);
  const row = await db.tx(req.user.email, async q => {
    await assertNameFree(q, s.name);
    const cols = Object.keys(s);
    return q.one(`insert into suppliers (${cols.join(', ')}) values (${cols.map((_, i) => `$${i + 1}`).join(', ')}) returning ${COLUMNS}`,
      cols.map(c => s[c]));
  });
  res.status(201).json(row);
});

router.patch('/suppliers/:id', async (req, res) => {
  const supplierId = id(req.params.id, 'supplier');
  const s = cleanSupplier(req.body, true);
  const cols = Object.keys(s);
  if (!cols.length) throw bad('Nothing to save');
  const row = await db.tx(req.user.email, async q => {
    await loadSupplier(q, supplierId);
    if (s.name) await assertNameFree(q, s.name, supplierId);
    // A supplier removed keeps its past sales and payments; its items just have no supplier any more.
    if (s.active === false) await q.query('update parts set supplier_id = null where supplier_id = $1', [supplierId]);
    return q.one(`update suppliers set ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')} where id = $1 returning ${COLUMNS}`,
      [supplierId, ...cols.map(c => s[c])]);
  });
  res.json(row);
});

function idList(value, field) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw bad(`${field} must be a list`);
  return [...new Set(value.map(v => id(v, 'item')))];
}

// Several items at once: part_ids get this supplier, remove_ids (items of this supplier) get none.
router.post('/suppliers/:id/items', async (req, res) => {
  const supplierId = id(req.params.id, 'supplier');
  const add = idList(req.body.part_ids, 'part_ids');
  const remove = idList(req.body.remove_ids, 'remove_ids');
  if (!add.length && !remove.length) throw bad('Pick at least one item');
  await db.tx(req.user.email, async q => {
    await loadSupplier(q, supplierId);
    const found = await q.many('select id from parts where id = any($1::bigint[])', [add]);
    if (found.length !== add.length) throw bad('Unknown item');
    if (add.length) await q.query('update parts set supplier_id = $1 where id = any($2::bigint[])', [supplierId, add]);
    if (remove.length) await q.query('update parts set supplier_id = null where supplier_id = $1 and id = any($2::bigint[])', [supplierId, remove]);
  });
  res.json(await loadSupplier(db, supplierId));
});

router.get('/suppliers/report', async (req, res) => {
  const start = date(req.query.start, 'Start date');
  const end = date(req.query.end, 'End date');
  if (start > end) throw bad('Start date must be on or before the end date');
  if (datesBetween(start, end).length > MAX_DAYS) throw bad(`Pick a range of at most ${MAX_DAYS} days`);
  const suppliers = await db.many(`select ${COLUMNS} from suppliers where active order by lower(name), id`);
  // What is owed counts every sale and payment from each supplier's owed_from on, whatever the range shown.
  const from = suppliers.reduce((d, s) => (s.pays_when_sold && s.owed_from < d ? s.owed_from : d), start);
  const [lines, payments] = await Promise.all([
    db.many(`select ji.part_id, ji.quantity, ji.pack_size, ji.unit_cost, ji.price, ji.commission,
        p.supplier_id, p.name, p.unit, j.department, j.job_date, j.closed_on
      from job_items ji join jobs j on j.id = ji.job_id join parts p on p.id = ji.part_id
      where ji.kind = 'part' and j.voided_at is null and coalesce(j.closed_on, j.job_date) >= $1`, [from]),
    db.many(`select id, supplier_id, expense_date, side, amount, description from expenses
      where supplier_id is not null and expense_date >= $1 order by expense_date, id`, [from]),
  ]);
  res.json(supplierReport({ suppliers, lines, payments, start, end }));
});

// Paying a supplier: a supplier payment at EOD on `date`, from the drawer cash, GCash or the cash fund.
router.post('/suppliers/:id/payments', async (req, res) => {
  const supplierId = id(req.params.id, 'supplier');
  const day = req.body.date ? date(req.body.date, 'Date') : await shopToday();
  const side = oneOf(req.body.side, ['cash', 'gcash', 'fund'], 'Paid from');
  const amount = money(req.body.amount, 'Amount', { min: 0.01 });
  const note = text(req.body.note, 'Note', { max: 120 });
  const row = await db.tx(req.user.email, async q => {
    const { name } = await loadSupplier(q, supplierId);
    await assertDayOpen(q, day, req.user);
    await assertNotFarAhead(q, day, 'Date');
    if (side === 'fund') await assertFundCovers(q, amount);
    const description = `Supplier payment: ${name}${note ? ` (${note})` : ''}`.slice(0, 200);
    return q.one(`insert into expenses (expense_date, side, description, amount, for_resale, supplier_id) values ($1, $2, $3, $4, true, $5)
      returning id as expense_id, expense_date, side, amount, description, supplier_id`, [day, side, description, amount, supplierId]);
  });
  res.status(201).json(row);
});

module.exports = { router };
