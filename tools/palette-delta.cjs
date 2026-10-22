const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const U = require(path.join(ROOT, '_scrape', 'catalog', 'palette-app.json'));
const ours = require(path.join(ROOT, 'assets/js/data/heartopia-palette.js'));

const rgb = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const game = [];
for (const b of U.base) game.push({ code: b.code, hex: b.hex.toUpperCase(), kind: 'base' });
for (const arr of Object.values(U.detail)) for (const c of arr) game.push({ code: c.code, hex: c.hex.toUpperCase(), kind: 'detail' });

const ourSet = new Set(ours.FLAT_COLORS.filter(Boolean).map((h) => h.toUpperCase()));
const ourList = [...ourSet];

const lines = [];
let exact = 0;
const near = [];
const far = [];
const orphans = [];
for (const g of game) {
  if (ourSet.has(g.hex)) { exact++; continue; }
  const gr = rgb(g.hex);
  let best = null;
  let bd = Infinity;
  for (const o of ourList) {
    const or = rgb(o);
    const d = Math.max(Math.abs(gr[0] - or[0]), Math.abs(gr[1] - or[1]), Math.abs(gr[2] - or[2]));
    if (d < bd) { bd = d; best = o; }
  }
  if (bd <= 1) near.push(g.code + ' ' + g.hex + ' ~ ' + best + ' (max delta ' + bd + ')');
  else if (bd <= 4) far.push(g.code + ' ' + g.hex + ' vs ' + best + ' (delta ' + bd + ')');
  else orphans.push(g.code + ' ' + g.hex + ' nearest ' + best + ' (delta ' + bd + ')');
}
lines.push('game colours (base+detail, distinct by code): ' + game.length);
lines.push('exact matches in our palette: ' + exact);
lines.push('within 1 per channel: ' + near.length);
lines.push('2 to 4 per channel: ' + far.length);
lines.push('more than 4 (genuinely different): ' + orphans.length);
lines.push('');
lines.push('--- within 1 (first 12) ---');
for (const n of near.slice(0, 12)) lines.push(n);
lines.push('--- 2..4 ---');
for (const n of far) lines.push(n);
lines.push('--- >4, no counterpart ---');
for (const n of orphans) lines.push(n);

const gameHex = new Set(game.map((g) => g.hex));
const unused = ourList.filter((h) => !gameHex.has(h));
lines.push('');
lines.push('our colours with no game counterpart: ' + unused.length);
lines.push(unused.join(' '));
lines.push('');
lines.push('game base 16: ' + U.base.map((b) => b.code + '=' + b.hex).join(' '));
lines.push('detail group keys: ' + Object.keys(U.detail).sort().join(' '));
lines.push('our group numbers: ' + ours.HEARTOPIA_GROUPS.map((g) => g.group).join(' '));

fs.writeFileSync(path.join(ROOT, '_scrape', 'catalog', 'palette-delta.txt'), lines.join('\n'), 'utf8');
console.log('exact ' + exact + ' | within1 ' + near.length + ' | 2to4 ' + far.length + ' | orphan ' + orphans.length + ' | ours-unmatched ' + unused.length);
