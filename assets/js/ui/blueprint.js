/*
 * Blueprint mode: the half of this app that is not painting.
 *
 * A Heartopia board is keyed into the game one cell at a time, by hand, with
 * the game's own pen. So the useful output of a design is not only a picture,
 * it is a *worksheet*: which shades are in use, how many cells each one is,
 * and how far along you are. Art-pia built their whole business on that and
 * charge for it; here it is a toggle, because we are the version where several
 * people can do the keying-in at once.
 *
 * Two work modes, exactly as the game needs them:
 *
 *   blocks - the board becomes a grid of 5/10/20-cell blocks. You fill one
 *            block, tick it, and never lose your place. Recommended for big
 *            faces, which is most of them: a dress front is 102x154.
 *   colour - the whole face at once, but only one shade is lit and everything
 *            else fades. You do all the dark green, then all the light green.
 *
 * Block progress is shared: it is part of the room, so two people splitting a
 * duvet never both do the same corner.
 */

import { FLAT_COLORS, HEARTOPIA_GROUPS } from '../data/heartopia-palette.js';
import { bytesToB64, readableInk } from '../util.js';

export const MODES = ['off', 'block', 'colour'];
export const BLOCK_SIZES = [5, 10, 20];

export class Blueprint {
  constructor(room) {
    this.room = room;
    this.mode = 'off';
    this.block = 10;
    this.done = new Map(); // face -> Uint8Array of flags
    this.pulse = null; // {x,y,at} - the cell you just tapped
    this.focus = null; // shade index isolated in colour mode
    this._off = [];
    this._bind();
  }

  _bind() {
    const r = this.room;
    this._off.push(
      r.on('blocks', ({ face, flags }) => {
        this.done.set(face, flags);
        r.emit('blueprint', {});
      }),
      // A new item has a different number of faces; stale progress is worse
      // than none.
      r.on('design', () => {
        this.done.clear();
        r.emit('blueprint', {});
      })
    );
  }

  destroy() {
    for (const off of this._off) off();
  }

  get on() {
    return this.mode !== 'off';
  }

  setMode(m) {
    this.mode = MODES.includes(m) ? m : 'off';
    if (this.mode === 'colour' && this.focus == null) this.focus = this.room.design.grid.color[0] || null;
    this.room.emit('blueprint', { mode: this.mode });
  }

  setBlock(n) {
    this.block = BLOCK_SIZES.includes(n) ? n : 10;
    this.done.clear();
    this.room.emit('blueprint', { block: this.block });
  }

  /** Block grid for the face on screen. */
  layout(faceIdx = this.room.design.active) {
    const g = this.room.design.faceAt(faceIdx);
    return {
      w: Math.ceil(g.w / this.block),
      h: Math.ceil(g.h / this.block),
      n: Math.ceil(g.w / this.block) * Math.ceil(g.h / this.block),
    };
  }

  flags(faceIdx = this.room.design.active) {
    const { n } = this.layout(faceIdx);
    let f = this.done.get(faceIdx);
    if (!f || f.length !== n) {
      f = new Uint8Array(n);
      this.done.set(faceIdx, f);
    }
    return f;
  }

  /**
   * Tick the block under the cursor, falling back to the newest cell you
   * painted. Scanning backwards from the end is the right way round: on a
   * nearly-finished duvet, finding the last painted cell by scanning forwards
   * would cost 32k reads per keystroke.
   */
  toggleLast(faceIdx = this.room.design.active) {
    const g = this.room.design.faceAt(faceIdx);
    let cell = this.pulse ? this.pulse.y * g.w + this.pulse.x : null;
    if (cell == null || !g.color[cell]) {
      cell = null;
      for (let i = g.n - 1; i >= 0; i--) {
        if (g.color[i]) {
          cell = i;
          break;
        }
      }
    }
    if (cell == null) return false;
    const x = cell % g.w;
    const y = (cell / g.w) | 0;
    return this.toggle(Math.floor(x / this.block), Math.floor(y / this.block), faceIdx);
  }

  toggle(bx, by, faceIdx = this.room.design.active) {
    const L = this.layout(faceIdx);
    if (bx < 0 || by < 0 || bx >= L.w || by >= L.h) return false;
    const f = this.flags(faceIdx);
    const i = by * L.w + bx;
    f[i] = f[i] ? 0 : 1;
    this._publish(faceIdx, f);
    return true;
  }

  /** Which block a cell falls in, or null. */
  blockAt(x, y, faceIdx = this.room.design.active) {
    if (this.mode !== 'block') return null;
    return { bx: Math.floor(x / this.block), by: Math.floor(y / this.block) };
  }

  _publish(faceIdx, f) {
    this.room.sendBlocks(faceIdx, bytesToB64(f));
  }

