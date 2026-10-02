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
