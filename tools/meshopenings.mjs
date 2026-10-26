// Which garment openings are real holes, and what a cap over them would cost.
//
// This used to run inside assets/js/game/meshdata.js on every garment load. It is
// here instead because the investigation ended with the conclusion that no
// view-independent rule can be trusted to apply it in the shipped app: five
// candidate predicates were measured across all 11 clothing meshes, and each one
// inverted on at least one garment. tools/solidcheck.mjs prints the numbers.
//
// Nothing in the app imports this file. It is a measuring instrument, not a
// feature: solidify() mutates the mesh you hand it, and that is exactly what the
// measurements say not to do automatically.
/**
 * Measure a closed boundary ring: how flat it is, how far the cloth lifts off it,
 * and which panel owns it. `warp` is the one that decides - see the comment where
 * it is computed for why the two earlier candidates did not.
 *
 * @param {object} mesh
 * @param {number[]} ring boundary vertices, in order, first vertex not repeated
 * @param {Map<number,number>} owner edge key -> the triangle that claimed it
 * @param {Map<number,number[]>} nbrs vertex -> adjacent vertices
 * @returns {{warp:number, turn:number, face:number}} warp under WARP is an opening
 */
function opening(mesh, ring, owner, nbrs) {
  const pos = mesh.pos;
  // Which panel does this rim belong to? The rim's own triangles answer that.
  const faces = new Map();
  for (let k = 0; k < ring.length; k++) {
    const a = ring[k];
    const b = ring[(k + 1) % ring.length];
    const t = owner.get(a < b ? a * 65536 + b : b * 65536 + a);
    if (t === undefined) continue;
    const f = mesh.idx[t * 4 + 3];
    faces.set(f, (faces.get(f) || 0) + 1);
  }
  let face = 0;
  let best = -1;
  for (const [f, n] of faces) if (n > best) ((best = n), (face = f));

  // The ring's own plane and its own size, measured in the frame a cap would have
  // to live in. Newell's method for the normal: no ordering assumption, and no
  // blow-up on a ring that is nearly flat.
  let cx = 0, cy = 0, cz = 0, nx = 0, ny = 0, nz = 0;
  for (let k = 0; k < ring.length; k++) {
    const p = ring[k];
    const q = ring[(k + 1) % ring.length];
    const px = pos[p * 3], py = pos[p * 3 + 1], pz = pos[p * 3 + 2];
    const qx = pos[q * 3], qy = pos[q * 3 + 1], qz = pos[q * 3 + 2];
    cx += px; cy += py; cz += pz;
    nx += (py - qy) * (pz + qz);
    ny += (pz - qz) * (px + qx);
    nz += (px - qx) * (py + qy);
  }
  cx /= ring.length; cy /= ring.length; cz /= ring.length;
  const nl = Math.hypot(nx, ny, nz) || 1;
  nx /= nl; ny /= nl; nz /= nl;

  // How far the rim strays out of its own plane, as a fraction of its own radius.
  // This is the measurement that decides, and it decides because of what a cap
  // *is*: a fan of triangles around one centre vertex, which is flat. A cuff, a
  // neck, a hem or a head hole can be spanned by something flat, because you
  // could lay that opening on a table. A panel outline is a saddle - the trousers'
  // front panel strays 7.4 cm out of a rim whose radius is a fraction of that -
  // and forcing a flat fan across it is not closing a hole, it is laying a sheet
  // over the garment, which is the +88% surface area this rule used to produce.
  //
  // It also explains why the two candidate rules before it both failed on the same
  // two items: "is there cloth behind the hole" measured a bucket's brim as a
  // floor (96-100% of every rim looked filled), and "does the cloth lift off the
  // rim" compared against a plane that does not exist for a saddle, scoring the
  // hat's real hole at 0.33 and the trousers' fake one at 0.83 - inverted, with no
  // threshold in between.
  let radius = 0;
  let dev = 0;
  for (const v of ring) {
    const dx = pos[v * 3] - cx, dy = pos[v * 3 + 1] - cy, dz = pos[v * 3 + 2] - cz;
    const across = dx * nx + dy * ny + dz * nz;
    const len2 = dx * dx + dy * dy + dz * dz;
    radius = Math.max(radius, Math.sqrt(Math.max(len2 - across * across, 0)));
    dev = Math.max(dev, Math.abs(across));
  }
  const warp = radius > 1e-6 ? dev / radius : 1;

  const rim = new Set(ring);
  const turns = [];
  for (const v of ring) {
    for (const w of nbrs.get(v) || []) {
      if (rim.has(w)) continue; // the rim is the hole's edge, not cloth across it
      const dx = pos[w * 3] - pos[v * 3];
      const dy = pos[w * 3 + 1] - pos[v * 3 + 1];
      const dz = pos[w * 3 + 2] - pos[v * 3 + 2];
      const len = Math.hypot(dx, dy, dz);
      if (len < 1e-6) continue;
      const across = Math.abs(dx * nx + dy * ny + dz * nz);
      const along = Math.sqrt(Math.max(len * len - across * across, 0));
      turns.push(across / Math.max(along, 1e-5));
    }
  }
  // Reported, not used: kept in the tooling output because it is the number that
  // looks like it should work and does not. The median, not the mean, for the same
  // reason as above.
  if (!turns.length) return { turn: 0, warp, face };
  turns.sort((a, b) => a - b);
  return { turn: turns[turns.length >> 1], warp, face };
}

