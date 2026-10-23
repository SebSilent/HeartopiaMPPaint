// Which layout is it: 8 interleaved floats per vertex, or three separate
// streams? The byte budget is the same either way, so test each against what
// the numbers can physically be.
import { readFileSync } from 'node:fs';

const file = process.argv[2] || '_scrape/meshes/tshirt-round.mesh-HNhf9EFW.bin';
const buf = readFileSync(file);
const headerLen = buf.readUInt32LE(0);
const header = JSON.parse(buf.subarray(4, 4 + headerLen).toString('utf8'));
let dataStart = 4 + headerLen;
while (buf[dataStart] === 0) dataStart++;
const V = header.vertices;
const I = header.indices;
const f = (o, n) => new Float32Array(buf.buffer, buf.byteOffset + dataStart + o, n);

const pos = f(0, V * 3);
const nrm = f(V * 3 * 4, V * 3);
const uv = f(V * 6 * 4, V * 2);
const idx = new Uint32Array(buf.buffer, buf.byteOffset + dataStart + V * 8 * 4, I);

const box = (a, stride, n) => {
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < a.length; i += stride) {
    for (let k = 0; k < n; k++) {
      lo[k] = Math.min(lo[k], a[i + k]);
      hi[k] = Math.max(hi[k], a[i + k]);
    }
  }
  return { lo: lo.map((x) => +x.toFixed(4)), hi: hi.map((x) => +x.toFixed(4)) };
};
console.log('POS', JSON.stringify(box(pos, 3, 3)));
console.log('NRM', JSON.stringify(box(nrm, 3, 3)));
console.log('UV ', JSON.stringify(box(uv, 2, 2)));

// A normal stream is unit length by definition. Measure how many are.
let unit = 0;
let worst = 0;
for (let i = 0; i < nrm.length; i += 3) {
  const l = Math.hypot(nrm[i], nrm[i + 1], nrm[i + 2]);
  if (Math.abs(l - 1) < 0.01) unit++;
  worst = Math.max(worst, Math.abs(l - 1));
}
console.log('normals of unit length:', unit, '/', V, 'worst deviation', worst.toFixed(4));

// Interleaved would put uv[0] at float 6 of each record; check that reading too.
let altUnit = 0;
const all = f(0, V * 8);
for (let i = 0; i < V; i++) {
  const l = Math.hypot(all[i * 8 + 3], all[i * 8 + 4], all[i * 8 + 5]);
  if (Math.abs(l - 1) < 0.01) altUnit++;
}
console.log('interleaved normals unit:', altUnit, '/', V);

console.log('idx max', Math.max(...idx.subarray(0, 50000)), 'of', V, 'tris', I / 3);
console.log('first 3 verts', [0, 1, 2].map((i) => pos.slice(i * 3, i * 3 + 3).join(',')).join(' | '));
console.log('first 3 uvs', [0, 1, 2].map((i) => uv.slice(i * 2, i * 2 + 2).join(',')).join(' | '));
