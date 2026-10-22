/*
 * Geometry and fills, on the cell grid.
 *
 * Everything here returns cell indices and takes no position on how they get
 * painted - a shape, a bucket fill and a brush stroke all end up as the same
 * op on the wire, which is what keeps the sync layer simple and lets any of
 * them be undone as one step.
 */

import { brushOffsets } from './grid.js';

/** Bresenham, so a line is exactly the cells a person would count. */
export function lineCells(x0, y0, x1, y1) {
  const out = [];
  let x = x0 | 0;
  let y = y0 | 0;
  const dx = Math.abs(x1 - x);
  const dy = -Math.abs(y1 - y);
  const sx = x < x1 ? 1 : -1;
  const sy = y < y1 ? 1 : -1;
  let err = dx + dy;
  for (let guard = 0; guard < 100000; guard++) {
    out.push([x, y]);
    if (x === x1 && y === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y += sy;
    }
  }
  return out;
}

/** Constrain a drag to 0/45/90 degrees, the way every paint program does. */
export function snapAngle(x0, y0, x1, y1) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len = Math.hypot(dx, dy);
  const step = Math.PI / 4;
  const a = Math.round(Math.atan2(dy, dx) / step) * step;
  return { x: Math.round(x0 + Math.cos(a) * len), y: Math.round(y0 + Math.sin(a) * len) };
}

export function rectCells(x0, y0, x1, y1, filled) {
  const [ax, bx] = [Math.min(x0, x1), Math.max(x0, x1)];
  const [ay, by] = [Math.min(y0, y1), Math.max(y0, y1)];
  const out = [];
  for (let y = ay; y <= by; y++) {
    for (let x = ax; x <= bx; x++) {
      if (filled || x === ax || x === bx || y === ay || y === by) out.push([x, y]);
    }
  }
  return out;
}

/**
 * Ellipse outline by the midpoint test, filled by rows. Deliberately not the
 * parametric form: that skips cells on shallow arcs and the outline breaks up.
 */
export function ellipseCells(x0, y0, x1, y1, filled) {
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const rx = Math.abs(x1 - x0) / 2;
  const ry = Math.abs(y1 - y0) / 2;
  if (rx < 0.5 && ry < 0.5) return [[Math.round(x0), Math.round(y0)]];
  const out = [];
  const X0 = Math.floor(Math.min(x0, x1));
  const X1 = Math.ceil(Math.max(x0, x1));
  const Y0 = Math.floor(Math.min(y0, y1));
  const Y1 = Math.ceil(Math.max(y0, y1));
  const inside = (x, y) => {
    const nx = rx > 0 ? (x - cx) / rx : 0;
    const ny = ry > 0 ? (y - cy) / ry : 0;
    return nx * nx + ny * ny <= 1.02;
  };
  if (filled) {
    for (let y = Y0; y <= Y1; y++) for (let x = X0; x <= X1; x++) if (inside(x, y)) out.push([x, y]);
    return out;
  }
  for (let y = Y0; y <= Y1; y++) {
    let first = -1;
    let last = -1;
    for (let x = X0; x <= X1; x++) {
      if (!inside(x, y)) continue;
      if (first < 0) first = x;
      last = x;
    }
    if (first < 0) continue;
    out.push([first, y]);
    if (last !== first) out.push([last, y]);
  }
  return dedupePairs(out);
}

export function polygonCells(points, filled = true) {
  if (points.length < 2) return [];
  if (!filled) {
    const out = [];
    for (let i = 0; i < points.length; i++) {
      const a = points[i];
      const b = points[(i + 1) % points.length];
      out.push(...lineCells(a[0], a[1], b[0], b[1]));
    }
    return dedupePairs(out);
  }
  const ys = points.map((p) => p[1]);
  const y0 = Math.min(...ys);
  const y1 = Math.max(...ys);
  const out = [];
  for (let y = Math.round(y0); y <= Math.round(y1); y++) {
    const xs = [];
    for (let i = 0; i < points.length; i++) {
      const a = points[i];
      const b = points[(i + 1) % points.length];
      if (a[1] === b[1]) continue;
      if ((y >= a[1] && y < b[1]) || (y >= b[1] && y < a[1])) {
        xs.push(a[0] + ((y - a[1]) / (b[1] - a[1])) * (b[0] - a[0]));
      }
    }
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      for (let x = Math.round(xs[k]); x <= Math.round(xs[k + 1]); x++) out.push([x, y]);
    }
  }
  return out;
}

