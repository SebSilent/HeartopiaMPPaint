/*
 * Input is the layer that broke in the real world and that no earlier test
 * touched: it needs a DOM. Rather than skip it, the view and room are stubbed
 * and the real Input methods are driven with synthetic pointer events.
 * Everything asserted here is behaviour a player reported as broken.
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeStamp } from '../assets/js/game/stamps.js';
import { shapeCells, roundOffsets } from '../assets/js/game/shapes.js';

// Input checks for Pointer Events support at bind time.
globalThis.window = globalThis.window || {};
globalThis.window.PointerEvent = function PointerEvent() {};

import { Grid } from '../assets/js/game/grid.js';
import { SingleFaceDesign } from '../assets/js/game/design.js';
import { History, patchWrite } from '../assets/js/game/history.js';
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
  const [gw, gh] = overrides.grid || [10, 10];
  const grid = new Grid(gw, gh);
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
  const history = new History();
  const input = new Input({
    room,
    view,
    getState: () => state,
    setState: (patch) => Object.assign(state, patch),
    history,
  });
  created.push(input);
  return { input, grid, view, room, state, history };
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

test('a round eraser erases the dab, not the square', () => {
  // brushShape is global state, so the eraser can be round too. It erases
  // through the same dab path: a square 3 paints 3x3, a round 3 erases the
  // plus out of it, and the four corners survive.
  const { input, grid, state } = makeInput({ state: { brush: 3, brushShape: 'square' } });
  input.onDown(pe({ clientX: 5 * SCALE, clientY: 5 * SCALE })); // square 3: cells 4..6 x 4..6
  input.onUp(pe({ clientX: 5 * SCALE, clientY: 5 * SCALE }));
  assert.equal([...grid.color].filter((c) => c).length, 9, 'a 3x3 block to erase from');

  state.tool = TOOLS.ERASER;
  state.brushShape = 'round';
  input.onDown(pe({ clientX: 5 * SCALE, clientY: 5 * SCALE })); // round 3: the plus
  input.onUp(pe({ clientX: 5 * SCALE, clientY: 5 * SCALE }));

  const left = [];
  for (let y = 0; y < 10; y++) for (let x = 0; x < 10; x++) if (grid.color[y * 10 + x]) left.push([x, y]);
  assert.deepEqual(left.map((p) => p.join(',')).sort(), ['4,4', '4,6', '6,4', '6,6'], 'only the corners survive');
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

test('a round-brush stroke also sends no cell twice', () => {
  // The sent-filter is now a typed-array generation mark, not a Set. Overlap
  // between consecutive dabs must still collapse to one send per cell.
  const { input, room } = makeInput({ state: { brush: 5, brushShape: 'round' } });
  input.onDown(pe({ clientX: 2, clientY: 2 }));
  for (let x = 2; x < 38; x += 3) input.onMove(pe({ clientX: x, clientY: 2 }));
  input.onUp(pe({ clientX: 38, clientY: 2 }));

  assert.ok(room.ops.length >= 2, 'expected several batches for a long drag');
  const all = room.ops.flatMap((o) => o.cells);
  assert.equal(new Set(all).size, all.length, 'no cell is sent twice in one stroke');
  input.destroy();
});

/** A 20x6 tip whose only ink is one row: a flat brush. */
const barStamp = () => {
  const a = new Uint8Array(20 * 6);
  for (let x = 0; x < 20; x++) a[3 * 20 + x] = 255;
  return makeStamp(20, 6, a);
};

test('an imported tip replaces the footprint, not just the look of it', () => {
  const { input, grid } = makeInput({ state: { brush: 5, stamp: barStamp() } });
  // One tap dead centre of cell (5,5): the stub view is at scale 4, so 20px.
  // Landing on a whole cell keeps the assertion about centring honest.
  input.onDown(pe({ clientX: 20, clientY: 20 }));
  input.onUp(pe({ clientX: 20, clientY: 20 }));

  const on = [];
  for (let y = 0; y < 10; y++) for (let x = 0; x < 10; x++) if (grid.color[y * 10 + x]) on.push([x, y]);
  assert.equal(on.length, 5, `a flat tip must paint 5 cells, got ${on.length}`);
  assert.equal(new Set(on.map((o) => o[1])).size, 1, 'all on one row');
  assert.deepEqual(on.map((o) => o[0]).sort((a, b) => a - b), [3, 4, 5, 6, 7], `centred on the tap: ${JSON.stringify(on)}`);
  input.destroy();
});

