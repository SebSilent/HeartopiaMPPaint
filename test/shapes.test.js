// Shape cells are what a stroke becomes, so they are checked as a picture:
// connected, closed, and spanning the box the player dragged.
import test from 'node:test';
import assert from 'node:assert/strict';
import { lineCells, rectCells, ellipseCells, polygonCells } from '../assets/js/game/shapes.js';

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