/**
 * How far out of its own plane a rim may stray and still be spanned, as a
 * fraction of the rim's own radius. Scale-free by construction: the same number
 * has to work on a shoe and a pair of trousers. Set from the two populations
 * measured by tools/solidcheck.mjs, which is printed there with every rim.
 */
const WARP = 0.2;

/**
 * Make every garment *opening* a surface, so nothing shows the page through it.
 *
 * These meshes are a single sheet of cloth, not a solid: a sweater is one tube
 * with the neck, two cuffs and a hem cut out of it. From the side that is
 * perfect. Look at the bucket hat from slightly below and you see straight past
 * the brim into the page - measured at 3,256 trapped backdrop pixels, three
 * islands of 444, 368 and 213, which is what people call a hole.
 *
 * The obvious rule - cap every boundary that closes on itself, leave the ones
 * that do not, since an open run is a panel's own silhouette - is topologically
 * clean and visually wrong. It closed `shorts` from 144 open edges to 0 and
 * raised its surface area 84%: for that garment the only closed cycles *are* the
 * front and back panel outlines, so the rule shrink-wrapped the shorts in a
 * sheet of smeared paint. `trousers` +88%, `sweat` +65%.
 *
 * So the question is asked of the rim's own shape instead: **can something flat
 * span this boundary?** A cap is a fan of triangles around one centre vertex, and
 * a fan is flat, so it only belongs across an opening you could lay on a table -
 * a cuff, a neck, a hem, a head hole. A panel outline is the edge of a saddle,
 * and forcing a flat fan across it is not closing a hole but laying a sheet over
 * the garment, which is exactly what the +84% and +88% surface areas above are.
 * `opening` measures how far each rim strays out of its own plane, as a fraction
 * of its own radius, and `WARP` is where the line sits.
 *
 * What a cap is, and is not: it is built from the opening's own vertices and
 * their own UVs, so it samples the paint already ringing the hole and fades it
 * inward - a lining, not a lid. Seen end-on a cuff is a line; seen from an angle
 * it is a dark tube, which is exactly what a real garment shows you there.
 *
 * @param {{pos:Float32Array,nrm:Float32Array,uv:Float32Array,idx:Uint16Array,faces:string[],tris:number}} mesh
 * @returns {mesh} the same object, with the caps appended
 */
