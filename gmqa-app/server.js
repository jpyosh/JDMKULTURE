const express = require('express');
const path = require('path');
const { db } = require('./lib/db');
const { createAuth } = require('./lib/auth');
const { errorHandler, HttpError } = require('./lib/http');

// verifyToken/sandbox are only passed by tests and scripts/sandbox.js, never in production.
function createApp({ verifyToken, sandbox = false } = {}) {
  const app = express();
  const { authenticate } = createAuth(verifyToken ? { verifyToken } : undefined);
  app.disable('x-powered-by');
  app.use(express.json({ limit: '200kb' }));
  app.use(express.static(path.join(__dirname, 'public'), { maxAge: sandbox ? 0 : '5m' }));

  // ---- public endpoints
  app.get('/api/auth/config', (req, res) => {
    if (sandbox) return res.json({ sandbox: true });
    res.json({ url: process.env.SUPABASE_URL || '', anonKey: process.env.SUPABASE_ANON_KEY || '' });
  });
  app.get('/api/health', async (req, res) => {
    const row = await db.one('select max(version) as version from schema_migrations');
    res.json({ ok: true, schema: row?.version ?? null });
  });

  // ---- everything below requires a signed-in, authorised user
  app.use('/api', authenticate);
  app.use('/api', require('./routes/admin').router);
  app.use('/api', require('./routes/catalog').router);
  app.use('/api', require('./routes/jobs').router);
  app.use('/api', require('./routes/days').router);
  app.use('/api', require('./routes/reports').router);
  app.use('/api', require('./routes/payroll').router);
  app.use('/api', require('./routes/finance').router);
  app.use('/api', () => { throw new HttpError(404, 'Unknown API endpoint'); });

  app.use(errorHandler);
  return app;
}

const app = createApp();

if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`GM QA running on http://localhost:${PORT}`));
}

module.exports = app;
module.exports.createApp = createApp;
