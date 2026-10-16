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