export function solidify(mesh) {
  const pos = mesh.pos;
  const V = pos.length / 3;

  // --- which edges belong to only one triangle? ------------------------------
  const use = new Map();
  const owner = new Map(); // edge key -> the last triangle that claimed it
  for (let t = 0; t < mesh.tris; t++) {
    for (let k = 0; k < 3; k++) {
      const a = mesh.idx[t * 4 + k];
      const b = mesh.idx[t * 4 + ((k + 1) % 3)];
      if (a === b) continue;
      const e = a < b ? a * 65536 + b : b * 65536 + a;
      use.set(e, (use.get(e) || 0) + 1);
      owner.set(e, t);
    }
  }
  const adj = new Map();
  for (const [e, n] of use) {
    if (n !== 1) continue;
    const a = e >> 16;
    const b = e & 0xffff;
    if (!adj.has(a)) adj.set(a, []);
    if (!adj.has(b)) adj.set(b, []);
    adj.get(a).push(b);
    adj.get(b).push(a);
  }

  // --- walk the boundary, keep only the runs that close ----------------------
  const used = new Set();
  const rings = [];
  for (const [e, n] of use) {
    if (n !== 1 || used.has(e)) continue;
    used.add(e);
    const a = e >> 16;
    const b = e & 0xffff;
    const ring = [a, b];
    let cur = b;
    let closed = false;
    for (;;) {
      let nxt = -1;
      for (const v of adj.get(cur) || []) {
        const k = v < cur ? v * 65536 + cur : cur * 65536 + v;
        if (used.has(k)) continue;
        used.add(k);
        nxt = v;
        break;
      }
      // Coming back to where we started closes the ring, and the start is not
      // added again: a ring that lists its first vertex twice makes a fan whose
      // last triangle is `a, a, centre`, which is how every opening here came to
      // carry one degenerate triangle and why `shorts` reported open edges 144->0
      // while still showing cloth through the middle of it.
      if (nxt < 0) break;
      if (nxt === a) {
        closed = true;
        break;
      }
      ring.push(nxt);
      cur = nxt;
    }
    // A ring of two is a single edge with nothing on either side, which is a
    // loose flap rather than a hole. Three or more is a hole you can see through
    // - and a ring of exactly three is one dropped triangle, the plainest case
    // of all.
    if (closed && ring.length >= 3) rings.push(ring);
  }

  // --- keep only the rings that are actually see-through ---------------------
  // Vertex adjacency, which is what `opening` reads to see where cloth goes from
  // the rim. Built from the triangles, not from the boundary edges: the rim's own
  // neighbours are inside the surface.
  const nbrs = new Map();
  const link = (a, b) => {
    if (a === b) return;
    if (!nbrs.has(a)) nbrs.set(a, []);
    nbrs.get(a).push(b);
  };
  for (let t = 0; t < mesh.tris; t++) {
    const a = mesh.idx[t * 4];
    const b = mesh.idx[t * 4 + 1];
    const c = mesh.idx[t * 4 + 2];
    link(a, b);
    link(b, c);
    link(c, a);
  }
  const kept = [];
  // Recorded for tools/solidcheck.mjs: which rims were measured, what they turned
  // out to be, and what was decided. "It refused to cap the hat" is a bug report
  // nobody can read without the number behind it.
  mesh.openings = [];
  for (const ring of rings) {
    const r = opening(mesh, ring, owner, nbrs);
    const cap = r.warp < WARP;
    mesh.openings.push({
      n: ring.length,
      warp: r.warp,
      turn: r.turn,
      face: mesh.faces[r.face] || r.face,
      capped: cap,
    });
    if (cap) kept.push({ ring, face: r.face, warp: r.warp });
  }
  mesh.rings = rings.length;
  mesh.refused = rings.length - kept.length;
  if (!kept.length) {
    mesh.capped = 0;
    return mesh;
  }

  // --- append one centre vertex per opening, then the fan ---------------------
  const extra = kept.length;
  const npos = new Float32Array((V + extra) * 3);
  npos.set(pos);
  const nnrm = new Float32Array((V + extra) * 3);
  nnrm.set(mesh.nrm);
  const nuv = new Float32Array((V + extra) * 2);
  nuv.set(mesh.uv);
  const add = [];
  kept.forEach((op, i) => {
    const ring = op.ring;
    const c = V + i;
    let x = 0, y = 0, z = 0, nx = 0, ny = 0, nz = 0, u = 0, v = 0;
    for (const p of ring) {
      x += pos[p * 3];
      y += pos[p * 3 + 1];
      z += pos[p * 3 + 2];
      nx += mesh.nrm[p * 3];
      ny += mesh.nrm[p * 3 + 1];
      nz += mesh.nrm[p * 3 + 2];
      u += mesh.uv[p * 2];
      v += mesh.uv[p * 2 + 1];
    }
    const n = ring.length;
    npos[c * 3] = x / n;
    npos[c * 3 + 1] = y / n;
    npos[c * 3 + 2] = z / n;
    const nl = Math.hypot(nx, ny, nz) || 1;
    nnrm[c * 3] = nx / nl;
    nnrm[c * 3 + 1] = ny / nl;
    nnrm[c * 3 + 2] = nz / nl;
    nuv[c * 2] = u / n;
    nuv[c * 2 + 1] = v / n;
    add.push(c);
  });
  mesh.pos = npos;
  mesh.nrm = nnrm;
  mesh.uv = nuv;

  // Count first, so the new buffer is exactly the right size.
  let newTris = 0;
  for (const op of kept) newTris += op.ring.length;
  const idx = new Uint16Array((mesh.tris + newTris) * 4);
  idx.set(mesh.idx.subarray(0, mesh.tris * 4));
  let w = mesh.tris;
  kept.forEach((op, i) => {
    const ring = op.ring;
    const c = add[i];
    for (let k = 0; k < ring.length; k++) {
      idx[w * 4] = ring[k];
      idx[w * 4 + 1] = ring[(k + 1) % ring.length];
      idx[w * 4 + 2] = c;
      // The panel the opening's own rim belongs to, so the cap samples that
      // face's paint rather than whichever panel the walk happened to reach.
      idx[w * 4 + 3] = op.face;
      w++;
    }
  });
  mesh.idx = idx;
  mesh.tris = w;
  mesh.capped = kept.length;
  mesh.capTris = newTris;
  return mesh;
}
