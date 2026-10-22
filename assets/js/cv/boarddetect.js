/*
 * Screenshot import: find a Heartopia board inside a picture of one.
 *
 * The loop that art-pia only half closes is "what is already in the game". You
 * take a screenshot of something you (or someone else) painted in-world, and
 * this turns it back into cells you can edit and paint over together. That is
 * a computer-vision problem, so it is solved like one - no hard-coded
 * coordinates, no assuming the screenshot came from a particular device.
 *
 * Four steps:
 *
 *   1. Edge energy. Sobel over luma. Grid lines are long, thin, axis-aligned
 *      edges, so they dominate the energy map and everything else is texture.
 *   2. Cell size. Sum the energy along rows and columns. A board makes a
 *      comb-like profile there, and the comb's pitch is the cell size - read
 *      it off the autocorrelation of the projection, not by counting.
 *   3. Rectangle. The board's own border is the strongest pair of lines at the
 *      outside of that comb. Take the outermost peaks that fit the pitch.
 *   4. Sample. Read the middle of each cell, and take the MEDIAN colour of
 *      that interior rather than the mean. A median is what lets the grid
 *      lines and the game's guide lines be ignored instead of removed: they
 *      cross the cell, they do not fill it.
 *
 * Then the colours found go through the same Lab/CIEDE2000 quantiser as any
 * imported photo, so a lifted board uses the game's palette and nothing else.
 */

import { palette } from '../color/science.js';

/** @typedef {{data:Uint8ClampedArray,width:number,height:number}} ImageLike */

const MIN_PITCH = 3;
const MAX_PITCH = 200;

export function detectBoard(img, opts = {}) {
  const { width: W, height: H, data } = img;
  // `data` must be the pixel array. Given an ImageData object every read is
  // undefined, the edge map is all NaN, and the honest answer is "no board" -
  // which blames the person's crop for the tool's own bug.
  if (!data || typeof data.length !== 'number') {
    throw new TypeError('detectBoard wants { data: Uint8ClampedArray, width, height } - the pixels, not an ImageData');
  }
  const gray = luma(data, W, H);
  const mag = sobel(gray, W, H);

  const colE = project(mag, W, H, 'x');
  const rowE = project(mag, W, H, 'y');

  const pitch =
    opts.pitch && opts.pitch > 0
      ? opts.pitch
      : estimatePitch(colE, rowE, { min: opts.minPitch || MIN_PITCH, max: opts.maxPitch || Math.min(MAX_PITCH, Math.floor(Math.min(W, H) / 3)) });

  if (!pitch) return null;

  const box = findBox(colE, rowE, pitch, W, H);
  if (!box) return null;

  let cols = Math.max(1, Math.round(box.w / pitch));
  let rows = Math.max(1, Math.round(box.h / pitch));

  // When the caller expects a known board, snap to it. A screenshot of the game
  // is usually cut a few pixels inside the far border, so a measured 29 rows is
  // the 30-row board with the last row half in frame - and 29 is a board that
  // cannot be painted anywhere. Refuse a count that is off by more than that.
  if (opts.expectCols && opts.expectRows) {
    const fit = (got, want) => Math.abs(got - want) <= Math.max(1, Math.round(want * 0.08));
    if (!fit(cols, opts.expectCols) || !fit(rows, opts.expectRows)) return null;
    // The cell size has to be chosen, not assumed. Two candidates: the measured
    // span divided by the expected count, and the autocorrelation pitch. Each is
    // wrong some of the time - a crop loses the far edge so the span runs short,
    // while a board rendered at a fractional pitch has an autocorrelation that
    // rounds to a whole pixel and drifts a cell across fifty. So score both
    // against the thing that does not guess: where the grid lines actually are.
    const step = (measuredSpan, n, prof, off) => {
      // `box.w` is the whole board extent: this codebase already derives
      // `cols = round(box.w / pitch)`, so the span covers n cells, not n-1 gaps.
      const a = measuredSpan / n;
      const b = pitch;
      const score = (s) => {
        let v = 0;
        for (let i = 1; i < n; i++) {
          const p = Math.round(off + i * s);
          if (p >= 0 && p < prof.length) v += prof[p];
        }
        return v / (n - 1);
      };
      return score(a) >= score(b) ? a : b;
    };
    // `box.w` is the span between the outer lines, which covers cols-1 cells.
    const sx = step(box.w, opts.expectCols, colE, box.x);
    const sy = step(box.h, opts.expectRows, rowE, box.y);
    box.w = opts.expectCols * sx;
    box.h = opts.expectRows * sy;
    // A grid that runs past the picture is a grid we cannot sample. Pull the
    // anchor back from the far edge instead, which is where the lines are.
    if (box.x + box.w > W) box.x = W - box.w;
    if (box.y + box.h > H) box.y = H - box.h;
    cols = opts.expectCols;
    rows = opts.expectRows;
  }
  // Re-derive the pitch from the integer cell count: a screenshot is rarely an
  // exact multiple, and "29.6 px, 30 cells" must become "30 cells, 29.6 px each"
  // rather than a board with a 4-pixel sliver down one side.
  const cw = box.w / cols;
  const ch = box.h / rows;

  const cells = sampleCells(data, W, H, box, cols, rows, cw, ch, opts);

  return {
    rect: { x: box.x, y: box.y, w: box.w, h: box.h },
    cols,
    rows,
    pitch,
    cell: { w: cw, h: ch },
    image: { data: cells.colors, width: cols, height: rows },
    confidence: cells.confidence,
    empty: cells.empty,
  };
}

