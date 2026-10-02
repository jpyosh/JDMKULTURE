#!/usr/bin/env node
// Database admin CLI. Reads DATABASE_URL from the environment (npm scripts load .env).
//
//   npm run db -- status                 list applied / pending migrations
//   npm run db -- migrate                back up every table, then apply pending migrations
//   npm run db -- backup                 dump every table to backups/<timestamp>.json
//   npm run db -- rehearse               copy the database and run pending migrations on the copy only
//   npm run db -- query "select ..."     run SQL in a READ ONLY transaction, print rows
//   npm run db -- grant <email> <owner|staff> [display name]
//   npm run db -- revoke <email>
//   npm run db -- users                  list app users and Supabase Auth accounts
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getDriver } = require('../lib/db');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');
const BACKUP_DIR = path.join(__dirname, '..', 'backups');
const LOCK_KEY = 4815162342; // arbitrary constant: serialises concurrent migration runs

function loadMigrations() {
  return fs.readdirSync(MIGRATIONS_DIR)
    .filter(file => /^\d{3}_[\w-]+\.sql$/.test(file))
    .sort()
    .map(file => {
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      return {
        version: file.slice(0, 3),
        name: file.slice(4, -4),
        sql,
        checksum: crypto.createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex').slice(0, 16),
      };
    });
}

const ensureTableSql = `create table if not exists public.schema_migrations (
  version text primary key,
  name text not null,
  checksum text not null,
  applied_at timestamptz not null default now()
)`;

async function appliedMigrations(driver) {
  await driver.query(ensureTableSql);
  await driver.query('alter table public.schema_migrations enable row level security');
  const { rows } = await driver.query('select version, name, checksum, applied_at from public.schema_migrations order by version');
  return new Map(rows.map(row => [row.version, row]));
}

// Read-only: reports what is applied without creating the tracking table.
async function status(driver = getDriver()) {
  const { rows: [tracking] } = await driver.query("select to_regclass('public.schema_migrations') as t");
  const applied = tracking.t
    ? new Map((await driver.query('select version, checksum, applied_at from public.schema_migrations')).rows.map(r => [r.version, r]))
    : new Map();
  return loadMigrations().map(m => {
    const row = applied.get(m.version);
    return {
      version: m.version,
      name: m.name,
      state: !row ? 'pending' : row.checksum === m.checksum ? 'applied' : 'applied (file changed since!)',
      applied_at: row?.applied_at ?? null,
    };
  });
}

// Each migration runs in its own transaction: it either fully applies or leaves no trace.
async function migrate(driver = getDriver(), { log = console.log, to = null } = {}) {
  const applied = await appliedMigrations(driver);
  const pending = loadMigrations().filter(m => !applied.has(m.version) && (!to || m.version <= to));
  for (const m of pending) {
    log(`applying ${m.version}_${m.name} ...`);
    await driver.transaction(async client => {
      await client.query('select pg_advisory_xact_lock($1)', [LOCK_KEY]);
      const again = await client.query('select 1 from public.schema_migrations where version = $1', [m.version]);
      if (again.rows.length) return;
      await client.script(m.sql);
      await client.query('insert into public.schema_migrations (version, name, checksum) values ($1, $2, $3)',
        [m.version, m.name, m.checksum]);
    });
    log(`applied  ${m.version}_${m.name}`);
  }
  if (!pending.length) log('database is up to date');
  return pending.map(m => m.version);
}

async function backup(driver = getDriver(), label = 'manual') {
  const { rows: tables } = await driver.query(`select table_name from information_schema.tables
    where table_schema = 'public' and table_type = 'BASE TABLE' order by table_name`);
  const dump = { taken_at: new Date().toISOString(), label, tables: {} };
  for (const { table_name: table } of tables) {
    dump.tables[table] = (await driver.query(`select * from public."${table.replace(/"/g, '""')}"`)).rows;
  }
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const file = path.join(BACKUP_DIR, `${dump.taken_at.replace(/[:.]/g, '-')}_${label}.json`);
  fs.writeFileSync(file, JSON.stringify(dump, null, 1));
  const counts = Object.entries(dump.tables).map(([t, r]) => `${t}=${r.length}`).join(' ');
  return { file, counts };
}

