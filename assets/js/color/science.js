/*
 * Colour, done the way it has to be done for a fixed game palette.
 *
 * Two rules, both learned the hard way by everyone who has ever turned a photo
 * into Heartopia art:
 *
 *   1. Never compare colours in RGB. Numeric distance in RGB does not track
 *      what an eye sees - it happily picks a muddy brown where a grey was
 *      meant. Convert to CIELAB, which is built around perception, and compare
 *      there with CIEDE2000, the correction on top of it.
 *
 *   2. CIEDE2000 is expensive. A 150x150 board is 22,500 pixels and the palette
 *      is 125 shades; running the full formula on every pair is too slow to be
 *      interactive. So narrow first with a cheap Lab distance, keep the six
 *      nearest, and only then be precise. Same answer, ~20x less work.
 *
 * Results are memoised per source colour, which is why a photo with a flat sky
 * in it finishes almost instantly.
 */

import { FLAT_COLORS } from '../data/heartopia-palette.js';

const RAD = Math.PI / 180;
const cosd = (d) => Math.cos(d * RAD);
const sind = (d) => Math.sin(d * RAD);

/* ---------------- conversion ---------------- */

/** sRGB byte -> linear light. */
function unlock(v) {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/**
 * sRGB -> CIELAB (D65).
 * @returns {[L,a,b]} L 0..100, a/b roughly -128..127
 */
export function rgbToLab(r, g, b) {
  const R = unlock(r);
  const G = unlock(g);
  const B = unlock(b);
  // sRGB D65 -> XYZ
  let x = (0.4124564 * R + 0.3575761 * G + 0.1804375 * B) / 0.95047;
  let y = 0.2126729 * R + 0.7151522 * G + 0.072175 * B;
  let z = (0.0193339 * R + 0.119192 * G + 0.9503041 * B) / 1.08883;
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  x = f(x);
  y = f(y);
  z = f(z);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

/**
 * CIEDE2000 colour difference between two Lab colours. 0 = identical;
 * ~1 is the smallest difference a human can just barely see under good light.
 */
export function deltaE2000(l1, l2) {
  const [L1, a1, b1] = l1;
  const [L2, a2, b2] = l2;
  const C1 = Math.hypot(a1, b1);
  const C2 = Math.hypot(a2, b2);
  const Cb = (C1 + C2) / 2;
  const Cb7 = Cb ** 7;
  const G = 0.5 * (1 - Math.sqrt(Cb7 / (Cb7 + 25 ** 7)));
  const a1p = (1 + G) * a1;
  const a2p = (1 + G) * a2;
  const C1p = Math.hypot(a1p, b1);
  const C2p = Math.hypot(a2p, b2);
  let h1p = (Math.atan2(b1, a1p) / RAD + 360) % 360;
  let h2p = (Math.atan2(b2, a2p) / RAD + 360) % 360;
  if (C1p === 0) h1p = 0;
  if (C2p === 0) h2p = 0;

  const dLp = L2 - L1;
  const dCp = C2p - C1p;
  let dhp = 0;
  if (C1p * C2p !== 0) {
    dhp = h2p - h1p;
    if (dhp > 180) dhp -= 360;
    else if (dhp < -180) dhp += 360;
  }
  const dHp = 2 * Math.sqrt(C1p * C2p) * sind(dhp / 2);
  const Lbp = (L1 + L2) / 2;
  const Cbp = (C1p + C2p) / 2;
  let hbp = h1p + h2p;
  if (C1p * C2p !== 0) {
    hbp = (h1p + h2p) / 2;
    if (Math.abs(h1p - h2p) > 180) hbp += hbp < 180 ? 180 : -180;
  }
  const T =
    1 -
    0.17 * cosd(hbp - 30) +
    0.24 * cosd(2 * hbp) +
    0.32 * cosd(3 * hbp + 6) -
    0.2 * cosd(4 * hbp - 63);
  const dTh = 30 * Math.exp(-(((hbp - 275) / 25) ** 2));
  const Cbp7 = Cbp ** 7;
  const Rc = 2 * Math.sqrt(Cbp7 / (Cbp7 + 25 ** 7));
  const Sl = 1 + (0.015 * (Lbp - 50) ** 2) / Math.sqrt(20 + (Lbp - 50) ** 2);
  const Sc = 1 + 0.045 * Cbp;
  const Sh = 1 + 0.015 * Cbp * T;
  const Rt = -sind(2 * dTh) * Rc;
  return Math.sqrt(
    (dLp / Sl) ** 2 + (dCp / Sc) ** 2 + (dHp / Sh) ** 2 + Rt * (dCp / Sc) * (dHp / Sh)
  );
}

/* ---------------- the palette as an index ---------------- */

export class PaletteIndex {
  /**
   * @param {Array<string|null>} colors  hex list; index 0 is "empty", skipped
   */
  constructor(colors = FLAT_COLORS) {
    this.colors = colors;
    this.labs = [];
    this.entries = []; // {idx, lab} for every real shade
    for (let i = 0; i < colors.length; i++) {
      const hex = colors[i];
      if (!hex) {
        this.labs[i] = null;
        continue;
      }
      const lab = hexToLab(hex);
      this.labs[i] = lab;
      this.entries.push({ idx: i, lab, hex });
    }
    this._cache = new Map();
    // The palette is denser than it looks: its closest pair measures 2.36,
    // which is below what an eye can separate. Anything that quantises a photo
    // will sprinkle those in and balloon the colour count, which is exactly
    // what reduceColors() below is for.
    this.closestPair = this._findClosestPair();
  }

  _findClosestPair() {
    let best = null;
    for (let i = 0; i < this.entries.length; i++) {
      for (let j = i + 1; j < this.entries.length; j++) {
        const d = deltaE2000(this.entries[i].lab, this.entries[j].lab);
        if (!best || d < best.d) best = { a: this.entries[i].hex, b: this.entries[j].hex, d };
      }
    }
    return best;
  }

  /**
   * Which shade should this colour be?
   * Cheap pass over everything, precise pass over the six nearest.
   * @returns {number} palette index (never 0)
   */
  nearest(r, g, b) {
    const key = (r << 16) | (g << 8) | b;
    const hit = this._cache.get(key);
    if (hit !== undefined) return hit;
    const lab = rgbToLab(r, g, b);
    const cands = [];
    for (const e of this.entries) {
      const d = (lab[0] - e.lab[0]) ** 2 + (lab[1] - e.lab[1]) ** 2 + (lab[2] - e.lab[2]) ** 2;
      cands.push([d, e]);
    }
    cands.sort((x, y) => x[0] - y[0]);
    let bestIdx = cands[0][1].idx;
    let bestD = Infinity;
    for (let i = 0; i < Math.min(6, cands.length); i++) {
      const d = deltaE2000(lab, cands[i][1].lab);
      if (d < bestD) {
        bestD = d;
        bestIdx = cands[i][1].idx;
      }
    }
    this._cache.set(key, bestIdx);
    return bestIdx;
  }

  /** Distance from a palette index to a colour, for "is this worth keeping". */
  distanceTo(idx, lab) {
    const mine = this.labs[idx];
    if (!mine) return Infinity;
    return deltaE2000(mine, lab);
  }

  labOf(idx) {
    return this.labs[idx];
  }

  get size() {
    return this.entries.length;
  }
}

export function hexToLab(hex) {
  const n = parseInt(String(hex).replace('#', ''), 16);
  return rgbToLab((n >> 16) & 255, (n >> 8) & 255, n & 255);
}

let _shared = null;
export function palette() {
  return _shared || (_shared = new PaletteIndex());
}

/**
 * How different two shades look, in ΔE(2000) units.
 *
 * This exists because "fill similar colour" was first written as a difference of
 * palette *indices*, and an index is a position in a list, not a colour. The
 * palette is grouped by family, so index distance calls two adjacent entries in
 * the same family far apart and two unrelated shades that happen to sit next to
 * each other nearly identical - a tolerance of 3 then fills half a sleeve and
 * stops dead at a seam.
 *
 * Scale, for the controls: under ~2 is something an eye cannot separate (the
 * palette's own closest pair measures 2.36), 5-10 is "the same colour in a
 * different light", 20 is "a different colour that goes with it".
 *
 * @returns {number|null} null when either index is not a real shade
 */
export function shadeDeltaE(a, b, pi = palette()) {
  const la = pi.labs[a];
  const lb = pi.labs[b];
  if (!la || !lb) return null;
  if (a === b) return 0;
  return deltaE2000(la, lb);
}

/**
 * How many tones the airbrush fades through. Four reads as a soft edge on a
 * brush-sized disc and keeps one dab to four ops rather than forty.
 */
export const FADE_STEPS = 4;

const fadeCache = new Map();

/**
 * The shade an airbrush dot lands in, `step` steps of FADE_STEPS away from
 * `idx` toward white.
 *
 * The board has no alpha, so a soft edge cannot be translucent - it has to be
 * paler. Every dot therefore snaps to a shade that actually ships in the
 * palette, which is what keeps the result exportable as the game would build
 * it. A colour already near white simply stays itself: it has nowhere paler to
 * go, and inventing a lighter one would be a colour the game does not have.
 */
export function fadeShade(idx, step, pi = palette()) {
  if (!idx) return 0; // empty is not a colour to fade
  const s = Math.max(0, Math.min(FADE_STEPS, step | 0));
  if (!s) return idx;
  let row = fadeCache.get(idx);
  if (!row) {
    const hex = FLAT_COLORS[idx];
    const r0 = parseInt(hex.slice(1, 3), 16);
    const g0 = parseInt(hex.slice(3, 5), 16);
    const b0 = parseInt(hex.slice(5, 7), 16);
    row = [idx];
    for (let k = 1; k <= FADE_STEPS; k++) {
      const t = k / FADE_STEPS;
      row.push(
        pi.nearest(
          Math.round(r0 + (255 - r0) * t),
          Math.round(g0 + (255 - g0) * t),
          Math.round(b0 + (255 - b0) * t)
        )
      );
    }
    fadeCache.set(idx, row);
  }
  return row[s];
}

/* ---------------- dithering ---------------- */

const BAYER2 = [
  [0, 2],
  [3, 1],
];
const BAYER4 = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
];
const BAYER8 = BAYER4.map((row, y) =>
  row.flatMap((v) => [4 * v + BAYER2[y % 2][0], 4 * v + BAYER2[y % 2][1]])
);

export const DITHER = ['none', 'bayer2', 'bayer4', 'bayer8', 'fs'];

function bayerMatrix(name) {
  if (name === 'bayer2') return BAYER2;
  if (name === 'bayer4') return BAYER4;
  return BAYER8;
}

/* ---------------- quantising a picture ---------------- */

/**
 * Turn RGBA pixels into palette indices.
 *
 * @param {{data: Uint8ClampedArray, width:number, height:number}} img
 * @param {object} [o]
 *   mode       'none' | 'bayer2' | 'bayer4' | 'bayer8' | 'fs'
 *   threshold  0..255 - skip source pixels darker than this (drop dark borders)
 *   alphaCut   0..255 - below this alpha the cell stays empty
 *   brightness -100..100, contrast -100..100, saturation 0..200
 *   keepEmpty  leave unpainted cells as 0 instead of mapping them
 * @returns {{cells: Uint8Array, colors: Set<number>, empty: number}}
 */
export function quantize(img, o = {}) {
  const pi = o.index || palette();
  const { width: w, height: h, data } = img;
  // Fail here rather than quietly: an ImageData object where the pixel array is
  // expected reads `undefined` for every pixel, and the honest-looking answer is
  // one flat shade across the whole board.
  if (!data || typeof data.length !== 'number') {
    throw new TypeError('quantize wants { data: Uint8ClampedArray, width, height } - the pixels, not an ImageData');
  }
  const cells = new Uint8Array(w * h);
  const colors = new Set();
  let empty = 0;
  const mode = o.mode && o.mode !== 'none' ? o.mode : 'none';
  const alphaCut = o.alphaCut ?? 8;
  const threshold = o.threshold ?? 0;
  const br = (o.brightness ?? 0) / 100;
  const co = 1 - (o.contrast ?? 0) / 100;
  const sa = 1 + (o.saturation ?? 0) / 100;

  // FS diffuses error, so it needs a working copy in float.
  const buf = mode === 'fs' ? new Float32Array(w * h * 3) : null;
  if (buf) {
    for (let i = 0, p = 0; i < w * h; i++, p += 3) {
      buf[p] = data[p * 4];
      buf[p + 1] = data[p * 4 + 1];
      buf[p + 2] = data[p * 4 + 2];
    }
  }

  const adjust = (v) => {
    let x = v / 255;
    x = x + br;
    x = (x - 0.5) * (1 / Math.max(0.05, co)) + 0.5;
    return Math.round(Math.min(255, Math.max(0, x)) * 255);
  };

  const mat = mode.startsWith('bayer') ? bayerMatrix(mode) : null;
  const m = mat ? mat.length : 0;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const p = i * 4;
      if (data[p + 3] <= alphaCut) {
        cells[i] = 0;
        empty++;
        continue;
      }
      let r, g, b;
      if (buf) {
        r = buf[i * 3];
        g = buf[i * 3 + 1];
        b = buf[i * 3 + 2];
      } else {
        r = data[p];
        g = data[p + 1];
        b = data[p + 2];
      }
      r = adjust(r);
      g = adjust(g);
      b = adjust(b);
      if (sa !== 1) {
        const l = 0.299 * r + 0.587 * g + 0.114 * b;
        r = Math.round(Math.min(255, Math.max(0, l + (r - l) * sa)));
        g = Math.round(Math.min(255, Math.max(0, l + (g - l) * sa)));
        b = Math.round(Math.min(255, Math.max(0, l + (b - l) * sa)));
      }
      if (Math.max(r, g, b) < threshold) {
        cells[i] = 0;
        empty++;
        continue;
      }
      let rr = r;
      let gg = g;
      let bb = b;
      if (mat) {
        // Ordered dither: nudge the colour toward whichever palette shade the
        // threshold cell favours, so a smooth ramp becomes a pattern of two.
        const t = (mat[y % m][x % m] / (m * m) - 0.5) * (o.strength ?? 24);
        rr = Math.round(Math.min(255, Math.max(0, r + t)));
        gg = Math.round(Math.min(255, Math.max(0, g + t)));
        bb = Math.round(Math.min(255, Math.max(0, b + t)));
      }
      const idx = pi.nearest(rr, gg, bb);
      cells[i] = idx;
      colors.add(idx);
      if (buf) {
        const pl = pi.labs[idx];
        const ph = pi.colors[idx];
        const n = parseInt(ph.slice(1), 16);
        const er = rr - ((n >> 16) & 255);
        const eg = gg - ((n >> 8) & 255);
        const eb = bb - (n & 255);
        void pl;
        // Floyd-Steinberg: 7/16 right, 3/16 below-left, 5/16 below, 1/16 below-right
        const push = (nx, ny, f) => {
          if (nx < 0 || nx >= w || ny >= h) return;
          const q = (ny * w + nx) * 3;
          buf[q] += er * f;
          buf[q + 1] += eg * f;
          buf[q + 2] += eb * f;
        };
        push(x + 1, y, 7 / 16);
        push(x - 1, y + 1, 3 / 16);
        push(x, y + 1, 5 / 16);
        push(x + 1, y + 1, 1 / 16);
      }
    }
  }
  return { cells, colors, empty };
}

