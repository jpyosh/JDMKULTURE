const test = require('node:test');
const assert = require('node:assert/strict');
const vercel = require('../vercel.json');

// The database is in Supabase Tokyo (ap-northeast-1). The API must run next to it: from Washington DC
// every query crossed the Pacific (~150 ms each, 1-3 s per save).
test('the API runs in Tokyo, next to the database', () => {
  assert.deepEqual(vercel.regions, ['hnd1']);
});

test('the sign-off PDF fonts ship with the API', () => {
  const api = vercel.builds.find(b => b.src === 'api/index.js');
  assert.ok(api.config.includeFiles.includes('lib/fonts/**'));
});