async function readOnlyQuery(driver, sql) {
  return driver.transaction(async client => {
    await client.query('set transaction read only');
    return (await client.query(sql)).rows;
  });
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  const driver = getDriver();
  try {
    switch (command) {
      case 'status':
        console.table(await status(driver));
        break;
      case 'migrate': {
        const pendingCount = (await status(driver)).filter(m => m.state === 'pending').length;
        if (!pendingCount) { console.log('database is up to date'); break; }
        const { file, counts } = await backup(driver, 'pre-migrate');
        console.log(`backup written: ${path.relative(process.cwd(), file)}\n  ${counts}`);
        await migrate(driver);
        break;
      }
      case 'backup': {
        const { file, counts } = await backup(driver, args[0] || 'manual');
        console.log(`backup written: ${path.relative(process.cwd(), file)}\n  ${counts}`);
        break;
      }
      case 'rehearse': {
        // Only SELECTs run against the real database (to take the copy); the migrations run on the copy.
        const { file, counts } = await backup(driver, 'rehearsal');
        console.log(`read-only copy taken: ${path.relative(process.cwd(), file)}\n  ${counts}`);
        const { rehearse } = require('./rehearse');
        const report = await rehearse(JSON.parse(fs.readFileSync(file, 'utf8')));
        if (report.checks.length) {
          console.table(report.checks.map(c => ({ check: c.name, before: c.before, after: c.after, result: c.ok ? 'OK' : 'MISMATCH' })));
        }
        for (const c of report.checks.filter(x => x.mismatchedJobIds)) console.log(`${c.name}: job ids ${c.mismatchedJobIds.join(', ')}`);
        if (report.error) console.log(`error: ${report.error}`);
        console.log(report.ok ? `REHEARSAL PASSED: migrations ${report.applied.join(', ')} work on a copy of this data.`
          : 'REHEARSAL FAILED: do not migrate this database until this is fixed.');
        process.exitCode = report.ok ? 0 : 1;
        break;
      }
      case 'query': {
        if (!args[0]) throw new Error('usage: query "<sql>"');
        const rows = await readOnlyQuery(driver, args.join(' '));
        console.log(JSON.stringify(rows, null, 2));
        break;
      }
      case 'grant': {
        const [email, role, ...name] = args;
        if (!email || !['owner', 'staff'].includes(role)) throw new Error('usage: grant <email> <owner|staff> [display name]');
        const { rows } = await driver.query(`insert into public.app_users (email, role, display_name, active)
          values (lower(btrim($1)), $2, nullif($3, ''), true)
          on conflict (email) do update set role = excluded.role, active = true,
            display_name = coalesce(excluded.display_name, app_users.display_name)
          returning email, role, display_name, active`, [email, role, name.join(' ')]);
        console.table(rows);
        break;
      }
      case 'revoke': {
        if (!args[0]) throw new Error('usage: revoke <email>');
        const { rows } = await driver.query('update public.app_users set active = false where email = lower(btrim($1)) returning email, role, active', [args[0]]);
        console.table(rows);
        break;
      }
      case 'users': {
        console.log('App users (who may use GM QA):');
        console.table((await driver.query('select email, role, display_name, active, user_id is not null as has_logged_in from public.app_users order by email')).rows);
        try {
          console.log('Supabase Auth accounts (who can sign in):');
          console.table((await driver.query('select email, created_at, last_sign_in_at from auth.users order by created_at')).rows);
        } catch {
          console.log('(auth.users not available on this database)');
        }
        break;
      }
      default:
        console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(1, 12).join('\n'));
        process.exitCode = command ? 1 : 0;
    }
  } finally {
    await driver.end();
  }
}

if (require.main === module) {
  main().catch(error => { console.error(`error: ${error.message}`); process.exitCode = 1; });
}

module.exports = { migrate, status, backup, loadMigrations };
