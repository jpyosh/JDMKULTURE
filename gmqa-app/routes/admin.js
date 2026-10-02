// Owner-only administration: who can use GM QA, and the change history.
const express = require('express');
const { requireOwner, clearUserCache } = require('../lib/auth');
const { db } = require('../lib/db');
const { bad, notFound, text, oneOf, pick } = require('../lib/http');

const router = express.Router();
const ROLES = ['owner', 'staff'];

router.get('/me', (req, res) => res.json(req.user));

router.get('/users', requireOwner, async (req, res) => {
  res.json(await db.many(`select email, role, display_name, active, user_id is not null as has_signed_in, created_at
    from app_users order by active desc, role, email`));
});

router.post('/users', requireOwner, async (req, res) => {
  const email = text(req.body.email, 'Email', { required: true, max: 200 }).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw bad('Enter a valid email address');
  const role = oneOf(req.body.role, ROLES, 'Role');
  const name = text(req.body.display_name, 'Name', { max: 80 });
  const row = await db.tx(req.user.email, q => q.one(`insert into app_users (email, role, display_name) values ($1, $2, $3)
    on conflict (email) do update set role = excluded.role, display_name = coalesce(excluded.display_name, app_users.display_name), active = true
    returning email, role, display_name, active`, [email, role, name]));
  clearUserCache();
  res.status(201).json(row);
});

router.patch('/users/:email', requireOwner, async (req, res) => {
  const email = String(req.params.email).toLowerCase();
  const f = pick(req.body, ['role', 'active', 'display_name']);
  const row = await db.tx(req.user.email, async q => {
    const existing = await q.one('select * from app_users where email = $1', [email]);
    if (!existing) throw notFound('User');
    const next = {
      role: 'role' in f ? oneOf(f.role, ROLES, 'Role') : existing.role,
      active: 'active' in f ? Boolean(f.active) : existing.active,
      display_name: 'display_name' in f ? text(f.display_name, 'Name', { max: 80 }) : existing.display_name,
    };
    if (email === req.user.email && (!next.active || next.role !== 'owner')) throw bad('You cannot remove your own owner access');
    if (existing.role === 'owner' && existing.active && (next.role !== 'owner' || !next.active)) {
      const { n } = await q.one("select count(*)::int as n from app_users where role = 'owner' and active");
      if (n <= 1) throw bad('There must always be at least one active owner');
    }
    return q.one(`update app_users set role = $2, active = $3, display_name = $4 where email = $1
      returning email, role, display_name, active`, [email, next.role, next.active, next.display_name]);
  });
  clearUserCache();
  res.json(row);
});

router.get('/audit', requireOwner, async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
  const params = [limit];
  let where = '';
  if (req.query.table) { params.push(String(req.query.table)); where = `where table_name = $${params.length}`; }
  if (req.query.row) { params.push(String(req.query.row)); where += `${where ? ' and' : 'where'} row_pk = $${params.length}`; }
  res.json(await db.many(`select id, at, actor, table_name, row_pk, action, old_row, new_row from audit_log ${where}
    order by id desc limit $1`, params));
});

module.exports = { router };
