// Match every mesh group to a paint face by evidence: the face's own outline
// ring says exactly which UV box its geometry can occupy (u = x/w, v = 1 - y/h),
// so a group's UV box either fits that face or it does not.
import { decode } from './mesh_parts.mjs';
import { FACE_DATA } from '../assets/js/data/heartopia-faces.js';
import { CLOTHING } from '../assets/js/game/slots.js';

const ITEMS = {
  tshirt: 'tshirt',
  tank: 'tank',
  sweatshirt: 'sweat',
  dress: 'dress',
  skirt: 'skirt',
  shorts: 'shorts',
  pants: 'trousers',
  bucketHat: 'bucket',
  cap: 'cap',
  shoes: 'shoes',
  maryJane: 'maryjanes',
};

const ringBox = (rings, w, h) => {
  let x0 = Infinity;
  let x1 = -Infinity;
  let y0 = Infinity;
  let y1 = -Infinity;
  for (const r of rings) {
    for (const [x, y] of r) {
      x0 = Math.min(x0, x);
      x1 = Math.max(x1, x);
      y0 = Math.min(y0, y);
      y1 = Math.max(y1, y);
    }
  }
  return { u0: x0 / w, u1: x1 / w, v0: 1 - y1 / h, v1: 1 - y0 / h };
};

for (const file of process.argv.slice(2)) {
  const m = decode(file);
  const key = JSON.parse(m.header.key);
  const item = ITEMS[key[0]];
  const def = CLOTHING.find((c) => c.id === item);
  console.log(`\n### ${key[0]} -> ${item}`);
  for (const f of def.faces) {
    const d = FACE_DATA[item] && FACE_DATA[item][f.id];
    if (!d || !d.rings) {
      console.log(`  face ${f.id} ${f.w}x${f.h}  NO RING DATA`);
      continue;
    }
    const b = ringBox(d.rings, f.w, f.h);
    console.log(`  face ${f.id.padEnd(8)} ${f.w}x${f.h}  uv ${b.u0.toFixed(3)}..${b.u1.toFixed(3)} x ${b.v0.toFixed(3)}..${b.v1.toFixed(3)}`);
  }
  for (const g of m.header.groups) {
    if (g.fabricLining) continue;
    let u0 = Infinity;
    let u1 = -Infinity;
    let v0 = Infinity;
    let v1 = -Infinity;
    for (let i = g.start; i < g.start + g.count; i++) {
      const vi = m.idx[i];
      u0 = Math.min(u0, m.uv[vi * 2]);
      u1 = Math.max(u1, m.uv[vi * 2]);
      v0 = Math.min(v0, m.uv[vi * 2 + 1]);
      v1 = Math.max(v1, m.uv[vi * 2 + 1]);
    }
    // Which face's box contains this group's box, with the least slack?
    const scores = def.faces.map((f) => {
      const d = FACE_DATA[item] && FACE_DATA[item][f.id];
      if (!d || !d.rings) return null;
      const b = ringBox(d.rings, f.w, f.h);
      const pad = 0.02;
      const fits = u0 >= b.u0 - pad && u1 <= b.u1 + pad && v0 >= b.v0 - pad && v1 <= b.v1 + pad;
      const slack = b.u1 - b.u0 + b.v1 - b.v0 - (u1 - u0) - (v1 - v0);
      return { id: f.id, fits, slack: +slack.toFixed(3) };
    });
    const best = scores.filter((s) => s).sort((a, b) => a.slack - b.slack);
    console.log(
      `  group ${g.part.padEnd(8)} tris ${String(g.count / 3).padStart(6)} uv ${u0.toFixed(3)}..${u1.toFixed(3)} x ${v0.toFixed(3)}..${v1.toFixed(3)}` +
        `  -> ${best.length ? best.map((s) => `${s.id}${s.fits ? '' : '(oversize)'}`).join(',') : 'NO CANDIDATE'}`
    );
  }
}
