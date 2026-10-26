/* Decode each mesh module and report boundary edges (used once = hole candidates). */
const fs = require('fs');
const path = require('path');

function decode(b64, h) {
  const bin = Buffer.from(b64, 'base64');
  const buf = bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength);
  const s = h.half / 32767;
  const V = h.v;
  const ip = new Int16Array(buf, h.o[0], V * 3);
  const iuv = new Uint16Array(buf, h.o[2], V * 2);
  const idx = new Uint16Array(buf, h.o[3], h.t * 4);
  const pos = new Float32Array(V * 3);
  const uv = new Float32Array(V * 2);
  for (let i = 0; i < V; i++) {
    pos[i * 3] = ip[i * 3] * s + h.c[0];
    pos[i * 3 + 1] = ip[i * 3 + 1] * s + h.c[1];
    pos[i * 3 + 2] = ip[i * 3 + 2] * s + h.c[2];
    uv[i * 2] = iuv[i * 2] / 65535;
    uv[i * 2 + 1] = iuv[i * 2 + 1] / 65535;
  }
  return { pos, uv, idx, tris: h.t, faces: h.faces, V };
}

const dir = 'assets/js/data/mesh';
for (const f of fs.readdirSync(dir)) {
  const src = fs.readFileSync(path.join(dir, f), 'utf8');
  const mb = src.match(/export const MESH = "([^"]+)"/);
  const hb = src.match(/export const HEADER = (\{[\s\S]*?\});/);
  if (!mb || !hb) { console.log(f, 'no match'); continue; }
  const h = JSON5(hb[1]);
  const m = decode(mb[1], h);
  const edges = new Map();
  for (let t = 0; t < m.tris; t++) {
    const a = m.idx[t * 4], b = m.idx[t * 4 + 1], c = m.idx[t * 4 + 2];
    for (const [p, q] of [[a, b], [b, c], [c, a]]) {
      const k = p < q ? p + '_' + q : q + '_' + p;
      edges.set(k, (edges.get(k) || 0) + 1);
    }
  }
  let b1 = 0, b3 = 0;
  for (const n of edges.values()) { if (n === 1) b1++; else if (n > 2) b3++; }
  console.log(`${f}: tris=${m.tris} verts=${m.V} edges=${edges.size} boundary=${b1} nonmanifold>2=${b3} euler=${m.V - edges.size + m.tris} faces=${JSON.stringify(m.faces)}`);
}
function JSON5(s) { return eval('(' + s + ')'); }