test('with no tip the same tap paints the built-in square', () => {
  const { input, grid } = makeInput({ state: { brush: 5, stamp: null } });
  input.onDown(pe({ clientX: 20, clientY: 20 }));
  input.onUp(pe({ clientX: 20, clientY: 20 }));
  assert.equal([...grid.color].filter((c) => c).length, 25, 'square 5x5');
  input.destroy();
});

test('a drag to a fractional cell paints what the drag to its floor paints', () => {
  // Regression for the freeze while drawing: _paint handed lineCells the raw
  // fractional move target, whose integer march could never equal it, so the
  // 100000-cell guard ran on every move and the stroke smeared over the board.
  // The target is floored now, so a fractional drag is the integer drag it
  // lands on - same cells, and no smear.
  const run = (mx, my) => {
    const { input, grid } = makeInput({ state: { brush: 5, brushShape: 'round' } });
    input.onDown(pe({ clientX: 2 * SCALE + 1, clientY: 2 * SCALE + 1 }));
    input.onMove(pe({ clientX: mx, clientY: my }));
    input.onUp(pe({ clientX: mx, clientY: my }));
    const on = [];
    for (let y = 0; y < 10; y++) for (let x = 0; x < 10; x++) if (grid.color[y * 10 + x]) on.push(x + ',' + y);
    input.destroy();
    return on;
  };
  const frac = run(7 * SCALE + 1.5, 5 * SCALE + 2.8); // cell (7.375, 5.7)
  const whole = run(7 * SCALE, 5 * SCALE); // cell (7, 5)
  assert.deepEqual(frac, whole, 'the fractional drag must land on the same cells');
  assert.ok(frac.length >= 6 && frac.length < 80, `a short round line, not a smear: ${frac.length} cells`);
});

test('a round brush paints exactly the union of its dabs along the drag', () => {
  // The hot path used to build a [x,y] pair array per candidate cell and
  // dedupe it with string keys. dabCells replaces that with one scratch pass;
  // this pins the painted result to the reference pipeline it replaced.
  const { input, grid } = makeInput({ state: { brush: 5, brushShape: 'round' } });
  input.onDown(pe({ clientX: 2 * SCALE + 1, clientY: 2 * SCALE + 1 })); // cell (2.25, 2.25)
  input.onMove(pe({ clientX: 7 * SCALE + 2, clientY: 4 * SCALE + 3 })); // cell (7.5, 4.75)
  input.onUp(pe({ clientX: 7 * SCALE + 2, clientY: 4 * SCALE + 3 }));

  const want = new Set();
  const seeds = [[7.5, 4.75], ...shapeCells('line', 2.25, 2.25, 7.5, 4.75, false)];
  for (const [sx, sy] of seeds) {
    const fx = Math.floor(sx);
    const fy = Math.floor(sy);
    for (const [dx, dy] of roundOffsets(5)) {
      const x = fx + dx;
      const y = fy + dy;
      if (x >= 0 && y >= 0 && x < 10 && y < 10) want.add(y * 10 + x);
    }
  }
  const got = [];
  for (let i = 0; i < 100; i++) if (grid.color[i]) got.push(i);
  assert.deepEqual(got.sort((a, b) => a - b), [...want].sort((a, b) => a - b));
  input.destroy();
});

