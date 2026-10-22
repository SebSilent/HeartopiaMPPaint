/*
 * Remote stroke pacing.
 *
 * A stroke arrives as a burst: the sender flushes whatever it collected in the
 * last ~50 ms in one packet, and a real link then delivers three of those at
 * once and none for a while. Applied as they land, that reads as someone
 * painting in clumps.
 *
 * So we replay it instead. Each burst waits a fixed `delayMs` behind room time,
 * then paints in over `spreadMs`. What you see is a line being drawn, not a
 * line appearing. The whole cost is the delay - about a tenth of a second, and
 * only on other people's strokes.
 *
 * Your own pen never waits. And because the grid is last-writer-wins on
 * (lamport, slot), a burst that lands late cannot stomp on something drawn
 * after it - those cells are simply rejected. Smoothing is allowed to be lazy
 * precisely because the model does not care about arrival order.
 */

import CONFIG from '../config.js';

export class StrokePacer {
  constructor(room, opts = {}) {
    this.room = room;
    this.delayMs = opts.delayMs ?? CONFIG.smooth.delayMs;
    this.spreadMs = opts.spreadMs ?? CONFIG.smooth.spreadMs;
    this.backlogCells = opts.backlogCells ?? CONFIG.smooth.backlogCells;
    this.queue = [];
    this.waiting = 0;
  }

  /** Take one burst off the wire. `msg.rt` is room time on the sender's side. */
  add(cells, msg, slot) {
    if (!cells || !cells.length) return;
    const rt = Number.isFinite(msg.rt) ? msg.rt : this.room.clock.now();
    const op = { cells, color: msg.c | 0, seq: msg.seq | 0, slot, due: rt + this.delayMs, done: 0 };
    this.queue.push(op);
    this.waiting += cells.length;
    // Falling further and further behind beats no smoothing at all, so once the
    // backlog is past the point where it would be visible we just drain it.
    if (this.waiting > this.backlogCells) this.tick(this.room.clock.now(), true);
  }

  /**
   * Draw everything that has come due. Called once per frame, before the board
   * is composited, so a paced cell lands in the frame it is released in.
   * @returns {number} cells applied
   */
  tick(now = this.room.clock.now(), force = false) {
    if (!this.queue.length) return 0;
    const keep = [];
    let applied = 0;

    for (const op of this.queue) {
      const total = op.cells.length;
      if (!force && now < op.due) {
        keep.push(op);
        continue;
      }
      const elapsed = now - op.due;
      const shown =
        force || elapsed >= this.spreadMs
          ? total
          : Math.max(1, Math.ceil((total * elapsed) / this.spreadMs));
      if (shown > op.done) {
        const slice = shown >= total ? op.cells.slice(op.done) : op.cells.slice(op.done, shown);
        op.done += slice.length;
        applied += this.room.paintRemote(slice, op.color, op.seq, op.slot);
      }
      if (op.done < total) keep.push(op);
    }

    this.queue = keep;
    this.waiting = 0;
    for (const op of keep) this.waiting += op.cells.length - op.done;
    return applied;
  }

  /** Stop pretending and draw it all. Used when we become the authority. */
  flush() {
    this.tick(this.room.clock.now(), true);
  }

  /** Forget everything. Used when the board is replaced under our feet. */
  drop() {
    this.queue = [];
    this.waiting = 0;
  }
}
