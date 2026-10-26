// Where exactly are the boundary loops that are left in the welded meshes?
//
// meshmask.mjs counts boundary edges and walks them into loops, but stops at
// sizes. This walks each loop and reports where it sits in 3D and which face's
// UV island it lives on, so a crack can be told from a legit opening (hem,
// neck, cuffs) by position, not by guesswork.
//
// Usage: node tools/cracks.mjs [item ...]
import { readFileSync } from 'node:fs';
import { FACE_DATA } from '../assets/js/data/heartopia-faces.js';

function decode(b64, h) {
  const bin = Buffer.from(b64, 'base64');
  const buf = bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength);
  const s = h.half / 32767;
  const V = h.v;
  const pos = new Float32Array(V * 3);
  const uv = new Float32Array(V * 2);
  const ip = new Int16Array(buf, h.o[0], V * 3);
  const iuv = new Uint16Array(buf, h.o[2], V * 2);
  for (let i = 0; i < V; i++) {
    pos[i * 3] = ip[i * 3] * s + h.c[0];
    pos[i * 3 + 1] = ip[i * 3 + 1] * s + h.c[1];
    pos[i * 3 + 2] = ip[i * 3 + 2] * s + h.c[2];
    uv[i * 2] = iuv[i * 2] / 65535;
    uv[i * 2 + 1] = iuv[i * 2 + 1] / 65535;
  }
  return { pos, uv, idx: new Uint16Array(buf, h.o[3], h.t * 4), faces: h.faces, tris: h.t };
}

const items = process.argv.slice(2).length ? process.argv.slice(2) : ['tshirt', 'tank', 'sweat', 'dress', 'skirt', 'shorts', 'trousers', 'bucket', 'cap', 'shoes', 'maryjanes'];

for (const item of items) {
  const mod = await import(`../assets/js/data/mesh/${item}.js`);
  const mesh = decode(mod.MESH, mod.HEADER);
  const edge = new Map();
  for (let t = 0; t < mesh.tris; t++) {
    const v = [mesh.idx[t * 4], mesh.idx[t * 4 + 1], mesh.idx[t * 4 + 2]];
    for (let k = 0; k < 3; k++) {
      const a = v[k];
      const b = v[(k + 1) % 3];
      const key = a < b ? a * 100000 + b : b * 100000 + a;
      edge.set(key, (edge.get(key) || 0) + 1);
    }
  }
  const adj = new Map();
  for (const [key, n] of edge) {
    if (n !== 1) continue;
    const a = Math.floor(key / 100000);
    const b = key % 100000;
    if (!adj.has(a)) adj.set(a, []);
    if (!adj.has(b)) adj.set(b, []);
    adj.get(a).push(b);
    adj.get(b).push(a);
  }
  // A vertex can carry several faces' copies (welded per face); report all.
  const vFaces = new Map();
  for (let t = 0; t < mesh.tris; t++)
    for (let k = 0; k < 3; k++) {
      const vi = mesh.idx[t * 4 + k];
      const fid = mesh.faces[mesh.idx[t * 4 + 3]];
      if (!vFaces.has(vi)) vFaces.set(vi, new Set());
      vFaces.get(vi).add(fid);
    }

  const seen = new Set();
  const lines = [];
  for (const start of adj.keys()) {
    if (seen.has(start)) continue;
    const loop = [];
    let cur = start;
    let prev = -1;
    while (cur !== undefined && !seen.has(cur)) {
      seen.add(cur);
      loop.push(cur);
      const nexts = adj.get(cur).filter((n) => n !== prev);
      prev = cur;
      cur = nexts.length ? nexts[0] : undefined;
    }
    // 3D bbox of the loop, and the faces its vertices belong to.
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    const faces = new Set();
    for (const vi of loop) {
      x0 = Math.min(x0, mesh.pos[vi * 3]); x1 = Math.max(x1, mesh.pos[vi * 3]);
      y0 = Math.min(y0, mesh.pos[vi * 3 + 1]); y1 = Math.max(y1, mesh.pos[vi * 3 + 1]);
      z0 = Math.min(z0, mesh.pos[vi * 3 + 2]); z1 = Math.max(z1, mesh.pos[vi * 3 + 2]);
      for (const f of vFaces.get(vi) || []) faces.add(f);
    }
    // UV extent per face (texel coords, renderer's flip).
    const uvBox = new Map();
    for (const fid of faces) {
      const f = (FACE_DATA[item] || {})[fid] || { w: 1, h: 1 };
      let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
      for (const vi of loop) {
        if (!(vFaces.get(vi) || new Set()).has(fid)) continue;
        u0 = Math.min(u0, mesh.uv[vi * 2] * f.w); u1 = Math.max(u1, mesh.uv[vi * 2] * f.w);
        v0 = Math.min(v0, (1 - mesh.uv[vi * 2 + 1]) * f.h); v1 = Math.max(v1, (1 - mesh.uv[vi * 2 + 1]) * f.h);
      }
      if (u0 <= u1) uvBox.set(fid, `u ${u0.toFixed(1)}..${u1.toFixed(1)} v ${v0.toFixed(1)}..${v1.toFixed(1)} (of ${f.w}x${f.h})`);
    }
    const c = [(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2];
    const ext = [(x1 - x0).toFixed(2), (y1 - y0).toFixed(2), (z1 - z0).toFixed(2)];
    lines.push(
      `  loop ${String(loop.length).padStart(3)}  centre [${c.map((n) => n.toFixed(2)).join(', ')}]  extent [${ext.join(', ')}]  faces [${[...faces].join(',')}]  ${[...uvBox].map(([f, b]) => `${f}: ${b}`).join(' | ')}`
    );
  }
  lines.sort((a, b) => Number(b.match(/loop\s+(\d+)/)[1]) - Number(a.match(/loop\s+(\d+)/)[1]));
  console.log(`${item}:`);
  console.log(lines.join('\n'));
}