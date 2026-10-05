// Payroll sign-off sheet: one printable PDF per pay period, built from the same payroll the screen
// shows (loadPayroll), with a signature and date-received box per employee and sign-off boxes for the
// people who prepare, check, approve and release the pay.
const path = require('path');
const PDFDocument = require('pdfkit');
const { otRuleNote } = require('./calc');

const MAX_DAYS = 16; // one pay period: a week, 1st-15th or 16th-end
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

// ---------------------------------------------------------------- formatting

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
const parts = date => { const [y, m, d] = date.split('-').map(Number); return { y, m, d }; };
const short = date => { const { m, d } = parts(date); return `${MONTHS[m - 1]} ${d}`; };
const weekdayOf = date => WEEKDAYS[new Date(`${date}T00:00:00Z`).getUTCDay()];

// "Sep 27 – Oct 4, 2026", or "Dec 28, 2026 – Jan 3, 2027" across a new year.
function periodLabel(start, end) {
  const [a, b] = [parts(start), parts(end)];
  return a.y === b.y ? `${short(start)} – ${short(end)}, ${b.y}` : `${short(start)}, ${a.y} – ${short(end)}, ${b.y}`;
}
// "Payroll_Signoff_Sep27-Oct4_2026.pdf"
function fileName(start, end) {
  const [a, b] = [parts(start), parts(end)];
  const tag = date => short(date).replace(' ', '');
  return a.y === b.y ? `Payroll_Signoff_${tag(start)}-${tag(end)}_${b.y}.pdf` : `Payroll_Signoff_${tag(start)}_${a.y}-${tag(end)}_${b.y}.pdf`;
}

const amount = n => Number(n).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const signed = n => (n < 0 ? `−${amount(-n)}` : n > 0 ? `+${amount(n)}` : '');
const plain = n => Number(n).toLocaleString('en-PH', { maximumFractionDigits: 2 });
const hours = n => `${plain(n)}h`;
const rate = n => `₱${plain(n)}`;
// Names typed all in capitals or all in lower case print as "Rene" / "Carlo"; short ones like "JR" stay.
function displayName(name) {
  const tidy = String(name).trim();
  if (tidy.length <= 2 || (tidy !== tidy.toUpperCase() && tidy !== tidy.toLowerCase())) return tidy;
  return tidy.toLowerCase().replace(/(^|[\s-])(\p{L})/gu, (m, sep, ch) => sep + ch.toUpperCase());
}
const roleLabel = role => (role ? `${displayName(role)} · ` : '');

// ---------------------------------------------------------------- rows

function sheetRows(payroll) {
  return payroll.rows
    .filter(r => r.pay.gross > 0 || r.adjustments.length > 0) // nobody with nothing to pay
    .map(({ employee, days, pay }) => ({
      name: displayName(employee.name),
      rates: `${roleLabel(employee.role)}${rate(employee.rate_per_day)} / ${plain(employee.construction_rate)}`,
      days: payroll.dates.map(d => {
        const day = days[d] || {};
        const ot = (Number(day.cw_ot_hours) || 0) + (Number(day.cn_ot_hours) || 0);
        return { code: day.code || '', ot: ot ? `+${hours(ot)}` : '' };
      }),
      cwDays: plain(pay.carwashDays),
      cnDays: plain(pay.constructionDays),
      ot: hours(pay.otHours),
      gross: amount(pay.gross - pay.additions),
      adjust: signed(pay.additions - pay.deductions),
      net: amount(pay.net),
      netValue: pay.net,
    }));
}

// ---------------------------------------------------------------- drawing

