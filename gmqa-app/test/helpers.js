const { PGlite } = require('@electric-sql/pglite');
const { pgliteDriver, parsers, setDriver } = require('../lib/db');
const { migrate } = require('../scripts/db');
const legacy = require('./fixtures/legacy-data.json');

const quiet = { log: () => {} };

async function newDriver() {
  const pglite = await PGlite.create({ parsers });
  return pgliteDriver(pglite);
}

// Inserts the exported pre-v2 SQLite rows into a database at migration 001.
async function loadLegacyData(driver) {
  const insert = async (table, rows) => {
    for (const row of rows) {
      const cols = Object.keys(row);
      await driver.query(
        `insert into public.${table} (${cols.map(c => `"${c}"`).join(', ')}) values (${cols.map((_, i) => `$${i + 1}`).join(', ')})`,
        cols.map(c => row[c]));
    }
    if (rows.length && 'id' in rows[0]) {
      await driver.query(`select setval(pg_get_serial_sequence('public.${table}', 'id'), (select max(id) from public.${table}))`);
    }
  };
  for (const table of ['services', 'addons', 'jobs', 'expenses', 'daily_meta', 'employees', 'payroll_entries']) {
    await insert(table, legacy[table]);
  }
}

// A fully migrated database with the legacy data converted, installed as the app's driver.
async function migratedDb() {
  const driver = await newDriver();
  await migrate(driver, { ...quiet, to: '001' });
  await loadLegacyData(driver);
  await migrate(driver, quiet);
  setDriver(driver);
  return driver;
}

module.exports = { newDriver, loadLegacyData, migratedDb, quiet, legacy };