test('a mirrored round brush paints the dab union and its reflection, each cell once', () => {
  // mirrorIndices runs after the dab union, on flat indices, and nothing pinned
  // that interaction for shaped tips. The reference is the same union, plus
  // every painted cell flipped across the x axis.
  const { input, grid, room } = makeInput({ state: { brush: 3, brushShape: 'round', mirror: 1 } });
  input.onDown(pe({ clientX: 2 * SCALE, clientY: 2 * SCALE })); // cell (2, 2)
  input.onMove(pe({ clientX: 6 * SCALE, clientY: 2 * SCALE })); // cell (6, 2)
  input.onUp(pe({ clientX: 6 * SCALE, clientY: 2 * SCALE }));

  const want = new Set();
  const seeds = [[6, 2], ...shapeCells('line', 2, 2, 6, 2, false)];
  for (const [sx, sy] of seeds) {
    const fx = Math.floor(sx);
    const fy = Math.floor(sy);
    for (const [dx, dy] of roundOffsets(3)) {
      const x = fx + dx;
      const y = fy + dy;
      if (x >= 0 && y >= 0 && x < 10 && y < 10) {
        want.add(y * 10 + x);
        want.add(y * 10 + (9 - x)); // the x mirror
      }
    }
  }
  const got = [];
  for (let i = 0; i < 100; i++) if (grid.color[i]) got.push(i);
  assert.deepEqual(got.sort((a, b) => a - b), [...want].sort((a, b) => a - b));

  const sent = room.ops.flatMap((o) => o.cells);
  assert.equal(new Set(sent).size, sent.length, 'no cell sent twice');
  input.destroy();
});

test('a spray tap inks a fixed share of the disc, inside it', () => {
  // The count is pinned by density - a quarter of the 13-cell disc of brush 5
  // rounds to 3 - while which cells is the rng's business; every one must stay
  // inside the disc the player aimed at.
  const { input, grid } = makeInput({ state: { brush: 5, brushShape: 'spray' } });
  input.onDown(pe({ clientX: 20, clientY: 20 })); // cell (5, 5)
  input.onUp(pe({ clientX: 20, clientY: 20 }));

  const on = [];
  for (let y = 0; y < 10; y++) for (let x = 0; x < 10; x++) if (grid.color[y * 10 + x]) on.push([x, y]);
  assert.equal(on.length, 3, `one dab of normal density inks 3 of 13 cells, got ${on.length}`);
  const disc = new Set(roundOffsets(5).map(([dx, dy]) => (5 + dy) * 10 + (5 + dx)));
  for (const [x, y] of on) assert.ok(disc.has(y * 10 + x), `(${x}, ${y}) is inside the disc`);
  input.destroy();
});

test('a spray stroke sends no cell twice', () => {
  // The spray draws a fresh scatter per dab, so the same cell can be inked
  // many times along a drag; the sent-filter must still collapse it to one
  // send per cell, exactly as it does for the round brush.
  const { input, room } = makeInput({ state: { brush: 5, brushShape: 'spray' } });
  input.onDown(pe({ clientX: 2, clientY: 2 }));
  for (let x = 2; x < 38; x += 3) input.onMove(pe({ clientX: x, clientY: 2 }));
  input.onUp(pe({ clientX: 38, clientY: 2 }));

  assert.ok(room.ops.length >= 2, 'expected several batches for a long drag');
  const all = room.ops.flatMap((o) => o.cells);
  assert.equal(new Set(all).size, all.length, 'no cell is sent twice in one stroke');
  input.destroy();
});

