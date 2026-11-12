// Owner's trends: sales, cars and net profit by day, pay week, month or quarter. Every figure comes from
// the server (GET /analytics) and matches Finance for the same days.
import { $, $$, api, esc, peso, prettyDate, todayLocal, openDaysBanner } from '../ui.js';

const GRAINS = [['day', 'Daily'], ['week', 'Weekly'], ['month', 'Monthly'], ['quarter', 'Quarterly']];

let root;
let grain = 'week';
let data = null;
let selected = -1;
let measure = 'sold'; // what the services' trend bars show: 'sold' or 'sales'
let lastRequest = 0;

function mount(el) {
  root = el;
  root.innerHTML = `
    <div class="view-header">
      <div><h1>Analytics</h1><div class="desc">How the shop is trending. The figures are the same as Finance for the same days.</div></div>
    </div>
    <div class="analytics-tools">
      <div class="segmented compact" role="group" aria-label="Period">
        ${GRAINS.map(([key, label]) => `<button type="button" data-grain="${key}">${label}</button>`).join('')}
      </div>
      <div><label>Up to</label><input type="date" data-date></div>
    </div>
    <div data-open-days></div>
    <div data-warning></div>
    <div class="weekly-summary" data-summary></div>
    <div class="card analytics-chart">
      <div class="analytics-readout" data-readout aria-live="polite"></div>
      <div data-chart></div>
      <div class="analytics-note" data-chart-note></div>
    </div>
    <div class="card analytics-services" data-services>
      <div class="analytics-services-head">
        <div><h2>Services</h2><div class="analytics-note" data-services-period aria-live="polite"></div><div class="analytics-note" data-services-compare></div></div>
        <div class="segmented compact" role="group" aria-label="Trend bars show">
          <button type="button" data-measure="sold">Sold</button><button type="button" data-measure="sales">Brought in</button>
        </div>
      </div>
      <div class="table-wrap"><table class="weekly-table service-table">
        <thead><tr><th>Service</th><th>Trend</th><th class="num">Sold</th><th class="num">Brought in</th><th class="num">Change</th></tr></thead>
        <tbody data-service-rows></tbody>
      </table></div>
    </div>
    <div class="card">
      <div class="table-wrap"><table class="weekly-table">
        <thead><tr><th>Period</th><th class="num">Days with sales</th><th class="num">Cars</th><th class="num">Sales</th><th class="num">Per day</th><th class="num">Per car</th>
          <th class="num">Commission</th><th class="num">Parts cost</th><th class="num">Expenses</th><th class="num">Payroll</th><th class="num">Bills</th><th class="num">Net profit</th></tr></thead>
        <tbody data-rows></tbody>
      </table></div>
    </div>
    <details class="card help-card" data-help>
      <summary>How to read Analytics</summary>
      <ul>
        <li><b>Only closed days count</b>, the same as Finance. A day is added once it is closed in EOD Closing; days still open are named at the top.</li>
        <li><b>Daily / Weekly / Monthly / Quarterly</b>: weeks are the Sunday-to-Saturday pay weeks, quarters are calendar quarters (Q1 is January to March).</li>
        <li><b>Sales</b>: paid sales booked in the period, every department together. <b>Cars</b>: every job of the period, paid or not, as in the sales report.</li>
        <li><b>Per day</b>: sales ÷ days with sales. Use it to compare periods, because a period still running has fewer days. <b>Per car</b>: sales ÷ cars.</li>
        <li><b>Net profit</b>: sales − commission − parts cost − expenses − payroll − bills, the same as Finance. Bills count on the day they are paid, so one big bill can make a single day or week look bad.</li>
        <li><b>To check</b>: someone was marked present at the carwash on a day with no sales. If those jobs were never entered, sales and profit for that period are too low.</li>
        <li><b>Services</b>: every Pricing Matrix service and add-on sold in the periods shown, biggest earner first, under the name on the sale (Standard Wash counts as Regular Wash). Tap a bar in the chart above to see another period.</li>
        <li><b>Sold</b>: how many, paid or not, like Cars. <b>Brought in</b>: the price on the sale of the paid ones, before discounts, like Sales. <b>Other</b> is custom items, parts and labor. Discounts are on the whole job, so they have their own line, and everything adds up to Sales.</li>
        <li><b>Trend</b>: each service's bars use its own scale, so they show its shape, not its size next to other services. <b>Change</b>: how many sold per day with sales in the last two periods with sales. <b>New</b> means none sold in the period before. Few sales swing the percentage a lot.</li>
      </ul>
    </details>`;
  $('[data-date]', root).value = todayLocal();
  $('[data-date]', root).addEventListener('change', load);
  $$('[data-grain]', root).forEach(b => b.addEventListener('click', () => {
    grain = b.dataset.grain;
    load();
  }));
  $$('[data-measure]', root).forEach(b => b.addEventListener('click', () => {
    measure = b.dataset.measure;
    if (data) renderServices(); // still loading: the first render uses the choice
  }));
}

