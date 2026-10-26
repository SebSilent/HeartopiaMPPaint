// Where do the "holes" in the 3D garment come from?
//
// Two suspects, both measurable without a browser:
//   A. The texture is transparent where the mesh samples it. faceTexture() uses
//      the game's own disabledPixels/rings mask for alpha, but the mesh's UVs
//      are under no obligation to stay inside that mask. Any texel the mesh
//      samples that the mask turns transparent shows the backdrop straight
//      through the garment.
//   B. The geometry itself is not watertight: an edge shared by only one
//      triangle is a crack in the shell.
//
// Usage: node tools/meshmask.mjs [item ...]
import { readFileSync } from 'node:fs';
import { FACE_DATA } from '../assets/js/data/heartopia-faces.js';

// Same decode as assets/js/game/meshdata.js, inlined so this runs in Node.
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
  return { pos, uv, idx: new Uint16Array(buf, h.o[3], h.t * 4), faces: h.faces, tris: h.t, half: h.half };
}

// Same mask as game/faces.js: disabled runs win, else the rings.
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

  // --- B: boundary edges (geometry cracks) ---
  let outside = 0; // UV outside the rect entirely
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
  let boundary = 0;
  const bEdges = [];
  for (const [key, n] of edge) if (n === 1) { boundary++; if (bEdges.length < 8) bEdges.push(key); }
  // Walk the boundary edges into loops: a garment legitimately opens at the
  // hem, neck and cuffs (a few long loops); scattered short loops are holes.
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
  const seenV = new Set();
  const loops = [];
  for (const start of adj.keys()) {
    if (seenV.has(start)) continue;
    let len = 0;
    let cur = start;
    let prev = -1;
    while (cur !== undefined && !seenV.has(cur)) {
      seenV.add(cur);
      len++;
      const nexts = adj.get(cur).filter((n) => n !== prev);
      prev = cur;
      cur = nexts.length ? nexts[0] : undefined;
    }
    loops.push(len);
  }
  loops.sort((a, b) => b - a);

  // --- A: UV coverage vs mask ---
  const perFace = new Map();
  for (let t = 0; t < mesh.tris; t++) {
    const fid = mesh.faces[mesh.idx[t * 4 + 3]];
    if (!perFace.has(fid)) perFace.set(fid, []);
    perFace.get(fid).push(t);
  }
  // Where do the boundary edges sit? Mark their midpoints in UV space per face.
  const bmarks = new Map(); // fid -> [u,v] list (texel coords)
  for (const [key, n] of edge) {
    if (n !== 1) continue;
    const a = Math.floor(key / 100000);
    const b = key % 100000;
    // Which face does either endpoint's triangle carry? Walk triangles once more.
    for (let t = 0; t < mesh.tris; t++) {
      const v0 = mesh.idx[t * 4];
      const v1 = mesh.idx[t * 4 + 1];
      const v2 = mesh.idx[t * 4 + 2];
      if ((v0 === a && v1 === b) || (v1 === a && v2 === b) || (v2 === a && v0 === b) ||
          (v0 === b && v1 === a) || (v1 === b && v2 === a) || (v2 === b && v0 === a)) {
        const fid = mesh.faces[mesh.idx[t * 4 + 3]];
        if (!bmarks.has(fid)) bmarks.set(fid, []);
        const w = (FACE_DATA[item] || {})[fid] || { w: 1, h: 1 };
        bmarks.get(fid).push([
          ((mesh.uv[a * 2] + mesh.uv[b * 2]) / 2) * w.w,
          ((1 - mesh.uv[a * 2 + 1]) + (1 - mesh.uv[b * 2 + 1])) / 2 * w.h,
        ]);
      }
    }
  }

  const lines = [];
  for (const [fid, tris] of perFace) {
    const mk = maskFor(item, fid);
    if (!mk) { lines.push(`  face ${fid}: NO MASK DATA`); continue; }
    const { m, w, h } = mk;
    // Rasterise the UV triangles at texel resolution, dilated one texel (the
    // renderer bleeds each triangle outward to hide seams, so it samples just
    // outside the exact footprint).
    const cov = new Uint8Array(w * h);
    for (const t of tris) {
      const pts = [];
      for (const k of [0, 1, 2]) {
        const vi = mesh.idx[t * 4 + k];
        const u = mesh.uv[vi * 2] * w;
        const v = (1 - mesh.uv[vi * 2 + 1]) * h;
        if (mesh.uv[vi * 2] < -0.002 || mesh.uv[vi * 2] > 1.002 || mesh.uv[vi * 2 + 1] < -0.002 || mesh.uv[vi * 2 + 1] > 1.002) outside++;
        pts.push([u, v]);
      }
      const x0 = Math.max(0, Math.floor(Math.min(pts[0][0], pts[1][0], pts[2][0]) - 1.5));
      const x1 = Math.min(w - 1, Math.ceil(Math.max(pts[0][0], pts[1][0], pts[2][0]) + 1.5));
      const y0 = Math.max(0, Math.floor(Math.min(pts[0][1], pts[1][1], pts[2][1]) - 1.5));
      const y1 = Math.min(h - 1, Math.ceil(Math.max(pts[0][1], pts[1][1], pts[2][1]) + 1.5));
      const [ax, ay] = pts[0];
      const [bx, by] = pts[1];
      const [cx, cy] = pts[2];
      const d = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
      if (Math.abs(d) < 1e-9) continue;
      for (let y = y0; y <= y1; y++)
        for (let x = x0; x <= x1; x++) {
          const px = x + 0.5;
          const py = y + 0.5;
          const w0 = ((bx - ax) * (py - ay) - (px - ax) * (by - ay)) / d;
          const w1 = ((cx - bx) * (py - by) - (px - bx) * (cy - by)) / d;
          const w2 = 1 - w0 - w1;
          if (w0 >= -0.08 && w1 >= -0.08 && w2 >= -0.08) cov[y * w + x] = 1;
        }
    }
    let hole = 0;   // mesh samples it, mask says transparent -> see-through
    let dead = 0;   // mask says paintable, mesh never covers it -> unpaintable in 3D
    let paintable = 0;
    for (let i = 0; i < m.length; i++) {
      if (m[i]) paintable++;
      if (cov[i] && !m[i]) hole++;
      if (m[i] && !cov[i]) dead++;
    }
    lines.push(`  face ${fid}: tris ${tris.length}  paintable ${paintable}/${w * h}  mesh-samples-but-transparent ${hole}  paintable-but-uncovered ${dead}`);
    // ASCII map: '#' = mesh covers, '.' = paintable but uncovered, 'x' = mesh
    // samples but mask disables, 'B' = a boundary edge midpoint (crack).
    const marks = bmarks.get(fid) || [];
    const rows = [];
    for (let y = 0; y < h; y += 2) {
      let row = '';
      for (let x = 0; x < w; x += 1) {
        let c = ' ';
        let hit = false;
        for (const [mx, my] of marks) if (mx >= x && mx < x + 1 && my >= y && my < y + 2) hit = true;
        for (let yy = y; yy < Math.min(y + 2, h); yy++) {
          const i = yy * w + x;
          if (cov[i] && !m[i]) c = 'x';
          else if (hit) c = 'B';
          else if (cov[i]) c = '#';
          else if (m[i]) c = '.';
        }
        row += c;
      }
      rows.push(row);
    }
    lines.push(rows.join('\n'));
  }
  console.log(`${item}: boundary edges ${boundary} (of ${edge.size}), uv-outside-rect ${outside}, boundary loops ${loops.length} sizes [${loops.slice(0, 12).join(',')}${loops.length > 12 ? ',...' : ''}]`);
  for (const l of lines) console.log(l);
}