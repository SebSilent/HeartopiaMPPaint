/*
 * Canvas view: owns the camera (zoom/pan), the crisp pixel-grid render and the
 * animation frame loop. Two layers:
 *   base - the painting itself, redrawn only when something changed
 *   fx   - remote cursors / local brush preview, redrawn every frame
 */

import { clamp } from './util.js';

// The board is the game's blank canvas: white, not tinted. A painter has to be
// able to trust what they see, and an empty Heartopia board reads as white.
const PAPER = '#ffffff';
const PAPER_EDGE = '#c9b997';
const GRID_LINE = 'rgba(60,45,25,0.16)';
const GRID_LINE_MAJOR = 'rgba(60,45,25,0.30)';
const OUTLINE_INK = 'rgba(36,26,16,0.9)';
const OUTLINE_PAPER = 'rgba(255,253,247,0.85)';

export class View {
  constructor({ base, fx, grid }) {
    this.base = base;
    this.fx = fx;
    this.grid = grid;
    /** Which face of the design this camera is looking at. */
    this.faceIndex = 0;
    this.bctx = base.getContext('2d');
    this.fctx = fx.getContext('2d');
    this.scale = 1;
    this.x = 0;
    this.y = 0;
    this.dpr = 1;
    this.showGrid = true;
    this._state = null; // offscreen w x h canvas
    this._image = null;
    this._baseDirty = true;
    this._fxDrawers = [];
    this._tickers = [];
    this._raf = null;
    this.onResize = null;
    /** Called whenever the camera scale changes, from any source. */
    this.onZoom = null;
    /**
     * A lagging copy of the grid (see net/display.js). When set, the screen
     * paints from it; grid.color stays the room's truth for everything else.
     */
    this.display = null;
    /** Set by the blueprint overlay: {draw(ctx, view)} or null. */
    this.overlay = null;
    this.rebuildStateCanvas();
  }

  /** Point the camera at another face of the same design. */
  setFace(grid, faceIndex) {
    this.grid = grid;
    this.faceIndex = faceIndex;
    // The outline belongs to the face, so whoever set it last has to restate it
    // here; otherwise a garment silhouette would survive onto a plain canvas.
    this.outline = null;
    if (this.onFace) this.onFace(faceIndex);
    this.rebuildStateCanvas();
    this.fit();
  }

  /* ---------- sizing ---------- */

  measure() {
    const rect = this.base.getBoundingClientRect();
    const dpr = clamp(window.devicePixelRatio || 1, 1, 3);
    const w = Math.max(1, Math.round(rect.width * dpr));
    const h = Math.max(1, Math.round(rect.height * dpr));
    if (this.base.width !== w || this.base.height !== h) {
      for (const c of [this.base, this.fx]) {
        c.width = w;
        c.height = h;
      }
    }
    this.dpr = dpr;
    this.cssW = rect.width;
    this.cssH = rect.height;
    this.rect = rect;
    this._baseDirty = true;
    return rect;
  }

  /** Scale the board so it fits the stage with a little air around it. */
  fit() {
    this.measure();
    // The stage has no size while the join gate is up; don't compute a bogus camera.
    if (this.cssW < 8 || this.cssH < 8) return;
    const pad = 24;
    const s = Math.min((this.cssW - pad) / this.grid.w, (this.cssH - pad) / this.grid.h);
    this.scale = clamp(s, 1, 64);
    this.x = (this.cssW - this.grid.w * this.scale) / 2;
    this.y = (this.cssH - this.grid.h * this.scale) / 2;
    this._baseDirty = true;
    this._emitZoom();
  }

  _emitZoom() {
    if (this.onZoom) this.onZoom(this.zoomPercent);
  }

  /* ---------- state layer ---------- */

  /** The display copy for the face on screen; null when there is no smoothing. */
  displayCells() {
    if (!this.display) return null;
    const b = this.display.cellsFor(this.faceIndex);
    return b && b.length === this.grid.n ? b : null;
  }

  rebuildStateCanvas() {
    const { w, h } = this.grid;
    if (!this._state || this._state.width !== w || this._state.height !== h) {
      this._state = document.createElement('canvas');
      this._state.width = w;
      this._state.height = h;
      this._sctx = this._state.getContext('2d');
      this._image = this._sctx.createImageData(w, h);
      this._u32 = new Uint32Array(this._image.data.buffer);
    }
    this._baseDirty = true;
  }

  markDirty() {
    this._baseDirty = true;
  }

  /* ---------- coordinate transforms ---------- */

  /** Client (viewport) coords -> fractional cell coords. */
  toCell(clientX, clientY) {
    return {
      x: (clientX - this.rect.left - this.x) / this.scale,
      y: (clientY - this.rect.top - this.y) / this.scale,
    };
  }

  toScreen(cx, cy) {
    return { x: cx * this.scale + this.x, y: cy * this.scale + this.y };
  }

  boardRectCss() {
    return { x: this.x, y: this.y, w: this.grid.w * this.scale, h: this.grid.h * this.scale };
  }

  isOverBoard(clientX, clientY) {
    const r = this.boardRectCss();
    return (
      clientX >= this.rect.left + r.x &&
      clientX <= this.rect.left + r.x + r.w &&
      clientY >= this.rect.top + r.y &&
      clientY <= this.rect.top + r.y + r.h
    );
  }

