/*
 * The book, as a solid with a rounded spine.
 *
 * The book's one face is a cover laid flat: front cover, spine, back cover, in
 * a row across 150 cells with an eighteen-cell spine in the middle. Folded back
 * up that is a closed book, and that is what this builds - a surface that runs
 * flat across the front cover, curves out and around the spine, and flat again
 * under the back cover, with a page block inside it.
 *
 * It speaks the same shape as a baked garment mesh (see game/meshdata.js), so
 * the preview's mesh path draws it with no special case: positions in normalised
 * body units (the renderer multiplies by 100 to get back to paint cells), the
 * mesh's own normals, and UVs in the face's own u = x/w, v = 1 - y/h convention.
 *
 * The round is deliberately small. A full half-circle of a spine would bulge
 * further from the covers than the book is thick and reads as a rolled towel;
 * a few cells of bulge on a quarter-turn is what a hardcover's spine actually
 * looks like from the front.
 */

import { BOOK } from './slots.js';

// The face is 150 x 84: front cover 0..66, spine 66..84, back cover 84..150.
const FACE_W = BOOK.faces[0].w;
const FACE_H = BOOK.faces[0].h;
const FRONT_END = 66; // where the front cover zone ends and the spine begins
const SPINE_END = 84; // where the spine ends and the back cover begins

const T = 26; // cover to cover, in cells
const BULGE = 7; // how far the spine stands out past the covers
// The covers are the front and back zones, 66 cells each - not the whole face,
// which also counts the spine between them. Half a cover is the book's half
// width, and the spine has to meet both covers at exactly -HALF.
const COVER_W = FRONT_END;
const HALF = COVER_W / 2;
const Y_HALF = FACE_H / 2;

/** One point on the cover's centre line, as a function of the face's u. */
function coverPoint(u) {
  if (u <= FRONT_END) {
    // Front cover, laid flat on top. u = 0 is the fore edge, u = 66 the spine.
    return { x: HALF - u, y: 0, z: T / 2, nx: 0, ny: 0, nz: 1 };
  }
  if (u >= SPINE_END) {
    // Back cover, flat underneath, running from the spine back out to the fore
    // edge. It starts where the spine lets go, so the strip never breaks.
    return { x: -HALF + (u - SPINE_END), y: 0, z: -T / 2, nx: 0, ny: 0, nz: -1 };
  }
  // The spine: a quarter-turn from facing up to facing down, bowing outward.
  const s = (u - FRONT_END) / (SPINE_END - FRONT_END);
  const th = Math.PI * s;
  const px = -HALF - BULGE * Math.sin(th);
  const pz = (T / 2) * Math.cos(th);
  // Outward normal, perpendicular to the tangent and pointing away from the
  // page block. At th = 0 it is +z (the front cover it joins), at th = pi it is
  // -z (the back cover), at the middle it is -x (the spine's own face).
  const nx = -(T / 2) * Math.sin(th);
  const nz = BULGE * Math.cos(th);
  const l = Math.hypot(nx, nz) || 1;
  return { x: px, y: 0, z: pz, nx: nx / l, ny: 0, nz: nz / l };
}

// Uniform in u, so the spine's eighteen cells get about a twelfth of the strip.
// It is the only curved part of the solid, so this is where the round lives; at
// half this resolution the spine reads as a mitred corner.
const U_STEPS = 96;
const V_STEPS = 8; // down the face, which is the book's height

