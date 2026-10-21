/*
 * Input.
 *
 * Everything goes through Pointer Events so one code path covers mouse, pen
 * and touch, and the pointer *type* is remembered per pointer id - that is how
 * a remote player's cursor is drawn as a finger, a pencil or an arrow.
 *
 * A stroke gets one lamport stamp when it begins and keeps it for every batch,
 * so what we paint locally is byte-for-byte what the room replays. No
 * "predicted then corrected" divergence.
 *
 * Every finger paints independently, so two-finger drawing on an iPad works.
 * Zoom/pan: mouse wheel, the +/- buttons, space+drag, or the Hand tool.
 */

import { strokeCells } from './game/grid.js';
import { clamp, throttle } from './util.js';
import CONFIG from './config.js';

export const TOOLS = {
  BRUSH: 'brush',
  ERASER: 'eraser',
  PICK: 'pick',
  PAN: 'pan',
};

const FLUSH_CELLS = 12; // batch size before an early send
const FLUSH_MS = 55; // ...or send this often

export class Input {
  constructor({ room, view, getState, setState }) {
    this.room = room;
    this.view = view;
    this.getState = getState;
    this.setState = setState;
    this.strokes = new Map(); // pointerId -> stroke
    this.gesture = new Map(); // pointerId -> {x,y} while in hand mode
    this.pinch = null;
    this.panPid = null;
    this.hover = null;
    this._pointers = new Map(); // pointerId -> latest sample for outbound cursors
    this._el = view.base.parentElement;
    this._off = [];
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
      this.hover = null;
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
          this.view.zoomBy(Math.exp(-e.deltaY * 0.0016), e.clientX - r.left, e.clientY - r.top);
        }
      },
      { passive: false }
    );

    add('keydown', (e) => {
      if (e.code === 'Space' && !e.repeat) {
        this._spaceHeld = true;
        e.preventDefault();
      }
    });
    add('keyup', (e) => {
      if (e.code === 'Space') this._spaceHeld = false;
    });
    add('contextmenu', (e) => e.preventDefault());
  }

  destroy() {
    for (const fn of this._off) fn();
    this._off = [];
    clearInterval(this._timer);
  }

  _handMode(e) {
    if (this._spaceHeld) return true;
    if (this.getState().tool === TOOLS.PAN) return true;
    return e.button === 1 || e.button === 2;
  }

  /* ---------- flow ---------- */

  onDown(e) {
    e.preventDefault();
    this.view.measure();
    const cell = this.view.toCell(e.clientX, e.clientY);
    const pid = e.pointerId;
    const type = e.pointerType || 'mouse';
    this._pointers.set(pid, { x: cell.x, y: cell.y, type, down: true });

    if (this._handMode(e)) {
      this.gesture.set(pid, { x: e.clientX, y: e.clientY });
      if (this.gesture.size === 2) this._startPinch();
      else this.panPid = pid;
      this._flushOut();
      return;
    }

    const tool = this.getState().tool;
    if (tool === TOOLS.PICK) {
      const c = this.room.grid.colorAt(Math.floor(cell.x), Math.floor(cell.y));
      if (c > 0) this.setState({ color: c });
      this._flushOut();
      return;
    }

    if (!this.room.canPaint) {
      this.room.emit('blocked');
      return;
    }

    const color = tool === TOOLS.ERASER ? 0 : this.getState().color;
    this.strokes.set(pid, {
      seq: this.room.nextSeq(),
      color,
      brush: this.getState().brush,
      last: { x: cell.x, y: cell.y },
      sent: new Set(),
      wire: [],
      type,
    });
    this._paint(pid, cell.x, cell.y, cell.x, cell.y);
    this._flush(pid);
    this._flushOut();
  }

  onMove(e) {
    const cell = this.view.toCell(e.clientX, e.clientY);
    const pid = e.pointerId;
    const type = e.pointerType || 'mouse';
    const painting = this.strokes.has(pid);
    this._pointers.set(pid, { x: cell.x, y: cell.y, type, down: painting || this.gesture.has(pid) });
    this._flushOut();

    if (this.gesture.has(pid)) {
      const prev = this.gesture.get(pid);
      this.gesture.set(pid, { x: e.clientX, y: e.clientY });
      if (this.pinch) this._updatePinch();
      else if (this.panPid === pid) this.view.panBy(e.clientX - prev.x, e.clientY - prev.y);
      return;
    }

    const s = this.strokes.get(pid);
    if (!s) {
      this.hover = cell;
      return;
    }
    this._paint(pid, s.last.x, s.last.y, cell.x, cell.y);
    s.last = { x: cell.x, y: cell.y };
    if (s.wire.length >= FLUSH_CELLS) this._flush(pid);
  }

  onUp(e) {
    const pid = e.pointerId;
    const s = this.strokes.get(pid);
    if (s) {
      this._flush(pid);
      this.strokes.delete(pid);
    }
    if (this.gesture.has(pid)) {
      this.gesture.delete(pid);
      if (this.gesture.size < 2) this.pinch = null;
      if (this.panPid === pid) this.panPid = this.gesture.size ? [...this.gesture.keys()][0] : null;
    }
    const p = this._pointers.get(pid);
    if (p) p.down = false;
    this._flushOut();
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
    // Applied locally with the same stamp the room will receive.
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
      const t = p.type === 'unrecognized' || !p.type ? 'mouse' : p.type;
      pts.push([pid, round2(p.x), round2(p.y), t, p.down ? 1 : 0]);
    }
    this.room.sendPointers(pts);
  }

  /* ---------- pinch / pan ---------- */

  _startPinch() {
    const pts = [...this.gesture.values()];
    if (pts.length < 2) return;
    this.pinch = {
      d0: Math.max(1, Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y)),
      scale0: this.view.scale,
      last: { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 },
    };
    this.panPid = null;
  }

  _updatePinch() {
    const pts = [...this.gesture.values()];
    if (pts.length < 2 || !this.pinch) return;
    const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
    const cx = (pts[0].x + pts[1].x) / 2 - this.view.rect.left;
    const cy = (pts[0].y + pts[1].y) / 2 - this.view.rect.top;
    const target = clamp(this.pinch.scale0 * (d / this.pinch.d0), 0.5, 64);
    this.view.zoomBy(target / this.view.scale, cx, cy);
    // two-finger drag pans as well
    const mx = (pts[0].x + pts[1].x) / 2;
    const my = (pts[0].y + pts[1].y) / 2;
    this.view.panBy(mx - this.pinch.last.x, my - this.pinch.last.y);
    this.pinch.last = { x: mx, y: my };
  }

  /* ---------- preview ---------- */

  drawPreview(ctx, view) {
    const st = this.getState();
    if (st.tool === TOOLS.PAN || this._spaceHeld) return;
    const ink = st.tool === TOOLS.ERASER ? '#8a7a63' : st.colorHex;
    const box = (cell, alpha) => {
      const b = brushBox(view, cell, st.brush);
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = ink;
      ctx.lineWidth = 1.5;
      ctx.strokeRect(b.x + 0.5, b.y + 0.5, b.w, b.h);
      ctx.restore();
    };
    if (this.hover) box(this.hover, 0.75);
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
