// How far apart are the two sides of a seam, actually? The stitch pass used a
// tolerance guessed from the weld cell; if the real offset is bigger than that
// it silently did nothing, which is what the render map suggests. This measures
// the distance instead of guessing it.
import { MESH, HEADER } from '../assets/js/data/mesh/tshirt.js';

const bin = atob(MESH);
const bytes = new Uint8Array(bin.length);
for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
const buf = bytes.buffer;
const V = HEADER.v;
const s = HEADER.half / 32767;
const pos = new Float32Array(V * 3);
const ip = new Int16Array(buf, HEADER.o[0], V * 3);
for (let i = 0; i < V * 3; i++) pos[i] = ip[i] * s + HEADER.c[(i % 3) | 0] * (i % 3 === 0 ? 1 : 1);
// Positions are per-axis offset; redo properly.
for (let i = 0; i < V; i++) {
  pos[i * 3] = ip[i * 3] * s + HEADER.c[0];
  pos[i * 3 + 1] = ip[i * 3 + 1] * s + HEADER.c[1];
  pos[i * 3 + 2] = ip[i * 3 + 2] * s + HEADER.c[2];
}

const idx = new Uint16Array(buf, HEADER.o[3], HEADER.t * 4);
const faceOf = new Map(); // vertex -> Set of faces
const edgeCount = new Map();
const at = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);
for (let t = 0; t < HEADER.t; t++) {
  const tri = [idx[t * 4], idx[t * 4 + 1], idx[t * 4 + 2]];
  const f = HEADER.faces[idx[t * 4 + 3]];
  for (const v of tri) {
    if (!faceOf.has(v)) faceOf.set(v, new Set());
    faceOf.get(v).add(f);
  }
  for (let k = 0; k < 3; k++) {
    const e = at(tri[k], tri[(k + 1) % 3]);
    edgeCount.set(e, (edgeCount.get(e) || 0) + 1);
  }
}

const boundary = [];
for (const [e, n] of edgeCount) {
  if (n !== 1) continue;
  const [a, b] = e.split('|').map(Number);
  for (const v of [a, b]) if (!boundary.includes(v)) boundary.push(v);
}

// Spatial hash over the boundary vertices.
const tol = 0.2;
const cell = tol;
const hash = new Map();
const key = (x, y, z) => `${Math.floor(x / cell)}|${Math.floor(y / cell)}|${Math.floor(z / cell)}`;
for (const v of boundary) {
  const k = key(pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]);
  const l = hash.get(k);
  if (l) l.push(v);
  else hash.set(k, [v]);
}

const dists = [];
let unmatched = 0;
for (const v of boundary) {
  const x = pos[v * 3];
  const y = pos[v * 3 + 1];
  const z = pos[v * 3 + 2];
  const mine = faceOf.get(v);
  let best = Infinity;
  let bestFace = null;
  for (let dx = -2; dx <= 2; dx++)
    for (let dy = -2; dy <= 2; dy++)
      for (let dz = -2; dz <= 2; dz++) {
        for (const w of hash.get(`${Math.floor(x / cell) + dx}|${Math.floor(y / cell) + dy}|${Math.floor(z / cell) + dz}`) || []) {
          if (w === v) continue;
          // Only a partner on a different face is a seam; one on the same face is
          // the boundary of a hole in that panel, which is a different defect.
          const other = [...faceOf.get(w)].some((f) => !mine.has(f));
          if (!other) continue;
          const d = Math.hypot(pos[w * 3] - x, pos[w * 3 + 1] - y, pos[w * 3 + 2] - z);
          if (d < best) {
            best = d;
            bestFace = [...faceOf.get(w)].join(',');
          }
        }
      }
  if (best === Infinity || best > tol) unmatched++;
  else dists.push(best);
}

dists.sort((a, b) => a - b);
const q = (p) => (dists.length ? dists[Math.min(dists.length - 1, Math.floor(dists.length * p))] : 0);
console.log(`boundary vertices ${boundary.length}, of which ${dists.length} have a partner on another face, ${unmatched} do not`);
console.log(
  `cross-face seam offset: median ${q(0.5).toFixed(4)}, p90 ${q(0.9).toFixed(4)}, max ${q(1).toFixed(4)}  (mesh units, body is ~1.0 wide)`
);
console.log(`as a fraction of the 526px preview, max offset is about ${((q(1) / 1.0) * 526 * 0.9).toFixed(1)} px`);
const buckets = {};
for (const d of dists) {
  const k = d < 0.001 ? 'exact' : d < 0.01 ? '<0.01' : d < 0.02 ? '<0.02' : d < 0.05 ? '<0.05' : d < 0.1 ? '<0.1' : '>=0.1';
  buckets[k] = (buckets[k] || 0) + 1;
}
console.log(`distribution: ${JSON.stringify(buckets)}`);
