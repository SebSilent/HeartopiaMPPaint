/*
 * The shared canvas.
 *
 * Every cell holds a palette index (0 = untouched board). Repaints are
 * last-writer-wins on (lamport seq, author slot), so concurrent strokes from
 * different devices converge to the same result on every peer without needing
 * a central lock - which is what keeps the room "always in sync" even when
 * two people paint the same pixel at the same moment.
 *
 * Deliberately DOM-free so it can be unit-tested in Node and reused verbatim
 * by server/relay.js.
 */

import { FLAT_COLORS } from '../data/heartopia-palette.js';
import { bytesToB64, b64ToBytes, fnv1a } from '../util.js';

/** Slot 0 is reserved for "everything up to this point agreed via snapshot". */
export const SLOT_SNAPSHOT = 0;

export class Grid {
  constructor(w = 1, h = 1) {
    this.resize(w, h);
  }

  resize(w, h) {
    this.w = w | 0;
    this.h = h | 0;
    this.n = this.w * this.h;
    this.color = new Uint8Array(this.n); // palette index, 0 = empty
    this.seq = new Uint32Array(this.n); // lamport stamp
    this.slot = new Uint16Array(this.n); // author tiebreak
    this.version = 0; // number of ops applied, for drift reporting
    this._scratch = new Uint32Array(this.n);
    this._stamp = 0;
    return this;
  }

  idx(x, y) {
    return y * this.w + x;
  }

  inBounds(x, y) {
    return x >= 0 && y >= 0 && x < this.w && y < this.h;
  }

  colorAt(x, y) {
    return this.inBounds(x, y) ? this.color[y * this.w + x] : -1;
  }

  /** Is this write newer than what the cell holds? */
  _isNewer(i, seq, slot) {
    return seq > this.seq[i] || (seq === this.seq[i] && slot > this.slot[i]);
  }

  /**
   * Apply a paint op.
   * @param {Iterable<number>} indices cell indices
   * @param {number} c palette index (0 = eraser)
   * @returns {number} how many cells visibly changed
   */
  paint(indices, c, seq, slot) {
    let changed = 0;
    for (const i of indices) {
      if (i < 0 || i >= this.n) continue;
      if (!this._isNewer(i, seq, slot)) continue;
      if (this.color[i] !== c) changed++;
      this.color[i] = c;
      this.seq[i] = seq;
      this.slot[i] = slot;
    }
    this.version++;
    return changed;
  }

  clearAll(seq, slot) {
    this.color.fill(0);
    this.seq.fill(seq);
    this.slot.fill(slot);
    this.version++;
  }

  /** Hash of the visible picture only - ignores stamps, so peers can compare. */
  checksum() {
    return fnv1a(this.color);
  }

  /** The picture on its own, for a multi-face snapshot. */
  cellsB64() {
    return bytesToB64(this.color);
  }

  setCells(b64) {
    const bytes = b64ToBytes(b64);
    if (bytes.length !== this.n) throw new Error(`cell buffer ${bytes.length} != ${this.n}`);
    this.color.set(bytes);
    this.version++;
    return this;
  }

  maxSeq() {
    let m = 0;
    for (let i = 0; i < this.n; i++) if (this.seq[i] > m) m = this.seq[i];
    return m;
  }

  /** How many cells hold paint. Cheaper than filtering the whole board. */
  usedCount() {
    let n = 0;
    for (let i = 0; i < this.n; i++) if (this.color[i]) n++;
    return n;
  }

