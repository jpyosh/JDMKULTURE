// Pricing Matrix: services + add-ons with a price and commission per vehicle class.
const express = require('express');
const { db } = require('../lib/db');
const { requireOwner } = require('../lib/auth');
const { bad, notFound, money, text, oneOf, id, pick } = require('../lib/http');
const { DEPARTMENT_KEYS } = require('../lib/calc');

const router = express.Router();

async function loadCatalog(q = db) {
  const [classes, items, prices] = await Promise.all([
    q.many('select code, label, sort_order, active from vehicle_classes order by sort_order, code'),
    q.many('select id, kind, department, name, sort_order, active from catalog_items where active order by kind desc, sort_order, id'),
    q.many('select p.item_id, p.vehicle_class, p.price, p.commission from catalog_prices p join catalog_items i on i.id = p.item_id where i.active'),
  ]);
  const byItem = new Map(items.map(item => [item.id, { ...item, prices: {} }]));
  for (const p of prices) {
    const item = byItem.get(p.item_id);
    if (item) item.prices[p.vehicle_class] = { price: p.price, commission: p.commission };
  }
  return { classes, items: [...byItem.values()] };
}

// Validates { CODE: { price, commission } } against the known classes.
async function cleanPrices(q, prices) {
  if (prices == null) return [];
  if (typeof prices !== 'object' || Array.isArray(prices)) throw bad('prices must be an object keyed by vehicle class');
  const codes = new Set((await q.many('select code from vehicle_classes')).map(r => r.code));
  return Object.entries(prices).map(([code, value]) => {
    if (!codes.has(code)) throw bad(`Unknown vehicle class ${code}`);
    return {
      code,
      price: money(value?.price, `${code} price`),
      commission: money(value?.commission, `${code} commission`),
    };
  });
}

async function savePrices(q, itemId, prices) {
  for (const p of prices) {
    await q.query(`insert into catalog_prices (item_id, vehicle_class, price, commission) values ($1, $2, $3, $4)
      on conflict (item_id, vehicle_class) do update set price = excluded.price, commission = excluded.commission
      where (catalog_prices.price, catalog_prices.commission) is distinct from (excluded.price, excluded.commission)`,
    [itemId, p.code, p.price, p.commission]);
  }
}

router.get('/catalog', async (req, res) => {
  res.json(await loadCatalog());
});

router.post('/catalog', requireOwner, async (req, res) => {
  const kind = oneOf(req.body.kind, ['service', 'addon'], 'kind');
  const department = oneOf(req.body.department, DEPARTMENT_KEYS, 'Department');
  const name = text(req.body.name, 'Name', { required: true, max: 120 });
  const itemId = await db.tx(req.user.email, async q => {
    const prices = await cleanPrices(q, req.body.prices);
    const { next } = await q.one('select coalesce(max(sort_order), 0) + 10 as next from catalog_items where kind = $1', [kind]);
    const item = await q.one('insert into catalog_items (kind, department, name, sort_order) values ($1, $2, $3, $4) returning id', [kind, department, name, next]);
    await savePrices(q, item.id, prices);
    return item.id;
  });
  const catalog = await loadCatalog();
  res.status(201).json(catalog.items.find(i => i.id === itemId));
});

router.patch('/catalog/:id', requireOwner, async (req, res) => {
  const itemId = id(req.params.id);
  const fields = pick(req.body, ['name', 'sort_order', 'department']);
  await db.tx(req.user.email, async q => {
    const existing = await q.one('select id from catalog_items where id = $1 and active', [itemId]);
    if (!existing) throw notFound('Item');
    if ('name' in fields) await q.query('update catalog_items set name = $2 where id = $1', [itemId, text(fields.name, 'Name', { required: true, max: 120 })]);
    if ('department' in fields) await q.query('update catalog_items set department = $2 where id = $1', [itemId, oneOf(fields.department, DEPARTMENT_KEYS, 'Department')]);
    if ('sort_order' in fields) await q.query('update catalog_items set sort_order = $2 where id = $1', [itemId, Math.trunc(Number(fields.sort_order) || 0)]);
    await savePrices(q, itemId, await cleanPrices(q, req.body.prices));
  });
  const catalog = await loadCatalog();
  res.json(catalog.items.find(i => i.id === itemId));
});

// Archive, never delete: past jobs keep their frozen copies of the name and price anyway.
router.delete('/catalog/:id', requireOwner, async (req, res) => {
  const changed = await db.tx(req.user.email, q => q.exec('update catalog_items set active = false where id = $1 and active', [id(req.params.id)]));
  if (!changed) throw notFound('Item');
  res.json({ ok: true });
});

// ---------------------------------------------------------------- vehicle classes

router.post('/classes', requireOwner, async (req, res) => {
  const code = text(req.body.code, 'Code', { required: true, max: 16 }).toUpperCase().replace(/\s+/g, '_');
  if (!/^[A-Z0-9_]+$/.test(code)) throw bad('Code may only contain letters, numbers and underscores');
  const label = text(req.body.label, 'Label', { max: 40 }) || code.replace(/_/g, ' ');
  const row = await db.tx(req.user.email, async q => {
    const { next } = await q.one('select coalesce(max(sort_order), 0) + 10 as next from vehicle_classes');
    return q.one('insert into vehicle_classes (code, label, sort_order) values ($1, $2, $3) returning *', [code, label, next]);
  });
  res.status(201).json(row);
});

router.patch('/classes/:code', requireOwner, async (req, res) => {
  const fields = pick(req.body, ['label', 'sort_order', 'active']);
  const row = await db.tx(req.user.email, async q => {
    const existing = await q.one('select * from vehicle_classes where code = $1', [req.params.code]);
    if (!existing) throw notFound('Vehicle class');
    const next = {
      label: 'label' in fields ? text(fields.label, 'Label', { required: true, max: 40 }) : existing.label,
      sort_order: 'sort_order' in fields ? Math.trunc(Number(fields.sort_order) || 0) : existing.sort_order,
      active: 'active' in fields ? Boolean(fields.active) : existing.active,
    };
    return q.one('update vehicle_classes set label = $2, sort_order = $3, active = $4 where code = $1 returning *',
      [existing.code, next.label, next.sort_order, next.active]);
  });
  res.json(row);
});

module.exports = { router, loadCatalog };
