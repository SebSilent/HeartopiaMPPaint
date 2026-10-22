/*
 * Input.
 *
 * Pointer Events give one code path for mouse, pen and touch, and the pointer
 * *type* is remembered per pointer id - that is how a remote player's cursor is
 * drawn as an arrow, a nib or a finger.
 *
 * Gestures follow what an iPad user already expects, so there is no "hand
 * tool" to discover:
 *
 *   one finger   paints
 *   two fingers  pinch to zoom, drag to pan (the finger stroke is committed
 *                first, so nothing you had already drawn disappears)
 *   Apple Pencil  always paints; touch pointers are ignored while the pencil
 *                is down, which is palm rejection
 *   mouse        left drag paints, middle/right or Space+drag pans,
 *                wheel zooms, ctrl+wheel changes brush size
 *
 * A stroke gets one lamport stamp when it begins and keeps it for every batch,
 * so what we paint locally is byte-for-byte what the room replays.
 */

import { strokeCells } from './game/grid.js';
import { clamp, throttle } from './util.js';
import { FLAT_COLORS } from './data/heartopia-palette.js';
import CONFIG from './config.js';

export const TOOLS = {
  BRUSH: 'brush',
  ERASER: 'eraser',
  PICK: 'pick',
};

const FLUSH_CELLS = 12;
const FLUSH_MS = 55;

/**
 * Resolve what a stroke paints.
 *
 * The grid stores a palette *index* in a Uint8Array. Handing it the player's
 * identity hex instead silently coerces to 0, which is "empty", so the stroke
 * appears to draw nothing at all and no error is thrown anywhere. That mistake
 * shipped once, so it is now checked here rather than assumed.
 */
export function paintColorFor(state, tool = state.tool) {
  if (tool === TOOLS.ERASER) return 0;
  const idx = state.colorIdx;
  if (typeof idx !== 'number' || !Number.isInteger(idx)) {
    throw new TypeError(`paint colour must be a palette index, got ${JSON.stringify(idx)}`);
  }
  if (idx < 0 || idx >= FLAT_COLORS.length) {
    throw new RangeError(`palette index ${idx} is out of range`);
  }
  return idx;
}

export class Input {
  constructor({ room, view, getState, setState }) {
    this.room = room;
    this.view = view;
    this.getState = getState;
    this.setState = setState;
    this.strokes = new Map(); // pointerId -> stroke
    this.touches = new Map(); // pointerId -> {x,y} live touch points
    this.pinch = null;
    this.pan = null;
    this.hover = null;
    this._pointers = new Map();
    this._el = view.base.parentElement;
    this._off = [];
    this._spaceHeld = false;
    this._bind();
    this._flushOut = throttle(() => this._sendPointers(), 1000 / CONFIG.timings.cursorHz);
    this._timer = setInterval(() => {
      for (const pid of this.strokes.keys()) this._flush(pid);
    }, FLUSH_MS);
    view.onFrame((ctx, v) => this.drawPreview(ctx, v));
  }

  _bind() {
    const el = this._el;
    const add = (type, fn, opts) => {
      el.addEventListener(type, fn, opts);
      this._off.push(() => el.removeEventListener(type, fn, opts));
    };

    if (!window.PointerEvent) {
      el.insertAdjacentHTML(
        'beforeend',
        '<div class="compat-warn">This browser is too old for Pointer Events. Try a current Chrome, Firefox, Safari or Edge.</div>'
      );
      return;
    }

    add('pointerdown', (e) => this.onDown(e));
    add('pointermove', (e) => this.onMove(e));
    add('pointerup', (e) => this.onUp(e));
    add('pointercancel', (e) => this.onUp(e));
    add('pointerleave', (e) => {
      this._pointers.delete(e.pointerId);
      if (e.pointerType === 'mouse') this.hover = null;
    });

    add(
      'wheel',
      (e) => {
        e.preventDefault();
        const st = this.getState();
        if (e.ctrlKey || e.metaKey) {
          const sizes = st.brushSizes;
          const i = sizes.indexOf(st.brush);
          this.setState({ brush: sizes[clamp(i + (e.deltaY < 0 ? 1 : -1), 0, sizes.length - 1)] });
        } else {
          const r = this.view.rect;
          // View emits the new zoom, so the readout follows wheel, pinch and buttons alike.
          this.view.zoomBy(Math.exp(-e.deltaY * 0.0016), e.clientX - r.left, e.clientY - r.top);
        }
      },
      { passive: false }
    );

    add('keydown', (e) => {
      if (e.code === 'Space' && !e.repeat && !this._inField(e)) {
        this._spaceHeld = true;
        e.preventDefault();
      }
    });
    add('keyup', (e) => {
      if (e.code === 'Space') this._spaceHeld = false;
    });
    add('contextmenu', (e) => e.preventDefault());
  }

