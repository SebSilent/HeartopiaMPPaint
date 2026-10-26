/*
 * Where the garment mesh actually samples its texture.
 *
 * The 2D editor clips paint to the game's own ring for a face, and that is
 * right: the game refuses to paint those cells. The 3D preview must NOT reuse
 * that clip, because the mesh's UVs are under no obligation to stay inside the
 * paint ring - measured with tools/meshmask.mjs, Mary Janes samples 1,321
 * texels the ring disables and the t-shirt sleeves 12. Every one of them used to
 * be punched fully transparent, so the backdrop showed straight through the
 * shoe. That was the "missing triangles": the triangles were there, painted
 * nothing.
 *
 * So the 3D texture gets its own alpha, built from the mesh's UV footprint and
 * dilated by a texel (the renderer bleeds each triangle outward to hide seams,
 * so it reads just outside the exact footprint). Cells the mesh never touch stay
 * transparent, which is what keeps the rectangle's corners from sticking out of
 * the silhouette as white tabs.
 */

const cache = new Map();

/** Rasterise one face's UV triangles into a texel-sized Uint8Array. */
function coverage(mesh, face) {
  const w = face.w;
  const h = face.h;
  const cov = new Uint8Array(w * h);
  for (let t = 0; t < mesh.tris; t++) {
    if (mesh.faces[mesh.idx[t * 4 + 3]] !== face.id) continue;
    const pts = [];
    for (let k = 0; k < 3; k++) {
      const vi = mesh.idx[t * 4 + k];
      // The mesh's UV is u = x/w and v = 1 - y/h in cells, matching the
      // renderer's own mapping: row (1 - v) * h.
      pts.push([mesh.uv[vi * 2] * w, (1 - mesh.uv[vi * 2 + 1]) * h]);
    }
    const [ax, ay] = pts[0];
    const [bx, by] = pts[1];
    const [cx, cy] = pts[2];
    const d = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
    if (Math.abs(d) < 1e-9) continue;
    const x0 = Math.max(0, Math.floor(Math.min(ax, bx, cx)) - 1);
    const x1 = Math.min(w - 1, Math.ceil(Math.max(ax, bx, cx)) + 1);
    const y0 = Math.max(0, Math.floor(Math.min(ay, by, cy)) - 1);
    const y1 = Math.min(h - 1, Math.ceil(Math.max(ay, by, cy)) + 1);
    for (let y = y0; y <= y1; y++) {
      const py = y + 0.5;
      for (let x = x0; x <= x1; x++) {
        const px = x + 0.5;
        const w0 = ((bx - ax) * (py - ay) - (px - ax) * (by - ay)) / d;
        const w1 = ((cx - bx) * (py - by) - (px - bx) * (cy - by)) / d;
        const w2 = 1 - w0 - w1;
        // The same small tolerance the renderer's bleed implies: a texel whose
        // centre sits a hair outside the exact triangle is still read by it.
        if (w0 >= -0.08 && w1 >= -0.08 && w2 >= -0.08) cov[y * w + x] = 1;
      }
    }
  }
  return cov;
}

/**
 * @param {{pos:Float32Array,uv:Float32Array,idx:Uint16Array,faces:string[],tris:number}} mesh
 * @param {{id:string,w:number,h:number}[]} faces
 * @returns {Map<string,Uint8Array>} face id -> 1 where the mesh samples it
 */
export function coverageFor(mesh, faces) {
  const key = mesh.key || null;
  if (key && cache.has(key)) return cache.get(key);
  const out = new Map();
  for (const f of faces) out.set(f.id, coverage(mesh, f));
  if (key) cache.set(key, out);
  return out;
}
