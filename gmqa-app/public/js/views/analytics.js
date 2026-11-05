// Owner's trends: sales, cars and net profit by day, pay week, month or quarter. Every figure comes from
// the server (GET /analytics) and matches Finance for the same days.
import { $, $$, api, esc, peso, prettyDate, todayLocal } from '../ui.js';

const GRAINS = [['day', 'Daily'], ['week', 'Weekly'], ['month', 'Monthly'], ['quarter', 'Quarterly']];

let root;
let grain = 'week';
let data = null;
let selected = -1;
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
    <div data-warning></div>
    <div class="weekly-summary" data-summary></div>
    <div class="card analytics-chart">
      <div class="analytics-readout" data-readout aria-live="polite"></div>
      <div data-chart></div>
      <div class="analytics-note" data-chart-note></div>
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
        <li><b>Daily / Weekly / Monthly / Quarterly</b>: weeks are the Sunday-to-Saturday pay weeks, quarters are calendar quarters (Q1 is January to March).</li>
        <li><b>Sales</b>: paid sales booked in the period, every department together. <b>Cars</b>: every job of the period, paid or not, as in the sales report.</li>
        <li><b>Per day</b>: sales ÷ days with sales. Use it to compare periods, because a period still running has fewer days. <b>Per car</b>: sales ÷ cars.</li>
        <li><b>Net profit</b>: sales − commission − parts cost − expenses − payroll − bills, the same as Finance. Bills count on the day they are paid, so one big bill can make a single day or week look bad.</li>
        <li><b>To check</b>: someone was marked present at the carwash on a day with no sales. If those jobs were never entered, sales and profit for that period are too low.</li>
      </ul>
    </details>`;
  $('[data-date]', root).value = todayLocal();
  $('[data-date]', root).addEventListener('change', load);
  $$('[data-grain]', root).forEach(b => b.addEventListener('click', () => {
    grain = b.dataset.grain;
    load();
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
}

export default { mount, show };
