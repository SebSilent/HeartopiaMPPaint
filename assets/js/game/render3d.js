/*
 * A tiny 3D renderer, in plain canvas 2D, for the preview.
 *
 * No WebGL and no library, because this project has no build step and has to
 * work on an iPad in a private tab as happily as on a gaming PC. What it does
 * is real perspective: object rotation, a pinhole camera, painter-sorted
 * triangles, affine-textured quads and a light direction.
 *
 * A textured triangle is drawn by clipping to it and applying the 2x3 matrix
 * that maps the texture's triangle onto the screen's. Perspective makes that
 * mapping wrong in the middle of a large quad, which is why every panel is cut
 * into a grid of smaller quads first - the error is proportional to quad size,
 * and at this size it is not visible.
 */

import { panelsFor } from './model3d.js';
import { enclosedHoles, cavityShade } from './coverage.js';

const RAD = Math.PI / 180;

/**
 * The largest enclosed backdrop region the gap pass will paint, in DEVICE
 * pixels of the preview canvas. Anything bigger is an opening - the neck, a
 * sleeve seen end-on, the air under a raised arm - and pretending otherwise
 * paints a dark slab where the player expects to see through.
 *
 * 600 is about a 25x25 square: comfortably a seam crack or a pinhole, and an
 * order of magnitude below the neck opening of a garment that fills the panel.
 */
const MAX_HOLE_AREA_PX = 600;

/** Cap on the long side of the coverage mask, which is the garment's projected
 *  box. The box normally fits inside this and the mask runs at full device
 *  resolution, which is the only way a one-pixel seam crack can be seen at all.
 *  A garment that fills an unusually large panel is scaled down instead, and the
 *  fill is smoothed back up - a cavity is soft, so that costs very little. */
const MASK_LONG_SIDE = 512;

/**
 * The studio backdrop, in one place. render() fills with it and _fillGaps()
 * checks against it before painting anything, so the two cannot drift apart and
 * leave the pass filling pixels that were never backdrop.
 */
const BACKDROP = '#c2ccd3';
const BACKDROP_RGB = [194, 204, 211];
// Roughly along the default camera, so the face you are looking at comes out
// white and only the sides fall away. The old [0.35,0.55,0.9] peaked at 0.72 on
// every panel, which is why the garment read as dark whatever the shading did.
const LIGHT = norm3([0.14, 0.24, 0.96]);