  /** Cells that are painted, for "canvas is empty" checks and export bounds. */
  usedBounds() {
    let x0 = this.w,
      y0 = this.h,
      x1 = -1,
      y1 = -1;
    for (let y = 0; y < this.h; y++) {
      for (let x = 0; x < this.w; x++) {
        if (this.color[y * this.w + x] === 0) continue;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
    if (x1 < 0) return null;
    return { x0, y0, x1, y1 };
  }

  isEmpty() {
    for (let i = 0; i < this.n; i++) if (this.color[i]) return false;
    return true;
  }

  /* ---------- wire format ---------- */

  toSnapshot(seqFloor) {
    return {
      w: this.w,
      h: this.h,
      cells: bytesToB64(this.color),
      seq: seqFloor ?? this._maxSeq(),
      version: this.version,
      checksum: this.checksum(),
    };
  }

  _maxSeq() {
    return this.maxSeq();
  }

  /**
   * Adopt a snapshot wholesale. This is also the repair path when a peer's
   * picture drifts away from the room's.
   */
  applySnapshot(s) {
    const w = s.w | 0;
    const h = s.h | 0;
    if (!(w > 0 && h > 0) || w * h > 256 * 256) {
      throw new Error(`bad snapshot size ${w}x${h}`);
    }
    const bytes = b64ToBytes(s.cells);
    if (bytes.length !== w * h) {
      throw new Error(`snapshot length ${bytes.length} != ${w * h} cells`);
    }
    if (w !== this.w || h !== this.h) this.resize(w, h);
    this.color.set(bytes);
    // Everything in the snapshot is older than anything we do next.
    this.seq.fill(s.seq | 0);
    this.slot.fill(SLOT_SNAPSHOT);
    this.version = s.version | 0;
    return true;
  }

  /**
   * Fill a Uint32 view of an RGBA buffer from the palette.
   * Little-endian packing: byte0=R, byte1=G, byte2=B, byte3=A.
   * @param {Uint8Array} [cells] another cell buffer of the same size, so the
   *   screen can show a lagging copy while `color` stays the room's truth.
   */
  fillRGBA(u32, cells) {
    const src = cells || this.color;
    const table = Grid._rgbaTable || (Grid._rgbaTable = buildRGBATable());
    const n = Math.min(this.n, u32.length);
    for (let i = 0; i < n; i++) u32[i] = table[src[i]];
  }
}

function buildRGBATable() {
  const t = new Uint32Array(FLAT_COLORS.length);
  for (let c = 0; c < FLAT_COLORS.length; c++) {
    const hex = FLAT_COLORS[c];
    if (!hex) {
      t[c] = 0; // untouched board -> transparent, paper shows through
      continue;
    }
    const n = parseInt(hex.slice(1), 16);
    const r = (n >> 16) & 255;
    const g = (n >> 8) & 255;
    const b = n & 255;
    t[c] = (255 << 24) | (b << 16) | (g << 8) | r;
  }
  return t;
}

/**
 * Rasterise a brush stroke segment into cell indices.
 * Marches in half-cell steps so fast drags never leave holes, then applies the
 * brush footprint. Returns deduplicated, in paint order.
 */
export function strokeCells(grid, x0, y0, x1, y1, brush) {
  const offs = brushOffsets(brush);
  const out = [];
  const dist = Math.hypot(x1 - x0, y1 - y0);
  const steps = Math.max(1, Math.ceil(dist * 2));
  grid._stamp++;
  const stamp = grid._stamp;
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    // floor, not round: the sample is a position, and it belongs to the cell it
    // falls inside - cell n spans [n, n+1).
    const cx = Math.floor(x0 + (x1 - x0) * t);
    const cy = Math.floor(y0 + (y1 - y0) * t);
    for (const dy of offs) {
      for (const dx of offs) {
        const x = cx + dx;
        const y = cy + dy;
        if (!grid.inBounds(x, y)) continue;
        const i = y * grid.w + x;
        if (grid._scratch[i] === stamp) continue;
        grid._scratch[i] = stamp;
        out.push(i);
      }
    }
  }
  return out;
}

/**
 * The cells one dab of a shaped brush covers when stamped at every seed, as
 * flat indices: in bounds, deduplicated, in paint order. One scratch pass - a
 * fast drag with a big tip can push a few hundred thousand candidates through
 * here per pointer event, so this must not build pair arrays or string keys.
 * Shares strokeCells' scratch: every call takes a fresh stamp from the same
 * counter, so no call can mistake another call's marks for its own.
 * @param {Array<[number, number]>} seeds  seed positions, floored here
 * @param {Array<[number, number]>} offsets  dab offsets from roundOffsets/stampOffsets
 */
export function dabCells(grid, seeds, offsets) {
  const out = [];
  grid._stamp++;
  const stamp = grid._stamp;
  for (const [sx, sy] of seeds) {
    const cx = Math.floor(sx);
    const cy = Math.floor(sy);
    for (const [dx, dy] of offsets) {
      const x = cx + dx;
      const y = cy + dy;
      if (!grid.inBounds(x, y)) continue;
      const i = y * grid.w + x;
      if (grid._scratch[i] === stamp) continue;
      grid._scratch[i] = stamp;
      out.push(i);
    }
  }
  return out;
}

export function brushOffsets(brush) {
  const a = [];
  const half = (brush - 1) / 2;
  for (let i = 0; i < brush; i++) a.push(Math.round(i - half) + 0); // +0 normalises -0
  return a;
}
