const express = require('express');
const path = require('path');
const { db } = require('./lib/db');
const { createAuth } = require('./lib/auth');
const { errorHandler, HttpError } = require('./lib/http');
const { redactCostsForStaff } = require('./lib/redact');
const { partsRetiredFrom } = require('./lib/parts-retired');

// verifyToken/sandbox are only passed by tests and scripts/sandbox.js, never in production.
function createApp({ verifyToken, sandbox = false } = {}) {
  const app = express();
  const { authenticate } = createAuth(verifyToken ? { verifyToken } : undefined);
  app.disable('x-powered-by');
  app.use(express.json({ limit: '200kb' }));
  app.use(express.static(path.join(__dirname, 'public'), { maxAge: sandbox ? 0 : '5m' }));

  // ---- public endpoints
  // parts_retired_from: the day the parts department moved to its Excel file (lib/parts-retired.js); the screens hide
  // selling parts from then. Not a secret, so it comes with the sign-in settings the page loads first.
  app.get('/api/auth/config', (req, res) => {
    const parts = { parts_retired_from: partsRetiredFrom() };
    if (sandbox) return res.json({ sandbox: true, ...parts });
    res.json({ url: process.env.SUPABASE_URL || '', anonKey: process.env.SUPABASE_ANON_KEY || '', ...parts });
  });
  app.get('/api/health', async (req, res) => {
    const row = await db.one('select max(version) as version from schema_migrations');
    res.json({ ok: true, schema: row?.version ?? null });
  });

  // ---- everything below requires a signed-in, authorised user
  app.use('/api', authenticate);
  app.use('/api', redactCostsForStaff);
  app.use('/api', require('./routes/admin').router);
  app.use('/api', require('./routes/catalog').router);
  app.use('/api', require('./routes/jobs').router);
  app.use('/api', require('./routes/days').router);
  app.use('/api', require('./routes/reports').router);
  app.use('/api', require('./routes/analytics').router);
  app.use('/api', require('./routes/payroll').router);
  app.use('/api', require('./routes/finance').router);
  app.use('/api', require('./routes/inventory').router);
  app.use('/api', require('./routes/cash-fund').router);
  app.use('/api', require('./routes/remittances').router);
  app.use('/api', require('./routes/suppliers').router);
  app.use('/api', () => { throw new HttpError(404, 'Unknown API endpoint'); });

  app.use(errorHandler);
  return app;
}

const app = createApp();

if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`GM Operations Console running on http://localhost:${PORT}`));
}

module.exports = app;
module.exports.createApp = createApp;
