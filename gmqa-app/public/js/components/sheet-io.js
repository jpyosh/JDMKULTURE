// Excel / Google Sheets in and out for the Inventory sheet: CSV export and rows pasted from a
// spreadsheet. Plain functions with no imports (tested in node: test/frontend.test.js).

// CSV that Excel and Sheets open as-is: byte-order mark (so ₱ and accents survive), CRLF rows, quoted
// cells where needed. Text that starts like a formula gets a leading ' so Excel shows it instead of running it.
export function toCsv(rows) {
  const cell = value => {
    if (typeof value === 'number') return String(value);
    let s = String(value ?? '');
    if (/^[=+\-@]/.test(s)) s = `'${s}`;
    return /[",\r\n]|^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return '﻿' + rows.map(row => row.map(cell).join(',') + '\r\n').join('');
}

// Text copied from Excel / Sheets (tab-separated) or a CSV file → rows of cells. Fully blank rows are dropped.
export function parsePasted(text) {
  const src = String(text || '').replace(/^﻿/, '');
  const firstLine = src.split(/\r?\n/, 1)[0];
  const sep = firstLine.includes('\t') ? '\t' : ',';
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') quoted = false; else cell += c;
    } else if (c === '"' && cell === '') quoted = true;
    else if (c === sep) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.some(v => v.trim() !== ''));
}

// Header names people use in their own sheets → item fields (compared lower-case, letters/digits only).
const HEADERS = {
  sku: ['sku', 'code', 'skucode', 'itemcode', 'partno', 'partnumber'],
  name: ['name', 'item', 'itemname', 'product', 'productname', 'part', 'partname'],
  unit: ['unit', 'units', 'uom'],
  price: ['price', 'sellingprice', 'srp', 'sellprice', 'retailprice'],
  commission: ['commission', 'comm', 'communit', 'commissionunit', 'commissionperunit', 'commperunit'],
  reorder_level: ['reorder', 'reorderat', 'reorderlevel', 'reorderpoint', 'minstock', 'minimum'],
  tags: ['tags', 'tag', 'category', 'categories'],
  stock: ['stock', 'qty', 'quantity', 'onhand', 'stockonhand', 'instock'],
  unit_cost: ['cost', 'unitcost', 'avgcost', 'averagecost', 'costperunit', 'cost/unit'],
};
const NUMBER_LABELS = { price: 'Selling price', commission: 'Commission', reorder_level: 'Reorder level', stock: 'Stock', unit_cost: 'Cost' };
const key = header => String(header || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// "₱12,500.00" → 12500; "" → 0; anything else → NaN.
export function parseNumber(value) {
  const s = String(value ?? '').replace(/₱|php|,|\s/gi, '');
  return s === '' ? 0 : Number(s);
}

// Rows (first = header) → { rows: items to import, errors: ['Row 5: ...'] }. Row numbers are the
// spreadsheet's own (the header is row 1). Unknown columns are ignored; tags split on , or ;.
export function importRows(table) {
  const [header = [], ...body] = table;
  const col = {};
  header.forEach((h, i) => {
    const k = key(h);
    const field = Object.keys(HEADERS).find(f => HEADERS[f].map(key).includes(k));
    if (field && !(field in col)) col[field] = i;
  });
  if (!('name' in col)) return { rows: [], errors: ['The header row needs a Name (or Item) column'] };

  const rows = [];
  const errors = [];
  body.forEach((cells, i) => {
    const n = i + 2;
    const get = field => (field in col ? String(cells[col[field]] ?? '').trim() : '');
    if (cells.every(c => String(c ?? '').trim() === '')) return;
    const item = {
      sku: get('sku'), name: get('name'), unit: get('unit') || 'pc',
      price: 0, commission: 0, reorder_level: 0,
      tags: get('tags').split(/[,;]/).map(t => t.trim()).filter(Boolean),
      stock: 0, unit_cost: 0,
    };
    const problems = [];
    if (!item.name) problems.push('the name is missing');
    for (const [field, label] of Object.entries(NUMBER_LABELS)) {
      const value = parseNumber(get(field));
      if (!Number.isFinite(value) || value < 0) problems.push(`${label} "${get(field)}" is not a number`);
      else item[field] = value;
    }
    if (problems.length) errors.push(`Row ${n}: ${problems.join(', ')}`);
    else rows.push(item);
  });
  return { rows, errors };
}
