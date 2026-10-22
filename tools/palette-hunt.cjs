const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

const src = fs.readFileSync(path.join(ROOT, '_scrape', '2026102208562', 'files', '27a7f6ef40.js'), 'latin1');
const start = src.indexOf('const U={');
if (start < 0) { console.log('marker not found'); process.exit(1); }
let depth = 0;
let i = src.indexOf('{', start);
let begin = i;
for (; i < src.length; i++) {
  if (src[i] === '{') depth++;
  else if (src[i] === '}') { depth--; if (depth === 0) break; }
}
const text = src.slice(begin, i + 1);
const U = new Function('return (' + text + ')')();

const app = require(path.join(ROOT, 'assets/js/data/heartopia-palette.js'));

const lines = [];
const baseHex = U.base.map((b) => b.hex.toUpperCase());
lines.push('app base colours: ' + U.base.length);
lines.push('app detail keys: ' + Object.keys(U.detail).length);
let total = 0;
const all = [];
for (const [k, arr] of Object.entries(U.detail)) {
  total += arr.length;
  for (const c of arr) all.push(c.hex.toUpperCase());
  lines.push('  ' + k + ' -> ' + arr.length + ' shades: ' + arr.map((c) => c.code + ' ' + c.hex.toUpperCase()).join(', '));
}
const appSet = new Set([...baseHex, ...all]);
lines.push('');
lines.push('detail entries total: ' + total);
lines.push('base + detail hexes: ' + (baseHex.length + all.length) + ', distinct: ' + appSet.size);

const ours = new Set(app.FLAT_COLORS.filter(Boolean).map((h) => h.toUpperCase()));
lines.push('our palette distinct: ' + ours.size);
const missing = [...appSet].filter((h) => !ours.has(h));
const extra = [...ours].filter((h) => !appSet.has(h));
lines.push('in game but not in our palette: ' + missing.length + (missing.length ? ' -> ' + missing.join(' ') : ''));
lines.push('in our palette but not in game data: ' + extra.length + (extra.length ? ' -> ' + extra.join(' ') : ''));

lines.push('');
lines.push('our groups: ' + app.HEARTOPIA_GROUPS.length + ' | game base colours: ' + U.base.length);
lines.push('game base: ' + baseHex.join(' '));

fs.writeFileSync(path.join(ROOT, '_scrape', 'catalog', 'palette-compare.txt'), lines.join('\n'), 'utf8');
fs.writeFileSync(path.join(ROOT, '_scrape', 'catalog', 'palette-app.json'), JSON.stringify(U, null, 1), 'utf8');
console.log('appSet ' + appSet.size + ' | ours ' + ours.size + ' | missing ' + missing.length + ' | extra ' + extra.length + ' | groups ' + app.HEARTOPIA_GROUPS.length + ' vs base ' + U.base.length);
