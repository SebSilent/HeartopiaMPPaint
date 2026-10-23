// Turn art-pia's fabric-simulation meshes into the preview's geometry.
//
// A garment arrives as 220,000 triangles: a per-cell grid with fabric folds,
// plus a second "lining" copy of every panel 0.6mm inside it. That is far more
// than a canvas-2D renderer can repaint on every stroke, so it is welded on a
// position grid down to a few thousand triangles, the lining is dropped, and the
// result is quantised into one base64 blob per garment, loaded only when the 3D
// preview opens.
//
// The mesh's own UVs are the contract with the paint grid: u = x / faceWidth,
// v = 1 - y / faceHeight, in cells. That is what lets a triangle sample the
// live face texture with no remapping.
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import { decode } from './mesh_parts.mjs';
import { FACE_DATA } from '../assets/js/data/heartopia-faces.js';
import { CLOTHING } from '../assets/js/game/slots.js';

const TARGET = Number(process.argv[2] || 1400);

// mesh id -> app item id, and mesh group part -> the face it samples.
const ITEMS = {
  tshirt: 'tshirt',
  tank: 'tank',
  sweatshirt: 'sweat',
  dress: 'dress',
  skirt: 'skirt',
  shorts: 'shorts',
  pants: 'trousers',
  bucketHat: 'bucket',
  cap: 'cap',
  shoes: 'shoes',
  maryJane: 'maryjanes',
};
const PARTS = {
  tshirt: { front: 'front', back: 'back', sleeve: 'sleeveL', sleeveR: 'sleeveR' },
  tank: { front: 'front', back: 'back' },
  sweatshirt: { front: 'front', back: 'back', sleeve: 'sleeve', sleeveR: 'sleeve' },
  dress: { front: 'front', back: 'back', inner: 'inner' },
  skirt: { front: 'front', back: 'back' },
  shorts: { front: 'front', back: 'back' },
  pants: { front: 'front', back: 'back' },
  bucketHat: { front: 'brimF', back: 'brimB', top: 'crown' },
  cap: { front: 'front', back: 'rear', top: 'brim' },
  shoes: { front: 'upper', back: 'toe', top: 'sole' },
  maryJane: { front: 'upper', top: 'sole' },
};

const dir = '_scrape/meshes';
const warn = [];

/** The UV box a face's own outline ring implies, to check a group against it. */
function ringBox(itemId, face) {
  const d = FACE_DATA[itemId] && FACE_DATA[itemId][face.id];
  if (!d || !d.rings) return null;
  let x0 = Infinity;
  let x1 = -Infinity;
  let y0 = Infinity;
  let y1 = -Infinity;
  for (const r of d.rings) {
    for (const [x, y] of r) {
      x0 = Math.min(x0, x);
      x1 = Math.max(x1, x);
      y0 = Math.min(y0, y);
      y1 = Math.max(y1, y);
    }
  }
  return { u0: x0 / face.w, u1: x1 / face.w, v0: 1 - y1 / face.h, v1: 1 - y0 / face.h };
}

/** Collect a garment's triangles, with the face each one samples. */
function triangles(mesh, meshId, item) {
  const table = PARTS[meshId];
  const out = [];
  const def = CLOTHING.find((c) => c.id === item);
  for (const g of mesh.header.groups) {
    if (g.fabricLining) continue;
    const faceId = table[g.part];
    if (!faceId) {
      warn.push(`${meshId}: group part "${g.part}" has no face`);
      continue;
    }
    const face = def.faces.find((f) => f.id === faceId);
    if (!face) {
      warn.push(`${meshId}: face "${faceId}" is not on the item`);
      continue;
    }
    const box = ringBox(item, face);
    if (box) {
      let u0 = Infinity;
      let u1 = -Infinity;
      let v0 = Infinity;
      let v1 = -Infinity;
      for (let i = g.start; i < g.start + g.count; i++) {
        const vi = mesh.idx[i];
        u0 = Math.min(u0, mesh.uv[vi * 2]);
        u1 = Math.max(u1, mesh.uv[vi * 2]);
        v0 = Math.min(v0, mesh.uv[vi * 2 + 1]);
        v1 = Math.max(v1, mesh.uv[vi * 2 + 1]);
      }
      const pad = 0.035;
      if (u0 < box.u0 - pad || u1 > box.u1 + pad || v0 < box.v0 - pad || v1 > box.v1 + pad) {
        warn.push(
          `${meshId}/${g.part}->${faceId}: uv ${u0.toFixed(3)}..${u1.toFixed(3)} x ${v0.toFixed(3)}..${v1.toFixed(3)} ` +
            `outside ring ${box.u0.toFixed(3)}..${box.u1.toFixed(3)} x ${box.v0.toFixed(3)}..${box.v1.toFixed(3)}`
        );
      }
    }
    const fi = def.faces.findIndex((f) => f.id === faceId);
    for (let i = g.start; i < g.start + g.count; i += 3) {
      out.push({
        v: [mesh.idx[i], mesh.idx[i + 1], mesh.idx[i + 2]],
        face: fi,
      });
    }
  }
  return out;
}

