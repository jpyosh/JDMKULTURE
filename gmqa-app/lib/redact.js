// Costs and margins are owner-only. For everyone else, cost fields are removed from every API
// response here, in one place, so a new endpoint cannot leak them by accident.
const HIDDEN_KEYS = new Set(['unit_cost', 'avg_cost', 'partsCost']);

function redactCosts(value, parentKey = null) {
  if (Array.isArray(value)) return value.map(v => redactCosts(v, parentKey));
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    const out = {};
    for (const [key, v] of Object.entries(value)) {
      if (HIDDEN_KEYS.has(key) || (parentKey === 'totals' && key === 'cost')) continue;
      out[key] = redactCosts(v, key);
    }
    return out;
  }
  return value;
}

// Express middleware: runs after authentication.
function redactCostsForStaff(req, res, next) {
  if (req.user?.role !== 'owner') {
    const json = res.json.bind(res);
    res.json = body => json(redactCosts(body));
  }
  next();
}

module.exports = { redactCosts, redactCostsForStaff };
