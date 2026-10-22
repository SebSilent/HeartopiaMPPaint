// Prove the shipped run-length cells decode to exactly the catalog's list.
import { readFileSync } from 'node:fs';
import { FACE_DATA } from '../assets/js/data/heartopia-faces.js';
import { maskFor, paintable, faceInfo } from '../assets/js/game/faces.js';

const data = JSON.parse(readFileSync('_scrape/catalog/ls-heartopia_presets_cache.json', 'utf8'));
const groups = Array.isArray(data) ? data : Object.values(data)[0];
const bySize = new Map();
for (const g of groups || []) {
  for (const c of g.canvases || []) {
    for (const f of c.faces || [c]) {
      for (const lv of f.levels || (f.w ? [f] : [])) {
        const key = `${lv.w}x${lv.h}`;
        const off = lv.disabledPixels || [];
        if (!bySize.has(key)) bySize.set(key, []);
        bySize.get(key).push(new Set(off));
      }
    }
  }
}

let bad = 0;
let checked = 0;
for (const item of Object.keys(FACE_DATA)) {
  for (const face of Object.keys(FACE_DATA[item])) {
    const f = FACE_DATA[item][face];
    const m = maskFor(item, face);
    if (!m) continue;
    const free = paintable(item, face);
    const offCount = m.length - free;
    const cands = bySize.get(`${f.w}x${f.h}`) || [];
    // The decoded mask is one claim; the catalog cell set is the other. They
    // have to agree on both the count and the exact cells.
    let best = null;
    for (const set of cands) {
      if (set.size !== offCount) continue;
      let same = true;
      for (let y = 0; y < f.h && same; y++) {
        for (let x = 0; x < f.w; x++) {
          const blocked = m[y * f.w + x] === 0;
          if (blocked !== set.has(x + ',' + y)) {
            same = false;
            break;
          }
        }
      }
      if (same) {
        best = set;
        break;
      }
    }
    checked++;
    if (!best) {
      bad++;
      console.log(`MISMATCH ${item}:${face} ${f.w}x${f.h} decoded ${offCount} of ${m.length}`);
    }
    if (!faceInfo(item, face)) {
      bad++;
      console.log(`LOST faceInfo ${item}:${face}`);
    }
  }
}
console.log(`faces checked ${checked} mismatches ${bad}`);
process.exit(bad ? 1 : 0);