/**
 * Weld on a position grid, per face, onto a position shared across faces.
 *
 * The grid is what makes 220,000 triangles affordable. Clusters are keyed by
 * face as well as by position, because two panels meeting at a seam want the
 * same point in space but different pixels of the paint - so they stay separate
 * vertices. They must however land on the *same* point, and keying the cluster
 * by face alone meant each face averaged its own members and drifted apart by
 * up to a cell: a hairline gap down every seam, and through it the background.
 *
 * So the position is resolved in two passes. Pass one buckets by quantised
 * position with no face in the key and averages, giving one canonical point per
 * grid cell. Pass two still clusters per face - for UV and normal - but writes
 * the canonical point out. Seams then meet exactly, and texturing is unchanged.
 */
function decimateRun(mesh, tris, cell) {
  const q = (x, y, z) => `${Math.round(x / cell)}|${Math.round(y / cell)}|${Math.round(z / cell)}`;

  // Pass one: the canonical position of every grid cell, across all faces.
  const buckets = new Map();
  for (const t of tris) {
    for (let k = 0; k < 3; k++) {
      const vi = t.v[k];
      const x = mesh.pos[vi * 3];
      const y = mesh.pos[vi * 3 + 1];
      const z = mesh.pos[vi * 3 + 2];
      const key = q(x, y, z);
      let b = buckets.get(key);
      if (!b) buckets.set(key, (b = { x: 0, y: 0, z: 0, n: 0 }));
      b.x += x;
      b.y += y;
      b.z += z;
      b.n++;
    }
  }

  // Pass two: cluster per face, emit the canonical position.
  const kept = [];
  const idxs = [];
  const map = new Map();
  for (const t of tris) {
    const ids = [];
    for (let k = 0; k < 3; k++) {
      const vi = t.v[k];
      const x = mesh.pos[vi * 3];
      const y = mesh.pos[vi * 3 + 1];
      const z = mesh.pos[vi * 3 + 2];
      const key = q(x, y, z);
      const ck = `${t.face}|${key}`;
      let id = map.get(ck);
      if (id === undefined) {
        id = kept.length;
        map.set(ck, id);
        const b = buckets.get(key);
        kept.push({
          x: b.x / b.n,
          y: b.y / b.n,
          z: b.z / b.n,
          f: t.face,
          nx: mesh.nrm[vi * 3],
          ny: mesh.nrm[vi * 3 + 1],
          nz: mesh.nrm[vi * 3 + 2],
          u: mesh.uv[vi * 2],
          v: mesh.uv[vi * 2 + 1],
        });
      }
      ids.push(id);
    }
    if (ids[0] === ids[1] || ids[1] === ids[2] || ids[2] === ids[0]) continue;
    idxs.push(ids[0], ids[1], ids[2], t.face);
  }
  return { kept, idxs };
}

/**
 * Stitch the seams the grid left open.
 *
 * Welding onto a grid only merges vertices that round to the same cell. Two
 * panels meeting at a seam routinely have their partners a little over half a
 * cell apart, so they land in different cells and stay that far apart - and a
 * gap of one cell on a garment a hundred cells wide is a four pixel slit down
 * the side of the rendered shirt, which is exactly what the render map showed:
 * trapped backdrop in a vertical line, not scattered.
 *
 * So find the vertices on the surface's open edge - the only places a seam can
 * be - and pair each with the nearest open-edge vertex belonging to a different
 * face, within a tolerance. Each pair is then moved to its midpoint, so neither
 * panel is favoured. Genuine openings (neck, cuffs, hem) have no partner to find
 * and stay open, which is correct: a t-shirt is not a sealed volume.
 */
