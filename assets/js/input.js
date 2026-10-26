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

import { strokeCells, dabCells } from './game/grid.js';
import { clamp, throttle } from './util.js';
import { FLAT_COLORS } from './data/heartopia-palette.js';
import CONFIG from './config.js';
import {
  shapeCells,
  fillCells,
  snapAngle,
  mirrored,
  mirrorIndices,
  roundOffsets,
  sprayOffsets,
  polygonCells,
} from './game/shapes.js';
import { newPatch, patchAdd, sealPatch, finishCapture } from './game/history.js';
import { stampOffsets } from './game/stamps.js';
import { shadeDeltaE, fadeShade, FADE_STEPS } from './color/science.js';
import { measure as measureText, prepare as prepareText, textCells } from './game/pixeltext.js';

export const TOOLS = {
  BRUSH: 'brush',
  ERASER: 'eraser',
  PICK: 'pick',
  FILL: 'fill',
  LINE: 'line',
  RECT: 'rect',
  ELLIPSE: 'ellipse',
  POLYGON: 'polygon',
  TEXT: 'text',
};

const PAINT_TOOLS = new Set([TOOLS.BRUSH, TOOLS.ERASER]);
const DRAG_SHAPES = new Set([TOOLS.LINE, TOOLS.RECT, TOOLS.ELLIPSE]);
/** Tools that place a whole block with one click instead of dragging. */
const PLACE_TOOLS = new Set([TOOLS.TEXT]);

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
    this.touches = new Map(); // pointerId -> {x,y} live touch points
    this.pinch = null;
    this.pan = null;
    this.hover = null;
    this.poly = []; // pending polygon points
    this._polyAt = 0; // when the last polygon point was placed, for double-click close
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
        // Scrolling over a panel is the panel's business, not the board's.
        if (e.target !== this.view.base && e.target !== this.view.fx) return;
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

    // Keys go on the window, not on #stage. The stage has no tabindex, so a
    // listener bound to it only fires when focus is inside it - and after a click
    // on a canvas it is not. Enter-to-close and Escape-to-abort a polygon were
    // therefore dead for anyone who had not first tabbed into the dock, with no
    // error anywhere to say so.
    const keyTarget = typeof window.addEventListener === 'function' ? window : el;
    const kd = (e) => {
      if (e.code === 'Shift') this._shift = true;
      if (e.code === 'Space' && !e.repeat && !this._inField(e)) {
        this._spaceHeld = true;
        e.preventDefault();
      }
      // Enter inside the Text field means "this string", not "close the shape".
      if (this._inField(e)) return;
      if (e.key === 'Enter' && this.poly.length) this._closePolygon();
      if (e.key === 'Escape' && this.poly.length) {
        this.poly = [];
        this.view.markDirty();
      }
    };
    const ku = (e) => {
      if (e.code === 'Space') this._spaceHeld = false;
      if (e.code === 'Shift') {
        this._shift = false;
        this.view.markDirty();
      }
    };
    keyTarget.addEventListener('keydown', kd);
    keyTarget.addEventListener('keyup', ku);
    this._off.push(() => keyTarget.removeEventListener('keydown', kd));
    this._off.push(() => keyTarget.removeEventListener('keyup', ku));
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
    // The panels, help card and zoom row are children of #stage, the element
    // these listeners sit on. A pointerdown on them must not start a stroke
    // behind the window, so only the two canvases may begin one.
    if (e.target !== this.view.base && e.target !== this.view.fx) return;
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
      // Touch has no click count to read, so a double-tap is timed instead.
      this._start(pid, cell, type, 1);
      this._flushOut();
      return;
    }

    this._pointers.set(pid, { x: cell.x, y: cell.y, type, down: true });

    if (type === 'pen') {
      this._start(pid, cell, type, e.detail);
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
    this._start(pid, cell, type, e.detail);
    this._flushOut();
  }

  /** One entry point for every tool, so mouse/pen/touch cannot drift apart. */
  _start(pid, cell, type, detail = 1) {
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
    if (st.tool === TOOLS.TEXT) return this._placeText(x, y);
    if (st.tool === TOOLS.POLYGON) {
      const last = this.poly[this.poly.length - 1];
      // Three ways to finish, because people mean it three different ways:
      // clicking back on the first vertex (the rubber band closing), a real
      // double-click anywhere (what MS Paint does, and what a mouse hand
      // reaches for without looking it up), and a double-tap - which has to be
      // timed, because touch reports no click count at all.
      const near = (p) => p && Math.hypot(x - p[0], y - p[1]) < 2;
      const dbl =
        detail >= 2 || (last && near(last) && performance.now() - this._polyAt < 380);
      if (this.poly.length > 2 && (near(this.poly[0]) || dbl)) return this._closePolygon();
      // A double-click lands twice in the same cell. Two identical vertices make
      // a degenerate edge, and a shape that closes on itself is how a polygon
      // ends up filling wrong, so the repeat is dropped rather than added.
      if (near(last)) {
        this._polyAt = performance.now();
        this.view.markDirty();
        return;
      }
      this.poly.push([x, y]);
      this._polyAt = performance.now();
      this.view.markDirty();
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
      gen: ++sentGen,
      wire: [],
      // An airbrush stroke lays down several tones at once, and the wire
      // carries one colour per op, so its unsent backlog is split by tone
      // instead of being a single list. Null for every other tool.
      wireByTone: isAir(st) ? new Map() : null,
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

    const sh = this.shapes.get(pid);
    if (sh) {
      // floor, not round: _start floored the anchor, so the free end has to
      // speak the same language or a drag can grow a cell on release.
      sh.x1 = Math.floor(cell.x);
      sh.y1 = Math.floor(cell.y);
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
    if (this._pending(s) >= FLUSH_CELLS) this._flush(pid);
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
    const cells = dabOffsets(st);
    const spray = !cells && isScatter(st);
    const air = spray && isAir(st);
    let seeds = null;
    if (cells || spray) {
      seeds = dabSeeds(x0, y0, x1, y1);
      if (spray) {
        // One fresh scatter per dab: a spray that repeats one pattern along
        // the drag is a texture, not a spray. Each dab stamps only its own
        // draw - pooling the draws would stamp every dab with every other
        // dab's scatter too, quadratically many stamps that paint the disc
        // nearly solid. dabCells dedupes within a dab, the loop below across
        // dabs, and the op carries cells, so the randomness never reaches
        // the wire.
        const density = st.sprayDensity ?? 0.25;
        base = [];
        const seen = new Set();
        for (const seed of seeds) {
          for (const i of dabCells(g, [seed], sprayOffsets(st.brush, density))) {
            if (!seen.has(i)) {
              seen.add(i);
              base.push(i);
            }
          }
        }
      } else {
        // roundOffsets and stampOffsets both hand back [dx, dy]. The
        // destructure used to say [dy, dx] and got away with it only because
        // a circle is symmetric - a tip is not.
        base = dabCells(g, seeds, cells);
      }
    } else {
      base = strokeCells(g, x0, y0, x1, y1, s.brush);
    }
    const expanded = mirrorIndices(g, base, st.mirror);
    const fresh = sentFilter(g, expanded, s.gen);
    if (!fresh.length) return;
    // Record before writing: the value we need is the one that is there now.
    if (!s.patch) s.patch = newPatch(this.room.design.active);
    patchAdd(s.patch, this.room.design, fresh);
    if (air) this._paintAir(s, g, fresh, seeds, st);
    else {
      this._write(fresh, s.color, s.seq);
      for (const i of fresh) s.wire.push(i);
    }
    this.view.markDirty();
  }

  /**
   * Lay one batch of airbrush dots. A dot's tone is how far it sits from the
   * nearest dab centre against the dab's own radius, so a drag fades along its
   * length rather than only at its ends, and the mirrored centres count too -
   * a mirrored stroke has to fade from its own centre, not the one across the
   * board.
   *
   * The tones are real palette shades, never invented ones, which is what keeps
   * the result exportable as the game would build it.
   */
  _paintAir(s, g, fresh, seeds, st) {
    const centres = mirrored(g, seeds, st.mirror);
    const radius = Math.max(0.5, st.brush / 2);
    const batch = new Map();
    for (const i of fresh) {
      const tone = fadeShade(s.color, airTone(i % g.w, (i / g.w) | 0, centres, radius));
      let list = batch.get(tone);
      if (!list) batch.set(tone, (list = []));
      list.push(i);
    }
    for (const [tone, list] of batch) {
      this._write(list, tone, s.seq);
      let acc = s.wireByTone.get(tone);
      if (!acc) s.wireByTone.set(tone, (acc = []));
      for (const i of list) acc.push(i);
    }
  }

  /** How many cells are waiting to go out. Both backlog shapes count. */
  _pending(s) {
    if (!s.wireByTone) return s.wire.length;
    let n = 0;
    for (const cells of s.wireByTone.values()) n += cells.length;
    return n;
  }

  /** Send whatever has accumulated since the last batch. Records nothing. */
  _flush(pid) {
    const s = this.strokes.get(pid);
    if (!s) return;
    if (s.wireByTone) {
      // One op per tone: the wire has no way to say "these cells in this
      // colour, those in that one", and inventing a richer op would be a
      // protocol change the other side of the wire does not speak.
      for (const [tone, cells] of s.wireByTone) {
        if (!cells.length) continue;
        s.wireByTone.set(tone, []);
        this.room.sendOp(cells, tone, s.seq);
      }
      return;
    }
    if (!s.wire.length) return;
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

  /**
   * Where a text block lands, as cell pairs, aimed at one cell.
   *
   * The block is centred on the tap and then slid back inside the face: a
   * signature aimed at the edge of a small board would otherwise lose its last
   * letters to a clip nobody asked for, and the game refuses those cells anyway.
   * When the block is wider than the face there is nowhere to slide it, so the
   * clip is honest and `_placeText` says so rather than pretending it fitted.
   *
   * One function because the ghost you aim and the cells that get committed must
   * be the same arithmetic - the same rule `ui/importer.js` `fitRect()` follows.
   */
  _textPairs(st, x, y) {
    const m = measureText(st.text, st.textSize);
    if (!m.w || !m.h) return { pairs: [], w: m.w, h: m.h };
    const g = this._grid;
    const ax = Math.min(Math.max(Math.round(x - m.w / 2), 0), Math.max(0, g.w - m.w));
    const ay = Math.min(Math.max(Math.round(y - m.h / 2), 0), Math.max(0, g.h - m.h));
    const pairs = textCells(st.text, st.textSize).map(([cx, cy]) => [ax + cx, ay + cy]);
    return { pairs, w: m.w, h: m.h };
  }

  _placeText(x, y) {
    const st = this.getState();
    const { pairs, w, h } = this._textPairs(st, x, y);
    if (!pairs.length) {
      this.room.emit('notice', 'Type something in the Text box first');
      return;
    }
    const dropped = prepareText(st.text).skipped;
    if (dropped.length) {
      this.room.emit('notice', `No pixel letter for ${dropped.join(' ')} - it was left out`);
    }
    const g = this._grid;
    if (w > g.w || h > g.h) {
      this.room.emit('notice', `That is ${w}×${h} cells and this face is ${g.w}×${g.h}`);
    }
    const painted = mirrored(g, pairs, st.mirror);
    if (!this._applyPairs(painted, paintColorFor(st), 'text')) {
      // Every cell landed somewhere the game will not take paint. Saying
      // nothing here is how a tool ends up looking broken with no error.
      this.room.emit('notice', 'Nothing there for the game to paint');
      return;
    }
    this.view.markDirty();
  }

  /** The aim line: the exact cells a tap would commit, at the pointer. */
  _drawTextGhost(ctx, view, st) {
    if (!this.hover) return;
    const { pairs } = this._textPairs(st, Math.floor(this.hover.x), Math.floor(this.hover.y));
    if (!pairs.length) return;
    ctx.save();
    ctx.globalAlpha = 0.5;
    ctx.fillStyle = st.colorHex;
    for (const [x, y] of mirrored(view.grid, pairs, st.mirror)) {
      const p = view.toScreen(x, y);
      ctx.fillRect(p.x, p.y, view.scale, view.scale);
    }
    ctx.restore();
  }

  /**
   * Which shades a bucket may spread to, as a table over the palette.
   *
   * The comparison is ΔE(2000) between the two shades, not the difference
   * between their indices: the palette is ordered by family, so index distance
   * is a measure of where a colour sits in a list. And it is built once per
   * click over ~126 shades rather than evaluated per cell, because a face is
   * thousands of cells and deltaE2000 is not a cheap function.
   */
  _shadeMatcher(from, tol) {
    if (!tol) return null;
    if (!this._matchCache || this._matchCache.from !== from || this._matchCache.tol !== tol) {
      const ok = new Uint8Array(FLAT_COLORS.length);
      for (let c = 0; c < FLAT_COLORS.length; c++) {
        const d = shadeDeltaE(from, c);
        ok[c] = d !== null && d <= tol ? 1 : 0;
      }
      // Empty is not a colour, it is the absence of one. A tolerance must never
      // swallow it, or a loose bucket floods the whole blank face.
      ok[0] = 0;
      this._matchCache = { from, tol, ok };
    }
    return this._matchCache.ok;
  }

  _floodAt(x, y) {
    const st = this.getState();
    const from = this._grid.colorAt(Math.floor(x), Math.floor(y));
    // Tolerance is a statement about colours, and empty is not a colour. A
    // loose bucket aimed at blank space would otherwise flood every unpainted
    // cell on the face, which reads as the button being broken.
    const tol = from === 0 ? 0 : st.fillTolerance | 0;
    const ok = this._shadeMatcher(from, tol);
    const cells = fillCells(this._grid, x, y, st.colorIdx, {
      contiguous: !st.fillGlobal,
      tolerance: tol,
      similar: ok ? (c) => c === from || ok[c] === 1 : null,
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
        // floor, not round: _start floors the vertices it records, so the
        // rubber line has to end on the same cell a click would add.
        const p = view.toScreen(Math.floor(this.hover.x), Math.floor(this.hover.y));
        ctx.lineTo(p.x, p.y);
      }
      ctx.stroke();
      ctx.restore();
    }

    if (PLACE_TOOLS.has(st.tool)) {
      // A block tool aims like a block, not like a brush tip.
      this._drawTextGhost(ctx, view, st);
      this._drawMirrorGuides(ctx, view, st);
      return;
    }
    if (DRAG_SHAPES.has(st.tool) || st.tool === TOOLS.POLYGON) return;
    const ink = st.tool === TOOLS.ERASER ? '#8a7a63' : st.colorHex;
    if (!ink) return;
    const dab = previewDab(st);
    const box = (cell, alpha) => {
      ctx.save();
      ctx.globalAlpha = alpha;
      if (dab) {
        // The square box lies about a shaped tip: a round brush 3 is a plus of
        // five cells and a tip is whatever shape the art is. Preview the rim of
        // the real dab - its cells with an unpainted 4-neighbour - so the
        // outline hugs what a stroke would paint.
        ctx.fillStyle = ink;
        const fx = Math.floor(cell.x);
        const fy = Math.floor(cell.y);
        for (const [dx, dy] of dabRim(dab)) {
          const p = view.toScreen(fx + dx, fy + dy);
          ctx.fillRect(p.x, p.y, view.scale, view.scale);
        }
      } else {
        const b = brushBox(view, cell, st.brush);
        ctx.strokeStyle = ink;
        ctx.lineWidth = 1.5;
        ctx.strokeRect(b.x + 0.5, b.y + 0.5, b.w, b.h);
      }
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

}

/**
 * The dab centres along a drag: the end cell, plus the line's cells when the
 * drag moves. Deduplicated in paint order - the prepended end cell is also the
 * line's last cell, and a repeated seed is a repeated dab. For the spray that
 * doubles the density at every move boundary; round and stamp dabs merely
 * re-ink the same cells, so this changes only what the spray draws.
 */
function dabSeeds(x0, y0, x1, y1) {
  const seeds = [[x1, y1]];
  if (Math.hypot(x1 - x0, y1 - y0) > 0.5) {
    for (const p of shapeCells('line', x0, y0, x1, y1, false)) seeds.push(p);
  }
  const seen = new Set();
  return seeds.filter(([x, y]) => {
    const k = `${Math.floor(x)},${Math.floor(y)}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * Spray is a brush shape, not a tip: it yields to an imported tip, and like
 * the round brush it only exists past size 1, where the plain square stroke
 * already is one cell.
 */
function isScatter(st) {
  return (st.brushShape === 'spray' || st.brushShape === 'air') && !st.stamp && st.brush > 1;
}

/**
 * The airbrush is the spray's scatter with a tone ramp on it: the same dots,
 * but a dot's shade fades toward white the further it sits from the dab centre.
 * The board has no alpha, so "soft" has to be made out of paler paint, and
 * every tone it uses is a shade the game already ships.
 */
function isAir(st) {
  return st.brushShape === 'air' && !st.stamp && st.brush > 1;
}

/**
 * How far a dot sits from the middle of its dab, as a step of FADE_STEPS: 0 at
 * the centre, FADE_STEPS at the rim. The board has no alpha, so this is what a
 * soft edge means here - paler paint, not translucent paint.
 */
function airTone(cx, cy, centres, radius) {
  let best = Infinity;
  for (const [sx, sy] of centres) {
    const d = Math.hypot(cx - sx, cy - sy);
    if (d < best) best = d;
  }
  return Math.min(FADE_STEPS, Math.floor((best / radius) * FADE_STEPS));
}

/**
 * The fixed footprint the preview can hug, or null for the plain square
 * stroke. For the spray that is the disc it scatters inside: the scatter is
 * random per dab, so previewing one draw would promise a pattern the next dab
 * breaks.
 */
function previewDab(st) {
  if (isScatter(st)) return roundOffsets(st.brush);
  return dabOffsets(st);
}

/**
 * The cells one dab of the current brush covers, as [dx, dy] offsets centred on
 * the seed cell, or null when the brush is a plain square stroke. An imported
 * tip wins over the square/round switch: it is the more specific thing the
 * player asked for. Both share this, because a tip dragged across the board has
 * to stay continuous exactly like a round brush.
 */
function dabOffsets(st) {
  if (st.stamp && st.brush > 1) return stampOffsets(st.stamp, st.brush);
  if (st.brushShape === 'round' && st.brush > 1) return roundOffsets(st.brush);
  return null;
}

/**
 * The rim of a dab: its cells with an unpainted 4-neighbour. Memoized per
 * offsets array - roundOffsets and stampOffsets both hand back stable arrays,
 * so a WeakMap hit is the norm and the scan runs once per (tip, size).
 */
const rimCache = new WeakMap();
function dabRim(offsets) {
  let rim = rimCache.get(offsets);
  if (rim) return rim;
  const on = new Set();
  for (const [dx, dy] of offsets) on.add(dx + ',' + dy);
  rim = offsets.filter(([dx, dy]) =>
    !on.has(dx + 1 + ',' + dy) || !on.has(dx - 1 + ',' + dy) ||
    !on.has(dx + ',' + (dy + 1)) || !on.has(dx + ',' + (dy - 1)));
  rimCache.set(offsets, rim);
  return rim;
}

/* ---------- stroke sent-filter ----------
 * A stroke must not send the same cell twice, and a big tip on a fast drag can
 * push a few hundred thousand candidates through here per pointer event. A Set
 * hashes every candidate twice; one Uint32 per cell, tagged with the stroke's
 * generation, answers in two array reads. Keyed by grid, because the array is
 * grid.n long. The generation counter is module-level and monotonic, so a mark
 * can never be mistaken for a later stroke's - short of 2^32 strokes in one
 * page session, which nothing reaches.
 */
const sentScratch = new WeakMap();
let sentGen = 0;

function sentFilter(grid, candidates, gen) {
  let marks = sentScratch.get(grid);
  if (!marks || marks.length !== grid.n) {
    marks = new Uint32Array(grid.n);
    sentScratch.set(grid, marks);
  }
  const out = [];
  for (const i of candidates) {
    if (marks[i] === gen) continue;
    marks[i] = gen;
    out.push(i);
  }
  return out;
}

function brushBox(view, cell, brush) {
  const half = (brush - 1) / 2;
  // floor, not round: the box previews the cells a stroke would paint, and
  // those are seeded from Math.floor(cell) in _paint.
  const p = view.toScreen(Math.floor(cell.x) - half, Math.floor(cell.y) - half);
  return { x: p.x, y: p.y, w: brush * view.scale, h: brush * view.scale };
}

function round2(v) {
  return Math.round(v * 100) / 100;
}