test('a mirrored spray paints each dab and its reflection', () => {
  // The mirror runs after the dab union, on flat indices; a spray's union is
  // random per dab, so the exact picture is not pinnable - but every painted
  // cell must have its reflection painted, and nothing may land outside the
  // discs and their reflections.
  const { input, grid, room } = makeInput({ state: { brush: 5, brushShape: 'spray', mirror: 1 } });
  input.onDown(pe({ clientX: 2 * SCALE, clientY: 2 * SCALE })); // cell (2, 2)
  input.onMove(pe({ clientX: 6 * SCALE, clientY: 2 * SCALE })); // cell (6, 2)
  input.onUp(pe({ clientX: 6 * SCALE, clientY: 2 * SCALE }));

  const want = new Set();
  const seeds = [[6, 2], ...shapeCells('line', 2, 2, 6, 2, false)];
  for (const [sx, sy] of seeds) {
    const fx = Math.floor(sx);
    const fy = Math.floor(sy);
    for (const [dx, dy] of roundOffsets(5)) {
      const x = fx + dx;
      const y = fy + dy;
      if (x >= 0 && y >= 0 && x < 10 && y < 10) {
        want.add(y * 10 + x);
        want.add(y * 10 + (9 - x)); // the x mirror
      }
    }
  }
  const got = [];
  for (let i = 0; i < 100; i++) if (grid.color[i]) got.push(i);
  assert.ok(got.length > 0, 'the spray painted something');
  assert.ok(got.length < want.size, 'a scatter, not the solid disc union');
  for (const i of got) {
    assert.ok(want.has(i), `cell ${i} is inside the discs and their reflections`);
    const x = i % 10;
    const y = (i - x) / 10;
    assert.ok(got.includes(y * 10 + (9 - x)), `the mirror of (${x}, ${y}) is painted too`);
  }
  const sent = room.ops.flatMap((o) => o.cells);
  assert.equal(new Set(sent).size, sent.length, 'no cell sent twice');
  input.destroy();
});

test('a spray previews the disc it scatters inside', () => {
  // The scatter is random per dab, so the preview must hug the disc, not one
  // draw of it: whatever cells one dab happens to ink, the next dab breaks.
  const { input, view } = makeInput({ state: { brush: 3, brushShape: 'spray' } });
  input.onMove(pe({ clientX: 7 * SCALE + 1.5, clientY: 5 * SCALE + 2.8 })); // hover (7.375, 5.7)
  const ctx = fakeCtx();
  input.drawPreview(ctx, view);
  const fills = ctx.calls.filter((c) => c[0] === 'fillRect').map((c) => c.slice(1));
  // The disc of brush 3 is a plus: centre + 4 arms. The centre is interior, so
  // the rim is the four arms: cells (8,5), (6,5), (7,4), (7,6) at scale 4.
  assert.deepEqual(
    fills.map((r) => r.join(',')).sort(),
    ['24,20,4,4', '28,16,4,4', '28,24,4,4', '32,20,4,4'],
  );
  const boxes = ctx.calls.filter((c) => c[0] === 'strokeRect');
  assert.equal(boxes.length, 0, 'no square box for the spray');
  input.destroy();
});

test('an imported tip wins over the spray', () => {
  // A tip is the more specific thing the player asked for; the spray must not
  // scatter it into a cloud.
  const { input, grid } = makeInput({ state: { brush: 5, brushShape: 'spray', stamp: barStamp() } });
  input.onDown(pe({ clientX: 20, clientY: 20 }));
  input.onUp(pe({ clientX: 20, clientY: 20 }));

  const on = [];
  for (let y = 0; y < 10; y++) for (let x = 0; x < 10; x++) if (grid.color[y * 10 + x]) on.push([x, y]);
  assert.equal(on.length, 5, `a flat tip must paint 5 cells, got ${on.length}`);
  assert.equal(new Set(on.map((o) => o[1])).size, 1, 'all on one row');
  input.destroy();
});

test('a huge dab on a fast drag does not blow the argument limit', () => {
  // s.wire.push(...fresh) spread every fresh cell into one call; past ~125k
  // arguments that is a RangeError, and a big tip on a fast drag on a big board
  // crosses it inside a single pointer event.
  const { input, room } = makeInput({ grid: [500, 500], state: { brush: 500, brushShape: 'round' } });
  input.onDown(pe({ clientX: 250 * SCALE, clientY: 250 * SCALE }));
  input.onUp(pe({ clientX: 250 * SCALE, clientY: 250 * SCALE }));

  const sent = room.ops.reduce((n, o) => n + o.cells.length, 0);
  assert.ok(sent > 125000, `expected one event to send more than the argument limit, got ${sent}`);
  input.destroy();
});

