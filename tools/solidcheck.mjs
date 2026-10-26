// Does capping the openings hold up? Boundary edges are the measure: an edge
// used by one triangle is cloth the eye can see through, and a cap turns each of
// a ring's edges into a shared one. So the number must fall by exactly the size
// of every ring capped - and nothing else may change: no triangle may lose its
// face, no index may point past the vertex list, and the surface area must not
// move, because a cap that changes area is a cap that is not in the plane.
//
// Usage: node tools/solidcheck.mjs [item ...]
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
// The cap builder under test. Deliberately NOT imported by the app: see the head
// of that file for the five measurements that decided it.
import { solidify } from './meshopenings.mjs';

if (typeof globalThis.atob !== 'function') globalThis.atob = (s) => Buffer.from(s, 'base64').toString('binary');

const dir = 'assets/js/data/mesh';

// A private copy of the decode so the "before" state is exactly the baked file.
function decode(b64, h) {
  const bin = Buffer.from(b64, 'base64');
  const buf = bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength);
  const s = h.half / 32767;
  const V = h.v;
  const ip = new Int16Array(buf, h.o[0], V * 3);
  const iuv = new Uint16Array(buf, h.o[2], V * 2);
  const pos = new Float32Array(V * 3);
  for (let i = 0; i < V; i++) {
    pos[i * 3] = ip[i * 3] * s + h.c[0];
    pos[i * 3 + 1] = ip[i * 3 + 1] * s + h.c[1];
    pos[i * 3 + 2] = ip[i * 3 + 2] * s + h.c[2];
  }
  return { pos, nrm: new Float32Array(V * 3), uv: Float32Array.from(iuv, (x) => x / 65535), idx: new Uint16Array(buf, h.o[3], h.t * 4), faces: h.faces, tris: h.t, V };
}

/** Open edges, and the runs they form, with each run's planar shape. */
function survey(mesh) {
  const use = new Map();
  for (let t = 0; t < mesh.tris; t++) {
    const v = [mesh.idx[t * 4], mesh.idx[t * 4 + 1], mesh.idx[t * 4 + 2]];
    for (let k = 0; k < 3; k++) {
      const a = v[k], b = v[(k + 1) % 3];
      if (a === b) continue;
      const e = a < b ? a * 65536 + b : b * 65536 + a;
      use.set(e, (use.get(e) || 0) + 1);
    }
  }
  let open = 0;
  const adj = new Map();
  for (const [e, n] of use) {
    if (n !== 1) continue;
    open++;
    const a = e >> 16, b = e & 0xffff;
    (adj.get(a) || adj.set(a, []).get(a)).push(b);
    (adj.get(b) || adj.set(b, []).get(b)).push(a);
  }
  const used = new Set();
  const runs = [];
  for (const [e, n] of use) {
    if (n !== 1 || used.has(e)) continue;
    used.add(e);
    const a = e >> 16, b = e & 0xffff;
    const verts = [a, b];
    let cur = b, closed = false;
    for (;;) {
      if (cur === a) { closed = true; break; }
      let nxt = -1;
      for (const v of adj.get(cur) || []) {
        const k = v < cur ? v * 65536 + cur : cur * 65536 + v;
        if (used.has(k)) continue;
        used.add(k);
        nxt = v;
        break;
      }
      if (nxt < 0) break;
      verts.push(nxt);
      cur = nxt;
    }
    // Mean bank width: a slit of length L and width W has area ~ L*W and
    // perimeter ~ 2L, so 2*area/perimeter is W.
    let nx = 0, ny = 0, nz = 0;
    for (let i = 0; i < verts.length; i++) {
      const p = verts[i], q = verts[(i + 1) % verts.length];
      nx += (mesh.pos[p * 3 + 1] - mesh.pos[q * 3 + 1]) * (mesh.pos[p * 3 + 2] + mesh.pos[q * 3 + 2]);
      ny += (mesh.pos[p * 3 + 2] - mesh.pos[q * 3 + 2]) * (mesh.pos[p * 3] + mesh.pos[q * 3]);
      nz += (mesh.pos[p * 3] - mesh.pos[q * 3]) * (mesh.pos[p * 3 + 1] + mesh.pos[q * 3 + 1]);
    }
    const nl = Math.hypot(nx, ny, nz) || 1;
    let cx = 0, cy = 0, cz = 0;
    for (const v of verts) { cx += mesh.pos[v * 3]; cy += mesh.pos[v * 3 + 1]; cz += mesh.pos[v * 3 + 2]; }
    cx /= verts.length; cy /= verts.length; cz /= verts.length;
    let area = 0, per = 0;
    for (let i = 0; i < verts.length; i++) {
      const p = verts[i], q = verts[(i + 1) % verts.length];
      const ax = mesh.pos[p * 3] - cx, ay = mesh.pos[p * 3 + 1] - cy, az = mesh.pos[p * 3 + 2] - cz;
      const bx = mesh.pos[q * 3] - cx, by = mesh.pos[q * 3 + 1] - cy, bz = mesh.pos[q * 3 + 2] - cz;
      area += (ax * by - ay * bx) * (nz / nl) + (ay * bz - az * by) * (nx / nl) + (az * bx - ax * bz) * (ny / nl);
      per += Math.hypot(mesh.pos[p * 3] - mesh.pos[q * 3], mesh.pos[p * 3 + 1] - mesh.pos[q * 3 + 1], mesh.pos[p * 3 + 2] - mesh.pos[q * 3 + 2]);
    }
    runs.push({ n: verts.length, closed, widthCm: (Math.abs(area / 2) * 2 / (per || 1)) * 100, lenCm: per * 100 });
  }
  return { open, runs };
}

