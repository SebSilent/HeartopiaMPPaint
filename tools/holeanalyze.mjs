// What "missing triangles" actually means in the baked meshes, measured.
//
// The browser probe (tools/meshholes.mjs) can only say how much backdrop is
// trapped. This says *why*, from the geometry alone, in one second per garment:
//
//   degenerate  a triangle with two coincident vertices or zero area draws
//               nothing at all, so the cloth has a gap exactly where it sits -
//               and no amount of culling or depth-sorting fixes that
//   sliver      a triangle whose area is tiny next to its own perimeter: it
//               paints a hairline, which reads as a crack rather than cloth
//   big         a triangle far larger than the mesh median: decimation merged a
//               whole patch into one quad, so its texture is smeared and its
//               affine error is visible as a fold or a see-through band
//   loops       boundary cycles, split by shape into "opening" (round, big -
//               a cuff, a neck, a hem) and "crack" (thin, small - cloth that
//               should be there and is not)
//
// Usage: node tools/holeanalyze.mjs [item ...]
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const dir = 'assets/js/data/mesh';

function decode(b64, h) {
  const bin = Buffer.from(b64, 'base64');
  const buf = bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength);
  const s = h.half / 32767;
  const V = h.v;
  const ip = new Int16Array(buf, h.o[0], V * 3);
  const inr = new Int8Array(buf, h.o[1], V * 3);
  const iuv = new Uint16Array(buf, h.o[2], V * 2);
  const pos = new Float32Array(V * 3);
  const nrm = new Float32Array(V * 3);
  const uv = new Float32Array(V * 2);
  for (let i = 0; i < V; i++) {
    pos[i * 3] = ip[i * 3] * s + h.c[0];
    pos[i * 3 + 1] = ip[i * 3 + 1] * s + h.c[1];
    pos[i * 3 + 2] = ip[i * 3 + 2] * s + h.c[2];
    nrm[i * 3] = inr[i * 3] / 127;
    nrm[i * 3 + 1] = inr[i * 3 + 1] / 127;
    nrm[i * 3 + 2] = inr[i * 3 + 2] / 127;
    uv[i * 2] = iuv[i * 2] / 65535;
    uv[i * 2 + 1] = iuv[i * 2 + 1] / 65535;
  }
  return { pos, nrm, uv, idx: new Uint16Array(buf, h.o[3], h.t * 4), faces: h.faces, tris: h.t, V };
}

const P = (m, i, k) => m.pos[i * 3 + k];
function triArea(m, a, b, c) {
  const ux = P(m, b, 0) - P(m, a, 0), uy = P(m, b, 1) - P(m, a, 1), uz = P(m, b, 2) - P(m, a, 2);
  const vx = P(m, c, 0) - P(m, a, 0), vy = P(m, c, 1) - P(m, a, 1), vz = P(m, c, 2) - P(m, a, 2);
  const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
  return Math.hypot(cx, cy, cz) / 2;
}
function perim(m, a, b, c) {
  return (
    Math.hypot(P(m, a, 0) - P(m, b, 0), P(m, a, 1) - P(m, b, 1), P(m, a, 2) - P(m, b, 2)) +
    Math.hypot(P(m, b, 0) - P(m, c, 0), P(m, b, 1) - P(m, c, 1), P(m, b, 2) - P(m, c, 2)) +
    Math.hypot(P(m, c, 0) - P(m, a, 0), P(m, c, 1) - P(m, a, 1), P(m, c, 2) - P(m, a, 2))
  );
}
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[(s.length / 2) | 0] : 0;
};

/** Boundary edges -> runs, as tools/meshloops.cjs does, with the planar area of each. */
function loops(m) {
  const use = new Map();
  for (let t = 0; t < m.tris; t++) {
    const v = [m.idx[t * 4], m.idx[t * 4 + 1], m.idx[t * 4 + 2]];
    for (let k = 0; k < 3; k++) {
      const a = v[k], b = v[(k + 1) % 3];
      if (a === b) continue;
      const key = a < b ? a * 65536 + b : b * 65536 + a;
      use.set(key, (use.get(key) || 0) + 1);
    }
  }
  const adj = new Map();
  for (const [key, n] of use) {
    if (n !== 1) continue;
    const a = key >> 16, b = key & 0xffff;
    if (!adj.has(a)) adj.set(a, []);
    if (!adj.has(b)) adj.set(b, []);
    adj.get(a).push(b);
    adj.get(b).push(a);
  }
  const used = new Set();
  const out = [];
  for (const [key, n] of use) {
    if (n !== 1 || used.has(key)) continue;
    const a = key >> 16, b = key & 0xffff;
    used.add(key);
    const verts = [a, b];
    let cur = b, closed = false;
    for (;;) {
      if (cur === a) { closed = true; break; }
      let nxt = -1;
      for (const v of adj.get(cur) || []) {
        const e = v < cur ? v * 65536 + cur : cur * 65536 + v;
        if (used.has(e)) continue;
        used.add(e);
        nxt = v;
        break;
      }
      if (nxt < 0) break;
      verts.push(nxt);
      cur = nxt;
    }
    // Planar area about the loop's own best-fit plane (Newell's normal), which is
    // what separates a cuff seen face-on from a slit seen edge-on.
    let nx = 0, ny = 0, nz = 0;
    for (let i = 0; i < verts.length; i++) {
      const p = verts[i], q = verts[(i + 1) % verts.length];
      nx += (P(m, p, 1) - P(m, q, 1)) * (P(m, p, 2) + P(m, q, 2));
      ny += (P(m, p, 2) - P(m, q, 2)) * (P(m, p, 0) + P(m, q, 0));
      nz += (P(m, p, 0) - P(m, q, 0)) * (P(m, p, 1) + P(m, q, 1));
    }
    const nl = Math.hypot(nx, ny, nz) || 1;
    let cx = 0, cy = 0, cz = 0;
    for (const v of verts) { cx += P(m, v, 0); cy += P(m, v, 1); cz += P(m, v, 2); }
    cx /= verts.length; cy /= verts.length; cz /= verts.length;
    let area = 0, per = 0;
    for (let i = 0; i < verts.length; i++) {
      const p = verts[i], q = verts[(i + 1) % verts.length];
      const ax = P(m, p, 0) - cx, ay = P(m, p, 1) - cy, az = P(m, p, 2) - cz;
      const bx = P(m, q, 0) - cx, by = P(m, q, 1) - cy, bz = P(m, q, 2) - cz;
      area += (ax * by - ay * bx) * (nz / nl) + (ay * bz - az * by) * (nx / nl) + (az * bx - ax * bz) * (ny / nl);
      per += Math.hypot(P(m, p, 0) - P(m, q, 0), P(m, p, 1) - P(m, q, 1), P(m, p, 2) - P(m, q, 2));
    }
    let span = 0;
    for (const v of verts) span = Math.max(span, Math.hypot(P(m, v, 0) - cx, P(m, v, 1) - cy, P(m, v, 2) - cz));
    out.push({
      verts, closed, areaC2: Math.abs(area / 2) * 1e4, perimC: per * 100,
      round: per > 0 ? Math.abs(area / 2) * 1e4 / (per * 100 * per * 100) : 0,
      spanC: span * 200, c: [cx, cy, cz],
    });
  }
  return out;
}