test('a shape drag to a fractional cell commits the shape its floor commits', () => {
  // _move used to round the free end of a dragged shape: a line released at
  // (7.375, 5.7) committed its far end at (8, 6) - a cell grown on each axis
  // that the pointer never crossed. The free end is floored now, so the
  // committed shape is the one the integer release would have drawn.
  const run = (mx, my) => {
    const { input, grid } = makeInput({ state: { tool: TOOLS.LINE } });
    input.onDown(pe({ clientX: 2 * SCALE + 1, clientY: 2 * SCALE + 1 }));
    input.onMove(pe({ clientX: mx, clientY: my }));
    input.onUp(pe({ clientX: mx, clientY: my }));
    const on = [];
    for (let y = 0; y < 10; y++) for (let x = 0; x < 10; x++) if (grid.color[y * 10 + x]) on.push(x + ',' + y);
    input.destroy();
    return on;
  };
  const frac = run(7 * SCALE + 1.5, 5 * SCALE + 2.8); // cell (7.375, 5.7)
  const whole = run(7 * SCALE, 5 * SCALE); // cell (7, 5)
  assert.deepEqual(frac, whole, 'the fractional release must commit the floored shape');
  assert.ok(frac.includes('7,5'), 'the line reaches the cell the pointer was in');
  assert.ok(!frac.includes('8,6'), 'the line did not grow a cell on release');
});

// drawPreview renders onto a canvas; a recording stub stands in for one.
const fakeCtx = () => {
  const calls = [];
  const rec = (name) => (...args) => calls.push([name, ...args]);
  return {
    calls,
    save: rec('save'),
    restore: rec('restore'),
    beginPath: rec('beginPath'),
    moveTo: rec('moveTo'),
    lineTo: rec('lineTo'),
    stroke: rec('stroke'),
    fillRect: rec('fillRect'),
    strokeRect: rec('strokeRect'),
    setLineDash: rec('setLineDash'),
  };
};

test('the polygon rubber line ends on the cell the next click would add', () => {
  // The rubber line used to end at round(hover): hovering at (7.375, 5.7)
  // previewed an endpoint in cell (8, 6) while the click would add (7, 5).
  const { input, view } = makeInput({ state: { tool: TOOLS.POLYGON } });
  input.onDown(pe({ clientX: 2 * SCALE, clientY: 2 * SCALE })); // vertex (2,2)
  input.onDown(pe({ clientX: 9 * SCALE, clientY: 3 * SCALE })); // vertex (9,3)
  input.onMove(pe({ clientX: 7 * SCALE + 1.5, clientY: 5 * SCALE + 2.8 })); // hover (7.375, 5.7)
  const ctx = fakeCtx();
  input.drawPreview(ctx, view);
  const lines = ctx.calls.filter((c) => c[0] === 'lineTo').map((c) => c.slice(1));
  assert.deepEqual(lines[lines.length - 1], [28, 20], 'rubber line ends at toScreen(7, 5)');
  input.destroy();
});

test('the brush footprint box previews the cells a stroke would paint', () => {
  // brushBox used to round the hover cell: at (7.375, 5.7) the box sat over
  // cells 7..9 x 5..7 while a stroke there paints 6..8 x 4..6.
  const { input, view } = makeInput({ state: { brush: 3 } });
  input.onMove(pe({ clientX: 7 * SCALE + 1.5, clientY: 5 * SCALE + 2.8 })); // hover (7.375, 5.7)
  const ctx = fakeCtx();
  input.drawPreview(ctx, view);
  const rects = ctx.calls.filter((c) => c[0] === 'strokeRect').map((c) => c.slice(1));
  assert.deepEqual(rects, [[24.5, 16.5, 12, 12]], 'box over cells 6..8 x 4..6');
  input.destroy();
});

test('a round brush previews its real footprint, not a square box', () => {
  // The preview drew brushBox for every tip: a round brush 3 previewed a 3x3
  // square while the stroke paints a plus of five cells.
  const { input, view } = makeInput({ state: { brush: 3, brushShape: 'round' } });
  input.onMove(pe({ clientX: 7 * SCALE + 1.5, clientY: 5 * SCALE + 2.8 })); // hover (7.375, 5.7)
  const ctx = fakeCtx();
  input.drawPreview(ctx, view);
  const fills = ctx.calls.filter((c) => c[0] === 'fillRect').map((c) => c.slice(1));
  // roundOffsets(3) is a plus: centre + 4 arms. The centre is interior, so the
  // rim is the four arms: cells (8,5), (6,5), (7,4), (7,6) at scale 4.
  assert.deepEqual(
    fills.map((r) => r.join(',')).sort(),
    ['24,20,4,4', '28,16,4,4', '28,24,4,4', '32,20,4,4'],
  );
  input.destroy();
});