/* ---------------- 1. edges ---------------- */

function luma(data, W, H) {
  const out = new Float32Array(W * H);
  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    out[i] = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
  }
  return out;
}

/** 3x3 Sobel magnitude. */
function sobel(g, W, H) {
  const m = new Float32Array(W * H);
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      const a = g[i - W - 1],
        b = g[i - W],
        c = g[i - W + 1];
      const d = g[i - 1],
        f = g[i + 1];
      const h = g[i + W - 1],
        j = g[i + W],
        k = g[i + W + 1];
      const gx = a + 2 * d + h - (c + 2 * f + k);
      const gy = a + 2 * b + c - (h + 2 * j + k);
      m[i] = Math.abs(gx) + Math.abs(gy);
    }
  }
  return m;
}

/** Sum of edge energy along each column (axis 'x') or each row (axis 'y'). */
function project(mag, W, H, axis) {
  if (axis === 'x') {
    const out = new Float32Array(W);
    for (let x = 0; x < W; x++) {
      let s = 0;
      for (let y = 0; y < H; y++) s += mag[y * W + x];
      out[x] = s / H;
    }
    return out;
  }
  const out = new Float32Array(H);
  for (let y = 0; y < H; y++) {
    let s = 0;
    const base = y * W;
    for (let x = 0; x < W; x++) s += mag[base + x];
    out[y] = s / W;
  }
  return out;
}

/* ---------------- 2. pitch ---------------- */

/**
 * Normalised autocorrelation of a projection. A board's comb lights up at its
 * own pitch and at multiples of it, so take the smallest lag that is both a
 * local peak and nearly as strong as the best peak.
 */
function estimatePitch(colE, rowE, { min, max }) {
  if (max < min) return 0;
  const scores = [];
  for (const prof of [colE, rowE]) {
    const s = autocorr(prof, min, max);
    if (s) scores.push(s);
  }
  if (!scores.length) return 0;
  // Columns and rows should agree on a square cell. When they do not, the
  // smaller one wins: a too-large pitch merges cells and loses detail, a
  // too-small one just oversamples.
  return Math.min(...scores);
}

function autocorr(prof, min, max) {
  const n = prof.length;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += prof[i];
  mean /= n;
  const d = new Float32Array(n);
  for (let i = 0; i < n; i++) d[i] = prof[i] - mean;
  let energy = 0;
  for (let i = 0; i < n; i++) energy += d[i] * d[i];
  if (energy < 1e-6) return 0;

  let best = 0;
  let bestV = 0;
  const hi = Math.min(max, Math.floor(n / 2));
  for (let lag = min; lag <= hi; lag++) {
    let s = 0;
    for (let i = 0; i + lag < n; i++) s += d[i] * d[i + lag];
    const v = s / energy;
    if (v > bestV) {
      bestV = v;
      best = lag;
    }
  }
  if (bestV < 0.12) return 0; // no real comb in there
  // Prefer the fundamental over a harmonic of itself.
  for (let lag = min; lag <= Math.floor(best / 2); lag++) {
    let s = 0;
    for (let i = 0; i + lag < n; i++) s += d[i] * d[i + lag];
    if (s / energy > bestV * 0.82) return lag;
  }
  return best;
}

/* ---------------- 3. the rectangle ---------------- */

/**
 * Peaks in a projection, then the outermost pair that the pitch can divide
 * evenly. The board's frame is a much stronger edge than its interior lines,
 * so ranking by height rather than by position is what picks the right pair.
 */
function findBox(colE, rowE, pitch, W, H) {
  const cx = peaks(colE);
  const cy = peaks(rowE);
  if (cx.length < 2 || cy.length < 2) return null;
  const x0 = cx[0];
  const x1 = cx[cx.length - 1];
  const y0 = cy[0];
  const y1 = cy[cy.length - 1];
  const w = x1 - x0;
  const h = y1 - y0;
  if (w < pitch * 2 || h < pitch * 2) return null;
  // A board is at least a third of the picture in both axes, or we are looking
  // at a shadow, a text underline, or a tile in the wall behind it.
  if (w < W * 0.25 || h < H * 0.25) return null;
  return refine({ x: x0, y: y0, w, h }, colE, rowE, pitch);
}