/** Star and heart are polygons on a unit circle, scaled to the drag box. */
export function starCells(x0, y0, x1, y1, points = 5) {
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const rx = Math.abs(x1 - x0) / 2;
  const ry = Math.abs(y1 - y0) / 2;
  const poly = [];
  for (let i = 0; i < points * 2; i++) {
    const a = (Math.PI * i) / points - Math.PI / 2;
    const k = i % 2 ? 0.42 : 1;
    poly.push([Math.round(cx + Math.cos(a) * rx * k), Math.round(cy + Math.sin(a) * ry * k)]);
  }
  return polygonCells(poly, true);
}

export function heartCells(x0, y0, x1, y1) {
  const w = Math.abs(x1 - x0);
  const h = Math.abs(y1 - y0);
  if (w < 2 || h < 2) return [[x0, y0]];
  const sx = x1 > x0 ? 1 : -1;
  const sy = y1 > y0 ? 1 : -1;
  const ox = Math.min(x0, x1);
  const oy = Math.min(y0, y1);
  const out = [];
  for (let y = 0; y <= h; y++) {
    for (let x = 0; x <= w; x++) {
      const u = (x / w) * 2 - 1;
      const v = -(((y / h) * 2 - 1) * sy * sy + (sy < 0 ? 0 : 0));
      const t = Math.PI * v;
      const hx = 16 * Math.sin(t) ** 3;
      const hy = 13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t);
      if (u * 16 <= hx && u * 16 >= -hx && v * 16 <= hy + 4) out.push([ox + x * sx, oy + y * sy]);
    }
  }
  return out.length ? out : rectCells(x0, y0, x1, y1, true);
}

export function arrowCells(x0, y0, x1, y1) {
  const shaft = lineCells(x0, y0, x1, y1);
  const ang = Math.atan2(y1 - y0, x1 - x0);
  const head = Math.max(3, Math.min(14, Math.hypot(x1 - x0, y1 - y0) * 0.24));
  const out = [...shaft];
  for (const w of [-1, 1]) {
    const a = ang + Math.PI + (w * Math.PI) / 6;
    out.push(...lineCells(x1, y1, Math.round(x1 + Math.cos(a) * head), Math.round(y1 + Math.sin(a) * head)));
  }
  return dedupePairs(out);
}

/* ---------------- fills ---------------- */

/**
 * Bucket fill. Contiguous by default; "similar" mode spreads to anything within
 * a colour distance, which is the Paint option people actually reach for.
 *
 * @param {{w:number,h:number,colorAt(x,y):number}} grid
 */
export function fillCells(grid, x, y, target, opts = {}) {
  const sx = Math.round(x);
  const sy = Math.round(y);
  const from = grid.colorAt(sx, sy);
  const tol = opts.tolerance | 0;
  const contig = opts.contiguous !== false;
  const seen = new Uint8Array(grid.w * grid.h);
  const out = [];
  const same = (c) => (tol ? Math.abs(c - from) <= tol : c === from);
  const match = (cx, cy) => {
    const c = grid.colorAt(cx, cy);
    return c >= 0 && same(c);
  };
  if (!match(sx, sy)) return out;
  if (contig) {
    const stack = [sy * grid.w + sx];
    seen[stack[0]] = 1;
    while (stack.length) {
      const i = stack.pop();
      const cx = i % grid.w;
      const cy = (i / grid.w) | 0;
      if (!same(grid.colorAt(cx, cy))) continue;
      out.push([cx, cy]);
      push(stack, seen, grid, cx + 1, cy);
      push(stack, seen, grid, cx - 1, cy);
      push(stack, seen, grid, cx, cy + 1);
      push(stack, seen, grid, cx, cy - 1);
    }
    return out;
  }
  for (let cy = 0; cy < grid.h; cy++) for (let cx = 0; cx < grid.w; cx++) if (match(cx, cy)) out.push([cx, cy]);
  return out;
}

