// For every boundary loop: how far away is the nearest vertex that is NOT part
// of the loop? If a crack's partners sit just past the stitch tolerance, a
// better stitch closes them at the source; if they are far, the loop is a real
// opening (or a panel outline) and only a fill cap closes it.
//
// Usage: node tools/crackgap.mjs [item ...]
import { readFileSync } from 'node:fs';

function decode(b64, h) {
  const bin = Buffer.from(b64, 'base64');
  const buf = bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength);
  const s = h.half / 32767;
  const V = h.v;
  const pos = new Float32Array(V * 3);
  const ip = new Int16Array(buf, h.o[0], V * 3);
  for (let i = 0; i < V; i++) {
    pos[i * 3] = ip[i * 3] * s + h.c[0];
    pos[i * 3 + 1] = ip[i * 3 + 1] * s + h.c[1];
    pos[i * 3 + 2] = ip[i * 3 + 2] * s + h.c[2];
  }
  return { pos, idx: new Uint16Array(buf, h.o[3], h.t * 4), tris: h.t };
}

const items = process.argv.slice(2).length ? process.argv.slice(2) : ['tshirt', 'tank', 'sweat', 'dress', 'skirt', 'shorts', 'trousers', 'bucket', 'cap', 'shoes', 'maryjanes'];

for (const item of items) {
  const mod = await import(`../assets/js/data/mesh/${item}.js`);
  const mesh = decode(mod.MESH, mod.HEADER);
  const V = mesh.pos.length / 3;
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
    if (loop.length < 2) continue;
    const inLoop = new Set(loop);
    // Nearest vertex outside the loop, brute force over a coarse bucket grid.
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const vi of loop) {
      x0 = Math.min(x0, mesh.pos[vi * 3]); x1 = Math.max(x1, mesh.pos[vi * 3]);
      y0 = Math.min(y0, mesh.pos[vi * 3 + 1]); y1 = Math.max(y1, mesh.pos[vi * 3 + 1]);
      z0 = Math.min(z0, mesh.pos[vi * 3 + 2]); z1 = Math.max(z1, mesh.pos[vi * 3 + 2]);
    }
    const diag = Math.hypot(x1 - x0, y1 - y0, z1 - z0);
    const cell = Math.max(diag, 0.05);
    const buckets = new Map();
    for (let i = 0; i < V; i++) {
      if (inLoop.has(i)) continue;
      const k = `${Math.floor(mesh.pos[i * 3] / cell)}|${Math.floor(mesh.pos[i * 3 + 1] / cell)}|${Math.floor(mesh.pos[i * 3 + 2] / cell)}`;
      if (!buckets.has(k)) buckets.set(k, []);
      buckets.get(k).push(i);
    }
    let best = Infinity;
    for (const vi of loop) {
      const x = mesh.pos[vi * 3], y = mesh.pos[vi * 3 + 1], z = mesh.pos[vi * 3 + 2];
      for (let dx = -1; dx <= 1; dx++)
        for (let dy = -1; dy <= 1; dy++)
          for (let dz = -1; dz <= 1; dz++) {
            const list = buckets.get(`${Math.floor(x / cell) + dx}|${Math.floor(y / cell) + dy}|${Math.floor(z / cell) + dz}`) || [];
            for (const j of list) {
              const d = Math.hypot(mesh.pos[j * 3] - x, mesh.pos[j * 3 + 1] - y, mesh.pos[j * 3 + 2] - z);
              if (d < best) best = d;
            }
          }
    }
    lines.push(`  loop ${String(loop.length).padStart(3)} diag ${diag.toFixed(3)}  nearest-outside ${best === Infinity ? 'none' : best.toFixed(4)}`);
  }
  lines.sort((a, b) => Number(b.match(/loop\s+(\d+)/)[1]) - Number(a.match(/loop\s+(\d+)/)[1]));
  console.log(`${item}:`);
  console.log(lines.join('\n'));
}