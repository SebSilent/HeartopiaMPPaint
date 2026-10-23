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
 * Weld on a position grid, per face.
 *
 * The grid is what makes 220,000 triangles affordable. Clusters are keyed by
 * face as well as by position, because two panels meeting at a seam want the
 * same point in space but different pixels of the paint.
 */
function decimateRun(mesh, tris, cell) {
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
      const key = `${t.face}|${Math.round(x / cell)}|${Math.round(y / cell)}|${Math.round(z / cell)}`;
      let id = map.get(key);
      if (id === undefined) {
        id = kept.length;
        map.set(key, id);
        kept.push({
          x,
          y,
          z,
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

/** Find the weld grid that lands nearest the target triangle count. */
function fit(mesh, tris) {
  let lo = 0.002;
  let hi = 0.2;
  let best = null;
  for (let i = 0; i < 22; i++) {
    const cell = (lo + hi) / 2;
    const r = decimateRun(mesh, tris, cell);
    const n = r.idxs.length / 4;
    if (n > TARGET) lo = cell;
    else {
      best = r;
      hi = cell;
    }
    if (Math.abs(hi - lo) / hi < 0.01) break;
  }
  return best || decimateRun(mesh, tris, hi);
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
  const { kept, idxs } = fit(mesh, tris);
  const V = kept.length;
  const T = idxs.length / 4;

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
  report.push(`${item.padEnd(11)} tris ${String(T).padStart(5)} verts ${String(V).padStart(5)} bytes ${b64.length}`);
}
console.log(report.join('\n'));
if (warn.length) console.log('\nWARNINGS\n' + warn.join('\n'));