function push(stack, seen, grid, x, y) {
  if (x < 0 || y < 0 || x >= grid.w || y >= grid.h) return;
  const i = y * grid.w + x;
  if (seen[i]) return;
  seen[i] = 1;
  stack.push(i);
}

/** Spray / airbrush: a random scatter inside the brush footprint. */
export function sprayCells(grid, x, y, brush, density = 0.45, rand = Math.random) {
  const out = [];
  const r = Math.max(0.5, (brush - 1) / 2);
  const round = r * r;
  const n = Math.max(1, Math.round(round * density * 3));
  for (let k = 0; k < n; k++) {
    const a = rand() * Math.PI * 2;
    const d = Math.sqrt(rand()) * r;
    const cx = Math.round(x + Math.cos(a) * d);
    const cy = Math.round(y + Math.sin(a) * d);
    if (grid.inBounds && !grid.inBounds(cx, cy)) continue;
    out.push([cx, cy]);
  }
  return dedupePairs(out);
}

/** Soft round brush in cells, for the airbrush falloff. */
export function roundOffsets(brush) {
  const offs = [];
  const r = (brush - 1) / 2;
  for (const dy of brushOffsets(brush)) {
    for (const dx of brushOffsets(brush)) {
      if (dx * dx + dy * dy <= r * r + 0.6) offs.push([dx, dy]);
    }
  }
  return offs.length ? offs : [[0, 0]];
}

export const SHAPES = ['line', 'rect', 'ellipse', 'triangle', 'star', 'heart', 'arrow', 'polygon'];

export function shapeCells(shape, x0, y0, x1, y1, filled) {
  switch (shape) {
    case 'line':
      return lineCells(x0, y0, x1, y1);
    case 'rect':
      return rectCells(x0, y0, x1, y1, filled);
    case 'ellipse':
      return ellipseCells(x0, y0, x1, y1, filled);
    case 'triangle':
      return polygonCells(
        [[Math.round((x0 + x1) / 2), Math.round(y0)], [Math.round(x0), Math.round(y1)], [Math.round(x1), Math.round(y1)]],
        filled
      );
    case 'star':
      return starCells(x0, y0, x1, y1, 5);
    case 'heart':
      return heartCells(x0, y0, x1, y1);
    case 'arrow':
      return arrowCells(x0, y0, x1, y1);
    default:
      return lineCells(x0, y0, x1, y1);
  }
}

/** Mirror a set of cell pairs across the board, for symmetric painting. */
export function mirrored(grid, pairs, axes) {
  if (!axes) return pairs;
  const out = [];
  for (const [x, y] of pairs) {
    out.push([x, y]);
    if (axes & 1) out.push([grid.w - 1 - x, y]);
    if (axes & 2) out.push([x, grid.h - 1 - y]);
    if (axes === 3) out.push([grid.w - 1 - x, grid.h - 1 - y]);
  }
  return dedupePairs(out);
}

/**
 * Mirror flat grid indices. Strokes already work in indices, and converting to
 * pairs and back would be a divide and a multiply per cell per batch.
 * @param {1|2|3} axes  bit 1 = across, bit 2 = down
 */
export function mirrorIndices(g, indices, axes) {
  if (!axes) return indices;
  const out = [];
  const seen = new Set();
  const add = (i) => {
    if (seen.has(i)) return;
    seen.add(i);
    out.push(i);
  };
  for (const i of indices) {
    add(i);
    const x = i % g.w;
    const y = (i / g.w) | 0;
    if (axes & 1) add(y * g.w + (g.w - 1 - x));
    if (axes & 2) add((g.h - 1 - y) * g.w + x);
    if (axes === 3) add((g.h - 1 - y) * g.w + (g.w - 1 - x));
  }
  return out;
}

export function dedupePairs(pairs) {
  const seen = new Set();
  const out = [];
  for (const [x, y] of pairs) {
    const k = `${x},${y}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push([x, y]);
  }
  return out;
}
