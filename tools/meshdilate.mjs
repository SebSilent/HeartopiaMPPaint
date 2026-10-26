// How far outside the game's mask do the mesh UVs sample? Tells us how much
// edge-dilation the 3D texture needs so no mesh sample lands on transparency.
import { FACE_DATA } from '../assets/js/data/heartopia-faces.js';

function decode(b64, h) {
  const bin = Buffer.from(b64, 'base64');
  const buf = bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength);
  const s = h.half / 32767;
  const V = h.v;
  const uv = new Float32Array(V * 2);
  const iuv = new Uint16Array(buf, h.o[2], V * 2);
  for (let i = 0; i < V; i++) {
    uv[i * 2] = iuv[i * 2] / 65535;
    uv[i * 2 + 1] = iuv[i * 2 + 1] / 65535;
  }
  return { uv, idx: new Uint16Array(buf, h.o[3], h.t * 4), faces: h.faces, tris: h.t };
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

// distance from the mask (chequered BFS over texel centres), for one texel
function distField(mk) {
  const { m, w, h } = mk;
  const d = new Int16Array(w * h).fill(-1);
  let frontier = [];
  for (let i = 0; i < w * h; i++) if (m[i]) { d[i] = 0; frontier.push(i); }
  let best = 0;
  while (frontier.length) {
    const next = [];
    for (const i of frontier) {
      const x = i % w, y = (i / w) | 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const j = ny * w + nx;
        if (d[j] !== -1) continue;
        d[j] = d[i] + 1;
        if (d[j] > best) best = d[j];
        next.push(j);
      }
    }
    frontier = next;
  }
  return { d, best };
}

const items = process.argv.slice(2).length ? process.argv.slice(2) : ['tshirt', 'tank', 'sweat', 'dress', 'skirt', 'shorts', 'trousers', 'bucket', 'cap', 'shoes', 'maryjanes'];
const worst = { item: '-', face: '-', d: 0 };
for (const item of items) {
  const mod = await import(`../assets/js/data/mesh/${item}.js`);
  const mesh = decode(mod.MESH, mod.HEADER);
  const perFace = new Map();
  for (let t = 0; t < mesh.tris; t++) {
    const fid = mesh.faces[mesh.idx[t * 4 + 3]];
    if (!perFace.has(fid)) perFace.set(fid, []);
    perFace.get(fid).push(t);
  }
  const parts = [];
  for (const [fid, tris] of perFace) {
    const f = (FACE_DATA[item] || {})[fid];
    if (!f) continue;
    const mk = maskFor(item, fid);
    const { d, best } = distField(mk);
    // max mask-distance over every texel the mesh's UV triangles touch
    let maxd = 0, n = 0;
    for (const t of tris) {
      const vs = [mesh.idx[t * 4], mesh.idx[t * 4 + 1], mesh.idx[t * 4 + 2]];
      const uvs = vs.map((v) => [mesh.uv[v * 2] * f.w, mesh.uv[v * 2 + 1] * f.h]);
      const minx = Math.max(0, Math.floor(Math.min(...uvs.map((p) => p[0]))));
      const maxx = Math.min(f.w - 1, Math.ceil(Math.max(...uvs.map((p) => p[0]))));
      const miny = Math.max(0, Math.floor(Math.min(...uvs.map((p) => p[1]))));
      const maxy = Math.min(f.h - 1, Math.ceil(Math.max(...uvs.map((p) => p[1]))));
      const [ax, ay] = uvs[0], [bx, by] = uvs[1], [cx, cy] = uvs[2];
      const det = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
      if (Math.abs(det) < 1e-9) continue;
      for (let y = miny; y <= maxy; y++)
        for (let x = minx; x <= maxx; x++) {
          const px = x + 0.5, py = y + 0.5;
          const w0 = ((bx - px) * (cy - py) - (cx - px) * (by - py)) / det;
          const w1 = ((cx - px) * (ay - py) - (ax - px) * (cy - py)) / det;
          const w2 = 1 - w0 - w1;
          if (w0 < -0.02 || w1 < -0.02 || w2 < -0.02) continue; // small bleed like the renderer's
          if (x < 0 || y < 0 || x >= f.w || y >= f.h) continue;
          n++;
          if (d[y * f.w + x] > maxd) maxd = d[y * f.w + x];
        }
    }
    parts.push(`${fid}:maxout${maxd}`);
    if (maxd > worst.d) { worst.d = maxd; worst.item = item; worst.face = fid; }
  }
  console.log(`${item}: ${parts.join(' ')}`);
}
console.log(`WORST: ${worst.item}/${worst.face} samples ${worst.d} texels outside the mask`);