function buildPdf(payroll) {
  const dates = payroll.dates;
  const rows = sheetRows(payroll);
  const total = Math.round(rows.reduce((t, r) => t + r.netValue, 0) * 100) / 100;

  const doc = new PDFDocument({
    size: 'A4', layout: 'landscape', margin: 28, font: FONTS.regular, bufferPages: true,
    info: { Title: `Payroll Sign-off Sheet — ${periodLabel(payroll.start, payroll.end)}`, Author: 'JDM Kulture Auto Salon' },
  });
  for (const [name, file] of Object.entries(FONTS)) doc.registerFont(name, file);

  const W = doc.page.width;
  const H = doc.page.height;
  const M = 28;
  const right = W - M;

  // Columns (x = left edge, w = width). Day columns share what is left.
  // Up to 8 days (a week) the columns are roomy; up to 16 (half a month) they tighten so every day fits.
  const fixed = dates.length <= 8
    ? { num: 16, name: 104, cw: 28, cn: 28, ot: 32, gross: 60, adjust: 60, net: 64, sig: 88, date: 54 }
    : { num: 14, name: 92, cw: 22, cn: 22, ot: 26, gross: 50, adjust: 48, net: 54, sig: 70, date: 40 };
  const dayW = Math.min(34, (right - M - Object.values(fixed).reduce((a, b) => a + b, 0)) / dates.length);
  const col = {};
  let x = M;
  for (const key of ['num', 'name']) { col[key] = { x, w: fixed[key] }; x += fixed[key]; }
  col.days = dates.map(() => { const c = { x, w: dayW }; x += dayW; return c; });
  for (const key of ['cw', 'cn', 'ot', 'gross', 'adjust', 'net', 'sig', 'date']) { col[key] = { x, w: fixed[key] }; x += fixed[key]; }
  const dayFont = dayW < 26 ? 7 : 8;

  // All text sits on its baseline so every item of a line shares one y. Text never wraps: it shrinks a
  // little to fit its column and, as a last resort (a very long name), is shortened with an ellipsis.
  const put = (str, c, y, { font = 'regular', size = 8, color = INK, align = 'left' } = {}) => {
    if (!str) return;
    const room = c.w - (align === 'center' ? 1 : 4);
    doc.font(font);
    let fontSize = size;
    while (fontSize > Math.max(5, size * 0.7) && doc.fontSize(fontSize).widthOfString(str) > room) fontSize -= 0.25;
    doc.fontSize(fontSize);
    let text = str;
    if (doc.widthOfString(text) > room) {
      while (text.length > 1 && doc.widthOfString(`${text}…`) > room) text = text.slice(0, -1);
      text = `${text.trimEnd()}…`;
    }
    const w = doc.widthOfString(text);
    const tx = align === 'center' ? c.x + (c.w - w) / 2 : align === 'right' ? c.x + c.w - 2 - w : c.x + 2;
    doc.fillColor(color).text(text, tx, y, { baseline: 'alphabetic', lineBreak: false });
  };
  const at = (xPos, w = 400) => ({ x: xPos - 2, w });
  const hline = (y, color = RULE, width = 0.6) => doc.moveTo(M, y).lineTo(right, y).lineWidth(width).strokeColor(color).stroke();

  const TITLE_H = 58;
  const HEAD_H = 26;
  const ROW_H = 30;
  const FOOT_H = 118;

  function drawTitle() {
    put('JDM Kulture Auto Salon — Payroll Sign-off Sheet', at(M, 520), M + 14, { font: 'bold', size: 14 });
    put('Pay period:', at(right - 230, 90), M + 14, { size: 9, color: MUTED });
    put(periodLabel(payroll.start, payroll.end), at(right - 150, 150), M + 14, { font: 'semibold', size: 9, align: 'right' });
    put('Each employee signs to confirm they received the net pay shown.', at(M, 520), M + 32, { size: 8.5, color: MUTED });
    put('Total net pay:', at(right - 230, 90), M + 32, { size: 9, color: MUTED });
    put(`₱${amount(total)}`, at(right - 150, 150), M + 32, { font: 'bold', size: 11, align: 'right' });
    doc.rect(M, M + 42, 46, 2).fill(RED);
  }

  function drawHeader(top) {
    doc.rect(M, top, right - M, HEAD_H).fill(HEAD_FILL);
    const y1 = top + 10;
    const y2 = top + 21;
    const h = { font: 'semibold', size: 7, color: MUTED };
    dates.forEach((d, i) => {
      put(weekdayOf(d), col.days[i], y1, { ...h, align: 'center', size: dayFont });
      put(d.slice(5), col.days[i], y2, { ...h, align: 'center', size: dayFont });
    });
    put('CW', col.cw, y1, { ...h, align: 'center' });
    put('days', col.cw, y2, { ...h, align: 'center' });
    put('CN', col.cn, y1, { ...h, align: 'center' });
    put('days', col.cn, y2, { ...h, align: 'center' });
    put('DATE', col.date, y1, { ...h, align: 'center' });
    put('RECEIVED', col.date, y2, { ...h, align: 'center' });
    put('#', col.num, y2, h);
    put('EMPLOYEE', col.name, y2, h);
    put('OT', col.ot, y2, { ...h, align: 'center' });
    put('GROSS (₱)', col.gross, y2, { ...h, align: 'right' });
    put('ADJUST. (₱)', col.adjust, y2, { ...h, align: 'right' });
    put('NET PAY (₱)', col.net, y2, { ...h, align: 'right' });
    put('SIGNATURE', col.sig, y2, { ...h, align: 'center' });
    hline(top + HEAD_H, '#9a9aa0', 0.8);
  }

  function drawRow(row, index, top) {
    const y1 = top + 12;
    const y2 = top + 23;
    put(String(index + 1), col.num, y1, { color: MUTED });
    put(row.name, col.name, y1, { font: 'semibold', size: 9 });
    put(row.rates, col.name, y2, { size: 6.5, color: MUTED });
    row.days.forEach((day, i) => {
      put(day.code, col.days[i], y1, { font: 'semibold', size: dayFont, align: 'center', color: day.code === 'A' ? RED : INK });
      put(day.ot, col.days[i], y2, { size: 6.5, align: 'center', color: MUTED });
    });
    put(row.cwDays, col.cw, y1, { align: 'center' });
    put(row.cnDays, col.cn, y1, { align: 'center' });
    put(row.ot, col.ot, y1, { align: 'center' });
    put(row.gross, col.gross, y1, { align: 'right' });
    put(row.adjust, col.adjust, y1, { align: 'right', color: row.adjust.startsWith('−') ? RED : INK });
    put(row.net, col.net, y1, { font: 'bold', size: 9, align: 'right' });
    // Boxes the employee fills in by hand.
    doc.rect(col.sig.x + 4, top + 4, col.sig.w - 8, ROW_H - 8).lineWidth(0.6).strokeColor(RULE).stroke();
    doc.rect(col.date.x + 4, top + 4, col.date.w - 8, ROW_H - 8).lineWidth(0.6).strokeColor(RULE).stroke();
    hline(top + ROW_H);
  }

  function drawFooter(top) {
    // The total lines up with the Net pay column and may run wider to its left; the label sits just before it.
    const totalText = `₱${amount(total)}`;
    const totalRight = col.net.x + col.net.w - 2;
    const totalW = doc.font('bold').fontSize(10).widthOfString(totalText);
    put(totalText, { x: totalRight - totalW - 2, w: totalW + 4 }, top + 16, { font: 'bold', size: 10, align: 'right' });
    put('TOTAL NET PAY', { x: totalRight - totalW - 140, w: 130 }, top + 16, { font: 'bold', size: 9, align: 'right' });
    put('P = Carwash day · 0.5P = Half carwash · CN = Construction · 0.5CN = Half construction · A = Absent · OFF = Day off · +h = overtime hours.',
      at(M, right - M), top + 36, { size: 7, color: MUTED });
    put(`Rate shown as carwash / construction daily rate. ${payroll.otRule || otRuleNote(payroll.start, payroll.end)}`, at(M, right - M), top + 47, { size: 7, color: MUTED });
    const boxes = [['Prepared by', '(Name & signature)'], ['Checked by', '(Name & signature)'], ['Approved by', '(Owner / Manager)'], ['Released by', '(Cash / GCash)']];
    const boxW = (right - M) / 4;
    boxes.forEach(([label, hint], i) => {
      const bx = M + i * boxW;
      doc.moveTo(bx, top + 82).lineTo(bx + boxW - 24, top + 82).lineWidth(0.6).strokeColor('#9a9aa0').stroke();
      put(label, at(bx, 70), top + 93, { font: 'semibold', size: 8 });
      const labelW = doc.font('semibold').fontSize(8).widthOfString(label);
      put(hint, at(bx + labelW + 5, 120), top + 93, { size: 7, color: MUTED });
      put('Date: ______________', at(bx, 160), top + 108, { size: 8, color: MUTED });
    });
  }

  // Pages: title once, the column header on every page, footer on the last page.
  let top = M + TITLE_H;
  drawTitle();
  drawHeader(top);
  top += HEAD_H;
  rows.forEach((row, i) => {
    const isLast = i === rows.length - 1;
    const needed = ROW_H + (isLast ? FOOT_H : 0);
    if (top + needed > H - M) {
      doc.addPage();
      top = M;
      drawHeader(top);
      top += HEAD_H;
    }
    drawRow(row, i, top);
    top += ROW_H;
  });
  if (!rows.length) {
    put('Nobody has pay to sign for in this period.', at(M, 400), top + 18, { color: MUTED });
    top += ROW_H;
  }
  if (top + FOOT_H > H - M) {
    doc.addPage();
    top = M;
  }
  drawFooter(top);

  // Page numbers when there is more than one page.
  const range = doc.bufferedPageRange();
  if (range.count > 1) {
    for (let p = 0; p < range.count; p++) {
      doc.switchToPage(p);
      doc.page.margins.bottom = 0; // the page number sits in the margin
      put(`Page ${p + 1} of ${range.count}`, at(right - 100, 100), H - 14, { size: 7, color: MUTED, align: 'right' });
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

module.exports = { buildPdf, fileName, periodLabel, MAX_DAYS };
