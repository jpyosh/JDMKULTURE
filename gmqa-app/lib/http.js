const { isDate } = require('./calc');

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const bad = message => new HttpError(400, message);
const notFound = (what = 'Record') => new HttpError(404, `${what} not found`);
const forbidden = (message = 'You do not have permission to do that') => new HttpError(403, message);
const conflict = message => new HttpError(409, message);

// ---------------------------------------------------------------- input validation
// Each helper returns the cleaned value or throws a 400 with a message the UI can show as-is.

function money(value, field, { min = 0, allowNull = false } = {}) {
  if (value === '' || value === null || value === undefined) {
    if (allowNull) return null;
    return 0;
  }
  const n = Number(value);
  if (!Number.isFinite(n) || n < min) throw bad(`${field} must be a number${min === 0 ? ' of 0 or more' : ` of at least ${min}`}`);
  if (n > 10_000_000) throw bad(`${field} is too large`);
  return Math.round(n * 100) / 100;
}

function text(value, field, { max = 200, required = false } = {}) {
  const s = value == null ? '' : String(value).trim();
  if (required && !s) throw bad(`${field} is required`);
  if (s.length > max) throw bad(`${field} must be at most ${max} characters`);
  return s || null;
}

function date(value, field = 'Date') {
  if (!isDate(value)) throw bad(`${field} must be a valid date (YYYY-MM-DD)`);
  return value;
}

function oneOf(value, allowed, field) {
  if (!allowed.includes(value)) throw bad(`${field} must be one of: ${allowed.join(', ')}`);
  return value;
}

function time(value, field) {
  if (value === '' || value == null) return null;
  if (!/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(value)) throw bad(`${field} must be a time (HH:MM)`);
  return value.slice(0, 5);
}

function id(value, field = 'id') {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) throw bad(`Invalid ${field}`);
  return n;
}

// Picks only allowed keys that are present in body.
function pick(body, keys) {
  return Object.fromEntries(keys.filter(k => Object.prototype.hasOwnProperty.call(body || {}, k)).map(k => [k, body[k]]));
}

// ---------------------------------------------------------------- error middleware

const PG_MESSAGES = {
  23505: 'That already exists (duplicate)',
  23503: 'That record is still referenced by other data, or points at something that does not exist',
  23514: 'That value is not allowed',
  23502: 'A required value is missing',
  '22P02': 'Invalid value format',
  22007: 'Invalid date or time',
  22008: 'Invalid date or time',
};

// eslint-disable-next-line no-unused-vars
function errorHandler(error, req, res, next) {
  if (error instanceof HttpError) return res.status(error.status).json({ error: error.message });
  if (error.type === 'entity.parse.failed') return res.status(400).json({ error: 'Request body is not valid JSON' });
  if (error.code && PG_MESSAGES[error.code]) {
    console.warn(`[db ${error.code}] ${req.method} ${req.originalUrl}: ${error.message}`);
    return res.status(error.code === '23505' ? 409 : 400).json({ error: PG_MESSAGES[error.code], detail: error.detail || error.constraint });
  }
  console.error(`[500] ${req.method} ${req.originalUrl}`, error);
  res.status(500).json({ error: 'Something went wrong on the server. Please try again.' });
}

module.exports = { HttpError, bad, notFound, forbidden, conflict, money, text, date, oneOf, time, id, pick, errorHandler };
