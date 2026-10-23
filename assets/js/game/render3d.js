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

const RAD = Math.PI / 180;
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
      const tri = { a, b, c, u: ua, v: ub, w2: uc, tex, lit, loop: null, face: face.id, a2: a[2], b2: b[2], c2: c[2], n, two: true };
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
            [u0 * face.w, ty(v0)], [u1 * face.w, ty(v0)], [u1 * face.w, ty(v1)], tex, lit, loop, face.id);
          tri(tris, bilerp(corners, u0, v0), bilerp(corners, u1, v1), bilerp(corners, u0, v1),
            [u0 * face.w, ty(v0)], [u1 * face.w, ty(v1)], [u0 * face.w, ty(v1)], tex, lit, loop, face.id);
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
    ctx.fillStyle = '#c2ccd3';
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
      view.push({ t, p, q, r, z: (t.a2 + t.b2 + t.c2) / 3 });
    }
    // Painter: smallest rz first is furthest from the camera.
    view.sort((a, b) => a.z - b.z);
    ctx.imageSmoothingEnabled = false;
    // A panel is flat but rotated, so its triangles sit at different depths and
    // interleave with other panels in the sort. The silhouette therefore has to
    // be clipped per triangle, not per panel. Each ring is projected once per
    // frame and reused.
    const clips = new Map();
    for (const v of view) {
      const loop = v.t.loop;
      if (!loop) {
        // Mesh triangles bleed into their neighbours to hide the seam cracks;
        // panels are clipped to the face outline and must not cross it.
        drawTri(ctx, v.p, v.q, v.r, v.t.u, v.t.v, v.t.w2, v.t.tex, v.t.lit, v.t.two);
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
      drawTri(ctx, v.p, v.q, v.r, v.t.u, v.t.v, v.t.w2, v.t.tex, v.t.lit);
      ctx.restore();
    }
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

function tri(tris, a, b, c, u, v, w2, tex, lit, loop, faceId) {
  tris.push({ a, b, c, u, v, w2, tex, lit, loop: loop || null, face: faceId, a2: a[2], b2: b[2], c2: c[2] });
}

/* ---------------- triangle rasteriser ---------------- */

function drawTri(ctx, p, q, r, u, v, w2, tex, lit, bleed) {
  if (!tex) return;
  // A triangle with no area cannot be mapped, but the threshold has to be near
  // nothing: at a steep orbit a whole band of the sleeve projects to slivers of a
  // hundredth of a pixel, and skipping them punched the holes the old counts
  // showed growing with angle. Only truly degenerate ones are dropped.
  const area = (q[0] - p[0]) * (r[1] - p[1]) - (r[0] - p[0]) * (q[1] - p[1]);
  if (Math.abs(area) < 1e-4) return;
  if (bleed) {
    // Neighbouring triangles share an exact edge, and two independently clipped
    // fills leave a hairline of backdrop along it. Push each vertex a third of a
    // pixel away from the centroid so neighbours overlap and the seam is covered.
    // The affine mapping below is left alone, so this stretches the texture by
    // well under a pixel - invisible, and the only way to hide the crack.
    const cx = (p[0] + q[0] + r[0]) / 3;
    const cy = (p[1] + q[1] + r[1]) / 3;
    const rad = (Math.hypot(p[0] - cx, p[1] - cy) + Math.hypot(q[0] - cx, q[1] - cy) + Math.hypot(r[0] - cx, r[1] - cy)) / 3;
    const k = 1 + 0.34 / Math.max(rad, 0.34);
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
  ctx.drawImage(tex, 0, 0);
  ctx.restore();

  if (lit < 1) {
    // Grey, not brown: multiply-style darkening of a white garment has to stay
    // neutral or the model reads as the wrong colour entirely.
    path(ctx, p, q, r);
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