function stitchSeams(kept, idxs, tol) {
  // Which vertices sit on an open edge: an edge used by one triangle only.
  const count = new Map();
  const at = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  for (let t = 0; t < idxs.length; t += 4) {
    const tri = [idxs[t], idxs[t + 1], idxs[t + 2]];
    for (let k = 0; k < 3; k++) {
      const e = at(tri[k], tri[(k + 1) % 3]);
      count.set(e, (count.get(e) || 0) + 1);
    }
  }
  const edgeVerts = new Set();
  for (const [e, n] of count) {
    if (n !== 1) continue;
    const [a, b] = e.split('|').map(Number);
    edgeVerts.add(a);
    edgeVerts.add(b);
  }
  if (!edgeVerts.size) return 0;

  // Spatial hash of the other faces' edge vertices, so this is not O(n^2).
  const hash = new Map();
  const hkey = (x, y, z) => `${Math.floor(x / tol)}|${Math.floor(y / tol)}|${Math.floor(z / tol)}`;
  for (const i of edgeVerts) {
    const v = kept[i];
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (let dz = -1; dz <= 1; dz++) {
          const k = `${Math.floor(v.x / tol) + dx}|${Math.floor(v.y / tol) + dy}|${Math.floor(v.z / tol) + dz}`;
          const list = hash.get(k);
          if (list) list.push(i);
          else hash.set(k, [i]);
        }
  }

  let stitched = 0;
  const done = new Set();
  for (const i of edgeVerts) {
    if (done.has(i)) continue;
    const v = kept[i];
    let best = -1;
    let bestD = tol;
    for (const j of hash.get(hkey(v.x, v.y, v.z)) || []) {
      if (j === i || done.has(j) || kept[j].f === v.f) continue;
      const d = Math.hypot(kept[j].x - v.x, kept[j].y - v.y, kept[j].z - v.z);
      if (d < bestD) {
        bestD = d;
        best = j;
      }
    }
    if (best < 0) continue;
    const w = kept[best];
    const mx = (v.x + w.x) / 2;
    const my = (v.y + w.y) / 2;
    const mz = (v.z + w.z) / 2;
    v.x = w.x = mx;
    v.y = w.y = my;
    v.z = w.z = mz;
    done.add(i);
    done.add(best);
    stitched++;
  }
  return stitched;
}

/**
 * Relax the welded mesh, once.
 *
 * Cluster decimation snaps to a grid, and a grid shows: on a curved silhouette
 * the steps catch the light as facets, and the user's word for it was "not
 * smooth". Each vertex moves halfway to the mean of the vertices it shares a
 * triangle with. Neighbours are found on the canonical position, so a seam
 * moves as one point and stays closed.
 *
 * One pass, and only the positions. Normals are then rebuilt from the new
 * geometry rather than kept, because keeping them would shade a surface that is
 * no longer there.
 */