const only = process.argv.slice(2);
const rows = [];
for (const f of readdirSync(dir)) {
  if (!f.endsWith('.js')) continue;
  const item = f.replace('.js', '');
  if (only.length && !only.includes(item)) continue;
  const src = readFileSync(join(dir, f), 'utf8');
  const h = eval('(' + src.match(/export const HEADER = ([\s\S]*?);\r?\n/)[1] + ')');
  const m = decode(src.match(/export const MESH = "([^"]+)"/)[1], h);

  const areas = [];
  let degen = 0, sliver = 0, big = 0, dupVert = 0, offFace = 0;
  for (let t = 0; t < m.tris; t++) {
    const a = m.idx[t * 4], b = m.idx[t * 4 + 1], c = m.idx[t * 4 + 2];
    if (a === b || b === c || a === c) { dupVert++; degen++; continue; }
    const A = triArea(m, a, b, c);
    const p = perim(m, a, b, c);
    areas.push(A);
    // Isoperimetric: an equilateral triangle scores 0.048; anything under a
    // twentieth of that is a needle, and a needle paints a hairline.
    if (p > 0 && A / (p * p) < 0.0024) sliver++;
    if (a === b || b === c || a === c || A < 1e-9) degen++;
  }
  const med = median(areas);
  for (let t = 0; t < m.tris; t++) {
    const a = m.idx[t * 4], b = m.idx[t * 4 + 1], c = m.idx[t * 4 + 2];
    if (a === b || b === c || a === c) continue;
    if (triArea(m, a, b, c) > med * 25) big++;
  }
  const L = loops(m);
  const cycles = L.filter((l) => l.closed && l.verts.length >= 3);
  const chains = L.filter((l) => !l.closed || l.verts.length < 3);
  // The judgement, per loop: a garment opening is round-ish AND big enough to
  // put a limb through; a crack is thin, or tiny, or both.
  const openings = cycles.filter((l) => l.round > 0.045 && l.areaC2 > 300);
  const cracks = cycles.filter((l) => !openings.includes(l));
  rows.push({ item, tris: m.tris, V: m.V, dupVert, degen, sliver, big, med: med * 1e4, cycles: cycles.length, openings: openings.length, cracks: cracks.length, chainN: chains.length, crackArea: cracks.reduce((s, l) => s + l.areaC2, 0) });
  console.log(`\n== ${item}: ${m.tris} tris, ${m.V} verts | dup-vert ${dupVert} | slivers ${sliver} | >25x median ${big} (median ${(med * 1e4).toFixed(2)}c2)`);
  for (const l of cycles) {
    const verdict = openings.includes(l) ? 'OPENING' : 'crack';
    console.log(`   ${verdict.padEnd(8)} n=${String(l.verts.length).padStart(3)} area=${l.areaC2.toFixed(0).padStart(6)}c2 perim=${l.perimC.toFixed(1)}c round=${l.round.toFixed(4)} span=${l.spanC.toFixed(1)}c at [${l.c.map((x) => x.toFixed(2)).join(',')}]`);
  }
  const thinChains = chains.filter((l) => l.verts.length >= 3 && l.round < 0.01);
  console.log(`   chains ${chains.length} (n>=3 thin: ${thinChains.length})`);
}
console.log('\n' + '='.repeat(100));
console.log('item        tris  dupV sliver  big25x  cycles open  crack  crackArea  chains');
for (const r of rows) {
  console.log(
    `${r.item.padEnd(11)} ${String(r.tris).padStart(5)} ${String(r.dupVert).padStart(4)} ${String(r.sliver).padStart(6)} ${String(r.big).padStart(7)} ${String(r.cycles).padStart(7)} ${String(r.openings).padStart(4)} ${String(r.cracks).padStart(6)} ${String(r.crackArea.toFixed(0)).padStart(9)} ${String(r.chainN).padStart(6)}`
  );
}
