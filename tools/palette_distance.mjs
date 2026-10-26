// Which palette pairs show that index distance is not colour distance? Printed
// to pick assertions for test/fill-similar.test.js - the test should name real
// shades, not invented ones.
import { FLAT_COLORS } from '../assets/js/data/heartopia-palette.js';
import { PaletteIndex, deltaE2000 } from '../assets/js/color/science.js';

const pi = new PaletteIndex(FLAT_COLORS);
const n = FLAT_COLORS.length;
console.log(`palette: ${n} entries, ${pi.entries.length} real shades`);
console.log(`closest pair in the whole palette: ${JSON.stringify(pi.closestPair)}`);

// Adjacent indices that look nothing alike.
const far = [];
for (let i = 1; i < n - 1; i++) {
  if (!pi.labs[i] || !pi.labs[i + 1]) continue;
  const d = deltaE2000(pi.labs[i], pi.labs[i + 1]);
  if (d > 12) far.push({ i, a: FLAT_COLORS[i], b: FLAT_COLORS[i + 1], d: +d.toFixed(1) });
}
far.sort((x, y) => y.d - x.d);
console.log(`\nindex-adjacent but perceptually far (${far.length} pairs), worst 6:`);
for (const f of far.slice(0, 6)) console.log(`  [${f.i}] ${f.a} vs [${f.i + 1}] ${f.b}  dE=${f.d}`);

// Distant indices that look alike.
const near = [];
for (let i = 1; i < n; i++) {
  for (let j = i + 2; j < n; j++) {
    if (!pi.labs[i] || !pi.labs[j]) continue;
    const d = deltaE2000(pi.labs[i], pi.labs[j]);
    if (d < 5) near.push({ i, j, gap: j - i, a: FLAT_COLORS[i], b: FLAT_COLORS[j], d: +d.toFixed(2) });
  }
}
near.sort((x, y) => y.gap - x.gap);
console.log(`\nindex-distant but perceptually close (${near.length} pairs), widest gap 6:`);
for (const p of near.slice(0, 6)) console.log(`  [${p.i}] ${p.a} vs [${p.j}] ${p.b}  gap=${p.gap} dE=${p.d}`);