function relax(kept, idxs) {
  const cell = 1e-5;
  const key = (x, y, z) => `${Math.round(x / cell)}|${Math.round(y / cell)}|${Math.round(z / cell)}`;
  // Vertices that share a canonical point are topologically one vertex.
  const byPos = new Map();
  for (let i = 0; i < kept.length; i++) {
    const k = key(kept[i].x, kept[i].y, kept[i].z);
    const list = byPos.get(k);
    if (list) list.push(i);
    else byPos.set(k, [i]);
  }
  const adj = kept.map(() => new Set());
  for (let t = 0; t < idxs.length; t += 4) {
    const tri = [idxs[t], idxs[t + 1], idxs[t + 2]];
    for (const a of tri)
      for (const b of tri) if (a !== b) for (const bn of byPos.get(key(kept[b].x, kept[b].y, kept[b].z)) || []) adj[a].add(bn);
  }
  const src = kept.map((v) => [v.x, v.y, v.z]);
  for (let i = 0; i < kept.length; i++) {
    const nb = adj[i];
    if (!nb.size) continue;
    let x = 0;
    let y = 0;
    let z = 0;
    for (const j of nb) {
      x += src[j][0];
      y += src[j][1];
      z += src[j][2];
    }
    const n = nb.size;
    kept[i].x = src[i][0] + 0.5 * (x / n - src[i][0]);
    kept[i].y = src[i][1] + 0.5 * (y / n - src[i][1]);
    kept[i].z = src[i][2] + 0.5 * (z / n - src[i][2]);
  }

  // Rebuild smooth vertex normals from the relaxed triangles, area-weighted.
  for (const v of kept) {
    v.nx = 0;
    v.ny = 0;
    v.nz = 0;
  }
  for (let t = 0; t < idxs.length; t += 4) {
    const [ia, ib, ic] = [idxs[t], idxs[t + 1], idxs[t + 2]];
    const a = kept[ia];
    const b = kept[ib];
    const c = kept[ic];
    const ux = b.x - a.x;
    const uy = b.y - a.y;
    const uz = b.z - a.z;
    const vx = c.x - a.x;
    const vy = c.y - a.y;
    const vz = c.z - a.z;
    // Cross product magnitude is twice the area, which is the weight wanted.
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    for (const v of [a, b, c]) {
      v.nx += nx;
      v.ny += ny;
      v.nz += nz;
    }
  }
  for (const v of kept) {
    const l = Math.hypot(v.nx, v.ny, v.nz) || 1;
    v.nx /= l;
    v.ny /= l;
    v.nz /= l;
  }
}

/** Find the weld grid that lands nearest the target triangle count. */
function fit(mesh, tris) {
  let lo = 0.002;
  let hi = 0.2;
  let best = null;
  let bestCell = hi;
  for (let i = 0; i < 22; i++) {
    const cell = (lo + hi) / 2;
    const r = decimateRun(mesh, tris, cell);
    const n = r.idxs.length / 4;
    if (n > TARGET) lo = cell;
    else {
      best = r;
      bestCell = cell;
      hi = cell;
    }
    if (Math.abs(hi - lo) / hi < 0.01) break;
  }
  if (!best) {
    best = decimateRun(mesh, tris, hi);
    bestCell = hi;
  }
  // Seam partners can be up to a cell apart and still be the same point, so the
  // stitching tolerance has to be a little over the cell that made the mesh.
  best.cell = bestCell;
  return best;
}

