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
 * so what we paint locally is byte-for-byte what the room replays. Every tool
 * ends up at that same place: a list of cells and one colour. Shapes, fills
 * and pastes just compute the list differently, and all of them record what the
 * cells held beforehand so one undo reverses one action.
 */

import { strokeCells } from './game/grid.js';
import { clamp, throttle } from './util.js';
import { FLAT_COLORS } from './data/heartopia-palette.js';
import CONFIG from './config.js';
import {
  shapeCells,
  fillCells,
  sprayCells,
  snapAngle,
  mirrored,
  mirrorIndices,
  roundOffsets,
  polygonCells,
  dedupePairs,
} from './game/shapes.js';
import { newPatch, patchAdd, sealPatch, finishCapture } from './game/history.js';

export const TOOLS = {
  BRUSH: 'brush',
  ERASER: 'eraser',
  PICK: 'pick',
  FILL: 'fill',
  SPRAY: 'spray',
  LINE: 'line',
  RECT: 'rect',
  ELLIPSE: 'ellipse',
  TRIANGLE: 'triangle',
  STAR: 'star',
  HEART: 'heart',
  ARROW: 'arrow',
  POLYGON: 'polygon',
  GUIDE: 'guide',
};

const PAINT_TOOLS = new Set([TOOLS.BRUSH, TOOLS.ERASER, TOOLS.SPRAY]);
const DRAG_SHAPES = new Set([
  TOOLS.LINE,
  TOOLS.RECT,
  TOOLS.ELLIPSE,
  TOOLS.TRIANGLE,
  TOOLS.STAR,
  TOOLS.HEART,
  TOOLS.ARROW,
]);

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
  constructor({ room, view, getState, setState, history, onHistory }) {
    this.room = room;
    this.view = view;
    this.getState = getState;
    this.setState = setState;
    this.history = history;
    // The undo buttons cannot poll for work; they have to be told. Without this
    // the stack fills and the buttons stay greyed forever while Ctrl+Z works.
    this.onHistory = onHistory || (() => {});
    this.strokes = new Map(); // pointerId -> stroke
    this.shapes = new Map(); // pointerId -> in-progress shape
    this.guides = new Map();
    this.touches = new Map(); // pointerId -> {x,y} live touch points
    this.pinch = null;
    this.pan = null;
    this.hover = null;
    this.poly = []; // pending polygon points
    this._pointers = new Map();
    this._el = view.base.parentElement;
    this._off = [];
    this._spaceHeld = false;
    this._shift = false;
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
      if (e.code === 'Shift') this._shift = true;
      if (e.code === 'Space' && !e.repeat && !this._inField(e)) {
        this._spaceHeld = true;
        e.preventDefault();
      }
      if (e.key === 'Enter' && this.poly.length) this._closePolygon();
      if (e.key === 'Escape') this.poly = [];
    });
    add('keyup', (e) => {
      if (e.code === 'Space') this._spaceHeld = false;
      if (e.code === 'Shift') {
        this._shift = false;
        this.view.markDirty();
      }
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

  get _grid() {
    return this.room.grid;
  }

  /** [x,y] pairs -> in-bounds, mirrored cell indices. */
  _expand(pairs) {
    const st = this.getState();
    const g = this._grid;
    const all = mirrored(g, pairs, st.mirror);
    const idx = [];
    for (const [x, y] of all) {
      const cx = Math.floor(x);
      const cy = Math.floor(y);
      if (g.inBounds(cx, cy)) idx.push(g.idx(cx, cy));
    }
    return idx;
  }

  /** Paint a set of indices now. The room handles the display copy. */
  _write(indices, color, seq) {
    if (!indices.length) return 0;
    return this.room.paintLocal(indices, color, seq);
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
      this._start(pid, cell, type);
      this._flushOut();
      return;
    }

    this._pointers.set(pid, { x: cell.x, y: cell.y, type, down: true });

    if (type === 'pen') {
      this._start(pid, cell, type);
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
    this._start(pid, cell, type);
    this._flushOut();
  }

  /** One entry point for every tool, so mouse/pen/touch cannot drift apart. */
  _start(pid, cell, type) {
    const st = this.getState();
    // floor, not round: cell n spans [n, n+1). Rounding would let a tap at 2.5
    // read cell 3, i.e. steal the left half of the neighbour's territory.
    const x = Math.floor(cell.x);
    const y = Math.floor(cell.y);

    // The eyedropper reads the board, it does not change it, so it works while
    // the room is still handing you a slot. Everything that writes has to wait.
    if (st.tool !== TOOLS.PICK && !this.room.canPaint) {
      this.room.emit('blocked');
      return;
    }

    if (st.tool === TOOLS.PICK) {
      const c = this._grid.colorAt(x, y);
      if (c > 0) this.setState({ colorIdx: c });
      return;
    }
    if (st.tool === TOOLS.FILL) return this._floodAt(x, y);
    if (st.tool === TOOLS.POLYGON) {
      if (this.poly.length && Math.hypot(x - this.poly[0][0], y - this.poly[0][1]) < 2 && this.poly.length > 2) {
        return this._closePolygon();
      }
      this.poly.push([x, y]);
      this.view.markDirty();
      return;
    }
    if (st.tool === TOOLS.GUIDE) {
      this.guides.set(pid, { points: [[cell.x, cell.y]] });
      return;
    }
    if (DRAG_SHAPES.has(st.tool)) {
      this.shapes.set(pid, { x0: x, y0: y, x1: x, y1: y, tool: st.tool, type });
      this.view.markDirty();
      return;
    }
    this._beginStroke(pid, cell, type);
  }

  _beginStroke(pid, cell, type) {
    const st = this.getState();
    this.strokes.set(pid, {
      seq: this.room.nextSeq(),
      color: paintColorFor(st),
      brush: st.brush,
      last: { x: cell.x, y: cell.y },
      sent: new Set(),
      wire: [],
      patch: null,
      recorded: false,
      type,
    });
    this._paint(pid, cell.x, cell.y, cell.x, cell.y);
    this._flush(pid);
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

    const g = this.guides.get(pid);
    if (g) {
      g.points.push([cell.x, cell.y]);
      this.view.markDirty();
      return;
    }

    const sh = this.shapes.get(pid);
    if (sh) {
      sh.x1 = Math.round(cell.x);
      sh.y1 = Math.round(cell.y);
      this.view.markDirty();
      if (type === 'mouse') this.hover = cell;
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
    if (s) this._endStroke(pid);
    const sh = this.shapes.get(pid);
    if (sh) {
      this.shapes.delete(pid);
      this._commitShape(sh);
    }
    const gd = this.guides.get(pid);
    if (gd) {
      this.guides.delete(pid);
      this._commitGuide(gd);
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
    this.view.markDirty();
  }

  /** Two fingers arrived: finish what the one finger had already drawn. */
  _commitTouchStrokes() {
    for (const [pid, s] of [...this.strokes]) {
      if (s.type !== 'touch') continue;
      this._endStroke(pid);
    }
    for (const [pid, sh] of [...this.shapes]) {
      if (sh.type !== 'touch') continue;
      this.shapes.delete(pid);
      this._commitShape(sh);
    }
  }

  /* ---------- painting ---------- */

  _paint(pid, x0, y0, x1, y1) {
    const s = this.strokes.get(pid);
    if (!s) return;
    const st = this.getState();
    const g = this._grid;
    let base;
    if (st.tool === TOOLS.SPRAY) {
      base = inBoundsPairs(g, sprayCells(g, x1, y1, st.brush, st.sprayDensity));
    } else if (st.brushShape === 'round' && st.brush > 1) {
      const pairs = [];
      const seeds = [[x1, y1]];
      if (Math.hypot(x1 - x0, y1 - y0) > 0.5) seeds.push(...shapeCells('line', x0, y0, x1, y1, false));
      for (const [sx, sy] of seeds) {
        for (const [dy, dx] of roundOffsets(st.brush)) pairs.push([Math.round(sx) + dx, Math.round(sy) + dy]);
      }
      base = inBoundsPairs(g, dedupePairs(pairs));
    } else {
      base = strokeCells(g, x0, y0, x1, y1, s.brush);
    }
    const expanded = mirrorIndices(g, base, st.mirror);
    const fresh = [];
    for (const i of expanded) {
      if (s.sent.has(i)) continue;
      s.sent.add(i);
      fresh.push(i);
    }
    if (!fresh.length) return;
    // Record before writing: the value we need is the one that is there now.
    if (!s.patch) s.patch = newPatch(this.room.design.active);
    patchAdd(s.patch, this.room.design, fresh);
    this._write(fresh, s.color, s.seq);
    s.wire.push(...fresh);
    this.view.markDirty();
  }

  /** Send whatever has accumulated since the last batch. Records nothing. */
  _flush(pid) {
    const s = this.strokes.get(pid);
    if (!s || !s.wire.length) return;
    const cells = s.wire;
    s.wire = [];
    this.room.sendOp(cells, s.color, s.seq);
  }

  /**
   * The stroke is over. One undo step for the whole of it: the patch grew with
   * every batch, so it holds every cell this stroke touched and the value each
   * one had before the first touch.
   */
  _endStroke(pid) {
    const s = this.strokes.get(pid);
    if (!s) return;
    this._flush(pid);
    this.strokes.delete(pid);
    if (s.patch && !s.recorded) {
      s.recorded = true;
      const sealed = sealPatch(s.patch);
      finishCapture(this.room.design, sealed);
      sealed.label = 'stroke';
      this.history.push(sealed);
      this.onHistory();
    }
  }

  /* ---------- shapes ---------- */

  _shapePairs(sh) {
    const st = this.getState();
    let { x0, y0, x1, y1 } = sh;
    if (sh.tool === TOOLS.LINE && this._shift) {
      const p = snapAngle(x0, y0, x1, y1);
      x1 = p.x;
      y1 = p.y;
    }
    if (sh.tool === TOOLS.RECT && this._shift) {
      const d = Math.min(Math.abs(x1 - x0), Math.abs(y1 - y0));
      x1 = x0 + Math.sign(x1 - x0 || 1) * d;
      y1 = y0 + Math.sign(y1 - y0 || 1) * d;
    }
    return shapeCells(sh.tool, x0, y0, x1, y1, st.shapeFilled);
  }

  _commitShape(sh) {
    const st = this.getState();
    const pairs = mirrored(this._grid, this._shapePairs(sh), st.mirror);
    this._applyPairs(pairs, paintColorFor(st), 'shape');
    this.view.markDirty();
  }

  _closePolygon() {
    if (this.poly.length < 3) {
      this.poly = [];
      return;
    }
    const st = this.getState();
    const pairs = mirrored(this._grid, polygonCells(this.poly, st.shapeFilled), st.mirror);
    this.poly = [];
    this._applyPairs(pairs, paintColorFor(st), 'polygon');
    this.view.markDirty();
  }

  _floodAt(x, y) {
    const st = this.getState();
    const cells = fillCells(this._grid, x, y, st.colorIdx, {
      contiguous: !st.fillGlobal,
      tolerance: st.fillTolerance | 0,
    });
    if (!cells.length) return;
    this._applyPairs(cells, paintColorFor(st), 'fill');
    this.view.markDirty();
  }

  /**
   * The one place a whole-region write happens: capture, paint, broadcast,
   * record. Shapes, fills and pastes all come through here so none of them can
   * forget a step - and so none of them can be painted without an undo.
   */
  _applyPairs(pairs, color, label, faceIdx = this.room.design.active) {
    const g = this.room.design.faceAt(faceIdx);
    const indices = [];
    for (const [x, y] of pairs) {
      const cx = Math.floor(x);
      const cy = Math.floor(y);
      if (g.inBounds(cx, cy)) indices.push(g.idx(cx, cy));
    }
    return this._applyIndices(indices, color, label, faceIdx);
  }

  _applyIndices(indices, color, label, faceIdx = this.room.design.active) {
    if (!indices.length) return 0;
    const design = this.room.design;
    const patch = newPatch(faceIdx);
    patchAdd(patch, design, indices);
    const seq = this.room.nextSeq();
    const changed = this.room.paintLocal(indices, color, seq, faceIdx);
    this.room.sendOp(indices, color, seq, faceIdx);
    const sealed = sealPatch(patch);
    finishCapture(design, sealed);
    sealed.label = label;
    this.history.push(sealed);
    this.onHistory();
    return changed;
  }

  /* ---------- guide lines ---------- */

  _commitGuide(g) {
    if (g.points.length < 2) return;
    const lines = [...(this.room.design.guides[this.room.design.active] || []), { points: g.points }];
    this.room.setGuides(lines);
    this.view.markDirty();
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
    this._drawGuides(ctx, view);
    if (this.pinch) return;

    for (const sh of this.shapes.values()) {
      const pairs = mirrored(view.grid, this._shapePairs(sh), st.mirror);
      ctx.save();
      ctx.fillStyle = st.colorHex;
      ctx.globalAlpha = 0.55;
      for (const [x, y] of pairs) {
        const p = view.toScreen(Math.round(x), Math.round(y));
        ctx.fillRect(p.x, p.y, view.scale, view.scale);
      }
      ctx.restore();
    }

    if (this.poly.length) {
      ctx.save();
      ctx.strokeStyle = st.colorHex;
      ctx.lineWidth = 2;
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      this.poly.forEach(([x, y], i) => {
        const p = view.toScreen(x, y);
        if (i === 0) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
      });
      if (this.hover) {
        const p = view.toScreen(Math.round(this.hover.x), Math.round(this.hover.y));
        ctx.lineTo(p.x, p.y);
      }
      ctx.stroke();
      ctx.restore();
    }

    if (DRAG_SHAPES.has(st.tool) || st.tool === TOOLS.POLYGON) return;
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
    this._drawMirrorGuides(ctx, view, st);
  }

  _drawMirrorGuides(ctx, view, st) {
    if (!st.mirror) return;
    ctx.save();
    ctx.strokeStyle = 'rgba(234,105,109,0.75)';
    ctx.lineWidth = 1;
    ctx.setLineDash([6, 5]);
    if (st.mirror & 1) {
      const p = view.toScreen(view.grid.w / 2, 0);
      const q = view.toScreen(view.grid.w / 2, view.grid.h);
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(q.x, q.y);
      ctx.stroke();
    }
    if (st.mirror & 2) {
      const p = view.toScreen(0, view.grid.h / 2);
      const q = view.toScreen(view.grid.w, view.grid.h / 2);
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(q.x, q.y);
      ctx.stroke();
    }
    ctx.restore();
  }

  _drawGuides(ctx, view) {
    const design = this.room.design;
    const live = this.guides.size > 0;
    const lines = design.guides[design.active] || [];
    if (!lines.length && !live) return;
    ctx.save();
    ctx.strokeStyle = 'rgba(90,70,40,0.45)';
    ctx.lineWidth = 1.5;
    for (const l of lines) {
      ctx.beginPath();
      l.points.forEach(([x, y], i) => {
        const p = view.toScreen(x, y);
        if (i === 0) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
      });
      ctx.stroke();
    }
    for (const g of this.guides.values()) {
      ctx.beginPath();
      g.points.forEach(([x, y], i) => {
        const p = view.toScreen(x, y);
        if (i === 0) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
      });
      ctx.stroke();
    }
    ctx.restore();
  }
}

/** [x,y] pairs -> flat indices, dropping anything off the board. */
function inBoundsPairs(g, pairs) {
  const out = [];
  for (const [x, y] of pairs) {
    const cx = Math.floor(x);
    const cy = Math.floor(y);
    if (g.inBounds(cx, cy)) out.push(g.idx(cx, cy));
  }
  return out;
}

function brushBox(view, cell, brush) {
  const half = (brush - 1) / 2;
  const p = view.toScreen(Math.round(cell.x) - half, Math.round(cell.y) - half);
  return { x: p.x, y: p.y, w: brush * view.scale, h: brush * view.scale };
}

function round2(v) {
  return Math.round(v * 100) / 100;
}
