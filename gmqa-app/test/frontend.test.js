// Every browser module must at least parse; a syntax error (e.g. a duplicate import) would blank the app.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..', 'public', 'js');
const files = fs.readdirSync(root, { recursive: true }).filter(f => f.endsWith('.js')).map(f => path.join(root, f));

test('frontend modules parse', () => {
  assert.ok(files.length >= 10, `found ${files.length} modules`);
  for (const file of files) {
    const result = spawnSync(process.execPath, ['--input-type=module', '--check'], { input: fs.readFileSync(file) });
    assert.equal(result.status, 0, `${path.relative(root, file)}: ${result.stderr}`);
  }
});

test('every module imported from ui.js is exported by it', () => {
  const ui = fs.readFileSync(path.join(root, 'ui.js'), 'utf8');
  const exported = new Set([...ui.matchAll(/export (?:async )?(?:function|const|class|let) ([\w$]+)/g)].map(m => m[1]));
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    for (const [, names] of src.matchAll(/import \{([^}]+)\} from '\.{1,2}\/(?:\.\.\/)?ui\.js'/g)) {
      for (const name of names.split(',').map(n => n.trim()).filter(Boolean)) {
        assert.ok(exported.has(name), `${path.relative(root, file)} imports ${name}, which ui.js does not export`);
      }
    }
  }
});

// The Inventory sheet's Excel/Sheets helpers (CSV export, paste import) are plain functions with no imports.
const sheetIo = () => import(`data:text/javascript,${encodeURIComponent(fs.readFileSync(path.join(root, 'components', 'sheet-io.js'), 'utf8'))}`);

test('sheet export: CSV that Excel and Sheets open correctly', async () => {
  const { toCsv } = await sheetIo();
  const csv = toCsv([['Item', 'Tags', 'Price'], ['Wiper 18"', 'Auto Parts, Exterior', 450], ['Snow foam', '', 0.5]]);
  assert.ok(csv.startsWith('﻿'), 'byte-order mark so Excel reads ₱ and accents');
  assert.equal(csv.slice(1), 'Item,Tags,Price\r\n"Wiper 18""","Auto Parts, Exterior",450\r\nSnow foam,,0.5\r\n');
  assert.ok(toCsv([['=1+1']]).includes("'=1+1"), 'cells that look like formulas are not run by Excel');
});

test('sheet paste: rows copied from Excel/Sheets become items', async () => {
  const { parsePasted, importRows } = await sheetIo();
  // Excel copies tab-separated rows; quoted cells may hold tabs.
  assert.deepEqual(parsePasted('Name\tPrice\r\n"Strut bar\tfront"\t3500\r\n\r\n'), [['Name', 'Price'], ['Strut bar\tfront', '3500']]);
  assert.deepEqual(parsePasted('a,b\n"x, y",2\n'), [['a', 'b'], ['x, y', '2']], 'CSV works too');

  const { rows, errors } = importRows([
    ['SKU', 'Item name', 'Unit', 'Selling price', 'Commission', 'Reorder at', 'Tags', 'Stock', 'Avg cost', 'Something else'],
    ['RIM-15', 'Rims 15in', 'set', '₱12,500.00', '500', '1', 'Auto Parts; Wheels', '2', '9,000', 'ignored'],
    ['', 'APC', 'gal', '', '', '', 'Carwash chemicals', '3.5', '420', ''],
    ['', '', '', '', '', '', '', '', '', ''],
    ['', 'Bad price', '', 'abc', '', '', '', '', '', ''],
  ]);
  assert.deepEqual(rows[0], { sku: 'RIM-15', name: 'Rims 15in', unit: 'set', price: 12500, commission: 500, reorder_level: 1,
    tags: ['Auto Parts', 'Wheels'], stock: 2, unit_cost: 9000, set_size: null, set_price: null });
  assert.deepEqual(rows[1], { sku: '', name: 'APC', unit: 'gal', price: 0, commission: 0, reorder_level: 0, tags: ['Carwash chemicals'], stock: 3.5,
    unit_cost: 420, set_size: null, set_price: null });
  assert.equal(rows.length, 2, 'blank rows are skipped; rows with errors are listed, not imported');
  assert.deepEqual(errors, ['Row 5: Selling price "abc" is not a number']);
  assert.deepEqual(importRows([['Price'], ['1']]).errors, ['The header row needs a Name (or Item) column']);
});

test('sheet paste: a set (pieces per set and its price) can be given per row', async () => {
  const { importRows } = await sheetIo();
  const { rows, errors } = importRows([
    ['Item', 'Unit', 'Selling price', 'Set of', 'Set price'],
    ['Lazertech 2in', 'pc', '2000', '2', '3,500'],
    ['Horn', 'pc', '500', '', ''],
    ['Odd', 'pc', '1', '1', '5'],
  ]);
  assert.deepEqual(rows.map(r => [r.name, r.set_size, r.set_price]), [['Lazertech 2in', 2, 3500], ['Horn', null, null]]);
  assert.deepEqual(errors, ['Row 4: Set of "1" must be more than 1 piece']);
});

// Themes (public/themes/*.css) only restyle: every rule must be scoped to its own data-theme, so nothing
// leaks into Classic or into another theme. The theme list must agree everywhere it is written down.
test('theme stylesheets are fully scoped, and every theme is wired up', () => {
  const publicDir = path.join(__dirname, '..', 'public');
  const index = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
  const themeJs = fs.readFileSync(path.join(root, 'theme.js'), 'utf8');
  const keys = [...themeJs.matchAll(/\{ key: '(\w+)'/g)].map(m => m[1]);
  assert.deepEqual(keys, ['classic', 'telemetry', 'editorial']);
  assert.match(index, /\['classic', 'telemetry', 'editorial'\]\.indexOf\(theme\)/, 'the boot script knows every theme');
  for (const key of keys) assert.match(index, new RegExp(`data-theme-choice="${key}"`), `switch offers ${key}`);

  for (const key of keys.filter(k => k !== 'classic')) {
    assert.match(index, new RegExp(`<link rel="stylesheet" href="themes/${key}.css">`), `${key}.css is linked`);
    const css = fs.readFileSync(path.join(publicDir, 'themes', `${key}.css`), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const scope = `:root[data-theme="${key}"]`;
    // Walk the rules: selectors outside @keyframes must all start with this theme's scope.
    const unscoped = [];
    let depth = 0, inKeyframes = -1, buf = '';
    for (const ch of css) {
      if (ch === '{') {
        const prelude = buf.trim();
        if (prelude.startsWith('@keyframes')) inKeyframes = depth;
        else if (inKeyframes < 0 && !prelude.startsWith('@')) {
          for (const sel of prelude.split(/,(?![^(]*\))/)) if (!sel.trim().startsWith(scope)) unscoped.push(sel.trim());
        }
        depth++; buf = '';
      } else if (ch === '}') {
        depth--; buf = '';
        if (depth === inKeyframes) inKeyframes = -1;
      } else if (ch === ';' && depth === 0) {
        buf = '';
      } else buf += ch;
    }
    assert.deepEqual(unscoped, [], `${key}.css has rules outside ${scope}`);
    const animations = [...css.matchAll(/@keyframes ([\w-]+)/g)].map(m => m[1]);
    assert.ok(animations.length >= 3, `${key} has its own motion`);
    for (const name of animations) assert.ok(name.startsWith(key === 'telemetry' ? 'tele-' : 'ed-'), `${name}: keyframes are named per theme`);
  }
});
