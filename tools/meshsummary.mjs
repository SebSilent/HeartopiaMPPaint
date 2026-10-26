// Compact summary of meshmask.mjs: numbers only, no ASCII maps.
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

function maskFor(item, fid) {
  const f = (FACE_DATA[item] || {})[fid];
  if (!f) return null;
  const m = new Uint8Array(f.w * f.h).fill(1);
  if (f.off) {
    const rows = String(f.off).split(';');
    for (let y = 0; y < rows.length && y < f.h; y++) {
      if (!rows[y]) continue;
      for (const run of rows[y].split(',')) {
        const i = run.indexOf(':');
        const x = Number(run.slice(0, i));
        const len = Number(run.slice(i + 1));
        for (let k = 0; k < len; k++) if (x + k >= 0 && x + k < f.w) m[y * f.w + x + k] = 0;
      }
    }
  } else if (f.rings && f.rings.length) {
    for (let y = 0; y < f.h; y++)
      for (let x = 0; x < f.w; x++) {
        let c = false;
        for (const ring of f.rings)
          for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
            const [xi, yi] = ring[i];
            const [xj, yj] = ring[j];
            if (yi > y + 0.5 !== yj > y + 0.5 && x + 0.5 < ((xj - xi) * (y + 0.5 - yi)) / (yj - yi) + xi) c = !c;
          }
        if (!c) m[y * f.w + x] = 0;
      }
  }
  return { m, w: f.w, h: f.h };
}

const items = process.argv.slice(2).length ? process.argv.slice(2) : ['tshirt', 'tank', 'sweat', 'dress', 'skirt', 'shorts', 'trousers', 'bucket', 'cap', 'shoes', 'maryjanes'];

for (const item of items) {
  const mod = await import(`../assets/js/data/mesh/${item}.js`);
  const mesh = decode(mod.MESH, mod.HEADER);
  const edge = new Map();
  for (let t = 0; t < mesh.tris; t++) {
    const v = [mesh.idx[t * 4], mesh.idx[t * 4 + 1], mesh.idx[t * 4 + 2]];
    for (let k = 0; k < 3; k++) {
      const a = v[k], b = v[(k + 1) % 3];
      const key = a < b ? a * 100000 + b : b * 100000 + a;
      edge.set(key, (edge.get(key) || 0) + 1);
    }
  }
  let boundary = 0;
  for (const n of edge.values()) if (n === 1) boundary++;
  // boundary loops
  const adj = new Map();
  for (const [key, n] of edge) {
    if (n !== 1) continue;
    const a = Math.floor(key / 100000), b = key % 100000;
    if (!adj.has(a)) adj.set(a, []);
    if (!adj.has(b)) adj.set(b, []);
    adj.get(a).push(b); adj.get(b).push(a);
  }
  const seenV = new Set(); const loops = [];
  for (const start of adj.keys()) {
    if (seenV.has(start)) continue;
    let len = 0, cur = start, prev = -1;
    while (cur !== undefined && !seenV.has(cur)) {
      seenV.add(cur); len++;
      const nexts = adj.get(cur).filter((n) => n !== prev);
      prev = cur; cur = nexts.length ? nexts[0] : undefined;
    }
    loops.push(len);
  }
  loops.sort((a, b) => b - a);
  const small = loops.filter((l) => l <= 12);

  // UV coverage per face
  const perFace = new Map();
  for (let t = 0; t < mesh.tris; t++) {
    const fid = mesh.faces[mesh.idx[t * 4 + 3]];
    if (!perFace.has(fid)) perFace.set(fid, []);
    perFace.get(fid).push(t);
  }
  const parts = [];
  for (const [fid, tris] of perFace) {
    const f = (FACE_DATA[item] || {})[fid];
    if (!f) { parts.push(`${fid}:no-face-data`); continue; }
    const mk = maskFor(item, fid);
    const cov = new Uint8Array(f.w * f.h);
    let outside = 0, transparent = 0;
    for (const t of tris) {
      const vs = [mesh.idx[t * 4], mesh.idx[t * 4 + 1], mesh.idx[t * 4 + 2]];
      const uvs = vs.map((v) => [mesh.uv[v * 2] * f.w, mesh.uv[v * 2 + 1] * f.h]);
      // rasterise the triangle in texel space, sampling cell centres
      const minx = Math.max(0, Math.floor(Math.min(...uvs.map((p) => p[0]))));
      const maxx = Math.min(f.w - 1, Math.ceil(Math.max(...uvs.map((p) => p[0]))));
      const miny = Math.max(0, Math.floor(Math.min(...uvs.map((p) => p[1]))));
      const maxy = Math.min(f.h - 1, Math.ceil(Math.max(...uvs.map((p) => p[1]))));
      const [ax, ay] = uvs[0], [bx, by] = uvs[1], [cx, cy] = uvs[2];
      const d = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
      if (Math.abs(d) < 1e-9) continue;
      for (let y = miny; y <= maxy; y++)
        for (let x = minx; x <= maxx; x++) {
          const px = x + 0.5, py = y + 0.5;
          const w0 = ((bx - px) * (cy - py) - (cx - px) * (by - py)) / d;
          const w1 = ((cx - px) * (ay - py) - (ax - px) * (cy - py)) / d;
          const w2 = 1 - w0 - w1;
          if (w0 < 0 || w1 < 0 || w2 < 0) continue;
          if (x < 0 || y < 0 || x >= f.w || y >= f.h) { outside++; continue; }
          cov[y * f.w + x] = 1;
          if (!mk.m[y * f.w + x]) transparent++;
        }
    }
    let uncovered = 0;
    for (let i = 0; i < cov.length; i++) if (mk.m[i] && !cov[i]) uncovered++;
    parts.push(`${fid}:uncov${uncovered}/transp${transparent}`);
  }
  console.log(`${item}: tris ${mesh.tris} bndEdges ${boundary} loops [${loops.join(',')}] small<=12: ${small.length} | ${parts.join(' ')}`);
}