  _inField(e) {
    const t = e.target;
    return t && t.matches && t.matches('input, textarea');
  }

  destroy() {
    for (const fn of this._off) fn();
    this._off = [];
    clearInterval(this._timer);
  }

  /* ---------- helpers ---------- */

  _penDown() {
    for (const s of this.strokes.values()) if (s.type === 'pen') return true;
    return false;
  }

  _beginStroke(pid, cell, type) {
    const st = this.getState();
    if (st.tool === TOOLS.PICK) {
      const c = this.room.grid.colorAt(Math.floor(cell.x), Math.floor(cell.y));
      if (c > 0) this.setState({ colorIdx: c });
      return;
    }
    if (!this.room.canPaint) {
      this.room.emit('blocked');
      return;
    }
    this.strokes.set(pid, {
      seq: this.room.nextSeq(),
      color: paintColorFor(st),
      brush: st.brush,
      last: { x: cell.x, y: cell.y },
      sent: new Set(),
      wire: [],
      type,
    });
    this._paint(pid, cell.x, cell.y, cell.x, cell.y);
    this._flush(pid);
  }

  /* ---------- flow ---------- */

  onDown(e) {
    e.preventDefault();
    this.view.measure();
    const pid = e.pointerId;
    const type = e.pointerType || 'mouse';
    const cell = this.view.toCell(e.clientX, e.clientY);

    if (type === 'touch') {
      // A resting palm must not paint, zoom or broadcast a cursor while the
      // pencil is doing the real work.
      if (this._penDown()) return;
      this.touches.set(pid, { x: e.clientX, y: e.clientY });
      this._pointers.set(pid, { x: cell.x, y: cell.y, type, down: true });
      if (this.touches.size >= 2) {
        this._commitTouchStrokes();
        this._startPinch();
        this._flushOut();
        return;
      }
      this._beginStroke(pid, cell, type);
      this._flushOut();
      return;
    }

    this._pointers.set(pid, { x: cell.x, y: cell.y, type, down: true });

    if (type === 'pen') {
      this._beginStroke(pid, cell, type);
      this._flushOut();
      return;
    }

    // mouse
    if (this._spaceHeld || e.button === 1 || e.button === 2) {
      this.pan = { pid, x: e.clientX, y: e.clientY };
      this._flushOut();
      return;
    }
    if (e.button !== 0) return;
    this._beginStroke(pid, cell, type);
    this._flushOut();
  }

  onMove(e) {
    const pid = e.pointerId;
    const type = e.pointerType || 'mouse';
    const cell = this.view.toCell(e.clientX, e.clientY);

    if (type === 'touch' && this._penDown()) return;

    if (this.touches.has(pid)) this.touches.set(pid, { x: e.clientX, y: e.clientY });

    if (this._pointers.has(pid)) {
      const s = this.strokes.get(pid);
      this._pointers.set(pid, { x: cell.x, y: cell.y, type, down: !!s || !!this.pan });
      this._flushOut();
    }

    if (this.pinch && type === 'touch') {
      this._updatePinch();
      return;
    }
    if (this.pan && this.pan.pid === pid) {
      this.view.panBy(e.clientX - this.pan.x, e.clientY - this.pan.y);
      this.pan.x = e.clientX;
      this.pan.y = e.clientY;
      return;
    }

    const s = this.strokes.get(pid);
    if (!s) {
      if (type === 'mouse') this.hover = cell;
      return;
    }
    this._paint(pid, s.last.x, s.last.y, cell.x, cell.y);
    s.last = { x: cell.x, y: cell.y };
    if (type === 'mouse') this.hover = cell;
    if (s.wire.length >= FLUSH_CELLS) this._flush(pid);
  }

