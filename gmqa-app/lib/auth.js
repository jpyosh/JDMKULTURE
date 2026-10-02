// Authentication (Supabase Auth issues the session token) + authorization (app_users table
// decides who may use GM QA and with which role). A Supabase account alone grants nothing.
const { createClient } = require('@supabase/supabase-js');
const { db } = require('./db');
const { HttpError, forbidden } = require('./http');

function supabaseVerifier() {
  const { SUPABASE_URL, SUPABASE_ANON_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return null;
  const client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  // getClaims verifies the JWT locally against the project's signing keys when it can, which
  // avoids a network round-trip to Supabase on every API call.
  return async token => {
    const { data, error } = await client.auth.getClaims(token);
    const claims = data?.claims;
    if (error || !claims?.sub || !claims.email) return null;
    return { id: claims.sub, email: String(claims.email).toLowerCase() };
  };
}

const CACHE_MS = 30_000;
const userCache = new Map();
const clearUserCache = () => userCache.clear();

async function resolveUser(identity) {
  const cached = userCache.get(identity.id);
  if (cached && cached.expires > Date.now()) return cached.user;

  let row = await db.one('select email, user_id, role, display_name, active from app_users where email = $1', [identity.email]);
  if (row && row.active && !row.user_id) {
    // First sign-in: bind this Supabase account to the invited email.
    row = await db.one('update app_users set user_id = $1 where email = $2 and user_id is null returning email, user_id, role, display_name, active',
      [identity.id, identity.email]) || row;
  }
  const user = row && row.active && row.user_id === identity.id
    ? { id: identity.id, email: row.email, role: row.role, name: row.display_name || row.email.split('@')[0] }
    : null;
  userCache.set(identity.id, { user, expires: Date.now() + CACHE_MS });
  return user;
}

function createAuth({ verifyToken = supabaseVerifier() } = {}) {
  async function authenticate(req, res, next) {
    if (!verifyToken) throw new HttpError(503, 'Sign-in is not configured on the server (SUPABASE_URL / SUPABASE_ANON_KEY)');
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!token) throw new HttpError(401, 'Please sign in');
    const identity = await verifyToken(token);
    if (!identity) throw new HttpError(401, 'Your session has expired. Please sign in again.');
    const user = await resolveUser(identity);
    if (!user) throw forbidden(`${identity.email} does not have access to GM QA yet. Ask the owner to add you in Settings.`);
    req.user = user;
    next();
  }
  return { authenticate };
}

const requireOwner = (req, res, next) => {
  if (req.user?.role !== 'owner') throw forbidden('Only the owner can do that');
  next();
};

module.exports = { createAuth, requireOwner, clearUserCache };