  /** Cells left in unfinished blocks - the honest "how much is to go". */
  remaining(faceIdx = this.room.design.active) {
    const g = this.room.design.faceAt(faceIdx);
    const f = this.flags(faceIdx);
    const L = this.layout(faceIdx);
    let left = 0;
    for (let y = 0; y < g.h; y++) {
      for (let x = 0; x < g.w; x++) {
        if (!g.color[y * g.w + x]) continue;
        const bx = Math.floor(x / this.block);
        const by = Math.floor(y / this.block);
        if (!f[by * L.w + bx]) left++;
      }
    }
    return left;
  }

  /**
   * The numbered shade list: only colours actually on the board, in the order
   * you would want to key them in - most cells first.
   */
  legend(faceIdx = this.room.design.active) {
    const g = this.room.design.faceAt(faceIdx);
    const counts = new Map();
    for (let i = 0; i < g.n; i++) {
      const c = g.color[i];
      if (c) counts.set(c, (counts.get(c) || 0) + 1);
    }
    return [...counts.entries()]
      .map(([idx, n]) => ({ idx, hex: FLAT_COLORS[idx] || '#ffffff', n, group: groupOf(idx) }))
      .sort((a, b) => b.n - a.n || a.idx - b.idx);
  }

  highlight(x, y) {
    const g = this.room.design.grid;
    const cx = Math.floor(x);
    const cy = Math.floor(y);
    if (!g.inBounds(cx, cy)) {
      this.pulse = null;
      return null;
    }
    this.pulse = { x: cx, y: cy, color: g.color[cy * g.w + cx], at: Date.now() };
    this.room.emit('blueprint', { pulse: this.pulse });
    return this.pulse;
  }

  /* ---------- drawing ---------- */

  draw(ctx, view) {
    if (!this.on) return;
    const g = view.grid;
    const r = view.boardRectCss();
    ctx.save();

    if (this.mode === 'colour' && this.focus != null) {
      // Fade everything that is not the shade you are keying in.
      ctx.fillStyle = 'rgba(255,255,255,0.78)';
      ctx.fillRect(r.x, r.y, r.w, r.h);
      for (let y = 0; y < g.h; y++) {
        for (let x = 0; x < g.w; x++) {
          if (g.color[y * g.w + x] !== this.focus) continue;
          const p = view.toScreen(x, y);
          ctx.fillStyle = FLAT_COLORS[this.focus] || '#000';
          ctx.fillRect(p.x, p.y, view.scale, view.scale);
        }
      }
    }

    if (this.mode === 'block') {
      const L = this.layout(view.faceIndex);
      const f = this.flags(view.faceIndex);
      ctx.lineWidth = 2;
      for (let by = 0; by < L.h; by++) {
        for (let bx = 0; bx < L.w; bx++) {
          const x0 = bx * this.block;
          const y0 = by * this.block;
          const x1 = Math.min(g.w, x0 + this.block);
          const y1 = Math.min(g.h, y0 + this.block);
          const a = view.toScreen(x0, y0);
          const b = view.toScreen(x1, y1);
          const done = !!f[by * L.w + bx];
          ctx.strokeStyle = done ? 'rgba(64,182,120,0.9)' : 'rgba(40,28,14,0.55)';
          ctx.strokeRect(a.x + 1, a.y + 1, b.x - a.x - 2, b.y - a.y - 2);
          if (done) {
            ctx.fillStyle = 'rgba(64,182,120,0.16)';
            ctx.fillRect(a.x + 1, a.y + 1, b.x - a.x - 2, b.y - a.y - 2);
          }
          // A block number only helps if it is big enough to read.
          if (b.x - a.x > 26) {
            const n = by * L.w + bx + 1;
            ctx.font = '600 10px ui-rounded, system-ui, sans-serif';
            ctx.fillStyle = 'rgba(40,28,14,0.7)';
            ctx.fillText(String(n), a.x + 4, a.y + 12);
          }
        }
      }
    }

    if (this.pulse) {
      const age = Date.now() - this.pulse.at;
      if (age < 2600) {
        const a = view.toScreen(this.pulse.x, this.pulse.y);
        ctx.strokeStyle = '#ea696d';
        ctx.lineWidth = 2.5;
        ctx.strokeRect(a.x - 1, a.y - 1, view.scale + 2, view.scale + 2);
        ctx.font = '700 11px ui-rounded, system-ui, sans-serif';
        const text = `${this.pulse.x},${this.pulse.y} · ${FLAT_COLORS[this.pulse.color] || 'empty'}`;
        const w = ctx.measureText(text).width;
        ctx.fillStyle = 'rgba(36,26,16,0.88)';
        ctx.fillRect(a.x, a.y - 17, w + 10, 15);
        ctx.fillStyle = '#fffdf7';
        ctx.fillText(text, a.x + 5, a.y - 6);
      }
    }
    ctx.restore();
  }
}

const GROUP_LENS = HEARTOPIA_GROUPS.map((g) => g.colors.length);

/** Flat shade index (1..125) -> which colour group holds it. */
function groupOf(idx) {
  let start = 1;
  for (let i = 0; i < GROUP_LENS.length; i++) {
    if (idx >= start && idx < start + GROUP_LENS[i]) return i;
    start += GROUP_LENS[i];
  }
  return 0;
}

export { readableInk };
