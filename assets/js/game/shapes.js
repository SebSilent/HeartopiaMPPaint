/*
 * Geometry and fills, on the cell grid.
 *
 * Everything here returns cell indices and takes no position on how they get
 * painted - a shape, a bucket fill and a brush stroke all end up as the same
 * op on the wire, which is what keeps the sync layer simple and lets any of
 * them be undone as one step.
 */

import { brushOffsets } from './grid.js';

/**
 * Bresenham, so a line is exactly the cells a person would count.
 *
 * Every coordinate is floored on the way in, the target twice over: cell n
 * spans [n, n+1), so a fractional sample belongs to the cell it falls inside -
 * rounding would steal half of every neighbour. Flooring the target also makes
 * the termination test an integer comparison. Against a raw fractional x1 an
 * integer x can never be equal, the loop never breaks, and the guard used to
 * walk it to 100000 cells on every brush stroke - the freeze while drawing.
 */
export function lineCells(x0, y0, x1, y1) {
  x0 = Math.floor(x0);
  y0 = Math.floor(y0);
  x1 = Math.floor(x1);
  y1 = Math.floor(y1);
  const out = [];
  let x = x0;
  let y = y0;
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
  // Degenerate drag: one cell, the one the pointer is in - floor, not round.
  if (rx < 0.5 && ry < 0.5) return [[Math.floor(x0), Math.floor(y0)]];
  const X0 = Math.floor(Math.min(x0, x1));
  const X1 = Math.ceil(Math.max(x0, x1));
  const Y0 = Math.floor(Math.min(y0, y1));
  const Y1 = Math.ceil(Math.max(y0, y1));
  const inside = (x, y) => {
    const nx = rx > 0 ? (x - cx) / rx : 0;
    const ny = ry > 0 ? (y - cy) / ry : 0;
    return nx * nx + ny * ny <= 1;
  };
  // The rim, as a closed ring.
  //
  // Taking the first and last cell of each scan row - the obvious trick - only
  // ever finds the left and right extremes, so the top and bottom of the
  // circle are simply missing and the outline reads as two parentheses. Walk
  // the curve instead and join consecutive samples with a line: Bresenham
  // cannot skip a cell between two samples that close, and the samples are
  // placed so that they never are.
  const steps = Math.max(24, Math.ceil(Math.PI * (rx + ry) * 2));
  const rim = [];
  let prev = null;
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    const px = Math.round(cx + Math.cos(a) * rx);
    const py = Math.round(cy + Math.sin(a) * ry);
    if (prev) rim.push(...lineCells(prev[0], prev[1], px, py));
    prev = [px, py];
  }
  if (!filled) return dedupePairs(rim);
  // The fill is the ring plus everything between its edges, so a filled
  // ellipse always contains the outline it would have drawn. Testing each cell
  // against the curve instead cannot: the ring is rounded to whole cells and
  // leans a little outside the true ellipse where it does.
  const out = [...rim];
  for (let y = Y0; y <= Y1; y++) {
    let first = -1;
    let last = -1;
    for (let x = X0; x <= X1; x++) {
      if (!inside(x, y)) continue;
      if (first < 0) first = x;
      last = x;
    }
    for (let x = first; x <= last; x++) out.push([x, y]);
  }
  return dedupePairs(out);
}

export function polygonCells(points, filled = true) {
  if (points.length < 2) return [];
  // Vertices are board samples: floor them so the polygon sits on the cells the
  // clicks actually landed in, whatever the caller passes.
  points = points.map(([x, y]) => [Math.floor(x), Math.floor(y)]);
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

/* ---------------- fills ---------------- */

/**
 * Bucket fill. Contiguous by default; "similar" mode spreads to anything within
 * a colour distance, which is the Paint option people actually reach for.
 *
 * @param {{w:number,h:number,colorAt(x,y):number}} grid
 */
export function fillCells(grid, x, y, target, opts = {}) {
  // floor, not round: cell n spans [n, n+1), so the seed is the cell the click
  // landed in. _floodAt already floors its argument, so this is latent today,
  // but the function is exported and the rule is the rule.
  const sx = Math.floor(x);
  const sy = Math.floor(y);
  const from = grid.colorAt(sx, sy);
  const tol = opts.tolerance | 0;
  const contig = opts.contiguous !== false;
  const seen = new Uint8Array(grid.w * grid.h);
  const out = [];
  // "Similar" has to mean similar *colours*. This module does not know what a
  // palette is, so the caller hands down the comparison and stays the only
  // place colour science lives; `tolerance` on its own is a distance between
  // list positions, which is kept only so a caller that has no palette can
  // still ask for a loose fill.
  const same =
    opts.similar ||
    ((c) => (tol ? Math.abs(c - from) <= tol : c === from));
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

// Memoised: _paint asks for this on every pointer move, and the O(brush²) scan
// is pure waste the second time. Callers only read the array, never mutate it.
const roundCache = new Map();

/** Soft round brush in cells, for the round brush shape. */
export function roundOffsets(brush) {
  const hit = roundCache.get(brush);
  if (hit) return hit;
  const offs = [];
  const r = (brush - 1) / 2;
  for (const dy of brushOffsets(brush)) {
    for (const dx of brushOffsets(brush)) {
      if (dx * dx + dy * dy <= r * r + 0.6) offs.push([dx, dy]);
    }
  }
  const out = offs.length ? offs : [[0, 0]];
  roundCache.set(brush, out);
  return out;
}

/**
 * One dab of the hard spray: a random scatter of cells inside the round
 * brush's footprint. Density is the share of that footprint one dab inks, so
 * a drag still fills the disc as its dabs overlap. The draw is fresh per dab -
 * one fixed pattern stamped along a drag is a texture, not a spray - and `rng`
 * is injectable so tests can pin a draw.
 */
export function sprayOffsets(brush, density, rng = Math.random) {
  const disc = roundOffsets(brush);
  const n = Math.max(1, Math.round(disc.length * density));
  const pool = disc.slice();
  const out = [];
  for (let k = 0; k < n && pool.length; k++) {
    const i = Math.floor(rng() * pool.length);
    out.push(pool[i]);
    pool[i] = pool[pool.length - 1];
    pool.pop();
  }
  return out;
}

export const SHAPES = ['line', 'rect', 'ellipse', 'polygon'];

/**
 * The four shapes a drag can make.
 *
 * Star, heart, arrow, triangle and spray were here too and are gone: they were
 * never part of what Heartopia's own boards ask for, and every one of them was
 * another path through the same cell maths that nobody had tested.
 */
export function shapeCells(shape, x0, y0, x1, y1, filled) {
  switch (shape) {
    case 'rect':
      return rectCells(x0, y0, x1, y1, filled);
    case 'ellipse':
      return ellipseCells(x0, y0, x1, y1, filled);
    case 'line':
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
