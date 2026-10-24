// Shape cells are what a stroke becomes, so they are checked as a picture:
// connected, closed, and spanning the box the player dragged.
import test from 'node:test';
import assert from 'node:assert/strict';
import { lineCells, rectCells, ellipseCells, polygonCells, fillCells, roundOffsets } from '../assets/js/game/shapes.js';
import { Grid } from '../assets/js/game/grid.js';

const set = (pairs) => new Set(pairs.map(([x, y]) => x + ',' + y));
const N8 = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];

/** {cells, loose, parts}: a rim should be one part with nothing loose. */
function survey(pairs) {
  const s = set(pairs);
  const cells = [...s].map((k) => k.split(',').map(Number));
  let loose = 0;
  let parts = 0;
  const seen = new Set();
  for (const [x, y] of cells) {
    let n = 0;
    for (const [dx, dy] of N8) if (s.has(x + dx + ',' + (y + dy))) n++;
    if (n < 2) loose++;
    const k = x + ',' + y;
    if (seen.has(k)) continue;
    parts++;
    const stack = [k];
    while (stack.length) {
      const cur = stack.pop();
      if (seen.has(cur)) continue;
      seen.add(cur);
      const [cx, cy] = cur.split(',').map(Number);
      for (const [dx, dy] of N8) {
        const nk = cx + dx + ',' + (cy + dy);
        if (s.has(nk) && !seen.has(nk)) stack.push(nk);
      }
    }
  }
  return { cells: cells.length, loose, parts };
}

const span = (pairs) => {
  const xs = pairs.map((p) => p[0]);
  const ys = pairs.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
};

test('an ellipse rim is one closed loop, not a scatter of arcs', () => {
  for (const box of [[0, 0, 19, 19], [10, 10, 40, 20], [0, 0, 9, 9], [5, 5, 60, 55], [0, 0, 3, 3]]) {
    const s = survey(ellipseCells(...box, false));
    assert.equal(s.parts, 1, `${box} broke into ${s.parts} pieces`);
    assert.equal(s.loose, 0, `${box} left ${s.loose} cells with no ring either side`);
  }
});

test('an ellipse rim reaches every side of the box it was dragged in', () => {
  const rim = ellipseCells(4, 6, 44, 30, false);
  const [x0, y0, x1, y1] = span(rim);
  assert.ok(x0 <= 5 && x1 >= 43, `x only reached ${x0}..${x1}`);
  assert.ok(y0 <= 7 && y1 >= 29, `y only reached ${y0}..${y1}`);
});

test('a filled ellipse covers its own rim', () => {
  const fill = set(ellipseCells(2, 3, 30, 21, true));
  for (const [x, y] of ellipseCells(2, 3, 30, 21, false)) {
    assert.ok(fill.has(x + ',' + y), `rim cell ${x},${y} is outside the fill`);
  }
});

test('a rectangle rim is a frame and the fill is the whole box', () => {
  const rim = rectCells(3, 4, 12, 9, false);
  const s = set(rim);
  assert.equal(s.size, 2 * (10 + 6) - 4, 'wrong number of frame cells');
  assert.ok(s.has('3,4') && s.has('12,4') && s.has('3,9') && s.has('12,9'), 'corners missing');
  assert.equal(set(rectCells(3, 4, 12, 9, true)).size, 10 * 6, 'fill is not the box');
});

test('a polygon rim closes back on its first point', () => {
  const poly = [[0, 0], [10, 0], [10, 8], [4, 12], [0, 6]];
  const s = survey(polygonCells(poly, false));
  assert.equal(s.parts, 1, 'the ring is broken');
  assert.equal(s.loose, 0, 'the ring has loose ends');
});

