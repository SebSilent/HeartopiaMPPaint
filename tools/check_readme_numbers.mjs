/*
 * One-off check: every face size and cell total quoted in README.md must match
 * assets/js/game/slots.js. Run with `node tools/check_readme_numbers.mjs`.
 *
 * The README is the thing a new player trusts, and a face size that disagrees
 * with the game is treated as a bug in this tool - so the numbers in it are
 * checked against the same module the app renders from, not retyped.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CATALOG, cellTotal } from '../assets/js/game/slots.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const md = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');

let bad = 0;
const check = (ok, msg) => {
  if (!ok) {
    bad++;
    console.log('MISMATCH ' + msg);
  }
};

for (const fam of ['clothing', 'furniture']) {
  for (const it of CATALOG[fam]) {
    for (const f of it.faces) {
      const needle = `${f.w}\u00d7${f.h}`;
      // The label is quoted too, so a right size on the wrong row is caught.
      // Commas are dropped: the README writes "Backrest front", slots.js says
      // "Backrest, front". The number is what is being checked, not the prose.
      const label = f.label.replace(/,/g, ' ').replace(/\s+/g, ' ').trim()
        .replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(`${label}[^|]*?${needle}`);
      check(re.test(md), `${it.name} / ${f.label} should read ${needle}`);
    }
    const total = cellTotal(it).toLocaleString('en-US');
    if (fam === 'clothing') {
      check(md.includes(`| ${total} |`), `${it.name} cell total should read ${total}`);
    }
  }
}

// Headline numbers used in prose.
const biggest = CATALOG.furniture
  .find((i) => i.id === 'bed2')
  .faces.reduce((m, f) => (f.w * f.h > m ? f.w * f.h : m), 0);
check(md.includes(biggest.toLocaleString('en-US')), `double bed duvet should read ${biggest} cells`);
check(md.includes(cellTotal(CATALOG.furniture.find((i) => i.id === 'bed2')).toLocaleString('en-US')),
  'double bed total should read 60,928');

const faceCount = ['clothing', 'furniture', 'book'].reduce(
  (n, fam) => n + CATALOG[fam].reduce((k, i) => k + i.faces.length, 0), 0);
check(md.includes(`${faceCount} faces`), `item face count should read ${faceCount}`);
check(md.includes(`${CATALOG.clothing.length} clothing items`), 'clothing item count');
check(md.includes(`${CATALOG.furniture.length} furniture items`), 'furniture item count');

console.log(bad ? `${bad} mismatch(es)` : 'README numbers match slots.js');
process.exit(bad ? 1 : 0);