mkdirSync('assets/js/data/mesh', { recursive: true });
const report = [];
for (const file of readdirSync(dir).filter((f) => f.endsWith('.bin') && f.includes('-round.'))) {
  const mesh = decode(`${dir}/${file}`);
  const meshId = JSON.parse(mesh.header.key)[0];
  const item = ITEMS[meshId];
  if (!item) {
    warn.push(`no item for mesh ${meshId}`);
    continue;
  }
  const tris = triangles(mesh, meshId, item);
  const fitted = fit(mesh, tris);
  const { kept, idxs } = fitted;
  // Tolerance comes from the cell that made the mesh. It was also tried at a
  // flat 0.045, which tools/seamcheck.mjs suggested would catch 40 more pairs -
  // it caught none of them and the render measured identically, because those
  // candidates are the far side of the garment rather than a seam.
  const stitched = stitchSeams(kept, idxs, fitted.cell * 1.6);
  relax(kept, idxs);
  const V = kept.length;
  const T = idxs.length / 4;

  // How open the surface is, counted on the welded result. An edge belonging to
  // one triangle only is a boundary; a garment legitimately has some (neck,
  // cuffs, hem are openings) but a seam that failed to weld looks identical, and
  // it is through those that the background shows.
  const edge = new Map();
  for (let t = 0; t < idxs.length; t += 4) {
    const tri = [idxs[t], idxs[t + 1], idxs[t + 2]];
    for (let k = 0; k < 3; k++) {
      const a = Math.min(tri[k], tri[(k + 1) % 3]);
      const b = Math.max(tri[k], tri[(k + 1) % 3]);
      const key = `${a}-${b}`;
      edge.set(key, (edge.get(key) || 0) + 1);
    }
  }
  let openEdges = 0;
  for (const n of edge.values()) if (n === 1) openEdges++;
  const openPct = ((openEdges / edge.size) * 100).toFixed(1);
  // Grid welding cannot be perfect: two seam vertices half a cell apart can
  // round to different cells and stay that far apart. What matters is whether
  // that shows, so the real test is made in the renderer, not here - see
  // tools/meshholes.mjs, which counts background pixels trapped inside the
  // garment silhouette at several orbit angles.

  let x0 = Infinity;
  let x1 = -Infinity;
  let y0 = Infinity;
  let y1 = -Infinity;
  let z0 = Infinity;
  let z1 = -Infinity;
  for (const v of kept) {
    x0 = Math.min(x0, v.x);
    x1 = Math.max(x1, v.x);
    y0 = Math.min(y0, v.y);
    y1 = Math.max(y1, v.y);
    z0 = Math.min(z0, v.z);
    z1 = Math.max(z1, v.z);
  }
  // Quantise positions about the model's own centre, so the largest extent
  // decides the step and nothing pays for an offset it does not have.
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const cz = (z0 + z1) / 2;
  const half = Math.max((x1 - x0) / 2, (y1 - y0) / 2, (z1 - z0) / 2, 1e-4);
  const s = 32767 / half;

  const pos = new Int16Array(V * 3);
  const nrm = new Int8Array(V * 3);
  const uv = new Uint16Array(V * 2);
  for (let i = 0; i < V; i++) {
    const v = kept[i];
    pos[i * 3] = Math.round((v.x - cx) * s);
    pos[i * 3 + 1] = Math.round((v.y - cy) * s);
    pos[i * 3 + 2] = Math.round((v.z - cz) * s);
    nrm[i * 3] = Math.max(-127, Math.min(127, Math.round(v.nx * 127)));
    nrm[i * 3 + 1] = Math.max(-127, Math.min(127, Math.round(v.ny * 127)));
    nrm[i * 3 + 2] = Math.max(-127, Math.min(127, Math.round(v.nz * 127)));
    uv[i * 2] = Math.round(Math.max(0, Math.min(1, v.u)) * 65535);
    uv[i * 2 + 1] = Math.round(Math.max(0, Math.min(1, v.v)) * 65535);
  }
  const idx = new Uint16Array(idxs.length);
  for (let i = 0; i < idxs.length; i++) idx[i] = idxs[i];

  const pad = (n) => (n + 3) & ~3;
  const bPos = pos.byteLength;
  const bNrm = nrm.byteLength;
  const bUv = uv.byteLength;
  const bIdx = idx.byteLength;
  const o1 = pad(bPos);
  const o2 = pad(o1 + bNrm);
  const o3 = pad(o2 + bUv);
  const buf = new ArrayBuffer(o3 + bIdx);
  new Int16Array(buf, 0, V * 3).set(pos);
  new Int8Array(buf, o1, V * 3).set(nrm);
  new Uint16Array(buf, o2, V * 2).set(uv);
  new Uint16Array(buf, o3, idx.length).set(idx);

  const b64 = Buffer.from(buf).toString('base64');
  const faces = CLOTHING.find((c) => c.id === item).faces.map((f) => f.id);
  writeFileSync(
    `assets/js/data/mesh/${item}.js`,
    `/* GENERATED by tools/build_mesh_module.mjs from art-pia's ${meshId} mesh.\n` +
      ` * Quantised fabric geometry: positions about the model centre, the mesh's\n` +
      ` * own normals, its UVs (u = x/w, v = 1 - y/h in cells), one face index\n` +
      ` * per triangle. Do not edit by hand. */\n` +
      `export const MESH = ${JSON.stringify(b64)};\n` +
      `export const HEADER = ${JSON.stringify({
        v: V,
        t: T,
        half,
        c: [+cx.toFixed(5), +cy.toFixed(5), +cz.toFixed(5)],
        // Where each stream starts. Carried in the file so the reader cannot
        // disagree with the writer about alignment.
        o: [0, o1, o2, o3],
        faces,
      })};\n`
  );
  report.push(
    `${item.padEnd(11)} tris ${String(T).padStart(5)} verts ${String(V).padStart(5)} bytes ${String(b64.length).padStart(6)} open ${openPct}% stitched ${stitched}`
  );
}
console.log(report.join('\n'));
if (warn.length) console.log('\nWARNINGS\n' + warn.join('\n'));
