import { $, $$, api, esc, peso, todayLocal, addDays, mondayOf, weekday, DEPARTMENTS } from '../ui.js';

let root;

function mount(el) {
  root = el;
  root.innerHTML = `
    <div class="view-header">
      <div><h1>Sales Reports</h1><div class="desc">Profit = Collected − Commission − Expenses. Unpaid jobs are shown separately.</div></div>
      <div class="date-range-picker">
        <div><label>From</label><input type="date" data-start></div>
        <span class="range-arrow" aria-hidden="true">→</span>
        <div><label>To</label><input type="date" data-end></div>
      </div>
    </div>
    <div class="preset-row">
      <button class="btn ghost small" type="button" data-preset="this-week">This week</button>
      <button class="btn ghost small" type="button" data-preset="last-week">Last week</button>
      <button class="btn ghost small" type="button" data-preset="this-month">This month</button>
      <button class="btn ghost small" type="button" data-preset="last-30">Last 30 days</button>
    </div>
    <div class="weekly-summary" data-summary></div>
    <div class="card">
      <div class="table-wrap"><table class="weekly-table">
        <thead><tr><th>Date</th><th class="num">Vehicles</th>${DEPARTMENTS.map(d => `<th class="num">${esc(d.label)}</th>`).join('')}<th class="num">Total sales</th>
          <th class="num">Cash received</th><th class="num">GCash received</th><th class="num">Unpaid</th><th class="num">Commission</th><th class="num">Expenses</th><th class="num">Profit</th></tr></thead>
        <tbody data-rows></tbody>
      </table></div>
    </div>
    <details class="card help-card" data-help>
      <summary>How to read this report</summary>
      <ul>
        <li><b>Carwash / Detailing / Tint &amp; PPF</b>: paid sales booked on that day. Detailing and Tint &amp; PPF jobs are booked on the day they are both done and paid.</li>
        <li><b>Total sales</b>: all paid sales of the day, every department together.</li>
        <li><b>Cash received / GCash received</b>: money that came in that day, by payment method. Usually equals Total sales; it differs when a running job was paid on a different day than it was booked.</li>
        <li><b>Unpaid</b>: carwash jobs serviced that day that the customer has not paid yet. Not included in sales or profit until paid.</li>
        <li><b>Commission</b>: detailer commission on the day's sales. <b>Expenses</b>: drawer expenses entered on the EOD screen.</li>
        <li><b>Profit</b> = Total sales − Commission − Expenses. Every column is a plain total; nothing is filtered or hidden.</li>
      </ul>
    </details>`;
  $('[data-start]', root).addEventListener('change', load);
  $('[data-end]', root).addEventListener('change', load);
  $$('[data-preset]', root).forEach(b => b.addEventListener('click', () => preset(b.dataset.preset)));
  preset('this-week', false);
}

function preset(name, reload = true) {
  const today = todayLocal();
  const ranges = {
    'this-week': [mondayOf(today), today],
    'last-week': [addDays(mondayOf(today), -7), addDays(mondayOf(today), -1)],
    'this-month': [`${today.slice(0, 8)}01`, today],
    'last-30': [addDays(today, -29), today],
  };
  [$('[data-start]', root).value, $('[data-end]', root).value] = ranges[name];
  if (reload) load();
}

async function show() { await load(); }

async function load() {
  const start = $('[data-start]', root).value;
  const end = $('[data-end]', root).value;
  if (!start || !end) return;
  const { days, totals: t } = await api('GET', `/reports/range?start=${start}&end=${end}`);
  $('[data-summary]', root).innerHTML = `
    <div class="weekly-stat"><span class="weekly-stat-label">Vehicles</span><strong>${t.vehicles}</strong><span class="weekly-stat-note">${days.length} trading day${days.length === 1 ? '' : 's'}</span></div>
    <div class="weekly-stat"><span class="weekly-stat-label">Collected</span><strong>${peso(t.collected)}</strong><span class="weekly-stat-note">${DEPARTMENTS.map(d => `${esc(d.label)} ${peso(t.departments[d.key])}`).join(' · ')}</span></div>
    <div class="weekly-stat"><span class="weekly-stat-label">Costs</span><strong class="amber-text">${peso(t.commission + t.expenses)}</strong><span class="weekly-stat-note">Comm. ${peso(t.commission)} · Exp. ${peso(t.expenses)}</span></div>
    <div class="weekly-stat weekly-stat-profit"><span class="weekly-stat-label">Profit</span><strong class="pos">${peso(t.profit)}</strong><span class="weekly-stat-note">${t.receivables ? `${peso(t.receivables)} still unpaid` : 'All jobs paid'}</span></div>`;
  const tbody = $('[data-rows]', root);
  if (!days.length) {
    tbody.innerHTML = '<tr><td colspan="12"><div class="empty-state">No sales in this range.</div></td></tr>';
    return;
  }
  const row = (label, d, cls = '') => `<tr class="${cls}">
    <td>${label}</td><td class="num" data-label="Vehicles">${d.vehicles}</td>
    ${DEPARTMENTS.map(x => `<td class="num money" data-label="${esc(x.label)}">${peso(d.departments[x.key])}</td>`).join('')}
    <td class="num money" data-label="Total sales">${peso(d.collected)}</td>
    <td class="num money" data-label="Cash received">${peso(d.cashReceived)}</td><td class="num money" data-label="GCash received">${peso(d.gcashReceived)}</td><td class="num money amber-text" data-label="Unpaid">${d.receivables ? peso(d.receivables) : '—'}</td>
    <td class="num money" data-label="Commission">${peso(d.commission)}</td><td class="num money" data-label="Expenses">${peso(d.expenses)}</td>
    <td class="num money weekly-profit ${d.profit < 0 ? 'neg' : 'pos'}" data-label="Profit">${peso(d.profit)}</td></tr>`;
  tbody.innerHTML = days.map(d => row(`<strong class="weekly-date">${esc(weekday(d.date))} ${esc(d.date)}</strong>`, d)).join('')
    + row('<strong>Total</strong>', t, 'weekly-total');
}

export default { mount, show };
