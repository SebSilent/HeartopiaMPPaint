/*
 * Input is the layer that broke in the real world and that no earlier test
 * touched: it needs a DOM. Rather than skip it, the view and room are stubbed
 * and the real Input methods are driven with synthetic pointer events.
 * Everything asserted here is behaviour a player reported as broken.
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';

// Input checks for Pointer Events support at bind time.
globalThis.window = globalThis.window || {};
globalThis.window.PointerEvent = function PointerEvent() {};

import { Grid } from '../assets/js/game/grid.js';
import { SingleFaceDesign } from '../assets/js/game/design.js';
import { History } from '../assets/js/game/history.js';
import { Input, TOOLS, paintColorFor } from '../assets/js/input.js';

const SCALE = 4;

function makeView() {
  const el = {
    addEventListener() {},
    removeEventListener() {},
    insertAdjacentHTML() {},
  };
  return {
    base: { parentElement: el },
    scale: SCALE,
    x: 0,
    y: 0,
    rect: { left: 0, top: 0 },
    cssW: 400,
    cssH: 400,
    dirty: false,
    zoomEvents: 0,
    lastZoom: null,
    onZoom: null,
    measure() {},
    toCell(cx, cy) {
      return { x: (cx - this.rect.left - this.x) / this.scale, y: (cy - this.rect.top - this.y) / this.scale };
    },
    toScreen(cx, cy) {
      return { x: cx * this.scale + this.x, y: cy * this.scale + this.y };
    },
    markDirty() {
      this.dirty = true;
    },
    onFrame() {},
    zoomBy(f) {
      this.zoomEvents++;
      this.scale = Math.max(0.5, Math.min(64, this.scale * f));
      if (this.onZoom) this.onZoom(Math.round(this.scale * 10));
    },
    panBy() {},
  };
}

function makeRoom(grid) {
  // Input talks to a Design, not to a bare grid, because a Heartopia item can
  // be several faces. The stub is a single-face Design rather than a Grid so it
  // has to honour the same face axis the real one does.
  const design = new SingleFaceDesign(grid);
  return {
    grid,
    design,
    me: { slot: 1 },
    canPaint: true,
    lamport: 0,
    ops: [],
    pointers: [],
    events: [],
    nextSeq() {
      return ++this.lamport;
    },
    paintLocal(cells, color, seq, faceIdx = design.active) {
      return design.paint(cells, color, seq, this.me.slot, faceIdx);
    },
    sendOp(cells, color, seq, faceIdx = design.active) {
      this.ops.push({ cells: [...cells], color, seq, face: faceIdx });
    },
    sendPointers(p) {
      this.pointers.push(p);
    },
    emit(name) {
      this.events.push(name);
    },
  };
}

// Input runs a batch timer for stroke flushing. Every instance is tracked so
// the suite can shut them down and let Node exit on its own.
const created = [];

function makeInput(overrides = {}) {
  const grid = new Grid(10, 10);
  const view = makeView();
  const room = makeRoom(grid);
  const state = {
    tool: TOOLS.BRUSH,
    colorIdx: 16, // #e95e2b
    colorHex: '#e95e2b',
    color: '#ea696d', // the player's identity colour: a hex, NOT a paint index
    brush: 1,
    brushSizes: [1, 2, 3, 5],
    ...overrides.state,
  };
  const input = new Input({
    room,
    view,
    getState: () => state,
    setState: (patch) => Object.assign(state, patch),
    history: new History(),
  });
  created.push(input);
  return { input, grid, view, room, state };
}

after(() => {
  for (const i of created) i.destroy();
});

const pe = (o) => ({
  preventDefault() {},
  pointerId: 1,
  pointerType: 'mouse',
  clientX: 0,
  clientY: 0,
  button: 0,
  ...o,
});

test('a mouse drag actually paints the selected shade', () => {
  const { input, grid, room } = makeInput();
  input.onDown(pe({ clientX: 2, clientY: 2 }));
  input.onMove(pe({ clientX: 10, clientY: 2 }));
  input.onMove(pe({ clientX: 18, clientY: 2 }));
  input.onUp(pe({ clientX: 18, clientY: 2 }));

  const painted = [...grid.color].filter((c) => c !== 0);
  assert.ok(painted.length >= 3, `expected a stroke, got ${painted.length} cells`);
  assert.ok(painted.every((c) => c === 16), 'every cell must hold the palette index');
  assert.ok(room.ops.length > 0, 'the stroke must be sent to the room');
  assert.equal(room.ops[0].color, 16);
  input.destroy();
});

test('painting with a hex instead of an index is rejected, not silently zeroed', () => {
  // Regression: state.color is the identity hex. Writing it into the Uint8Array
  // grid coerced to 0, so strokes were invisible and nothing threw.
  assert.throws(() => paintColorFor({ colorIdx: '#ea696d', tool: TOOLS.BRUSH }), TypeError);
  assert.throws(() => paintColorFor({ colorIdx: 999, tool: TOOLS.BRUSH }), RangeError);
  assert.equal(paintColorFor({ colorIdx: 16, tool: TOOLS.BRUSH }), 16);
  assert.equal(paintColorFor({ colorIdx: 16, tool: TOOLS.ERASER }), 0);
});

test('the eraser clears cells back to 0', () => {
  const { input, grid, state } = makeInput();
  input.onDown(pe({ clientX: 2, clientY: 2 }));
  input.onUp(pe({ clientX: 2, clientY: 2 }));
  assert.ok([...grid.color].some((c) => c === 16));

  state.tool = TOOLS.ERASER;
  input.onDown(pe({ clientX: 2, clientY: 2 }));
  input.onUp(pe({ clientX: 2, clientY: 2 }));
  assert.equal(grid.color[0], 0);
  input.destroy();
});

test('the eyedropper reads a palette index, not a colour name', () => {
  const { input, grid, state } = makeInput();
  grid.paint([22], 40, 1, 1); // cell (2,2)
  state.tool = TOOLS.PICK;
  // Dead centre of cell (2,2). A tap is rounded to a cell, and a point that
  // lands on the boundary rounds to whichever neighbour happens to be painted -
  // which is a property of the tap, not a bug in the eyedropper.
  input.onDown(pe({ clientX: 2 * SCALE + SCALE / 2, clientY: 2 * SCALE + SCALE / 2 }));
  input.onUp(pe({ clientX: 2 * SCALE + SCALE / 2, clientY: 2 * SCALE + SCALE / 2 }));
  assert.equal(state.colorIdx, 40);
  input.destroy();
});

test('the eyedropper works before the room has given you a slot', () => {
  // Reading the board changes nothing, so it is not gated. Painting is.
  const { input, grid, room, state } = makeInput();
  room.canPaint = false;
  grid.paint([5], 33, 1, 1);
  state.tool = TOOLS.PICK;
  input.onDown(pe({ clientX: 5 * SCALE + SCALE / 2, clientY: SCALE / 2 }));
  assert.equal(state.colorIdx, 33, 'the sample came from the board');
  assert.deepEqual(room.events, [], 'and nothing was refused, because nothing was asked');
  input.destroy();
});

test('a second finger stops painting and starts a pinch, keeping the stroke', () => {
  const { input, grid, view } = makeInput();
  view.onZoom = (p) => {
    view.lastZoom = p;
  };

  input.onDown(pe({ pointerId: 1, pointerType: 'touch', clientX: 2, clientY: 2 }));
  input.onMove(pe({ pointerId: 1, pointerType: 'touch', clientX: 20, clientY: 2 }));
  const before = [...grid.color].filter((c) => c === 16).length;
  assert.ok(before > 0, 'the first finger should already have painted');

  input.onDown(pe({ pointerId: 2, pointerType: 'touch', clientX: 100, clientY: 60 }));
  assert.equal(input.strokes.size, 0, 'the finger stroke must be committed, not left open');
  assert.ok(input.pinch, 'pinch should be active');
  assert.ok([...grid.color].filter((c) => c === 16).length >= before, 'the stroke must survive');

  input.onMove(pe({ pointerId: 2, pointerType: 'touch', clientX: 200, clientY: 60 }));
  assert.ok(view.zoomEvents > 0, 'pinch must report the new zoom');
  assert.ok(view.lastZoom > SCALE * 10, 'spreading fingers zooms in');
  input.destroy();
});

test('finger touches are ignored while the stylus is down', () => {
  const { input, grid } = makeInput();
  input.onDown(pe({ pointerId: 7, pointerType: 'pen', clientX: 2, clientY: 2 }));
  assert.ok(input.strokes.has(7), 'the pencil paints');

  input.onDown(pe({ pointerId: 3, pointerType: 'touch', clientX: 60, clientY: 60 }));
  assert.equal(input.strokes.has(3), false, 'a palm must not start a stroke');
  assert.equal(input.touches.size, 0, 'nor join the gesture');
  assert.equal(input.pinch, null, 'nor trigger a zoom');
  input.destroy();
});

test('space-drag pans instead of painting, and right-drag does too', () => {
  const { input, grid } = makeInput();
  input._spaceHeld = true;
  input.onDown(pe({ clientX: 5, clientY: 5 }));
  assert.equal(input.strokes.size, 0);
  assert.ok(input.pan);
  input.onUp(pe({ clientX: 5, clientY: 5 }));
  input._spaceHeld = false;

  input.onDown(pe({ button: 2, clientX: 5, clientY: 5 }));
  assert.equal(input.strokes.size, 0);
  input.onUp(pe({ button: 2, clientX: 5, clientY: 5 }));
  assert.equal([...grid.color].some((c) => c !== 0), false, 'no paint from pan gestures');
  input.destroy();
});

test('painting is refused, with a signal, when the room is not ready', () => {
  const { input, room, grid } = makeInput();
  room.canPaint = false;
  input.onDown(pe({ clientX: 2, clientY: 2 }));
  assert.equal(input.strokes.size, 0);
  assert.deepEqual(room.events, ['blocked']);
  assert.equal([...grid.color].some((c) => c !== 0), false);
  input.destroy();
});

test('a stroke keeps one lamport stamp across every batch', () => {
  const { input, room } = makeInput({ state: { brush: 1 } });
  input.onDown(pe({ clientX: 2, clientY: 2 }));
  for (let x = 2; x < 38; x += 3) input.onMove(pe({ clientX: x, clientY: 2 }));
  input.onUp(pe({ clientX: 38, clientY: 2 }));

  assert.ok(room.ops.length >= 2, 'expected several batches for a long drag');
  assert.equal(new Set(room.ops.map((o) => o.seq)).size, 1, 'all batches share the stroke stamp');
  const all = room.ops.flatMap((o) => o.cells);
  assert.equal(new Set(all).size, all.length, 'no cell is sent twice in one stroke');
  input.destroy();
});
