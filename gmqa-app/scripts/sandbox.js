#!/usr/bin/env node
// Runs the full app on a throwaway in-memory Postgres (PGlite) with the dry-run data loaded and
// fake sign-in, so changes can be tried without touching production. Nothing is saved on exit.
//
//   npm run sandbox            then open http://localhost:3100
//   sign in as owner@sandbox or staff@sandbox (any password)
const crypto = require('crypto');
const { migratedDb } = require('../test/helpers');
const { createApp } = require('../server');

const uuidFor = email => crypto.createHash('md5').update(email).digest('hex')
  .replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');

async function start(port = Number(process.env.PORT) || 3100) {
  const driver = await migratedDb();
  await driver.query(`insert into app_users (email, role, display_name) values
    ('owner@sandbox', 'owner', 'Sandbox Owner'), ('staff@sandbox', 'staff', 'Sandbox Staff')`);
  const verifyToken = async token => (token && token.includes('@') ? { id: uuidFor(token), email: token.toLowerCase() } : null);
  const server = createApp({ verifyToken, sandbox: true }).listen(port);
  await new Promise(resolve => server.once('listening', resolve));
  return { server, driver, url: `http://localhost:${server.address().port}` };
}

if (require.main === module) {
  start().then(({ url }) => {
    console.log(`GM QA sandbox running at ${url}`);
    console.log('Sign in as owner@sandbox or staff@sandbox (any password). Data resets when you stop it.');
  });
}

module.exports = { start };
