// For every closed boundary cycle: how much of the garment's own cloth would a
// cap add, and how close the cycle is to a circle. A cuff bounds a small disc in
// front of a lot of cloth; a panel outline bounds a disc as big as the panel it
// belongs to, and capping that is not a repair but a shrink-wrap.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const dir = 'assets/js/data/mesh';

function dec(b64, h) {
  const bin = Buffer.from(b64, 'base64');
  const buf = bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength);
  const s = h.half / 32767;
  const V = h.v;
  const ip = new Int16Array(buf, h.o[0], V * 3);
  const pos = new Float32Array(V * 3);
  for (let i = 0; i < V; i++) {
    pos[i * 3] = ip[i * 3] * s + h.c[0];
    pos[i * 3 + 1] = ip[i * 3 + 1] * s + h.c[1];
    pos[i * 3 + 2] = ip[i * 3 + 2] * s + h.c[2];
  }
  return { pos, idx: new Uint16Array(buf, h.o[3], h.t * 4), tris: h.t };
}

for (const f of readdirSync(dir)) {
  if (!f.endsWith('.js')) continue;
  const src = readFileSync(join(dir, f), 'utf8');
  const h = eval('(' + src.match(/export const HEADER = ([\s\S]*?);\r?\n/)[1] + ')');
  const m = dec(src.match(/export const MESH = "([^"]+)"/)[1], h);
  let cloth = 0;
  for (let t = 0; t < m.tris; t++) {
    const a = m.idx[t * 4], b = m.idx[t * 4 + 1], c = m.idx[t * 4 + 2];
    const ux = m.pos[b * 3] - m.pos[a * 3], uy = m.pos[b * 3 + 1] - m.pos[a * 3 + 1], uz = m.pos[b * 3 + 2] - m.pos[a * 3 + 2];
    const vx = m.pos[c * 3] - m.pos[a * 3], vy = m.pos[c * 3 + 1] - m.pos[a * 3 + 1], vz = m.pos[c * 3 + 2] - m.pos[a * 3 + 2];
    cloth += Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
  }
  const use = new Map();
  for (let t = 0; t < m.tris; t++) {
    for (let k = 0; k < 3; k++) {
      const a = m.idx[t * 4 + k], b = m.idx[t * 4 + ((k + 1) % 3)];
      if (a === b) continue;
      const e = a < b ? a * 65536 + b : b * 65536 + a;
      use.set(e, (use.get(e) || 0) + 1);
    }
  }
  const adj = new Map();
  for (const [e, n] of use) {
    if (n !== 1) continue;
    const a = e >> 16, b = e & 0xffff;
    if (!adj.has(a)) adj.set(a, []);
    if (!adj.has(b)) adj.set(b, []);
    adj.get(a).push(b);
    adj.get(b).push(a);
  }
  const used = new Set();
  const bits = [];
  for (const [e, n] of use) {
    if (n !== 1 || used.has(e)) continue;
    used.add(e);
    const a = e >> 16, b = e & 0xffff;
    const r = [a, b];
    let cur = b, closed = false;
    for (;;) {
      if (cur === a) { closed = true; break; }
      let nx = -1;
      for (const v of adj.get(cur) || []) {
        const k = v < cur ? v * 65536 + cur : cur * 65536 + v;
        if (used.has(k)) continue;
        used.add(k);
        nx = v;
        break;
      }
      if (nx < 0) break;
      r.push(nx);
      cur = nx;
    }
    if (!closed || r.length < 3) continue;
    let P = 0;
    for (let i = 0; i < r.length; i++) {
      const p = r[i], q = r[(i + 1) % r.length];
      P += Math.hypot(m.pos[p * 3] - m.pos[q * 3], m.pos[p * 3 + 1] - m.pos[q * 3 + 1], m.pos[p * 3 + 2] - m.pos[q * 3 + 2]);
    }
    let cx = 0, cy = 0, cz = 0;
    for (const v of r) { cx += m.pos[v * 3]; cy += m.pos[v * 3 + 1]; cz += m.pos[v * 3 + 2]; }
    cx /= r.length; cy /= r.length; cz /= r.length;
    let mx = 0;
    for (const v of r) mx = Math.max(mx, Math.hypot(m.pos[v * 3] - cx, m.pos[v * 3 + 1] - cy, m.pos[v * 3 + 2] - cz));
    // How far the ring's own plane is from flat: the fan lives in that plane, so
    // a ring that is a saddle (a panel outline) makes a crumpled cap, and a ring
    // that is a flat mouth (a cuff) makes a clean one.
    let flat = 0;
    let nx2 = 0, ny2 = 0, nz2 = 0;
    for (let i = 0; i < r.length; i++) {
      const p = r[i], q = r[(i + 1) % r.length];
      nx2 += (m.pos[p * 3 + 1] - m.pos[q * 3 + 1]) * (m.pos[p * 3 + 2] + m.pos[q * 3 + 2]);
      ny2 += (m.pos[p * 3 + 2] - m.pos[q * 3 + 2]) * (m.pos[p * 3] + m.pos[q * 3]);
      nz2 += (m.pos[p * 3] - m.pos[q * 3]) * (m.pos[p * 3 + 1] + m.pos[q * 3 + 1]);
    }
    const nl = Math.hypot(nx2, ny2, nz2) || 1;
    for (const v of r) {
      const d = Math.abs((m.pos[v * 3] - cx) * (nx2 / nl) + (m.pos[v * 3 + 1] - cy) * (ny2 / nl) + (m.pos[v * 3 + 2] - cz) * (nz2 / nl));
      flat = Math.max(flat, d);
    }
    const disc = Math.PI * mx * mx;
    const circ = (P * P) / (4 * Math.PI);
    bits.push(`n=${r.length} disc=${disc.toFixed(0)}c2 cloth%=${((disc / cloth) * 100).toFixed(0)} round=${(disc / circ).toFixed(2)} outofplane=${(flat * 100).toFixed(1)}c`);
  }
  console.log(`${f.replace('.js', '').padEnd(11)} cloth ${(cloth * 1e4).toFixed(0).padStart(6)}c2 | ${bits.join('  |  ')}`);
}
