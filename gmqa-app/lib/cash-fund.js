// The cash fund (revolving fund) for abonos: purchases the day's sales cannot cover yet.
// Money in = what the boss hands over (the starting amount, then each replenishment).
// Money out = expenses recorded at EOD as paid from the cash fund (side 'fund').
// A replenishment closes out every purchase made up to its date, so the boss can be handed an
// itemized list of exactly what he is paying back, weekly or monthly.
const path = require('path');
const PDFDocument = require('pdfkit');
const { db } = require('./db');
const { round2 } = require('./calc');

async function loadCashFund(q = db) {
  const [fund, totals, pending, topups] = await Promise.all([
    q.one('select target from cash_fund where id = 1'),
    q.one(`select (select coalesce(sum(amount), 0) from cash_fund_topups) as money_in,
      (select coalesce(sum(amount), 0) from expenses where side = 'fund') as money_out`),
    q.many(`select id, expense_date, description, amount, created_by from expenses
      where side = 'fund' and topup_id is null order by expense_date, id`),
    q.many(`select t.id, t.entry_date, t.amount, t.note, t.created_by,
        coalesce(sum(e.amount), 0) as items_total, count(e.id)::int as item_count
      from cash_fund_topups t left join expenses e on e.topup_id = t.id
      group by t.id order by t.entry_date desc, t.id desc`),
  ]);
  const target = Number(fund?.target || 0);
  const balance = round2(totals.money_in - totals.money_out);
  const pendingTotal = round2(pending.reduce((s, e) => s + e.amount, 0));
  return {
    target, balance, pending, pendingTotal,
    // What to ask the boss for: back up to the fund's size, or (no size set) what was spent.
    toReplenish: target > 0 ? round2(Math.max(0, target - balance)) : pendingTotal,
    topups: topups.map(t => ({ id: t.id, entry_date: t.entry_date, amount: t.amount, note: t.note, created_by: t.created_by,
      itemsTotal: round2(t.items_total), itemCount: t.item_count })),
  };
}

const topupItems = (q, topupId) => q.many(`select id, expense_date, description, amount, created_by from expenses
  where topup_id = $1 order by expense_date, id`, [topupId]);

// ---------------------------------------------------------------- replenishment sheet (PDF)