function peaks(prof) {
  const n = prof.length;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += prof[i];
  mean /= n;
  let sd = 0;
  for (let i = 0; i < n; i++) sd += (prof[i] - mean) ** 2;
  sd = Math.sqrt(sd / n);
  const cut = mean + sd * 1.1;
  const out = [];
  for (let i = 1; i < n - 1; i++) {
    if (prof[i] < cut) continue;
    if (prof[i] >= prof[i - 1] && prof[i] >= prof[i + 1]) out.push(i);
  }
  return out.length > 3 ? out : [];
}

/** Slide the box by up to a pixel and keep whatever aligns best with the comb. */
function refine(box, colE, rowE, pitch) {
  let best = null;
  let bestS = -Infinity;
  for (let dx = -2; dx <= 2; dx++) {
    for (let dy = -2; dy <= 2; dy++) {
      const b = { ...box, x: box.x + dx, y: box.y + dy };
      const s = alignScore(b, colE, rowE, pitch);
      if (s > bestS) {
        bestS = s;
        best = b;
      }
    }
  }
  return best;
}

function alignScore(box, colE, rowE, pitch) {
  let s = 0;
  const n = Math.max(2, Math.round(box.w / pitch));
  for (let i = 0; i <= n; i++) {
    const x = Math.round(box.x + i * (box.w / n));
    if (x >= 0 && x < colE.length) s += colE[x];
  }
  const m = Math.max(2, Math.round(box.h / pitch));
  for (let i = 0; i <= m; i++) {
    const y = Math.round(box.y + i * (box.h / m));
    if (y >= 0 && y < rowE.length) s += rowE[y];
  }
  return s;
}

/* ---------------- 4. read the cells ---------------- */

/**
 * Median of the cell's interior. The grid lines sit on the cell borders and
 * the game's own guide lines cross the middle - a mean would mix them into
 * every colour, a median throws them out, because they occupy a minority of
 * the pixels either way.
 */
function sampleCells(data, W, H, box, cols, rows, cw, ch, opts) {
  const out = new Uint8ClampedArray(cols * rows * 4);
  const trim = opts.trim ?? 0.16; // ignore this fraction of each edge
  const bufR = [];
  const bufG = [];
  const bufB = [];
  let empty = 0;
  let coverage = 0;

  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      const x0 = Math.round(box.x + cx * cw + cw * trim);
      const x1 = Math.round(box.x + (cx + 1) * cw - cw * trim);
      const y0 = Math.round(box.y + cy * ch + ch * trim);
      const y1 = Math.round(box.y + (cy + 1) * ch - ch * trim);
      bufR.length = 0;
      bufG.length = 0;
      bufB.length = 0;
      for (let y = Math.max(0, y0); y < Math.min(H, y1); y++) {
        for (let x = Math.max(0, x0); x < Math.min(W, x1); x++) {
          const p = (y * W + x) * 4;
          bufR.push(data[p]);
          bufG.push(data[p + 1]);
          bufB.push(data[p + 2]);
        }
      }
      const i = (cy * cols + cx) * 4;
      if (bufR.length < 2) {
        out[i + 3] = 0;
        empty++;
        continue;
      }
      out[i] = median(bufR);
      out[i + 1] = median(bufG);
      out[i + 2] = median(bufB);
      out[i + 3] = 255;
      coverage += 1;
    }
  }
  return { colors: out, confidence: coverage / (cols * rows), empty };
}

function median(a) {
  const s = Float64Array.from(a).sort();
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/* ---------------- lift it into a board ---------------- */

/**
 * Detection -> palette indices. Everything present in the screenshot is mapped
 * to the nearest of the game's shades, and only shades that actually appear
 * are used, so a lifted board never gains colours the original did not have.
 *
 * @returns {{cells:Uint8Array,cols:number,rows:number,colors:Set<number>,confidence:number}}
 */
export function liftBoard(img, opts = {}) {
  const det = detectBoard(img, opts);
  if (!det) return null;
  const pi = opts.index || palette();
  const { data, width: cols, height: rows } = det.image;
  const cells = new Uint8Array(cols * rows);
  const colors = new Set();
  for (let i = 0; i < cols * rows; i++) {
    const p = i * 4;
    if (data[p + 3] < 8) continue;
    cells[i] = pi.nearest(data[p], data[p + 1], data[p + 2]);
    colors.add(cells[i]);
  }
  return { cells, cols, rows, colors, confidence: det.confidence, detect: det };
}

/**
 * Which Heartopia slot does this look like? Match the detected cell count and
 * aspect against the catalogue. Says nothing when it cannot tell - a wrong
 * guess costs a person their work, an honest "unknown" costs a click.
 */
export function guessSlot(cols, rows, catalogue) {
  const aspect = cols / rows;
  const scored = [];
  for (const face of catalogue) {
    const dCells = Math.hypot(face.w - cols, face.h - rows);
    const dAspect = Math.abs(Math.log(aspect / (face.w / face.h)));
    if (dCells <= 1.5 && dAspect < 0.02) scored.push({ face, score: dCells + dAspect });
  }
  scored.sort((a, b) => a.score - b.score);
  return scored.length ? scored[0].face : null;
}