async function show() { await load(); }

async function load() {
  const day = $('[data-date]', root).value;
  if (!day) return;
  const request = ++lastRequest;
  const result = await api('GET', `/analytics?grain=${grain}&date=${day}`);
  if (request !== lastRequest) return; // a newer choice is already loading
  data = result;
  selected = data.periods.length - 1;
  render();
}

const changeText = (pct, previous) => {
  if (pct === null) return `nothing to compare in ${previous.label}`;
  return `${pct > 0 ? '+' : ''}${pct}% vs ${previous.label}`;
};
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function render() {
  const { periods, change } = data;
  $$('[data-grain]', root).forEach(b => {
    const active = b.dataset.grain === data.grain;
    b.classList.toggle('active', active);
    b.setAttribute('aria-pressed', String(active));
  });
  const now = periods[periods.length - 1];
  const before = periods[periods.length - 2];
  const running = now.partial ? ' so far' : '';

  $('[data-open-days]', root).innerHTML = openDaysBanner(periods.flatMap(p => p.openDays));
  const toCheck = periods.flatMap(p => p.staffNoSales);
  $('[data-warning]', root).innerHTML = toCheck.length ? `<div class="banner tips-reminder" data-to-check>
    <span><b>Check these numbers.</b> Someone was marked present at the carwash on ${plural(toCheck.length, 'day')} with no sales logged
    (latest: ${esc(prettyDate(toCheck[toCheck.length - 1]))}). If those jobs were never entered, sales and profit are too low.</span></div>` : '';

  $('[data-summary]', root).innerHTML = `
    <div class="weekly-stat"><span class="weekly-stat-label">Sales, ${esc(now.label)}${running}</span><strong>${peso(now.sales)}</strong><span class="weekly-stat-note">${peso(now.perDay)} per day · ${esc(changeText(change.perDay, before))}</span></div>
    <div class="weekly-stat"><span class="weekly-stat-label">Cars</span><strong>${now.cars}</strong><span class="weekly-stat-note">${plural(now.salesDays, 'day')} with sales</span></div>
    <div class="weekly-stat"><span class="weekly-stat-label">Per car</span><strong>${peso(now.perCar)}</strong><span class="weekly-stat-note">${esc(changeText(change.perCar, before))}</span></div>
    <div class="weekly-stat weekly-stat-profit"><span class="weekly-stat-label">Net profit</span><strong class="${now.netProfit < 0 ? 'neg' : 'pos'}">${peso(now.netProfit)}</strong><span class="weekly-stat-note">${now.receivables ? `${peso(now.receivables)} still unpaid` : 'All jobs paid'}</span></div>`;

  const top = Math.max(...periods.map(p => p.sales), 1);
  $('[data-chart]', root).innerHTML = `
    <div class="analytics-bars">${periods.map((p, i) => `<button type="button" class="analytics-bar${p.partial ? ' partial' : ''}" data-bar="${i}"
      aria-label="${esc(p.label)}: ${esc(peso(p.sales))}"><span style="height:${(p.sales / top * 100).toFixed(1)}%"></span></button>`).join('')}</div>
    <div class="analytics-ticks" aria-hidden="true">${periods.map(p => `<span>${esc(tick(p))}</span>`).join('')}</div>`;
  $$('[data-bar]', root).forEach(bar => {
    const pick = () => { selected = Number(bar.dataset.bar); paintSelection(); };
    ['mouseenter', 'focus', 'click'].forEach(type => bar.addEventListener(type, pick));
  });
  $('[data-chart-note]', root).textContent = `Sales for each period${now.partial ? '. The lighter bar is still running' : ''}.`;
  paintSelection();

  $('[data-rows]', root).innerHTML = [...periods].reverse().map(p => `<tr>
    <td><strong class="weekly-date">${esc(p.label)}</strong>${p.partial ? ' <span class="muted small">so far</span>' : ''}</td>
    <td class="num" data-label="Days with sales">${p.salesDays}${p.staffNoSales.length ? `<small class="to-check">${p.staffNoSales.length} to check</small>` : ''}</td>
    <td class="num" data-label="Cars">${p.cars}</td>
    <td class="num money" data-label="Sales">${peso(p.sales)}</td>
    <td class="num money" data-label="Per day">${peso(p.perDay)}</td>
    <td class="num money" data-label="Per car">${peso(p.perCar)}</td>
    <td class="num money" data-label="Commission">${peso(p.commission)}</td>
    <td class="num money" data-label="Parts cost">${peso(p.partsCost)}</td>
    <td class="num money" data-label="Expenses">${peso(p.expenses)}</td>
    <td class="num money" data-label="Payroll">${peso(p.payroll)}</td>
    <td class="num money" data-label="Bills">${peso(p.bills)}</td>
    <td class="num money weekly-profit ${p.netProfit < 0 ? 'neg' : 'pos'}" data-label="Net profit">${peso(p.netProfit)}</td></tr>`).join('');
}