/* ---------------- colour reduction ---------------- */

/**
 * Fewer colours, same picture. Two passes, in this order, because they fix
 * different problems:
 *
 *   1. drop rare - a shade used by 3 cells out of 10,000 is noise from the
 *      palette's near-identical neighbours, not a decision you made.
 *   2. merge close - of what is left, fold the pair that is least different
 *      into the one that is used more, until the count fits.
 *
 * @param {Uint8Array} cells  palette indices, 0 = empty
 * @param {number} target  how many shades you want to end with
 * @param {object} [o] {index, rarePct}
 * @returns {{cells: Uint8Array, map: Map<number,number>, from:number, to:number}}
 */
export function reduceColors(cells, target, o = {}) {
  const pi = o.index || palette();
  const counts = new Map();
  for (let i = 0; i < cells.length; i++) {
    const c = cells[i];
    if (c) counts.set(c, (counts.get(c) || 0) + 1);
  }
  const total = cells.length;
  const rarePct = o.rarePct ?? 0.004; // 0.4% of the board
  const map = new Map();
  let live = [...counts.keys()];

  // pass 1: rare colours fold into their nearest survivor
  const rare = live.filter((c) => counts.get(c) / total < rarePct && live.length > target);
  for (const c of rare) {
    let best = null;
    let bestD = Infinity;
    for (const other of live) {
      if (other === c || rare.includes(other)) continue;
      const d = pi.distanceTo(other, pi.labOf(c));
      if (d < bestD) {
        bestD = d;
        best = other;
      }
    }
    if (best != null) {
      map.set(c, best);
      counts.set(best, (counts.get(best) || 0) + counts.get(c));
      live = live.filter((x) => x !== c);
    }
  }

  // pass 2: merge the closest remaining pair, repeatedly
  while (live.length > target) {
    let pair = null;
    let bestD = Infinity;
    for (let i = 0; i < live.length; i++) {
      for (let j = i + 1; j < live.length; j++) {
        const d = deltaE2000(pi.labOf(live[i]), pi.labOf(live[j]));
        if (d < bestD) {
          bestD = d;
          pair = [live[i], live[j]];
        }
      }
    }
    if (!pair) break;
    const [a, b] = pair;
    const keep = (counts.get(a) || 0) >= (counts.get(b) || 0) ? a : b;
    const gone = keep === a ? b : a;
    map.set(gone, keep);
    counts.set(keep, (counts.get(keep) || 0) + (counts.get(gone) || 0));
    live = live.filter((x) => x !== gone);
  }

  if (map.size) {
    // A chain (a->b, b->c) has to resolve to the end of it.
    const resolve = (c) => {
      let v = c;
      const seen = new Set();
      while (map.has(v) && !seen.has(v)) {
        seen.add(v);
        v = map.get(v);
      }
      return v;
    };
    for (let i = 0; i < cells.length; i++) {
      if (cells[i]) cells[i] = resolve(cells[i]);
    }
  }
  const from = counts.size;
  const to = new Set([...cells].filter((c) => c)).size;
  return { cells, map, from, to };
}

/**
 * The in-game cost of a design, as a pure number.
 *
 * Placing a pixel is fast. What eats the clock is switching the pen to a
 * different colour - so the time is roughly cells x distinct colours, and the
 * whole point of reduction, block mode and colour-by-colour work is to push
 * that down. Kept here, tested, and not wired to any UI yet: when we build the
 * estimate readout, it is already correct.
 */
export function buildCost(cells, colors = null) {
  const used = colors || new Set([...cells].filter((c) => c)).size;
  const painted = [...cells].filter((c) => c).length;
  return {
    painted,
    colors: used,
    /** Ordered taps: every colour switch costs, every same-colour tap is cheap. */
    taps: painted + used * 12,
    score: painted * (typeof used === 'number' ? used : used.size),
  };
}
