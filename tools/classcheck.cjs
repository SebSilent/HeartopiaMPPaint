/* Which class names does the markup use that the stylesheet never mentions? */
const fs = require('fs');
const css = fs.readFileSync('assets/css/style.css', 'utf8');
const html = fs.readFileSync('index.html', 'utf8');
const js = [
  'js/ui.js',
  'js/main.js',
  'js/cursors.js',
  'js/ui/blueprint.js',
  'js/ui/importer.js',
  'js/game/render3d.js',
]
  .map((f) => {
    try { return fs.readFileSync('assets/' + f, 'utf8'); } catch (e) { return ''; }
  })
  .join('\n');

const names = new Set();
function addAll(str) {
  for (const c of str.split(/\s+/)) if (c && /^[a-z][a-z0-9-]*$/i.test(c)) names.add(c);
}
for (const m of html.matchAll(/class="([^"]+)"/g)) addAll(m[1]);
for (const m of js.matchAll(/className\s*=\s*['"`]([^'"`]+)['"`]/g)) addAll(m[1]);
for (const m of js.matchAll(/classList\.(?:add|remove|toggle)\(\s*['"]([^'"]+)['"]/g)) addAll(m[1]);
for (const m of js.matchAll(/class="([^"]+)"/g)) addAll(m[1]);

const missing = [...names]
  .filter((c) => !new RegExp('\\.' + c.replace(/-/g, '\\-') + '(?![a-z0-9-])', 'i').test(css))
  .sort();
console.log('MISSING (' + missing.length + '): ' + missing.join(' '));