// Short enough to sit under a bar on a phone.
function tick(p) {
  if (data.grain === 'day') return String(Number(p.start.slice(8)));
  if (data.grain === 'week') return p.label.split('–')[0];
  if (data.grain === 'month') return p.label.slice(0, 3);
  return p.label;
}

function paintSelection() {
  const p = data.periods[selected];
  $$('[data-bar]', root).forEach(bar => bar.classList.toggle('selected', Number(bar.dataset.bar) === selected));
  $('[data-readout]', root).textContent = `${p.label}${p.partial ? ' so far' : ''}: ${peso(p.sales)} · ${plural(p.cars, 'car')} · net profit ${peso(p.netProfit)}`;
  renderServices();
}

const CHANGE_TEXT = { up: pct => `▲ ${pct}%`, down: pct => `▼ ${Math.abs(pct)}%`, flat: () => 'Same', new: () => 'New' };

// One bar per period, on the service's own scale.
function spark(s) {
  const { periods } = data;
  const show = v => (measure === 'sales' ? peso(v) : String(v));
  const top = Math.max(...s.periods.map(c => c[measure]), 1);
  const bars = s.periods.map((c, i) => `<span class="${[periods[i].partial && 'partial', i === selected && 'selected'].filter(Boolean).join(' ')}"
    style="height:${(c[measure] / top * 100).toFixed(1)}%" title="${esc(periods[i].label)}: ${esc(show(c[measure]))}"></span>`).join('');
  const said = s.periods.map((c, i) => `${periods[i].label} ${show(c[measure])}`).join(', ');
  return `<div class="service-spark" data-spark role="img" aria-label="${esc(`${measure === 'sales' ? 'Brought in' : 'Sold'}: ${said}`)}">${bars}</div>`;
}

function renderServices() {
  const { items, other, discounts, compare } = data.services;
  const p = data.periods[selected];
  $$('[data-measure]', root).forEach(b => {
    const active = b.dataset.measure === measure;
    b.classList.toggle('active', active);
    b.setAttribute('aria-pressed', String(active));
  });
  $('[data-services-period]', root).textContent = `Sold and brought in: ${p.label}${p.partial ? ' so far' : ''}. Tap a bar in the chart above for another period.`;
  $('[data-services-compare]', root).textContent = compare
    ? `Change is always ${compare.now} vs ${compare.before}, whichever bar is picked.`
    : 'Change needs two periods with sales.';
  const rows = items.map(s => `<tr data-service>
    <td><strong>${esc(s.name)}</strong>${s.kind === 'addon' ? ' <span class="muted small">Add-on</span>' : ''}</td>
    <td data-label="Trend">${spark(s)}</td>
    <td class="num" data-label="Sold">${s.periods[selected].sold}</td>
    <td class="num money" data-label="Brought in">${peso(s.periods[selected].sales)}</td>
    <td class="num service-change ${s.trend || ''}" data-label="Change">${s.trend ? CHANGE_TEXT[s.trend](s.change) : '–'}</td></tr>`).join('');
  const line = (label, amount, attr = '') => `<tr class="weekly-total"><td colspan="3">${label}</td>
    <td class="num money" data-label="Brought in" ${attr}>${amount}</td><td></td></tr>`;
  $('[data-service-rows]', root).innerHTML = (rows || '<tr><td colspan="5" class="muted">No services sold in these periods.</td></tr>')
    + line('Other: custom items, parts, labor', peso(other[selected]))
    + line('Discounts', `−${peso(discounts[selected])}`)
    + line('Sales', peso(p.sales), 'data-services-total');
}

export default { mount, show };
