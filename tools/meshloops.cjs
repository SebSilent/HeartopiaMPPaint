/* Walk boundary edges properly: cycles AND open chains, with shape metrics.
 * A weld crack is a THIN loop (area << perimeter^2); a real opening (cuff, hem,
 * neck) is round-ish. This decides which loops the loader may patch. */
const fs = require('fs');
const path = require('path');

function decode(b64, h) {
  const bin = Buffer.from(b64, 'base64');
  const buf = bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength);
  const s = h.half / 32767;
  const V = h.v;
  const ip = new Int16Array(buf, h.o[0], V * 3);
  const idx = new Uint16Array(buf, h.o[3], h.t * 4);
  const pos = new Float32Array(V * 3);
  for (let i = 0; i < V; i++) {
    pos[i * 3] = ip[i * 3] * s + h.c[0];
    pos[i * 3 + 1] = ip[i * 3 + 1] * s + h.c[1];
    pos[i * 3 + 2] = ip[i * 3 + 2] * s + h.c[2];
  }
  return { pos, idx, tris: h.t, V };
}

function boundary(pos, idx, tris) {
  const use = new Map();
  for (let t = 0; t < tris; t++) {
    const a = idx[t * 4], b = idx[t * 4 + 1], c = idx[t * 4 + 2];
    for (const [p, q] of [[a, b], [b, c], [c, a]]) {
      if (p === q) continue;
      const k = p < q ? p + '_' + q : q + '_' + p;
      use.set(k, (use.get(k) || 0) + 1);
    }
  }
  const adj = new Map();
  for (const [k, n] of use) {
    if (n !== 1) continue;
    const [p, q] = k.split('_').map(Number);
    (adj.get(p) || adj.set(p, []).get(p)).push(q);
    (adj.get(q) || adj.set(q, []).get(q)).push(p);
  }
  // traverse every boundary edge exactly once
  const used = new Set();
  const runs = [];
  for (const [k] of use) {
    if (use.get(k) !== 1 || used.has(k)) continue;
    const [s0, s1] = k.split('_').map(Number);
    const verts = [s0, s1];
    used.add(k);
    let cur = s1;
    let closed = false;
    for (;;) {
      if (cur === s0) { closed = true; break; }
      const ns = adj.get(cur) || [];
      let nxt = -1;
      for (const v of ns) {
        const e = v < cur ? v + '_' + cur : cur + '_' + v;
        if (!used.has(e)) { nxt = v; used.add(e); break; }
      }
      if (nxt < 0) break;
      verts.push(nxt);
      cur = nxt;
    }
    runs.push({ verts, closed });
  }
  return runs;
}

function metrics(pos, verts) {
  let P = 0;
  for (let i = 0; i < verts.length; i++) {
    const a = verts[i], b = verts[(i + 1) % verts.length];
    if (i === verts.length - 1 && verts.length > 2) {
      // open chain: do not count the closing edge in perimeter
    }
    P += Math.hypot(pos[a * 3] - pos[b * 3], pos[a * 3 + 1] - pos[b * 3 + 1], pos[a * 3 + 2] - pos[b * 3 + 2]);
  }
  let cx = 0, cy = 0, cz = 0;
  for (const v of verts) { cx += pos[v * 3]; cy += pos[v * 3 + 1]; cz += pos[v * 3 + 2]; }
  cx /= verts.length; cy /= verts.length; cz /= verts.length;
  const sp = [0, 0, 0];
  for (const v of verts) {
    sp[0] += Math.abs(pos[v * 3] - cx); sp[1] += Math.abs(pos[v * 3 + 1] - cy); sp[2] += Math.abs(pos[v * 3 + 2] - cz);
  }
  const order = [0, 1, 2].sort((a, b) => sp[b] - sp[a]);
  const A = order[0], B = order[1];
  let area = 0;
  for (let i = 0; i < verts.length; i++) {
    const a = verts[i], b = verts[(i + 1) % verts.length];
    area += pos[a * 3 + A] * pos[b * 3 + B] - pos[b * 3 + A] * pos[a * 3 + B];
  }
  area = Math.abs(area) / 2;
  return { P, area, c: [cx, cy, cz] };
}

const dir = 'assets/js/data/mesh';
const items = process.argv.slice(2);
for (const f of fs.readdirSync(dir)) {
  if (items.length && !items.includes(f.replace('.js', ''))) continue;
  const src = fs.readFileSync(path.join(dir, f), 'utf8');
  const h = eval('(' + src.match(/export const HEADER = ([\s\S]*?);\r?\n/)[1] + ')');
  const m = decode(src.match(/export const MESH = "([^"]+)"/)[1], h);
  const runs = boundary(m.pos, m.idx, m.tris);
  console.log(`\n== ${f} ==`);
  for (const r of runs) {
    const { P, area, c } = metrics(m.pos, r.verts);
    const cells2 = (area * 10000).toFixed(0);
    const round = P > 0 ? ((area * 10000) / (P * P * 10000)).toFixed(4) : '0';
    const kind = r.closed ? (r.verts.length <= 4 ? 'degen' : 'cycle') : 'chain';
    if (r.verts.length < 3 && r.closed) continue;
    let gap = 0;
    if (!r.closed) {
      const a = r.verts[0], b = r.verts[r.verts.length - 1];
      gap = Math.hypot(m.pos[a * 3] - m.pos[b * 3], m.pos[a * 3 + 1] - m.pos[b * 3 + 1], m.pos[a * 3 + 2] - m.pos[b * 3 + 2]) * 100;
    }
    const wide = Math.max(...r.verts.map((v) => Math.hypot(m.pos[v * 3] - c[0], m.pos[v * 3 + 1] - c[1], m.pos[v * 3 + 2] - c[2]))) * 200;
    console.log(
      `  ${kind} n=${String(r.verts.length).padStart(3)} area=${cells2.padStart(6)}c2 perim=${(P * 100).toFixed(1)}c round=${round} gap=${gap.toFixed(1)}c span=${wide.toFixed(1)}c c=[${c.map((x) => x.toFixed(2)).join(',')}]`
    );
  }
}