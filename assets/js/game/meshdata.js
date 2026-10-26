// The real garment shapes, at runtime.
//
// tools/build_mesh_module.mjs bakes each clothing item's fabric-simulation mesh
// out of art-pia's files: welded from ~220,000 triangles down to about 1,400,
// with the mesh's own normals and UVs. One file per garment, ~27 KB, imported
// only when the 3D preview is opened - the board itself never pays for it.
import { CLOTHING } from './slots.js';

const KNOWN = new Set(CLOTHING.map((c) => c.id));
const cache = new Map();

function decode(b64, h, itemId) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const buf = bytes.buffer;
  const s = h.half / 32767;
  const V = h.v;
  const pos = new Float32Array(V * 3);
  const nrm = new Float32Array(V * 3);
  const uv = new Float32Array(V * 2);
  const ip = new Int16Array(buf, h.o[0], V * 3);
  const inr = new Int8Array(buf, h.o[1], V * 3);
  const iuv = new Uint16Array(buf, h.o[2], V * 2);
  for (let i = 0; i < V; i++) {
    pos[i * 3] = ip[i * 3] * s + h.c[0];
    pos[i * 3 + 1] = ip[i * 3 + 1] * s + h.c[1];
    pos[i * 3 + 2] = ip[i * 3 + 2] * s + h.c[2];
    nrm[i * 3] = inr[i * 3] / 127;
    nrm[i * 3 + 1] = inr[i * 3 + 1] / 127;
    nrm[i * 3 + 2] = inr[i * 3 + 2] / 127;
    uv[i * 2] = iuv[i * 2] / 65535;
    uv[i * 2 + 1] = iuv[i * 2 + 1] / 65535;
  }
  return {
    pos,
    nrm,
    uv,
    idx: new Uint16Array(buf, h.o[3], h.t * 4),
    faces: h.faces,
    tris: h.t,
    half: h.half,
    // Lets tools/meshopenings.mjs and meshcover.js cache derived data against
    // this exact mesh, instead of recomputing it on every frame.
    key: itemId,
  };
}

/**
 * The garment's mesh, or null if this item has none.
 * @param {string} itemId
 */
export async function loadMesh(itemId) {
  if (!KNOWN.has(itemId)) return null;
  if (cache.has(itemId)) return cache.get(itemId);
  const p = import(`../data/mesh/${itemId}.js`)
    .then((m) => {
      const mesh = decode(m.MESH, m.HEADER, itemId);
      cache.set(itemId, mesh);
      return mesh;
    })
    .catch(() => {
      // A garment with no mesh of its own falls back to the flat panels.
      cache.set(itemId, null);
      return null;
    });
  cache.set(itemId, p);
  return p;
}