  onUp(e) {
    const pid = e.pointerId;
    const s = this.strokes.get(pid);
    if (s) {
      this._flush(pid);
      this.strokes.delete(pid);
    }
    if (this.touches.has(pid)) {
      this.touches.delete(pid);
      if (this.touches.size < 2) this.pinch = null;
      if (this.touches.size === 1) {
        // One finger left after a pinch: do not resurrect a stroke mid-gesture,
        // but let the remaining finger start a fresh one when it next moves.
        this._pointers.delete(pid);
      }
    }
    if (this.pan && this.pan.pid === pid) this.pan = null;
    const p = this._pointers.get(pid);
    if (p) p.down = false;
    this._flushOut();
  }

  /** Two fingers arrived: finish what the one finger had already drawn. */
  _commitTouchStrokes() {
    for (const [pid, s] of [...this.strokes]) {
      if (s.type !== 'touch') continue;
      this._flush(pid);
      this.strokes.delete(pid);
    }
  }

  /* ---------- painting ---------- */

  _paint(pid, x0, y0, x1, y1) {
    const s = this.strokes.get(pid);
    if (!s) return;
    const cells = strokeCells(this.room.grid, x0, y0, x1, y1, s.brush);
    const fresh = [];
    for (const i of cells) {
      if (s.sent.has(i)) continue;
      s.sent.add(i);
      fresh.push(i);
    }
    if (!fresh.length) return;
    this.room.paintLocal(fresh, s.color, s.seq);
    s.wire.push(...fresh);
    this.view.markDirty();
  }

  _flush(pid) {
    const s = this.strokes.get(pid);
    if (!s || !s.wire.length) return;
    const cells = s.wire;
    s.wire = [];
    this.room.sendOp(cells, s.color, s.seq);
  }

  /* ---------- outbound pointers ---------- */

  _sendPointers() {
    if (!this._pointers.size) return;
    const pts = [];
    for (const [pid, p] of this._pointers) {
      const t = !p.type || p.type === 'unrecognized' ? 'mouse' : p.type;
      pts.push([pid, round2(p.x), round2(p.y), t, p.down ? 1 : 0]);
    }
    this.room.sendPointers(pts);
  }

  /* ---------- pinch ---------- */

  _startPinch() {
    const pts = [...this.touches.values()];
    if (pts.length < 2) return;
    this.pinch = {
      d0: Math.max(1, Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y)),
      scale0: this.view.scale,
      last: { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 },
    };
    this.pan = null;
  }

  _updatePinch() {
    const pts = [...this.touches.values()];
    if (pts.length < 2 || !this.pinch) return;
    const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
    const r = this.view.rect;
    const cx = (pts[0].x + pts[1].x) / 2 - r.left;
    const cy = (pts[0].y + pts[1].y) / 2 - r.top;
    const target = clamp(this.pinch.scale0 * (d / this.pinch.d0), 0.5, 64);
    this.view.zoomBy(target / this.view.scale, cx, cy);
    const mx = (pts[0].x + pts[1].x) / 2;
    const my = (pts[0].y + pts[1].y) / 2;
    this.view.panBy(mx - this.pinch.last.x, my - this.pinch.last.y);
    this.pinch.last = { x: mx, y: my };
  }

  /* ---------- preview ---------- */

  drawPreview(ctx, view) {
    const st = this.getState();
    if (this.pinch) return;
    const ink = st.tool === TOOLS.ERASER ? '#8a7a63' : st.colorHex;
    if (!ink) return;
    const box = (cell, alpha) => {
      const b = brushBox(view, cell, st.brush);
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = ink;
      ctx.lineWidth = 1.5;
      ctx.strokeRect(b.x + 0.5, b.y + 0.5, b.w, b.h);
      ctx.restore();
    };
    if (this.hover) box(this.hover, 0.7);
    for (const s of this.strokes.values()) box(s.last, 0.95);
  }
}

function brushBox(view, cell, brush) {
  const half = (brush - 1) / 2;
  const p = view.toScreen(Math.round(cell.x) - half, Math.round(cell.y) - half);
  return { x: p.x, y: p.y, w: brush * view.scale, h: brush * view.scale };
}

function round2(v) {
  return Math.round(v * 100) / 100;
}
