/*
 * What you see, a moment behind what is true - one copy per face.
 *
 * A stroke arrives as a burst: the sender flushes whatever it collected in the
 * last ~50 ms in one packet, and a real link then delivers three of those at
 * once and none for a while. Painting each packet the instant it lands reads as
 * someone drawing in clumps.
 *
 * So the grid and the screen are split apart.
 *
 *   grid.color    - the room's truth. Updated the moment a packet lands, on
 *                   every machine, host included. Checksums, snapshots and a
 *                   host handover all read this, so nothing that has to be
 *                   correct is ever waiting on an animation.
 *   display.cells - a copy of it, released on schedule. This is what is drawn.
 *
 * Releasing means copying the *current* value out of the grid, not replaying the
 * old colour. If something newer has since been painted over that cell, the
 * screen shows the newer thing, and the picture can only ever converge on the
 * truth - it cannot strand a stale pixel. When the queue empties, the copy is
 * finished and the two buffers are identical by construction.
 *
 * Your own strokes skip the schedule entirely (room.paintLocal reveals them on
 * the same call), so the pen is always instant.
 *
 * A design has as many faces as the item does - four for a T-shirt - and each
 * one gets its own copy and its own queue, because a guest painting a sleeve
 * while you paint the front is two independent animations, not one.
 */

import CONFIG from '../config.js';

export class StrokeDisplay {
  constructor(design, opts = {}) {
    this.design = design;
    this.delayMs = opts.delayMs ?? CONFIG.smooth.delayMs;
    this.spreadMs = opts.spreadMs ?? CONFIG.smooth.spreadMs;
    this.backlogCells = opts.backlogCells ?? CONFIG.smooth.backlogCells;
    this.queue = [];
    this.waiting = 0;
    this.cells = [];
    this.syncAll();
  }

  /** The display buffer for one face, grown if that face just appeared. */
  cellsFor(i) {
    const g = this.design.faceAt(i);
    if (!g) return null;
    let b = this.cells[i];
    if (!b || b.length !== g.n) {
      b = new Uint8Array(g.n);
      this.cells[i] = b;
    }
    return b;
  }

  /** Show these cells now. */
  reveal(face, indices) {
    const g = this.design.faceAt(face);
    const dst = this.cellsFor(face);
    if (!g || !dst) return;
    const src = g.color;
    for (let k = 0; k < indices.length; k++) {
      const i = indices[k];
      if (i >= 0 && i < dst.length) dst[i] = src[i];
    }
  }

  /** Make one face's picture exactly the truth, and drop anything queued for it. */
  sync(face) {
    const g = this.design.faceAt(face);
    const dst = this.cellsFor(face);
    if (!g || !dst) return;
    dst.set(g.color);
    this.queue = this.queue.filter((op) => op.face !== face);
    this.waiting = this.queue.reduce((n, op) => n + op.cells.length - op.done, 0);
  }

  syncAll() {
    for (let i = 0; i < this.design.faces.length; i++) this.sync(i);
  }

  /** Queue a remote burst for slow release. `msg.rt` is room time on the sender's side. */
  add(face, cells, msg) {
    if (!cells || !cells.length) return;
    const rt = Number.isFinite(msg.rt) ? msg.rt : this.design.now ? this.design.now() : Date.now();
    this.queue.push({ face, cells, due: rt + this.delayMs, done: 0 });
    this.waiting += cells.length;
    // Falling further and further behind beats no smoothing at all.
    if (this.waiting > this.backlogCells) this.tick(rt, true);
  }

  /**
   * Release whatever has come due. Call once per frame, before compositing.
   * @returns {number} how many faces changed
   */
  tick(now = Date.now(), force = false) {
    if (!this.queue.length) return 0;
    const had = this.queue.length;
    const keep = [];
    const touched = new Set();

    for (const op of this.queue) {
      const total = op.cells.length;
      if (!force && now < op.due) {
        keep.push(op);
        continue;
      }
      const elapsed = now - op.due;
      const to =
        force || elapsed >= this.spreadMs ? total : Math.max(1, Math.ceil((total * elapsed) / this.spreadMs));
      if (to > op.done) {
        this.reveal(op.face, to >= total ? op.cells.slice(op.done) : op.cells.slice(op.done, to));
        touched.add(op.face);
        op.done = to;
      }
      if (op.done < total) keep.push(op);
    }

    this.queue = keep;
    this.waiting = 0;
    for (const op of keep) this.waiting += op.cells.length - op.done;

    // Nothing left to animate: the copy is done, so make that exact rather than
    // approximate. One memcpy per face, and no risk of a cell left behind by a
    // skipped frame or a clock jump.
    if (!keep.length && had) {
      for (let i = 0; i < this.design.faces.length; i++) {
        const g = this.design.faceAt(i);
        const dst = this.cells[i];
        if (g && dst && dst.length === g.n) {
          dst.set(g.color);
          touched.add(i);
        }
      }
    }
    return touched.size;
  }

  /** The whole design was replaced under us - match it immediately. */
  drop() {
    this.syncAll();
  }
}