function norm3(v) {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

function dot3(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
function sub3(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function add3(a, b) {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}
function cross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function lerp3(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}
function bilerp(c, u, v) {
  return lerp3(lerp3(c[0], c[1], u), lerp3(c[3], c[2], u), v);
}

/** Roll about Z, pitch about X, yaw about Y - in that order. */
function orient(p, yaw, pitch, roll) {
  let [x, y, z] = p;
  // A panel with no rotation still has to come back as numbers: the guards
  // below skip the maths when an angle is zero, and a caller that measures the
  // result would otherwise see NaN.
  if (!x && !y && !z) return [0, 0, 0];
  if (roll) {
    const c = Math.cos(roll * RAD);
    const s = Math.sin(roll * RAD);
    const nx = x * c - y * s;
    y = x * s + y * c;
    x = nx;
  }
  if (pitch) {
    const c = Math.cos(pitch * RAD);
    const s = Math.sin(pitch * RAD);
    const ny = y * c - z * s;
    z = y * s + z * c;
    y = ny;
  }
  if (yaw) {
    const c = Math.cos(yaw * RAD);
    const s = Math.sin(yaw * RAD);
    const nx = x * c + z * s;
    z = -x * s + z * c;
    x = nx;
  }
  return [x, y, z];
}

export class Preview3D {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {(faceId:string)=>HTMLCanvasElement|null} texture  face id -> its pixels
   */
  constructor(canvas, texture, outline) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.texture = texture;
    this.outline = outline;
    this.yaw = -24;
    this.pitch = 14;
    this.zoom = 1;
    this.radius = 1;
    this._tris = [];
    this._cache = new Map();
    this._dirty = true;
    // Set from CONFIG.d3.gapFill by the app. A property rather than an import so
    // the renderer stays testable and the switch stays a single place; `?gapFill=0`
    // renders the same frame without the pass, which is what makes the two
    // comparable pixel for pixel.
    this.gapFill = true;
  }

  /**
   * Build the triangle list for an item.
   * @param {{id:string,faces:Array}} item
   * @returns {number} triangles
   */
  /**
   * Use a real garment mesh for the next build. Pass null to go back to the
   * flat panel schematic, which is all furniture and the book have.
   * @param {{pos:Float32Array,nrm:Float32Array,uv:Float32Array,idx:Uint16Array,faces:string[],tris:number}|null} mesh
   */
  setMesh(mesh) {
    this.mesh = mesh;
    this._cache.clear();
    this._dirty = true;
  }

  /**
   * The garment as art-pia's fabric simulation made it: about 1,400 triangles,
   * each already carrying the face it samples and the mesh's own normal.
   *
   * Nothing is subdivided here, unlike the panels. The affine texture error is
   * proportional to triangle size and these are already small, which is the
   * whole reason the real mesh is worth shipping.
   */
  _buildMesh(item) {
    const m = this.mesh;
    const tris = [];
    // Mesh units are roughly one unit across a body; the rest of this renderer
    // counts in paint cells, and the camera's near limit is written in them.
    const S = 100;
    for (let t = 0; t < m.tris; t++) {
      const ia = m.idx[t * 4];
      const ib = m.idx[t * 4 + 1];
      const ic = m.idx[t * 4 + 2];
      const faceId = m.faces[m.idx[t * 4 + 3]];
      const face = item.faces.find((f) => f.id === faceId) || item.faces[0];
      if (!face) continue;
      const a = [m.pos[ia * 3] * S, m.pos[ia * 3 + 1] * S, m.pos[ia * 3 + 2] * S];
      const b = [m.pos[ib * 3] * S, m.pos[ib * 3 + 1] * S, m.pos[ib * 3 + 2] * S];
      const c = [m.pos[ic * 3] * S, m.pos[ic * 3 + 1] * S, m.pos[ic * 3 + 2] * S];
      const n = [
        (m.nrm[ia * 3] + m.nrm[ib * 3] + m.nrm[ic * 3]) / 3,
        (m.nrm[ia * 3 + 1] + m.nrm[ib * 3 + 1] + m.nrm[ic * 3 + 1]) / 3,
        (m.nrm[ia * 3 + 2] + m.nrm[ib * 3 + 2] + m.nrm[ic * 3 + 2]) / 3,
      ];
      // The three vertex normals as well as their average. One shade per
      // triangle is what makes a 1,350-triangle garment look like folded card:
      // the mesh's normals are already smooth (shared per vertex, rebuilt after
      // relaxing), so the brightness genuinely differs between a triangle's own
      // corners and interpolating it is free detail the average throws away.
      const vn = [
        [m.nrm[ia * 3], m.nrm[ia * 3 + 1], m.nrm[ia * 3 + 2]],
        [m.nrm[ib * 3], m.nrm[ib * 3 + 1], m.nrm[ib * 3 + 2]],
        [m.nrm[ic * 3], m.nrm[ic * 3 + 1], m.nrm[ic * 3 + 2]],
      ];
      const tex = this._texFor(face);
      const facing = Math.abs(dot3(norm3(n), LIGHT));
      const lit = 0.66 + 0.34 * facing;
      // The mesh's UV is u = x/w and v = 1 - y/h in cells, so the texture row
      // is (1 - v) * h: the paint grid counts down from the top of the face.
      const ua = [m.uv[ia * 2] * face.w, (1 - m.uv[ia * 2 + 1]) * face.h];
      const ub = [m.uv[ib * 2] * face.w, (1 - m.uv[ib * 2 + 1]) * face.h];
      const uc = [m.uv[ic * 2] * face.w, (1 - m.uv[ic * 2 + 1]) * face.h];
      // `two` marks a triangle that must be drawn from both sides: see the cull
      // note in draw() for why a cloth shell needs that.
      const tri = { a, b, c, u: ua, v: ub, w2: uc, tex, lit, loop: null, face: face.id, n, vn, two: true };
      tris.push(tri);
    }
    this.radius = Math.max(1, m.half * S);
    this._tris = tris;
    this._dirty = true;
    return tris.length;
  }

  build(item) {
    if (this.mesh) return this._buildMesh(item);
    const panels = panelsFor(item.id) || fallbackPanels(item.faces);
    const tris = [];
    let radius = 1;
    for (const p of panels) {
      const face = item.faces.find((f) => f.id === p.face) || item.faces[0];
      if (!face) continue;
      const fw = (face.w * p.scale) / 2;
      const fh = (face.h * p.scale) / 2;
      const corners = [
        [-fw, -fh, 0],
        [fw, -fh, 0],
        [fw, fh, 0],
        [-fw, fh, 0],
      ].map((v) => add3(orient(v, p.yaw, p.pitch, p.roll), p.pos));
      const normal = norm3(cross(sub3(corners[1], corners[0]), sub3(corners[2], corners[0])));
      const tex = this._texFor(face);
      // Half of the face's own cell grid, at least 3 cuts: enough that the
      // affine approximation stays under half a pixel of error.
      const n = Math.max(3, Math.min(8, Math.round(Math.max(fw, fh) / 10)));
      // White cloth under warm light: a face turned away from the lamp is grey,
      // never brown. The old 0.62 floor multiplied a near-black shade into the
      // pixels and turned the whole garment dark green.
      const facing = Math.abs(dot3(normal, LIGHT));
      // Two thirds of the brightness comes from the paint itself, so a white
      // face stays brighter than the backdrop at every angle instead of sinking
      // into it as the panel turns.
      const lit = 0.66 + 0.34 * facing;
      // The silhouette rides along as a polygon in model space and is clipped
      // once per panel at draw time. Cutting the quad grid to one quad per cell
      // would need 15,000+ triangles on a dress, and every triangle repaints the
      // whole face texture, which is more than this preview is worth.
      const loop = this._loopFor(item.id, face, p, corners);
      for (let iy = 0; iy < n; iy++) {
        for (let ix = 0; ix < n; ix++) {
          const u0 = ix / n;
          const u1 = (ix + 1) / n;
          const v0 = iy / n;
          const v1 = (iy + 1) / n;
          // The face id travels with the triangle so the texture can be re-baked
          // in place when the paint changes.
          // v is measured up the panel from its bottom edge, and the paint grid
          // counts rows down from the top of the face, so the row is (1 - v) * h.
          const ty = (vv) => (1 - vv) * face.h;
          tri(tris, bilerp(corners, u0, v0), bilerp(corners, u1, v0), bilerp(corners, u1, v1),
            [u0 * face.w, ty(v0)], [u1 * face.w, ty(v0)], [u1 * face.w, ty(v1)], tex, lit, loop, face.id, normal);
          tri(tris, bilerp(corners, u0, v0), bilerp(corners, u1, v1), bilerp(corners, u0, v1),
            [u0 * face.w, ty(v0)], [u1 * face.w, ty(v1)], [u0 * face.w, ty(v1)], tex, lit, loop, face.id, normal);
        }
      }
      for (const v of corners) radius = Math.max(radius, Math.hypot(v[0], v[1], v[2]));
    }
    this.radius = radius;
    this._tris = tris;
    this._dirty = true;
    return tris.length;
  }

  /** The face silhouette, mapped into the panel's model-space plane. */
  _loopFor(itemId, face, p, corners) {
    if (!this.outline) return null;
    const o = this.outline(itemId, face.id);
    // outlineFor() hands back { w, h, ring } in cell coordinates.
    if (!o || !Array.isArray(o.ring) || o.ring.length < 3) return null;
    const ux = [(corners[1][0] - corners[0][0]) / face.w, (corners[1][1] - corners[0][1]) / face.w, (corners[1][2] - corners[0][2]) / face.w];
    const uy = [(corners[3][0] - corners[0][0]) / face.h, (corners[3][1] - corners[0][1]) / face.h, (corners[3][2] - corners[0][2]) / face.h];
    return o.ring.map((pt) => [
      corners[0][0] + pt[0] * ux[0] + pt[1] * uy[0],
      corners[0][1] + pt[0] * ux[1] + pt[1] * uy[1],
      corners[0][2] + pt[0] * ux[2] + pt[1] * uy[2],
    ]);
  }

  _texFor(face) {
    // Cache by face id; the caller invalidates by clearing the cache.
    if (!this._cache.has(face.id)) this._cache.set(face.id, this.texture(face.id));
    return this._cache.get(face.id);
  }

  /** Forget the baked textures so the next build pulls fresh ones. */
  invalidate() {
    this._cache.clear();
    this._dirty = true;
  }

  /**
   * Unwind the canvas state after a draw died partway through a triangle.
   *
   * A textured triangle saves, clips to itself, paints, and restores. If
   * something throws between the clip and the restore - a texture that went
   * away, a context the browser took back - the clip stays live, and a clip is
   * part of the state stack: setTransform does not clear it and neither does
   * clearing the bitmap. Every frame after that paints inside one dead
   * triangle, so the preview looks permanently broken even though the loop
   * restarted happily. Re-assigning the size is the only thing that resets the
   * stack, and it is cheap enough to be worth doing on a path that only runs
   * when something already went wrong.
   */
  resetState() {
    const cv = this.canvas;
    // Step the size and come back, so the reset does not depend on whether this
    // engine treats assigning the same width as a no-op.
    cv.width = cv.width + 1;
    cv.height = cv.height + 1;
    cv.width = cv.width - 1;
    cv.height = cv.height - 1;
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this._dirty = true;
  }

  /**
   * Re-bake every face texture from the live grid.
   *
   * Clearing the cache alone is not enough: each triangle already holds the
   * canvas it was built from, so a stroke would only show up after a full
   * rebuild. This swaps the texture in place, which is cheap enough to run on
   * every paint.
   */
  refresh() {
    this._cache.clear();
    for (const t of this._tris) {
      if (!this._cache.has(t.face)) this._cache.set(t.face, this.texture(t.face));
      const tex = this._cache.get(t.face);
      if (tex) t.tex = tex;
    }
    this._dirty = true;
  }

  /**
   * Repaint, but only when something actually moved.
   *
   * A garment is a thousand-odd textured triangles and costs about 14 ms, so a
   * loop that repaints an unchanged view throws away the frame budget on every
   * idle tick. Anything that can change the picture marks it dirty instead.
   */
  markDirty() {
    this._dirty = true;
  }

  render(force) {
    if (!force && !this._dirty) return;
    this._dirty = false;
    const cv = this.canvas;
    const ctx = this.ctx;
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    const rect = cv.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width * dpr));
    const h = Math.max(1, Math.round(rect.height * dpr));
    if (cv.width !== w || cv.height !== h) {
      cv.width = w;
      cv.height = h;
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    // Studio backdrop, a mid grey. It has to sit *between* the garment's two
    // extremes: a face square to the lamp measures about 235 and a turned one
    // about 160, so a backdrop at 202 makes the lit side read white and the
    // shaded side read solid. Near-white here made the whole garment look grey.
    ctx.fillStyle = BACKDROP;
    ctx.fillRect(0, 0, w, h);
    if (!this._tris.length) return;

    // Frame the model, don't just pick a distance. At cell units a garment
    // radius is 100-200 while the old fixed focal put it at 2-3% of the panel,
    // which is why the preview looked like a speck on a grey field.
    //
    // Fit against the model's own box, not a bounding sphere: a dress is 168
    // cells wide and a trousers face is 116 tall, and a single radius would
    // leave one of them stranded in the middle of the panel.
    // Fit against the model's axis-aligned box, not a bounding sphere: a dress
    // is 168 cells wide and a trousers face is 116 tall, and one shared radius
    // would leave whichever axis is shorter stranded in the middle.
    //
    // Read the triangle list locally. this._tris is only assigned at the end of
    // build(), so a first render before any build would size the focal off an
    // empty box.
    const tris = this._tris;
    const ext = this._aabb(tris);
    // Far enough back that the near edge of the model is not clipped by the
    // camera's minimum depth.
    // ext.z is the front of the model toward the camera, so the camera has to
    // sit behind it by more than the near-plane limit.
    const dist = Math.max(ext.z + 2 + Math.hypot(ext.x, ext.y) * 1.15, 1);
    const focal = Math.min(
      (0.85 * w) / (2 * ext.x),
      (0.85 * h) / (2 * ext.y)
    ) * dist * this.zoom;
    const view = [];
    for (const t of this._tris) {
      // There is no back-face culling here, deliberately. It used to skip any
      // triangle pointing away from the camera, on the assumption that a garment
      // is a closed solid and half of it is wasted work. It is not closed: the
      // mesh art-pia ships is a single cloth shell, because the lining is a
      // separate group that baking drops - so the away-facing half was the only
      // thing covering the neck, cuffs and hem, and culling it turned every
      // opening into a window onto the backdrop. That is what "holes" was.
      //
      // Everything is drawn and the painter sort below decides what wins, which
      // is the correct answer for a shell. Lighting already used abs(dot), so an
      // inside face is shaded rather than black. The cost is roughly twice the
      // triangles per frame, measured in tools/perf.mjs.
      const p = this._project(t.a, dist, focal, w, h, ext);
      if (!p) continue;
      const q = this._project(t.b, dist, focal, w, h, ext);
      const r = this._project(t.c, dist, focal, w, h, ext);
      if (!q || !r) continue;
      // Shade from the oriented normal, every frame. The value baked at build
      // time dotted the mesh's model-space normal with LIGHT, but LIGHT is a
      // view-space direction (panels dot it with an already-oriented normal and
      // are right). The result was a lamp welded to the garment: orbiting did not
      // move the light at all, so the shirt kept whatever brightness it happened
      // to have when it was built and read as scattered grey plateaus rather than
      // cloth turning under a light.
      //
      // This is one orient and one dot per triangle, which is not what the frame
      // costs; tools/perf.mjs measures it.
      let lit = t.lit;
      let lits = null;
      // Which way is this triangle pointing, now that the model has been turned?
      // The camera looks down -z and _project reports depth as `dist - z`, so a
      // larger view-space z is nearer. A triangle whose oriented normal has
      // positive z faces the camera.
      const nz = t.n ? orient(t.n, this.yaw, this.pitch, 0)[2] : 0;
      const front = nz >= 0;
      if (t.vn) {
        // Per-corner brightness, so the overlay can interpolate across the face
        // instead of stamping one flat value onto it.
        lits = [0, 1, 2].map((k) => 0.66 + 0.34 * Math.abs(dot3(norm3(orient(t.vn[k], this.yaw, this.pitch, 0)), LIGHT)));
        lit = (lits[0] + lits[1] + lits[2]) / 3;
      } else if (t.n) {
        lit = 0.66 + 0.34 * Math.abs(dot3(norm3(orient(t.n, this.yaw, this.pitch, 0)), LIGHT));
      }
      // The inside of a cloth shell is in shadow. A garment is one surface, so
      // the lining is the same triangles seen from behind, and shading them by
      // the same rule as the outside made the inside of a sleeve read as a
      // second, brighter copy of the paint - which is most of what looked like
      // seeing through the garment.
      if (!front) {
        lit *= 0.78;
        if (lits) lits = lits.map((l) => l * 0.78);
      }
      // The sort key must be measured in the space the camera looks through.
      // This used to be (a2+b2+c2)/3, the model's own z captured at build time,
      // so orbiting never reordered anything: at yaw -24 (the default view) a
      // panel's model z and its screen depth differ by its x, which on a dress
      // is 84 cells - more than twice the garment's whole depth. Far surfaces
      // painted over near ones and the preview looked see-through, "wall hack"
      // exactly. p[2] is the oriented z that _project already computed.
      view.push({ t, p, q, r, z: (p[2] + q[2] + r[2]) / 3, lit, lits, front });
    }
    // Two passes, back-facing triangles first, then front-facing, each painted
    // far to near. A garment is a single open shell, so the away-facing half is
    // what covers the neck, cuffs and hem from the inside - it must be drawn,
    // and drawing it first is what stops the lining showing through the front.
    view.sort((a, b) => (a.front === b.front ? a.z - b.z : a.front ? 1 : -1));
    // The frame's final draw order, kept for tests and tools. `view` is already
    // built per frame, so this holds a reference rather than copying anything.
    this._drawn = view;
    ctx.imageSmoothingEnabled = false;
    // A panel is flat but rotated, so its triangles sit at different depths and
    // interleave with other panels in the sort. The silhouette therefore has to
    // be clipped per triangle, not per panel. Each ring is projected once per
    // frame and reused.
    const clips = new Map();
    // The bleed has to be a fraction of a DEVICE pixel, not of a CSS one: the
    // crack between two clipped fills is one device pixel wide at any dpr, and
    // 0.34 device pixels was too thin to cover it on the dpr 2-3 screens where
    // the seams showed as hairlines.
    const bleed = 0.45 + 0.18 * dpr;
    for (const v of view) {
      const loop = v.t.loop;
      if (!loop) {
        // Mesh triangles bleed into their neighbours to hide the seam cracks;
        // panels are clipped to the face outline and must not cross it.
        drawTri(ctx, v.p, v.q, v.r, v.t.u, v.t.v, v.t.w2, v.t.tex, v.lit, v.t.two ? bleed : 0, v.lits);
        continue;
      }
      let pts = clips.get(loop);
      if (!pts) {
        pts = loop.map((p) => this._project(p, dist, focal, w, h, ext));
        if (pts.some((p) => !p)) pts = null;
        clips.set(loop, pts);
      }
      if (!pts) continue;
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
      ctx.closePath();
      ctx.clip();
      drawTri(ctx, v.p, v.q, v.r, v.t.u, v.t.v, v.t.w2, v.t.tex, v.lit);
      ctx.restore();
    }
    this._fillGaps(ctx, w, h, bleed);
  }

  /**
   * Paint the backdrop that is trapped inside the garment.
   *
   * The shell is open, so the renderer draws both of its faces and the painter
   * sort picks what wins. That is right for a shell and still leaves small
   * islands of backdrop sealed inside the silhouette where two panels fail to
   * meet - they drift as you orbit, and they are what reads as "holes in the
   * clothing". Sealing them in the mesh was measured and rejected (see
   * game/coverage.js), so this fixes it per frame, in the one place that knows
   * what the camera is doing.
   *
   * Coverage comes from the geometry, never from the colour: the backdrop is
   * #c2ccd3 and the garment's own shading passes straight through that value, so
   * colour-matching the background finds shadow bands on cloth and would paint
   * them darker. Drawing the triangles solid into a small mask cannot lie.
   */
  _fillGaps(ctx, w, h, bleed) {
    const view = this._drawn;
    if (!view || !view.length) return;
    if (!this.gapFill) {
      this._gapPx = 0;
      this._gapFound = 0;
      this._gapSkipped = 'off';
      return;
    }
    // Three offscreen canvases, so this needs a DOM. The Node tests drive the
    // painter sort and the lining shading through a stubbed context and never
    // look at pixels, and the rule itself is pure - it lives in game/coverage.js
    // with its own tests. What the pass is *for* is measured in a browser, by
    // tools/meshholes.mjs, which counts trapped backdrop pixels before and after.
    if (typeof document === 'undefined') {
      this._gapPx = 0;
      this._gapSkipped = 'no dom';
      return;
    }
    // Work over the garment's projected box at full device resolution, not the
    // whole panel at a reduced one. The first version did the latter and left
    // about a third of the defect standing: the worst remaining holes were single
    // backdrop pixels - hairline cracks between two mesh triangles - and at 0.46
    // scale a single device pixel is not even one mask pixel, so the pass could
    // not see the thing it exists to fix. The box is usually well under half the
    // panel, which pays for the resolution.
    let x0 = w;
    let y0 = h;
    let x1 = 0;
    let y1 = 0;
    for (const v of view) {
      for (const p of [v.p, v.q, v.r]) {
        if (p[0] < x0) x0 = p[0];
        if (p[0] > x1) x1 = p[0];
        if (p[1] < y0) y0 = p[1];
        if (p[1] > y1) y1 = p[1];
      }
    }
    x0 = Math.max(0, Math.floor(x0) - 1);
    y0 = Math.max(0, Math.floor(y0) - 1);
    x1 = Math.min(w, Math.ceil(x1) + 1);
    y1 = Math.min(h, Math.ceil(y1) + 1);
    const bw = x1 - x0;
    const bh = y1 - y0;
    if (bw < 3 || bh < 3) return;
    const k = Math.min(1, MASK_LONG_SIDE / Math.max(bw, bh));
    const mw = Math.max(1, Math.round(bw * k));
    const mh = Math.max(1, Math.round(bh * k));
    if (mw < 3 || mh < 3) return;

    // 1. coverage, at mask resolution, from the same projected triangles the
    // frame was drawn with. The mask has to agree with the frame about what is
    // cloth: narrower than the frame and this pass paints shadow onto cloth,
    // wider than the frame and the cracks it cannot see stay open.
    const covC = this._covC || (this._covC = document.createElement('canvas'));
    if (covC.width !== mw || covC.height !== mh) {
      covC.width = mw;
      covC.height = mh;
    }
    const cc = covC.getContext('2d');
    cc.setTransform(k, 0, 0, k, -x0 * k, -y0 * k);
    cc.clearRect(0, 0, mw, mh);
    // Rebuild the frame's own geometry, bleed and all, rather than approximating
    // it with a stroke. Stroking by a fixed width dilated the mask slightly more
    // than the frame bleeds, so the two-pixel specks that were left standing at
    // full resolution were invisible to the mask that was supposed to find them.
    // The degenerate-area test is copied for the same reason: a sliver the frame
    // skips must be skipped here too, or its backdrop is never counted as a hole.
    cc.fillStyle = '#fff';
    for (const v of view) {
      let p = v.p;
      let q = v.q;
      let r = v.r;
      const area = (q[0] - p[0]) * (r[1] - p[1]) - (r[0] - p[0]) * (q[1] - p[1]);
      if (Math.abs(area) < 1e-4) continue;
      if (v.t.two && bleed) {
        const cx = (p[0] + q[0] + r[0]) / 3;
        const cy = (p[1] + q[1] + r[1]) / 3;
        const rad =
          (Math.hypot(p[0] - cx, p[1] - cy) + Math.hypot(q[0] - cx, q[1] - cy) + Math.hypot(r[0] - cx, r[1] - cy)) / 3;
        const e = 1 + bleed / Math.max(rad, bleed);
        p = [cx + (p[0] - cx) * e, cy + (p[1] - cy) * e];
        q = [cx + (q[0] - cx) * e, cy + (q[1] - cy) * e];
        r = [cx + (r[0] - cx) * e, cy + (r[1] - cy) * e];
      }
      cc.beginPath();
      cc.moveTo(p[0], p[1]);
      cc.lineTo(q[0], q[1]);
      cc.lineTo(r[0], r[1]);
      cc.closePath();
      cc.fill();
    }
    const covImg = cc.getImageData(0, 0, mw, mh).data;
    const n = mw * mh;
    // Reused between frames, because the box size jitters by a pixel as the
    // model settles and allocating a coverage array per frame is work nobody
    // asked for. `let`, not `const`: the first version declared it const and
    // reassigned it, which threw the moment the box changed size - frame 1 was
    // fine, frame 2 killed the preview, and the only trace was a toast.
    let cov = this._cov;
    if (!cov || cov.length !== n) {
      cov = new Uint8Array(n);
      this._cov = cov;
    }
    for (let i = 0; i < n; i++) cov[i] = covImg[i * 4 + 3] > 127 ? 1 : 0;

    // 2. the rule. The area limit is stated in device pixels and converted, so
    // the threshold means the same thing whatever the mask scale works out at.
    const maxFill = Math.max(2, Math.round(MAX_HOLE_AREA_PX * k * k));
    const holes = enclosedHoles(cov, mw, mh, maxFill);
    // Found vs painted: the difference is what the frame check below refused, and
    // it is the number that says whether this pass is guessing or measuring.
    this._gapFound = holes.px;
    this._gapIslands = holes.holes;
    this._gapKept = holes.kept;
    if (!holes.px) {
      this._gapPx = 0;
      return;
    }

    // 3. the colour of the cloth each hole pixel leans on, read from the frame
    // that was just finished - so it is the painted garment's own shade, tint and
    // all, not an approximation of it.
    const colC = this._colC || (this._colC = document.createElement('canvas'));
    if (colC.width !== mw || colC.height !== mh) {
      colC.width = mw;
      colC.height = mh;
    }
    const lc = colC.getContext('2d');
    lc.setTransform(1, 0, 0, 1, 0, 0);
    lc.clearRect(0, 0, mw, mh);
    lc.drawImage(this.canvas, x0, y0, bw, bh, 0, 0, mw, mh);
    const frame = lc.getImageData(0, 0, mw, mh).data;

    // 4. build the fill at mask scale, then scale it up with smoothing. A hard
    // upscale would put a blocky dark wart where a crack used to be.
    const fillC = this._fillC || (this._fillC = document.createElement('canvas'));
    if (fillC.width !== mw || fillC.height !== mh) {
      fillC.width = mw;
      fillC.height = mh;
    }
    const fc = fillC.getContext('2d');
    const out = fc.createImageData(mw, mh);
    const od = out.data;
    let painted = 0;
    for (let p = 0; p < n; p++) {
      if (!holes.fill[p]) continue;
      const s = holes.src[p] * 4;
      const o = p * 4;
      // Geometry says hole; the frame says whether it really is. The bleed is a
      // sub-pixel guess in both passes, and a mask that is slightly wider than
      // what was painted would otherwise put a dark pixel on cloth. The backdrop
      // is a flat fill, so this test is exact, and it can only ever skip a fill.
      if (
        Math.abs(frame[o] - BACKDROP_RGB[0]) > 4 ||
        Math.abs(frame[o + 1] - BACKDROP_RGB[1]) > 4 ||
        Math.abs(frame[o + 2] - BACKDROP_RGB[2]) > 4
      )
        continue;
      const sh = cavityShade(holes.dist[p]);
      od[o] = frame[s] * sh;
      od[o + 1] = frame[s + 1] * sh;
      od[o + 2] = frame[s + 2] * sh;
      od[o + 3] = 255;
      painted++;
    }
    this._gapPx = painted;
    fc.putImageData(out, 0, 0);
    if (!painted) return;

    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(fillC, 0, 0, mw, mh, x0, y0, bw, bh);
    ctx.restore();
  }

  _project(p, dist, focal, w, h, off) {
    const [x, y, z] = orient(p, this.yaw, this.pitch, 0);
    const depth = dist - z;
    if (depth < 1) return null;
    const f = focal / depth;
    // Centre the model's own box, not the origin: sleeves and hems sit far off
    // centre, and framing the origin left the garment stranded in a corner.
    return [w / 2 + (x - off.cx) * f, h / 2 - (y - off.cy) * f, z];
  }

  /**
   * The model's axis-aligned box in view space. Framing needs each axis on its
   * own: a garment that is wide and shallow has to be fitted by its width, not
   * by the largest distance from the centre.
   */
  _aabb(tris) {
    let mx = -Infinity;
    let nx = Infinity;
    let my = -Infinity;
    let ny = Infinity;
    let mz = -Infinity;
    let nz = Infinity;
    let seen = 0;
    for (const t of tris) {
      for (const v of [t.a, t.b, t.c]) {
        // orient() returns [x, y, z] with y up; the camera looks down z.
        const [px, py, depth] = orient(v, this.yaw, this.pitch, 0);
        if (!Number.isFinite(px) || !Number.isFinite(py) || !Number.isFinite(depth)) continue;
        seen++;
        mx = Math.max(mx, px);
        nx = Math.min(nx, px);
        my = Math.max(my, py);
        ny = Math.min(ny, py);
        mz = Math.max(mz, depth);
        nz = Math.min(nz, depth);
      }
    }
    if (!seen) return { x: 1, y: 1, z: 0, cx: 0, cy: 0, cz: 0 };
    return {
      x: Math.max((mx - nx) / 2, 1),
      y: Math.max((my - ny) / 2, 1),
      cx: (mx + nx) / 2,
      cy: (my + ny) / 2,
      // Depth is not framed, only kept clear of the camera's near limit.
      z: Math.max(mz - nz, 0),
      cz: (mz + nz) / 2,
    };
  }

  orbit(dx, dy) {
    this.yaw += dx * 0.45;
    this.pitch = Math.max(-85, Math.min(85, this.pitch - dy * 0.45));
    this._dirty = true;
  }

  setZoom(z) {
    this.zoom = Math.max(0.3, Math.min(3.5, z));
    this._dirty = true;
  }

  reset() {
    this.yaw = -24;
    this.pitch = 14;
    this.zoom = 1;
    this._dirty = true;
  }
}

function tri(tris, a, b, c, u, v, w2, tex, lit, loop, faceId, n) {
  tris.push({ a, b, c, u, v, w2, tex, lit, loop: loop || null, face: faceId, n: n || null });
}

/* ---------------- triangle rasteriser ---------------- */

function drawTri(ctx, p, q, r, u, v, w2, tex, lit, bleed, lits) {
  if (!tex) return;
  // A triangle with no area cannot be mapped, but the threshold has to be near
  // nothing: at a steep orbit a whole band of the sleeve projects to slivers of a
  // hundredth of a pixel, and skipping them punched the holes the old counts
  // showed growing with angle. Only truly degenerate ones are dropped.
  const area = (q[0] - p[0]) * (r[1] - p[1]) - (r[0] - p[0]) * (q[1] - p[1]);
  if (Math.abs(area) < 1e-4) return;
  if (bleed) {
    // Neighbouring triangles share an exact edge, and two independently clipped
    // fills leave a hairline of backdrop along it. Push each vertex out from the
    // centroid by `bleed` device pixels so neighbours overlap and the seam is
    // covered. The affine mapping below is left alone, so this stretches the
    // texture by well under a pixel - invisible, and the only way to hide it.
    // `bleed` comes from the caller because the crack is a DEVICE pixel wide:
    // a fixed CSS-pixel fraction was too thin on a dpr-3 screen.
    const cx = (p[0] + q[0] + r[0]) / 3;
    const cy = (p[1] + q[1] + r[1]) / 3;
    const rad = (Math.hypot(p[0] - cx, p[1] - cy) + Math.hypot(q[0] - cx, q[1] - cy) + Math.hypot(r[0] - cx, r[1] - cy)) / 3;
    const k = 1 + bleed / Math.max(rad, bleed);
    p = [cx + (p[0] - cx) * k, cy + (p[1] - cy) * k];
    q = [cx + (q[0] - cx) * k, cy + (q[1] - cy) * k];
    r = [cx + (r[0] - cx) * k, cy + (r[1] - cy) * k];
  }
  const du1 = v[0] - u[0];
  const dv1 = v[1] - u[1];
  const du2 = w2[0] - u[0];
  const dv2 = w2[1] - u[1];
  const det = du1 * dv2 - du2 * dv1;
  if (Math.abs(det) < 1e-9) return;
  const dx1 = q[0] - p[0];
  const dy1 = q[1] - p[1];
  const dx2 = r[0] - p[0];
  const dy2 = r[1] - p[1];
  const m11 = (dx1 * dv2 - dx2 * dv1) / det;
  const m12 = (dy1 * dv2 - dy2 * dv1) / det;
  const m21 = (dx2 * du1 - dx1 * du2) / det;
  const m22 = (dy2 * du1 - dy1 * du2) / det;
  const e = p[0] - m11 * u[0] - m21 * u[1];
  const f = p[1] - m12 * u[0] - m22 * u[1];

  path(ctx, p, q, r);
  ctx.save();
  ctx.clip();
  ctx.setTransform(m11, m12, m21, m22, e, f);
  // One path serves both the clip and the shading fill below. The current path is
  // not part of the canvas state, so it survives save/restore and can be filled
  // again once the clip is off - tracing it twice per triangle was 1,350
  // redundant path constructions a frame.
  ctx.drawImage(tex, 0, 0);
  ctx.restore();

  // Grey, not brown: multiply-style darkening of a white garment has to stay
  // neutral or the model reads as the wrong colour entirely.
  if (lits && Math.abs(area) > 70) {
    // Interpolate the shade across the triangle. One flat value per triangle is
    // what a 1,350-triangle mesh looks like: folded card, with a visible edge at
    // every seam, because the brightness jumps instead of rolling. The mesh's own
    // normals are smooth, so the three corners really do have three different
    // brightnesses and the field between them is linear - which is exactly what a
    // canvas gradient is.
    //
    // The construction: find the corner whose brightness lies between the other
    // two, and the point on the opposite edge that shares it. The line through
    // those two is an iso-brightness line, so the brightness axis is perpendicular
    // to it, and the two extreme corners project onto that axis as the gradient's
    // endpoints.
    // The extremes have to be found among all three corners. Comparing only
    // corners 0 and 2 and calling the remaining one the middle is wrong whenever
    // corner 1 is the brightest or the darkest, and then the axis, the iso point
    // and both colour stops are all wrong - which made the surface more faceted
    // than flat shading, not less.
    let iA = 0;
    let iC = 0;
    for (const k of [1, 2]) {
      if (lits[k] < lits[iA]) iA = k;
      if (lits[k] > lits[iC]) iC = k;
    }
    // The three indices are 0, 1 and 2, so the one that is neither extreme is
    // whatever is left. Only meaningful once the corners actually differ, checked
    // by the span below.
    const iB = 3 - iA - iC;
    const span = lits[iC] - lits[iA];
    if (span < 0.004) {
      ctx.fillStyle = `rgba(0,0,0,${(1 - lit).toFixed(3)})`;
      ctx.fill();
    } else {
      const pts = [p, q, r];
      const B = pts[iB];
      const t = (lits[iB] - lits[iA]) / span;
      const dx = pts[iA][0] + (pts[iC][0] - pts[iA][0]) * t - B[0];
      const dy = pts[iA][1] + (pts[iC][1] - pts[iA][1]) * t - B[1];
      const len = Math.hypot(dx, dy) || 1;
      // Perpendicular to the iso line: that is the direction brightness changes in.
      const gx = -dy / len;
      const gy = dx / len;
      const s0 = (pts[iA][0] - B[0]) * gx + (pts[iA][1] - B[1]) * gy;
      const s1 = (pts[iC][0] - B[0]) * gx + (pts[iC][1] - B[1]) * gy;
      // Whichever extreme projects lower on the axis carries the darker corner.
      const first = s0 <= s1 ? iA : iC;
      const last = s0 <= s1 ? iC : iA;
      const lo = Math.min(s0, s1);
      const hi = Math.max(s0, s1);
      const g = ctx.createLinearGradient(B[0] + lo * gx, B[1] + lo * gy, B[0] + hi * gx, B[1] + hi * gy);
      g.addColorStop(0, `rgba(0,0,0,${(1 - lits[first]).toFixed(3)})`);
      g.addColorStop(1, `rgba(0,0,0,${(1 - lits[last]).toFixed(3)})`);
      ctx.fillStyle = g;
      ctx.fill();
    }
  } else if (lit < 1) {
    ctx.fillStyle = `rgba(0,0,0,${(1 - lit).toFixed(3)})`;
    ctx.fill();
  }
}

function path(ctx, p, q, r) {
  ctx.beginPath();
  ctx.moveTo(p[0], p[1]);
  ctx.lineTo(q[0], q[1]);
  ctx.lineTo(r[0], r[1]);
  ctx.closePath();
}

/** An item with no model gets its faces laid out in a row, so 3D still shows something. */
function fallbackPanels(faces) {
  const gap = 10;
  let x = 0;
  return faces.map((f) => {
    const p = { face: f.id, pos: [x + f.w / 2, 0, 0], yaw: 0, pitch: 0, roll: 0, scale: 1 };
    x += f.w + gap;
    return p;
  });
}
