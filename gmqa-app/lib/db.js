// Postgres access. Everything goes through query()/tx() so the driver can be swapped
// (node-postgres in production, in-memory PGlite in tests).
const { Pool, types } = require('pg');

// Return numbers as JS numbers and dates as plain 'YYYY-MM-DD' strings. node-pg's default
// Date conversion applies the server's timezone and silently shifts business dates.
const NUMERIC = 1700, INT8 = 20, DATE = 1082;
const parsers = {
  [NUMERIC]: v => (v === null ? null : parseFloat(v)),
  [INT8]: v => (v === null ? null : parseInt(v, 10)),
  [DATE]: v => v,
};
for (const [oid, fn] of Object.entries(parsers)) types.setTypeParser(Number(oid), fn);

let driver = null;

function pgDriver(connectionString) {
  const pool = new Pool({
    connectionString: connectionString.replace(/[?&]sslmode=[^&]*/, ''),
    ssl: /localhost|127\.0\.0\.1/.test(connectionString) ? false : { rejectUnauthorized: false },
    max: Number(process.env.PGPOOL_MAX || 5),
    connectionTimeoutMillis: 8000,
    idleTimeoutMillis: 10000,
    statement_timeout: 15000,
  });
  return {
    query: (text, params) => pool.query(text, params),
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn({ query: (text, params) => client.query(text, params), script: text => client.query(text) });
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    },
    end: () => pool.end(),
  };
}

function pgliteDriver(pglite) {
  return {
    query: (text, params) => pglite.query(text, params),
    transaction: fn => pglite.transaction(tx => fn({ query: (text, params) => tx.query(text, params), script: text => tx.exec(text) })),
    end: () => pglite.close(),
  };
}

function getDriver() {
  if (!driver) {
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set');
    driver = pgDriver(process.env.DATABASE_URL);
  }
  return driver;
}

function setDriver(d) { driver = d; }

function helpers(run) {
  return {
    query: run,
    async many(text, params = []) { return (await run(text, params)).rows; },
    async one(text, params = []) { return (await run(text, params)).rows[0] || null; },
    async exec(text, params = []) {
      const result = await run(text, params);
      return result.rowCount ?? result.affectedRows ?? 0;
    },
  };
}

const db = helpers((text, params) => getDriver().query(text, params));

// Runs fn inside a transaction. `actor` (the signed-in user's email) is recorded by the
// audit_log trigger for every row changed in this transaction.
db.tx = function tx(actor, fn) {
  return getDriver().transaction(async client => {
    const q = helpers((text, params) => client.query(text, params));
    if (actor) await q.query("SELECT set_config('app.actor', $1, true)", [actor]);
    return fn(q);
  });
};

module.exports = { db, setDriver, getDriver, pgDriver, pgliteDriver, parsers };