test('a line never leaves a gap between its cells', () => {
  for (const [x0, y0, x1, y1] of [[0, 0, 17, 5], [0, 0, 5, 17], [0, 0, 12, 12], [3, 9, 3, 2]]) {
    const cells = lineCells(x0, y0, x1, y1);
    assert.equal(cells[0][0], x0);
    assert.deepEqual(cells[cells.length - 1], [x1, y1], 'the line stopped short');
    for (let i = 1; i < cells.length; i++) {
      const dx = Math.abs(cells[i][0] - cells[i - 1][0]);
      const dy = Math.abs(cells[i][1] - cells[i - 1][1]);
      assert.ok(dx <= 1 && dy <= 1, `gap at step ${i}`);
    }
  }
});

test('a line to a fractional cell is the line to the cell it lands in', () => {
  // Regression for the freeze while drawing: the march truncated its start
  // with | 0 but broke on the raw target, so an integer x never equalled a
  // fractional x1, the 100000-cell guard ran to the end, and _paint pushed
  // ~100k pairs on every pointer move. The target is floored now, so the
  // break is reachable and the stroke is the integer line it lands on.
  for (const [x0, y0, x1, y1] of [[5, 5, 5.37, 8.9], [2.5, 3.2, 12.8, 3.9], [9.1, 1.4, 1.7, 9.6]]) {
    const cells = lineCells(x0, y0, x1, y1);
    assert.deepEqual(cells, lineCells(Math.floor(x0), Math.floor(y0), Math.floor(x1), Math.floor(y1)));
    assert.deepEqual(cells[cells.length - 1], [Math.floor(x1), Math.floor(y1)], 'the line stopped short');
    const steps = Math.max(Math.abs(Math.floor(x1) - Math.floor(x0)), Math.abs(Math.floor(y1) - Math.floor(y0)));
    assert.ok(cells.length <= steps + 1, `${cells.length} cells for ${steps} steps`);
  }
});

test('a polygon is drawn on the cells its vertices land in', () => {
  const whole = [[0, 0], [10, 0], [10, 8], [4, 12], [0, 6]];
  const frac = [[0.4, 0.6], [10.9, 0.2], [10.3, 8.7], [4.5, 12.9], [0.1, 6.4]];
  assert.deepEqual(polygonCells(frac, false), polygonCells(whole, false));
  assert.deepEqual(polygonCells(frac, true), polygonCells(whole, true));
});

test('a fill seeds from the cell the click landed in', () => {
  // cell n spans [n, n+1): a click at (3.9, 2.1) is a click on cell (3, 2).
  // Seeding by rounding would start at (4, 2), an empty cell, and flood the
  // whole empty board instead of the blob.
  const g = new Grid(6, 6);
  g.paint([14, 15, 20, 21], 7, 1, 1); // a 2x2 blob on cells (2,2)..(3,3)
  const cells = (x, y) => fillCells(g, x, y, 7).map((p) => p.join(',')).sort();
  assert.deepEqual(cells(3.9, 2.1), cells(3, 2), 'the fractional seed flooded the same cells');
  assert.deepEqual(cells(3.9, 2.1), ['2,2', '2,3', '3,2', '3,3']);
});

test('a degenerate ellipse is the cell the pointer is in', () => {
  // cell n spans [n, n+1): a tap at (3.9, 2.1) is cell (3, 2) - rounding would
  // paint (4, 2), a cell the pointer never touched.
  assert.deepEqual(ellipseCells(3.9, 2.1, 3.9, 2.1, false), [[3, 2]]);
  assert.deepEqual(ellipseCells(3.9, 2.1, 3.9, 2.1, true), [[3, 2]]);
});

test('roundOffsets scans once per size and hands back the same array after', () => {
  // _paint asks for the footprint on every pointer move; the O(brush^2) scan
  // is the expensive part, so the second call must reuse the first.
  const a = roundOffsets(5);
  assert.ok(roundOffsets(5) === a, 'the second call must reuse the first scan');
  assert.notEqual(roundOffsets(3), a, 'a different size is a different cache entry');
  assert.deepEqual(roundOffsets(3), roundOffsets(3));
  assert.deepEqual(roundOffsets(1), [[0, 0]]);
  assert.ok(a.some(([x, y]) => x === 0 && y === 0), 'centred on the seed');
});
