// The parts department moved to its own Excel file on 2026-11-18. The app keeps every parts sale up to Nov 17 (EOD,
// Sales Reports, Finance and Analytics show those days as before) and takes no new one: no parts counter sale and no
// part line on a job dated from that day. What parts earns comes back as one figure a week (parts_weekly_net).
const { bad } = require('./http');

const PARTS_RETIRED_FROM = '2026-11-18';

// Tests and the UI smoke test describe the parts counter as it worked before, so they can turn the cutover off (null)
// or move it; production always uses PARTS_RETIRED_FROM.
let override;
const setPartsRetiredFrom = day => { override = day; };
const partsRetiredFrom = () => (override === undefined ? PARTS_RETIRED_FROM : override);

// A parts sale (a parts counter job, or a part on any job) dated `day`.
function assertPartsSaleAllowed(day) {
  const from = partsRetiredFrom();
  if (from && day >= from) {
    throw bad(`Parts are no longer sold in the app from ${from}: the parts department keeps its sales in its Excel file.`);
  }
}

module.exports = { PARTS_RETIRED_FROM, partsRetiredFrom, setPartsRetiredFrom, assertPartsSaleAllowed };
