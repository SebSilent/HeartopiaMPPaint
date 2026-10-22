/*
 * What you see, a moment behind what is true.
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
 */

import CONFIG from '../config.js';

export class StrokeDisplay {
  constructor(room, opts = {}) {
    this.room = room;
    this.grid = room.grid;
    this.delayMs = opts.delayMs ?? CONFIG.smooth.delayMs;
    this.spreadMs = opts.spreadMs ?? CONFIG.smooth.spreadMs;
    this.backlogCells = opts.backlogCells ?? CONFIG.smooth.backlogCells;
    this.cells = new Uint8Array(this.grid.color.length);
    this.queue = [];
    this.waiting = 0;
    this.sync();
  }

  /** Show these cells now. */
  reveal(indices) {
    const src = this.grid.color;
    const dst = this.cells;
    for (let k = 0; k < indices.length; k++) {
      const i = indices[k];
      if (i >= 0 && i < dst.length) dst[i] = src[i];
    }
  }

  /** Make the picture exactly the truth, and stop animating. */
  sync() {
    if (this.cells.length !== this.grid.color.length) this.cells = new Uint8Array(this.grid.color.length);
    this.cells.set(this.grid.color);
    this.queue = [];
    this.waiting = 0;
  }

  /** Queue a remote burst for slow release. `msg.rt` is room time on the sender's side. */
  add(cells, msg) {
    if (!cells || !cells.length) return;
    const rt = Number.isFinite(msg.rt) ? msg.rt : this.room.clock.now();
    this.queue.push({ cells, due: rt + this.delayMs, done: 0 });
    this.waiting += cells.length;
    // Falling further and further behind beats no smoothing at all.
    if (this.waiting > this.backlogCells) this.tick(this.room.clock.now(), true);
  }

  /**
   * Release whatever has come due. Call once per frame, before compositing.
   * @returns {number} cells revealed
   */
  tick(now = this.room.clock.now(), force = false) {
    if (!this.queue.length) return 0;
    const had = this.queue.length;
    const keep = [];
    let revealed = 0;

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
        this.reveal(to >= total ? op.cells.slice(op.done) : op.cells.slice(op.done, to));
        revealed += to - op.done;
        op.done = to;
      }
      if (op.done < total) keep.push(op);
    }

    this.queue = keep;
    this.waiting = 0;
    for (const op of keep) this.waiting += op.cells.length - op.done;

    // Nothing left to animate: the copy is done, so make that exact rather than
    // approximate. One memcpy, and no risk of a cell left behind by a skipped
    // frame or a clock jump.
    if (!keep.length && had && this.cells.length === this.grid.color.length) {
      this.cells.set(this.grid.color);
    }
    return revealed;
  }

  /** The board was replaced under us - match it immediately. */
  drop() {
    this.sync();
  }
}