const FONTS = {
  regular: path.join(__dirname, 'fonts', 'Inter-Regular.woff'),
  semibold: path.join(__dirname, 'fonts', 'Inter-SemiBold.woff'),
  bold: path.join(__dirname, 'fonts', 'Inter-Bold.woff'),
};
const INK = '#111111';
const MUTED = '#6b6b70';
const RULE = '#cfcfd4';
const HEAD_FILL = '#f2f2f4';
const RED = '#c51f2b';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const prettyDate = date => { const [y, m, d] = date.split('-').map(Number); return `${MONTHS[m - 1]} ${d}, ${y}`; };
const peso = n => `₱${Number(n).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// "Cash_Fund_Replenishment_Oct12_2026.pdf"
function sheetFileName(date) {
  const [y, m, d] = date.split('-').map(Number);
  return `Cash_Fund_Replenishment_${MONTHS[m - 1]}${d}_${y}.pdf`;
}

// sheet: { date, heading, note?, items, total, facts: [[label, value], ...] }
function buildSheet(sheet) {
  const doc = new PDFDocument({
    size: 'A4', margin: 40, font: FONTS.regular, bufferPages: true,
    info: { Title: `Cash Fund Replenishment — ${prettyDate(sheet.date)}`, Author: 'JDM Kulture Auto Salon' },
  });
  for (const [name, file] of Object.entries(FONTS)) doc.registerFont(name, file);
  const W = doc.page.width;
  const H = doc.page.height;
  const M = 40;
  const right = W - M;

  // Baseline-aligned, never wraps: shrinks a little, then ends with an ellipsis (as on the payroll sheet).
  const put = (str, x, w, y, { font = 'regular', size = 9, color = INK, align = 'left' } = {}) => {
    if (!str) return;
    const room = w - 4;
    doc.font(font);
    let fontSize = size;
    while (fontSize > size * 0.75 && doc.fontSize(fontSize).widthOfString(str) > room) fontSize -= 0.25;
    doc.fontSize(fontSize);
    let text = str;
    if (doc.widthOfString(text) > room) {
      while (text.length > 1 && doc.widthOfString(`${text}…`) > room) text = text.slice(0, -1);
      text = `${text.trimEnd()}…`;
    }
    const tw = doc.widthOfString(text);
    const tx = align === 'right' ? x + w - 2 - tw : x + 2;
    doc.fillColor(color).text(text, tx, y, { baseline: 'alphabetic', lineBreak: false });
  };
  const hline = (y, color = RULE, width = 0.6) => doc.moveTo(M, y).lineTo(right, y).lineWidth(width).strokeColor(color).stroke();

  const col = { num: { x: M, w: 24 }, date: { x: M + 24, w: 84 }, item: { x: M + 108, w: 250 }, by: { x: M + 358, w: 77 }, amount: { x: M + 435, w: right - M - 435 } };
  const ROW_H = 22;
  const HEAD_H = 22;
  const FOOT_H = 120;

  // Title and summary.
  put('JDM Kulture Auto Salon — Cash Fund Replenishment', M, 420, M + 16, { font: 'bold', size: 15 });
  put(sheet.heading, M, 420, M + 34, { size: 9.5, color: MUTED });
  put(prettyDate(sheet.date), right - 150, 150, M + 16, { font: 'semibold', size: 10, align: 'right' });
  doc.rect(M, M + 44, 46, 2).fill(RED);
  let top = M + 62;
  for (const [label, value] of sheet.facts) {
    put(label, M, 200, top, { size: 9.5, color: MUTED });
    put(value, M + 200, 140, top, { font: 'semibold', size: 10, align: 'right' });
    top += 16;
  }
  if (sheet.note) { put(`Note: ${sheet.note}`, M, right - M, top, { size: 9, color: MUTED }); top += 16; }
  top += 10;

  const drawHeader = () => {
    doc.rect(M, top, right - M, HEAD_H).fill(HEAD_FILL);
    const h = { font: 'semibold', size: 7.5, color: MUTED };
    put('#', col.num.x, col.num.w, top + 14, h);
    put('DATE', col.date.x, col.date.w, top + 14, h);
    put('ITEM / WHAT IT WAS FOR', col.item.x, col.item.w, top + 14, h);
    put('RECORDED BY', col.by.x, col.by.w, top + 14, h);
    put('AMOUNT', col.amount.x, col.amount.w, top + 14, { ...h, align: 'right' });
    top += HEAD_H;
    hline(top, '#9a9aa0', 0.8);
  };
  drawHeader();
  sheet.items.forEach((item, i) => {
    if (top + ROW_H + (i === sheet.items.length - 1 ? FOOT_H : 0) > H - M) { doc.addPage(); top = M; drawHeader(); }
    put(String(i + 1), col.num.x, col.num.w, top + 15, { color: MUTED });
    put(prettyDate(item.expense_date), col.date.x, col.date.w, top + 15);
    put(item.description, col.item.x, col.item.w, top + 15, { font: 'semibold' });
    put((item.created_by || '').split('@')[0], col.by.x, col.by.w, top + 15, { size: 8, color: MUTED });
    put(peso(item.amount), col.amount.x, col.amount.w, top + 15, { align: 'right' });
    top += ROW_H;
    hline(top);
  });
  if (!sheet.items.length) {
    put('No purchases to replenish.', M, 300, top + 16, { color: MUTED });
    top += ROW_H;
  }
  if (top + FOOT_H > H - M) { doc.addPage(); top = M; }

  put('TOTAL', col.item.x, col.item.w + col.by.w, top + 20, { font: 'bold', size: 10, align: 'right' });
  put(peso(sheet.total), col.amount.x, col.amount.w, top + 20, { font: 'bold', size: 11, align: 'right' });
  const boxes = ['Prepared by', 'Checked by', 'Received by'];
  const boxW = (right - M) / boxes.length;
  boxes.forEach((label, i) => {
    const bx = M + i * boxW;
    doc.moveTo(bx, top + 78).lineTo(bx + boxW - 24, top + 78).lineWidth(0.6).strokeColor('#9a9aa0').stroke();
    put(label, bx, 150, top + 90, { font: 'semibold', size: 8.5 });
    put('Date: ______________', bx, 160, top + 106, { size: 8.5, color: MUTED });
  });

  const range = doc.bufferedPageRange();
  if (range.count > 1) {
    for (let p = 0; p < range.count; p++) {
      doc.switchToPage(p);
      doc.page.margins.bottom = 0;
      put(`Page ${p + 1} of ${range.count}`, right - 100, 100, H - 16, { size: 7.5, color: MUTED, align: 'right' });
    }
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.end();
  });
}

module.exports = { loadCashFund, topupItems, buildSheet, sheetFileName, peso };
