/*
 * A design is the set of faces a Heartopia item exposes, each with its own
 * grid. This is the object the room syncs.
 *
 * It used to be one grid, because one canvas is one grid. Once a T-shirt is
 * four grids of two different shapes, "the board" stops being a single thing -
 * so the room gained a face axis on every op, snapshot and checksum, and this
 * class became the single place that knows how many faces there are.
 *
 * DOM-free on purpose: server/relay.js imports it unchanged.
 */

import { Grid } from './grid.js';
import { findItem, boardForItem, itemIdForBoard } from './slots.js';
import { fnv1a } from '../util.js';

/**
 * A one-grid stand-in that speaks the same face axis as a real Design, for
 * tests and for any caller that only ever deals with a single board. It is
 * deliberately not a `Grid`: code written against a Design must be able to run
 * against this without the stub quietly diverging from the real thing.
 */
export class SingleFaceDesign {
  constructor(grid, active = 0) {
    this._grid = grid;
    this.active = active;
    this.faces = [grid];
    this.version = 0;
    // Callers read design.item for names and face metadata. A grid has no
    // catalogue entry, so it describes itself: one face, nothing to label.
    this.item = {
      id: grid.id || 'single',
      name: 'Board',
      family: 'canvas',
      faces: [{ id: 'main', label: 'Board', w: grid.w, h: grid.h }],
    };
  }

  get id() {
    return this.item.id;
  }

  faceAt(i) {
    return i === this.active ? this._grid : null;
  }

  get w() {
    return this._grid.w;
  }

  get h() {
    return this._grid.h;
  }

  paint(indices, colorIdx, seq, slot, faceIdx = this.active) {
    if (faceIdx !== this.active) return 0;
    this.version++;
    return this._grid.paint(indices, colorIdx, seq, slot);
  }
}

export class Design {
  /** @param {string} itemId  an id from slots.js */
  constructor(itemId) {
    this.setItem(itemId, true);
    this.version = 0;
  }

  /* ---------- identity ---------- */

  get id() {
    return this.item.id;
  }

  get family() {
    return this.item.family;
  }

  /** Canvas designs still speak the old {ratio, level} language for the UI. */
  get board() {
    return boardForItem(this.item.id) || { ratio: '1:1', level: 1 };
  }

  setItem(itemId, keep = false) {
    const item = findItem(itemId);
    if (!item) throw new Error(`unknown design "${itemId}"`);
    if (keep && this.item && this.item.id === item.id) return;
    this.item = item;
    this.faces = item.faces.map((f) => new Grid(f.w, f.h));
    this.active = 0;
    this.guides = item.faces.map(() => []);
    this.version++;
  }

  /** Old rooms announced {ratio, level}; that maps to exactly one canvas item. */
  static fromBoard(ratio, level) {
    return new Design(itemIdForBoard(ratio, level));
  }

  /* ---------- faces ---------- */

  get face() {
    return this.item.faces[this.active];
  }

  /** The grid you are looking at right now. */
  get grid() {
    return this.faces[this.active];
  }

  get w() {
    return this.grid.w;
  }

  get h() {
    return this.grid.h;
  }

  setActive(i) {
    const n = this.faces.length;
    this.active = ((i % n) + n) % n;
    return this.face;
  }

  faceAt(i) {
    return this.faces[i] || null;
  }

  /* ---------- writing ---------- */

  paint(indices, colorIdx, seq, slot, faceIdx = this.active) {
    const g = this.faces[faceIdx];
    if (!g) return 0;
    const changed = g.paint(indices, colorIdx, seq, slot);
    this.version++;
    return changed;
  }

  clearAll(seq, slot) {
    for (const g of this.faces) g.clearAll(seq, slot);
    this.version++;
  }

  /* ---------- reading ---------- */

  /**
   * One hash for the whole design, not per face. Peers compare this to notice
   * drift; if it were per face, a guest would have to ask which face disagreed.
   */
  checksum() {
    if (this.faces.length === 1) return this.faces[0].checksum();
    let total = 0;
    for (const g of this.faces) total += g.n;
    const joined = new Uint8Array(total);
    let off = 0;
    for (const g of this.faces) {
      joined.set(g.color, off);
      off += g.n;
    }
    return fnv1a(joined);
  }

  /** Cells painted across every face - the "is this blank" check. */
  usedCells() {
    let n = 0;
    for (const g of this.faces) for (let i = 0; i < g.n; i++) if (g.color[i]) n++;
    return n;
  }

  isEmpty() {
    return this.usedCells() === 0;
  }

  /** Which palette indices appear anywhere in the design, and how often. */
  usage() {
    const counts = new Map();
    for (const g of this.faces) {
      for (let i = 0; i < g.n; i++) {
        const c = g.color[i];
        if (!c) continue;
        counts.set(c, (counts.get(c) || 0) + 1);
      }
    }
    return counts;
  }

  /* ---------- wire ---------- */

  toSnapshot(seqFloor) {
    return {
      item: this.item.id,
      active: this.active,
      faces: this.faces.map((g) => ({ w: g.w, h: g.h, cells: g.cellsB64() })),
      seq: seqFloor ?? this.maxSeq(),
      version: this.version,
      checksum: this.checksum(),
    };
  }

  maxSeq() {
    let m = 0;
    for (const g of this.faces) m = Math.max(m, g.maxSeq());
    return m;
  }

  /**
   * Adopt a snapshot. If it describes a different item the design is rebuilt to
   * match, because the room's item is the truth, not whatever we picked.
   */
  applySnapshot(s) {
    if (!s || !Array.isArray(s.faces) || !s.faces.length) throw new Error('snapshot has no faces');
    if (typeof s.item === 'string' && s.item !== this.item.id && findItem(s.item)) {
      this.setItem(s.item);
    }
    if (s.faces.length !== this.faces.length) {
      // The wire is describing an item we do not know. Refuse rather than
      // half-apply: a silent mismatch here is a permanently desynced room.
      throw new Error(`snapshot has ${s.faces.length} faces, design has ${this.faces.length}`);
    }
    const seq = s.seq | 0;
    for (let i = 0; i < s.faces.length; i++) {
      const f = s.faces[i];
      const g = this.faces[i];
      if (g.w !== (f.w | 0) || g.h !== (f.h | 0)) {
        throw new Error(`face ${i} is ${f.w}x${f.h}, expected ${g.w}x${g.h}`);
      }
      g.setCells(f.cells);
      g.seq.fill(seq);
      g.slot.fill(0);
    }
    if (typeof s.active === 'number') this.active = Math.max(0, Math.min(this.faces.length - 1, s.active | 0));
    this.version = s.version | 0;
    return true;
  }

  /* ---------- guide lines (not pixels: an underlay you draw over) ---------- */

  setGuides(faceIdx, lines) {
    this.guides[faceIdx] = lines;
    this.version++;
  }
}
