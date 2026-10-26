// How many mesh texel samples fall outside the 2D ring mask? That is the
// number of transparent texels the 3D preview punches into the garment.
import { CLOTHING } from '../assets/js/game/slots.js';
import { FACE_DATA } from '../assets/js/data/heartopia-faces.js';
import { maskFor } from '../assets/js/game/faces.js';

function decode(b64, h) {
  const bin = Buffer.from(b64, 'base64');
  const V = h.v;
  const iuv = new Uint16Array(bin.buffer, bin.byteOffset + h.o[2], V * 2);
  const idx = new Uint16Array(bin.buffer, bin.byteOffset + h.o[3], h.t * 4);
  const uv = new Float32Array(V * 2);
  for (let i = 0; i < V; i++) {
    uv[i * 2] = iuv[i * 2] / 65535;
    uv[i * 2 + 1] = iuv[i * 2 + 1] / 65535;
  }
  return { uv, idx, faces: h.faces, tris: h.t };
}

for (const item of CLOTHING) {
  let m;
  try {
    ({ MESH: m } = await import(new URL(`../assets/js/data/mesh/${item.id}.js`, import.meta.url).href));
    m = decode(m, (await import(new URL(`../assets/js/data/mesh/${item.id}.js`, import.meta.url).href)).HEADER);
  } catch { continue; }
  const def = FACE_DATA[item.id];
  let out = 0, tot = 0, worst = null;
  for (let t = 0; t < m.tris; t++) {
    const fid = m.faces[m.idx[t * 4 + 3]];
    const f = def[fid];
    const mask = maskFor(item.id, fid);
    if (!mask) continue;
    const ia = m.idx[t * 4], ib = m.idx[t * 4 + 1], ic = m.idx[t * 4 + 2];
    // sample the UV triangle on a 12x12 barycentric grid
    const N = 12;
    for (let i = 0; i <= N; i++)
      for (let j = 0; j <= N - i; j++) {
        const u = (i / N) * m.uv[ia * 2] + (j / N) * m.uv[ib * 2] + (1 - i / N - j / N) * m.uv[ic * 2];
        const v = (i / N) * m.uv[ia * 2 + 1] + (j / N) * m.uv[ib * 2 + 1] + (1 - i / N - j / N) * m.uv[ic * 2 + 1];
        const x = Math.min(f.w - 1, Math.max(0, Math.round(u * f.w)));
        const y = Math.min(f.h - 1, Math.max(0, Math.round((1 - v) * f.h)));
        tot++;
        if (!mask[y * f.w + x]) out++;
      }
  }
  console.log(`${item.id}: ${(100 * out / tot).toFixed(2)}% of mesh texel samples land outside the 2D mask (${out}/${tot})`);
}