test('an imported tip previews its rim, not a square box', () => {
  // The rim preview was pinned for the round brush only. A tip goes through the
  // same dabRim path; a flat bar tip has every cell on the rim, because each
  // touches unpainted rows above and below.
  const { input, view } = makeInput({ state: { brush: 5, stamp: barStamp() } });
  input.onMove(pe({ clientX: 7 * SCALE + 1.5, clientY: 5 * SCALE + 2.8 })); // hover (7.375, 5.7)
  const ctx = fakeCtx();
  input.drawPreview(ctx, view);
  const fills = ctx.calls.filter((c) => c[0] === 'fillRect').map((c) => c.slice(1));
  // stampOffsets(bar, 5) is one row of five: cells (5..9, 5) at scale 4.
  assert.deepEqual(
    fills.map((r) => r.join(',')).sort(),
    ['20,20,4,4', '24,20,4,4', '28,20,4,4', '32,20,4,4', '36,20,4,4'],
  );
  const boxes = ctx.calls.filter((c) => c[0] === 'strokeRect');
  assert.equal(boxes.length, 0, 'no square box for a shaped tip');
  input.destroy();
});

/* ---------------- undo ---------------- */

test('a finished stroke leaves one undo step, and undoing it restores the board', () => {
  const { input, grid, room, history } = makeInput();
  input.onDown(pe({ clientX: 2, clientY: 2 }));
  input.onMove(pe({ clientX: 10, clientY: 2 }));
  input.onMove(pe({ clientX: 18, clientY: 2 }));
  input.onUp(pe({ clientX: 18, clientY: 2 }));

  assert.equal(history.canUndo, true, 'the stroke is undoable');
  assert.equal(history.past.length, 1, 'one stroke is one undo step, however many batches');

  const entry = history.undo();
  assert.equal(entry.face, 0);
  assert.equal(entry.label, 'stroke');
  const { indices, values } = patchWrite(entry);
  assert.ok(indices.length >= 3, `expected the whole stroke, got ${indices.length} cells`);
  assert.ok([...values].every((v) => v === 0), 'undo hands back the pre-stroke values');

  // Apply it the way main.js step() does: group by value, one fresh stamp.
  const byColor = new Map();
  for (let i = 0; i < indices.length; i++) {
    const c = values[i];
    if (!byColor.has(c)) byColor.set(c, []);
    byColor.get(c).push(indices[i]);
  }
  const seq = room.nextSeq();
  for (const [c, list] of byColor) room.paintLocal(list, c, seq, entry.face);
  assert.ok([...grid.color].every((c) => c === 0), 'the board is blank again');
  input.destroy();
});

test('a fill is one undo step through the same region path', () => {
  const { input, grid, history } = makeInput({ state: { tool: TOOLS.FILL } });
  input.onDown(pe({ clientX: 4 * SCALE, clientY: 4 * SCALE }));
  input.onUp(pe({ clientX: 4 * SCALE, clientY: 4 * SCALE }));

  assert.ok([...grid.color].every((c) => c === 16), 'the blank board floods to the colour');
  assert.equal(history.canUndo, true, 'the fill is undoable');
  assert.equal(history.past.length, 1);

  const entry = history.undo();
  assert.equal(entry.label, 'fill');
  const { indices, values } = patchWrite(entry);
  assert.equal(indices.length, 100, 'the whole 10x10 board was one blank region');
  assert.ok([...values].every((v) => v === 0));

  const back = history.redo();
  assert.ok([...back.values].every((v) => v === 16), 'redo hands back the fill');
  input.destroy();
});
