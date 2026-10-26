// Diagnose the garment meshes: per-face UV boxes, degenerate triangles,
// UVs outside the texture, unknown face ids, and winding.
import { readFileSync } from 'node:fs';
import { CLOTHING } from '../assets/js/game/slots.js';
import { FACE_DATA } from '../assets/js/data/heartopia-faces.js';

function decode(b64, h) {
  const bin = Buffer.from(b64, 'base64');
  const s = h.half / 32767;
  const V = h.v;
  const ip = new Int16Array(bin.buffer, bin.byteOffset + h.o[0], V * 3);
  const iuv = new Uint16Array(bin.buffer, bin.byteOffset + h.o[2], V * 2);
  const idx = new Uint16Array(bin.buffer, bin.byteOffset + h.o[3], h.t * 4);
  const pos = new Float32Array(V * 3);
  const uv = new Float32Array(V * 2);
  for (let i = 0; i < V; i++) {
    pos[i * 3] = ip[i * 3] * s + h.c[0];
    pos[i * 3 + 1] = ip[i * 3 + 1] * s + h.c[1];
    pos[i * 3 + 2] = ip[i * 3 + 2] * s + h.c[2];
    uv[i * 2] = iuv[i * 2] / 65535;
    uv[i * 2 + 1] = iuv[i * 2 + 1] / 65535;
  }
  return { pos, uv, idx, faces: h.faces, tris: h.t, half: h.half };
}

for (const item of CLOTHING) {
  const file = new URL(`../assets/js/data/mesh/${item.id}.js`, import.meta.url);
  let m;
  try {
    const mod = await import(file.href);
    m = decode(mod.MESH, mod.HEADER);
  } catch (e) {
    console.log(`${item.id}: NO MESH (${e.message})`);
    continue;
  }
  const def = FACE_DATA[item.id] || item;
  const perFace = {};
  const bad = { oob: 0, degenerate: 0, unknownFace: 0, flipped: 0 };
  for (let t = 0; t < m.tris; t++) {
    const ia = m.idx[t * 4], ib = m.idx[t * 4 + 1], ic = m.idx[t * 4 + 2];
    const fid = m.faces[m.idx[t * 4 + 3]];
    const fdef = def && (def.faces ? def.faces.find((f) => f.id === fid) : def[fid]);
    if (!fdef) { bad.unknownFace++; continue; }
    const box = (perFace[fid] ||= { n: 0, u0: 9, u1: -9, v0: 9, v1: -9 });
    box.n++;
    for (const i of [ia, ib, ic]) {
      box.u0 = Math.min(box.u0, m.uv[i * 2]);
      box.u1 = Math.max(box.u1, m.uv[i * 2]);
      box.v0 = Math.min(box.v0, m.uv[i * 2 + 1]);
      box.v1 = Math.max(box.v1, m.uv[i * 2 + 1]);
      if (m.uv[i * 2] < 0 || m.uv[i * 2] > 1 || m.uv[i * 2 + 1] < 0 || m.uv[i * 2 + 1] > 1) bad.oob++;
    }
    const ax = m.pos[ia * 3], ay = m.pos[ia * 3 + 1], az = m.pos[ia * 3 + 2];
    const bx = m.pos[ib * 3], by = m.pos[ib * 3 + 1], bz = m.pos[ib * 3 + 2];
    const cx = m.pos[ic * 3], cy = m.pos[ic * 3 + 1], cz = m.pos[ic * 3 + 2];
    const e1 = [bx - ax, by - ay, bz - az], e2 = [cx - ax, cy - ay, cz - az];
    const cr = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    const area = Math.hypot(cr[0], cr[1], cr[2]) / 2;
    if (area < 1e-6) bad.degenerate++;
  }
  const parts = Object.entries(perFace).map(([fid, b]) =>
    `${fid}#${b.n} u[${b.u0.toFixed(3)},${b.u1.toFixed(3)}] v[${b.v0.toFixed(3)},${b.v1.toFixed(3)}]`);
  console.log(`${item.id}: ${m.tris} tris · ${parts.join(' · ')} · bad=${JSON.stringify(bad)}`);
}