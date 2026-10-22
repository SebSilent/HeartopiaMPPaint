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
const LIGHT = norm3([0.35, 0.55, 0.9]);

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
  constructor(canvas, texture) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.texture = texture;
    this.yaw = -24;
    this.pitch = 14;
    this.zoom = 1;
    this.radius = 1;
    this._tris = [];
    this._cache = new Map();
  }

  /**
   * Build the triangle list for an item.
   * @param {{id:string,faces:Array}} item
   * @returns {number} triangles
   */
  build(item) {
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
      const lit = 0.62 + 0.38 * Math.abs(dot3(normal, LIGHT));
      for (let iy = 0; iy < n; iy++) {
        for (let ix = 0; ix < n; ix++) {
          const u0 = ix / n;
          const u1 = (ix + 1) / n;
          const v0 = iy / n;
          const v1 = (iy + 1) / n;
          tri(tris, bilerp(corners, u0, v0), bilerp(corners, u1, v0), bilerp(corners, u1, v1),
            [u0 * face.w, v0 * face.h], [u1 * face.w, v0 * face.h], [u1 * face.w, v1 * face.h], tex, lit);
          tri(tris, bilerp(corners, u0, v0), bilerp(corners, u1, v1), bilerp(corners, u0, v1),
            [u0 * face.w, v0 * face.h], [u1 * face.w, v1 * face.h], [u0 * face.w, v1 * face.h], tex, lit);
        }
      }
      for (const v of corners) radius = Math.max(radius, Math.hypot(v[0], v[1], v[2]));
    }
    this.radius = radius;
    this._tris = tris;
    return tris.length;
  }

  _texFor(face) {
    // Cache by face id; the caller invalidates by clearing the cache.
    if (!this._cache.has(face.id)) this._cache.set(face.id, this.texture(face.id));
    return this._cache.get(face.id);
  }

  invalidate() {
    this._cache.clear();
  }

  render() {
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
    ctx.clearRect(0, 0, w, h);
    if (!this._tris.length) return;

    const focal = 0.95 * Math.min(w, h) * this.zoom;
    const dist = this.radius * 2.7;
    const view = [];
    for (const t of this._tris) {
      const p = this._project(t.a, dist, focal, w, h);
      if (!p) continue;
      const q = this._project(t.b, dist, focal, w, h);
      const r = this._project(t.c, dist, focal, w, h);
      if (!q || !r) continue;
      view.push({ t, p, q, r, z: (t.a2 + t.b2 + t.c2) / 3 });
    }
    // Painter: smallest rz first is furthest from the camera.
    view.sort((a, b) => a.z - b.z);
    ctx.imageSmoothingEnabled = false;
    for (const v of view) drawTri(ctx, v.p, v.q, v.r, v.t.u, v.t.v, v.t.w2, v.t.tex, v.t.lit);
  }

  _project(p, dist, focal, w, h) {
    const [x, y, z] = orient(p, this.yaw, this.pitch, 0);
    const depth = dist - z;
    if (depth < 1) return null;
    const f = focal / depth;
    return [w / 2 + x * f, h / 2 - y * f, z];
  }

  orbit(dx, dy) {
    this.yaw += dx * 0.45;
    this.pitch = Math.max(-85, Math.min(85, this.pitch - dy * 0.45));
  }

  setZoom(z) {
    this.zoom = Math.max(0.3, Math.min(3.5, z));
  }

  reset() {
    this.yaw = -24;
    this.pitch = 14;
    this.zoom = 1;
  }
}

function tri(tris, a, b, c, u, v, w2, tex, lit) {
  tris.push({ a, b, c, u, v, w2, tex, lit, a2: a[2], b2: b[2], c2: c[2] });
}

/* ---------------- triangle rasteriser ---------------- */

function drawTri(ctx, p, q, r, u, v, w2, tex, lit) {
  if (!tex) return;
  if (Math.abs((q[0] - p[0]) * (r[1] - p[1]) - (r[0] - p[0]) * (q[1] - p[1])) < 0.02) return;
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
    path(ctx, p, q, r);
    ctx.fillStyle = `rgba(24,16,9,${((1 - lit) * 0.8).toFixed(3)})`;
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