/** A flat quad of pages, sampling a corner of the cover so it reads as paper. */
function pageBlock(push, tri) {
  // The page block sits inside the covers and stops short of the spine, which
  // is exactly how a case-bound book looks: the spine is leather, the pages are
  // a block set in from it. Its three visible edges (fore edge, top, bottom)
  // sample the very corner of the front cover zone, which is unpainted paper on
  // any board that has not been painted right out to the edge.
  const x0 = -HALF + 3;
  const x1 = HALF - 2;
  const zT = T / 2 - 2;
  const zB = -T / 2 + 2;
  const y = Y_HALF - 2;
  const uvCorner = [0.5 / FACE_W, 1 - 0.5 / FACE_H]; // top-left texel of the face
  const uvSpan = 6 / FACE_W;
  const faces = [
    // [a, b, c, d] corners of each side, in order, with a normal.
    { p: [[x1, -y, zT], [x1, -y, zB], [x1, y, zB], [x1, y, zT]], n: [1, 0, 0] }, // fore edge
    { p: [[x0, y, zT], [x1, y, zT], [x1, y, zB], [x0, y, zB]], n: [0, 1, 0] }, // top
    { p: [[x0, -y, zB], [x1, -y, zB], [x1, -y, zT], [x0, -y, zT]], n: [0, -1, 0] }, // bottom
  ];
  for (const f of faces) {
    const base = push(f.p, f.n, uvCorner, uvSpan);
    tri(base[0], base[1], base[2]);
    tri(base[0], base[2], base[3]);
  }
}

/**
 * @returns {{pos:Float32Array,nrm:Float32Array,uv:Float32Array,idx:Uint16Array,
 *            faces:string[],tris:number,half:number,key:string}}
 */
export function bookMesh() {
  const pos = [];
  const nrm = [];
  const uv = [];
  const idx = [];
  const S = 100; // normalised body units, matching the baked garments

  const pushVert = (x, y, z, nx, ny, nz, u, v) => {
    pos.push(x / S, y / S, z / S);
    nrm.push(nx, ny, nz);
    uv.push(u, v);
    return pos.length / 3 - 1;
  };

  // --- the cover: a grid swept along the folded centre line ---
  const grid = [];
  for (let iu = 0; iu <= U_STEPS; iu++) {
    const u = (iu / U_STEPS) * FACE_W;
    const pt = coverPoint(u);
    const col = [];
    for (let iv = 0; iv <= V_STEPS; iv++) {
      const v = (iv / V_STEPS) * FACE_H; // row down the face, 0 at the top
      const y = Y_HALF - v; // the top of the face is the top of the book
      col.push(pushVert(pt.x, y, pt.z, pt.nx, pt.ny, pt.nz, u / FACE_W, 1 - v / FACE_H));
    }
    grid.push(col);
  }
  for (let iu = 0; iu < U_STEPS; iu++) {
    for (let iv = 0; iv < V_STEPS; iv++) {
      const a = grid[iu][iv];
      const b = grid[iu + 1][iv];
      const c = grid[iu + 1][iv + 1];
      const d = grid[iu][iv + 1];
      idx.push(a, b, c, 0, a, c, d, 0);
    }
  }

  // --- the page block, sampling the cover's own corner for paper ---
  const pushSide = (corners, n, uv0, span) => {
    const out = [];
    const us = [0, span, span, 0];
    const vs = [0, 0, span, span];
    corners.forEach((p, k) => {
      out.push(pushVert(p[0], p[1], p[2], n[0], n[1], n[2], uv0[0] + us[k], uv0[1] - vs[k]));
    });
    return out;
  };
  pageBlock(pushSide, (a, b, c) => idx.push(a, b, c, 0));

  let half = 0;
  for (let i = 0; i < pos.length; i++) half = Math.max(half, Math.abs(pos[i]));

  return {
    pos: Float32Array.from(pos),
    nrm: Float32Array.from(nrm),
    uv: Float32Array.from(uv),
    idx: Uint16Array.from(idx),
    faces: [BOOK.faces[0].id],
    tris: idx.length / 4,
    half,
    key: 'procedural:book',
  };
}

/** Which items have a procedural solid. Cheap enough to ask on every click. */
const PROCEDURAL = new Map([[BOOK.id, bookMesh]]);

export function hasProcedural(itemId) {
  return PROCEDURAL.has(itemId);
}

/** Build it. Not free - this is where the geometry is generated. */
export function proceduralFor(itemId) {
  const build = PROCEDURAL.get(itemId);
  return build ? build() : null;
}