  /* ---------- camera moves ---------- */

  zoomBy(factor, cssX = null, cssY = null) {
    const min = 0.5;
    const max = 64;
    const next = clamp(this.scale * factor, min, max);
    if (next === this.scale) return;
    const ax = cssX == null ? this.cssW / 2 : cssX;
    const ay = cssY == null ? this.cssH / 2 : cssY;
    // keep the point under the anchor fixed
    const cx = (ax - this.x) / this.scale;
    const cy = (ay - this.y) / this.scale;
    this.scale = next;
    this.x = ax - cx * next;
    this.y = ay - cy * next;
    this._baseDirty = true;
    this._emitZoom();
  }

  panBy(dx, dy) {
    this.x += dx;
    this.y += dy;
    this._baseDirty = true;
  }

  get zoomPercent() {
    return Math.round(this.scale * 10);
  }

  /* ---------- drawing ---------- */

  drawBase() {
    const ctx = this.bctx;
    const d = this.dpr;
    ctx.setTransform(d, 0, 0, d, 0, 0);
    ctx.clearRect(0, 0, this.cssW, this.cssH);

    const g = this.grid;
    const r = this.boardRectCss();

    // board shadow + paper
    ctx.save();
    ctx.shadowColor = 'rgba(70,50,25,0.25)';
    ctx.shadowBlur = 18;
    ctx.shadowOffsetY = 6;
    ctx.fillStyle = PAPER;
    ctx.fillRect(r.x, r.y, r.w, r.h);
    ctx.restore();

    // pixels - from the display copy, which may be a moment behind the grid
    g.fillRGBA(this._u32, this.displayCells());
    this._sctx.putImageData(this._image, 0, 0);
    ctx.imageSmoothingEnabled = false; // Heartopia boards are pixel art
    ctx.drawImage(this._state, r.x, r.y, r.w, r.h);

    if (this.outline && this.outline.w === g.w && this.outline.h === g.h) this._drawOutline(ctx, r);

    // grid
    if (this.showGrid && this.scale >= 5) {
      ctx.lineWidth = 1;
      ctx.strokeStyle = GRID_LINE;
      ctx.beginPath();
      for (let i = 0; i <= g.w; i++) {
        const x = Math.round(r.x + i * this.scale) + 0.5;
        ctx.moveTo(x, r.y);
        ctx.lineTo(x, r.y + r.h);
      }
      for (let j = 0; j <= g.h; j++) {
        const y = Math.round(r.y + j * this.scale) + 0.5;
        ctx.moveTo(r.x, y);
        ctx.lineTo(r.x + r.w, y);
      }
      ctx.stroke();

      // every 10th line reads as a guide on the big boards
      if (this.scale >= 3) {
        ctx.strokeStyle = GRID_LINE_MAJOR;
        ctx.beginPath();
        for (let i = 0; i <= g.w; i += 10) {
          const x = Math.round(r.x + i * this.scale) + 0.5;
          ctx.moveTo(x, r.y);
          ctx.lineTo(x, r.y + r.h);
        }
        for (let j = 0; j <= g.h; j += 10) {
          const y = Math.round(r.y + j * this.scale) + 0.5;
          ctx.moveTo(r.x, y);
          ctx.lineTo(r.x + r.w, y);
        }
        ctx.stroke();
      }
    }

    ctx.strokeStyle = PAPER_EDGE;
    ctx.lineWidth = 2;
    ctx.strokeRect(r.x + 1, r.y + 1, r.w - 2, r.h - 2);
  }

  /**
   * The garment silhouette for the face now on screen. Cell coordinates, so it
   * scales with the board; drawn over the paint because it is a guide, not art.
   */
  _drawOutline(ctx, r) {
    const o = this.outline;
    const sx = r.w / o.w;
    const sy = r.h / o.h;
    ctx.save();
    ctx.beginPath();
    o.ring.forEach((p, i) => {
      const x = r.x + p[0] * sx;
      const y = r.y + p[1] * sy;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.closePath();
    ctx.strokeStyle = OUTLINE_INK;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.stroke();
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = OUTLINE_PAPER;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();
  }

  /** Register a callback that paints the overlay layer each frame. */
  onFrame(fn) {
    this._fxDrawers.push(fn);
  }

  /** Run before the board is composited, so work done here shows this frame. */
  onTick(fn) {
    this._tickers.push(fn);
  }

  start() {
    if (this._raf) return;
    const loop = () => {
      this._raf = requestAnimationFrame(loop);
      for (const fn of this._tickers) {
        try {
          fn();
        } catch (e) {
          console.error('tick failed', e);
        }
      }
      if (this._baseDirty) {
        this._baseDirty = false;
        this.drawBase();
      }
      const ctx = this.fctx;
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      ctx.clearRect(0, 0, this.cssW, this.cssH);
      // The blueprint sits under the cursors: it is furniture for the hand,
      // not something to draw on top of.
      if (this.overlay) {
        try {
          this.overlay.draw(ctx, this);
        } catch (e) {
          console.error('overlay failed', e);
        }
      }
      for (const fn of this._fxDrawers) {
        try {
          fn(ctx, this);
        } catch (e) {
          console.error('fx drawer failed', e);
        }
      }
    };
    this._raf = requestAnimationFrame(loop);
  }

  stop() {
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = null;
  }
}
