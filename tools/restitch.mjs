// Can a better matching close the cracks that the bake's greedy stitch left?
//
// The bake stitches open-edge vertices in vertex order: the first vertex grabs
// its nearest free partner, which can steal a partner a later vertex needed.
// This tries the classic fix - collect every candidate pair within tolerance,
// accept them in increasing distance order, skip pairs whose ends are taken -
// as a post-process on the already-baked mesh, and reports what survives.
//
// Usage: node tools/restitch.mjs item tol [...]
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
  return { pos, idx: new Uint16Array(buf, h.o[3], h.t * 4), faces: h.faces, tris: h.t, V };
}

function boundaryLoops(mesh) {
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
  let open = 0;
  for (const [key, n] of edge) {
    if (n !== 1) continue;
    open++;
    const a = Math.floor(key / 100000);
    const b = key % 100000;
    if (!adj.has(a)) adj.set(a, []);
    if (!adj.has(b)) adj.set(b, []);
    adj.get(a).push(b);
    adj.get(b).push(a);
  }
  const seen = new Set();
  const sizes = [];
  for (const start of adj.keys()) {
    if (seen.has(start)) continue;
    let n = 0;
    let cur = start;
    let prev = -1;
    while (cur !== undefined && !seen.has(cur)) {
      seen.add(cur);
      n++;
      const nexts = adj.get(cur).filter((x) => x !== prev);
      prev = cur;
      cur = nexts.length ? nexts[0] : undefined;
    }
    sizes.push(n);
  }
  sizes.sort((a, b) => b - a);
  return { open, sizes };
}

for (const item of process.argv.slice(2).filter((a) => !/^\d/.test(a))) {
  const mod = await import(`../assets/js/data/mesh/${item}.js`);
  const tols = process.argv.slice(3).map(Number).filter((n) => n > 0);
  for (const tol of tols.length ? tols : [0.02, 0.03, 0.04, 0.05]) {
    const mesh = decode(mod.MESH, mod.HEADER);
    const before = boundaryLoops(mesh);
    // Vertex -> faces, so a pair is only accepted across faces (a face's own
    // open edge is its silhouette, never a seam).
    const vFace = new Map();
    for (let t = 0; t < mesh.tris; t++)
      for (let k = 0; k < 3; k++) {
        const vi = mesh.idx[t * 4 + k];
        const fid = mesh.faces[mesh.idx[t * 4 + 3]];
        if (!vFace.has(vi)) vFace.set(vi, new Set());
        vFace.get(vi).add(fid);
      }
    // Boundary edges again, on this mesh.
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
    const edgeVerts = new Set();
    for (const [key, n] of edge) {
      if (n !== 1) continue;
      const a = Math.floor(key / 100000);
      const b = key % 100000;
      edgeVerts.add(a);
      edgeVerts.add(b);
    }
    // Candidate pairs within tol, accepted nearest first.
    const list = [...edgeVerts];
    const pairs = [];
    for (let a = 0; a < list.length; a++)
      for (let b = a + 1; b < list.length; b++) {
        const i = list[a];
        const j = list[b];
        const d = Math.hypot(mesh.pos[i * 3] - mesh.pos[j * 3], mesh.pos[i * 3 + 1] - mesh.pos[j * 3 + 1], mesh.pos[i * 3 + 2] - mesh.pos[j * 3 + 2]);
        if (d < tol && ![...vFace.get(i)].some((f) => vFace.get(j).has(f))) pairs.push([d, i, j]);
      }
    pairs.sort((p, q) => p[0] - q[0]);
    const done = new Set();
    let welded = 0;
    for (const [, i, j] of pairs) {
      if (done.has(i) || done.has(j)) continue;
      for (let k = 0; k < 3; k++) mesh.pos[i * 3 + k] = mesh.pos[j * 3 + k] = (mesh.pos[i * 3 + k] + mesh.pos[j * 3 + k]) / 2;
      done.add(i);
      done.add(j);
      welded++;
    }
    const after = boundaryLoops(mesh);
    console.log(
      `${item} tol ${tol}: pairs ${pairs.length} welded ${welded} | open edges ${before.open}->${after.open}  loops [${before.sizes.join(',')}] -> [${after.sizes.join(',')}]`
    );
  }
}