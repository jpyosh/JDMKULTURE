// Today in the shop (Philippine time), and the limits on how far ahead something can be dated.
// A wrong year or month in a date box is caught here instead of landing on a day nobody will look at.
const { db } = require('./db');
const { addDays } = require('./calc');
const { bad } = require('./http');

const SHOP_TODAY = "(now() at time zone 'Asia/Manila')::date";
// Entries (a job, an expense, money put aside, a bill, a payout) may be dated this many days ahead.
const MAX_DAYS_AHEAD = 7;

let pinned = null; // tests and the UI smoke test pin today; production always asks the database
const setShopToday = day => { pinned = day; };

async function shopToday(q = db) {
  return pinned || (await q.one(`select ${SHOP_TODAY} as d`)).d;
}

// Something that has happened (a day closed, a job finished, a payment received) cannot be dated after today.
async function assertNotAfterToday(q, day, field) {
  const today = await shopToday(q);
  if (day > today) throw bad(`${field} cannot be after today (${today})`);
}

// An entry can be dated a few days ahead (a booking, a planned payout), not further.
async function assertNotFarAhead(q, day, field) {
  const today = await shopToday(q);
  if (day > addDays(today, MAX_DAYS_AHEAD)) {
    throw bad(`${field} ${day} is too far ahead: at most ${MAX_DAYS_AHEAD} days after today (${today}). Check the year and month.`);
  }
}

module.exports = { shopToday, setShopToday, assertNotAfterToday, assertNotFarAhead, MAX_DAYS_AHEAD };