/**
 * Shape of the surface itself. A weld that pinches cloth shows up here before it
 * shows up anywhere: area falls, the garment shrinks along an axis, and the
 * triangles around the pinch collapse into slivers. Closing open edges is only
 * good news if these three barely move.
 */
function shape(mesh) {
  let area = 0, sliver = 0;
  const bb = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (let t = 0; t < mesh.tris; t++) {
    const a = mesh.idx[t * 4], b = mesh.idx[t * 4 + 1], c = mesh.idx[t * 4 + 2];
    const ux = mesh.pos[b * 3] - mesh.pos[a * 3], uy = mesh.pos[b * 3 + 1] - mesh.pos[a * 3 + 1], uz = mesh.pos[b * 3 + 2] - mesh.pos[a * 3 + 2];
    const vx = mesh.pos[c * 3] - mesh.pos[a * 3], vy = mesh.pos[c * 3 + 1] - mesh.pos[a * 3 + 1], vz = mesh.pos[c * 3 + 2] - mesh.pos[a * 3 + 2];
    const A = Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
    const P =
      Math.hypot(ux, uy, uz) +
      Math.hypot(mesh.pos[c * 3] - mesh.pos[b * 3], mesh.pos[c * 3 + 1] - mesh.pos[b * 3 + 1], mesh.pos[c * 3 + 2] - mesh.pos[b * 3 + 2]) +
      Math.hypot(vx, vy, vz);
    area += A;
    if (P > 0 && A / (P * P) < 0.0024) sliver++;
    for (const v of [a, b, c])
      for (let k = 0; k < 3; k++) {
        bb[k] = Math.min(bb[k], mesh.pos[v * 3 + k]);
        bb[k + 3] = Math.max(bb[k + 3], mesh.pos[v * 3 + k]);
      }
  }
  return { area, sliver, size: [bb[3] - bb[0], bb[4] - bb[1], bb[5] - bb[2]] };
}

const only = process.argv.slice(2);
let totBefore = 0, totAfter = 0, totCap = 0;
for (const f of readdirSync(dir)) {
  if (!f.endsWith('.js')) continue;
  const item = f.replace('.js', '');
  if (only.length && !only.includes(item)) continue;
  const src = readFileSync(join(dir, f), 'utf8');
  const h = eval('(' + src.match(/export const HEADER = ([\s\S]*?);\r?\n/)[1] + ')');
  const b64 = src.match(/export const MESH = "([^"]+)"/)[1];
  const raw = decode(b64, h);
  const before = survey(raw);
  const s0 = shape(raw);
  const t0 = Date.now();
  const m = solidify(decode(b64, h));
  const ms = Date.now() - t0;
  const after = survey(m);
  const s1 = shape(m);
  totBefore += before.open;
  totAfter += after.open;
  totCap += m.capped || 0;
  // Every index must still address a real vertex, and every cap vertex must
  // still sample inside its own face: the two ways an appended fan breaks.
  const V = m.pos.length / 3;
  let bad = 0;
  for (let t = 0; t < m.tris; t++) {
    for (let k = 0; k < 3; k++) if (!(m.idx[t * 4 + k] < V)) bad++;
    if (!(m.idx[t * 4 + 3] < m.faces.length)) bad++;
    if (m.idx[t * 4] === m.idx[t * 4 + 1] || m.idx[t * 4 + 1] === m.idx[t * 4 + 2] || m.idx[t * 4] === m.idx[t * 4 + 2]) bad++;
  }
  const rings = before.runs.filter((r) => r.closed && r.n >= 3);
  console.log(
    `${item.padEnd(11)} open ${String(before.open).padStart(4)}->${String(after.open).padStart(4)}` +
      ` (${(((before.open - after.open) / before.open) * 100).toFixed(0).padStart(4)}%)` +
      ` caps ${String(m.capped || 0).padStart(2)}/${String(rings.length).padStart(2)} tris ${h.t}->${m.tris}` +
      ` | area ${((s1.area - s0.area) / s0.area * 100).toFixed(2)}% slivers ${s0.sliver}->${s1.sliver}` +
      ` bad ${bad} ${ms}ms` + (m.solidifyFailed ? ` SOLIDIFY FAILED: ${m.solidifyFailed}` : '')
  );
  for (const o of m.openings || []) {
    console.log(
      `             rim n=${String(o.n).padStart(3)} face ${String(o.face).padEnd(8)} warp ${o.warp.toFixed(3).padStart(6)}  turn ${o.turn.toFixed(2).padStart(5)} -> ${o.capped ? 'CAP' : 'leave'}`
    );
  }
}
console.log(`\ntotal open edges ${totBefore} -> ${totAfter} (${(((totBefore - totAfter) / totBefore) * 100).toFixed(1)}% closed), ${totCap} openings capped`);
