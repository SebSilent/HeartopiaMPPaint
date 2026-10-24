import test from 'node:test';
import assert from 'node:assert/strict';

import { traceBoundary } from '../assets/js/game/trace.js';
import { boardOutline, outlineFor } from '../assets/js/game/outline.js';
import { faceInfo, maskFor } from '../assets/js/game/faces.js';
import { CATALOG } from '../assets/js/game/slots.js';

/** The same even-odd rule the board and the checker use. */
function inRings(rings, x, y) {
  let c = false;
  for (const r of rings) {
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const [xi, yi] = r[i];
      const [xj, yj] = r[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
    }
  }
  return c;
}

function grid(w, h, on) {
  const m = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) m[y * w + x] = on(x, y) ? 1 : 0;
  return m;
}

test('one cell traces as the square it occupies', () => {
  const rings = traceBoundary(grid(3, 3, (x, y) => x === 1 && y === 1), 3, 3);
  assert.equal(rings.length, 1);
  assert.deepEqual(new Set(rings[0].map((p) => p.join(','))), new Set(['1,1', '2,1', '2,2', '1,2']));
});

test('a solid block traces as its outline, not as a staircase', () => {
  const rings = traceBoundary(grid(6, 4, (x, y) => x >= 1 && x <= 4 && y >= 1 && y <= 2), 6, 4);
  assert.equal(rings.length, 1);
  assert.equal(rings[0].length, 4, 'collinear vertices should be dropped');
  // A loop has no agreed starting vertex, so compare the corners, not the order.
  assert.deepEqual(new Set(rings[0].map((p) => p.join(','))), new Set(['1,1', '5,1', '5,3', '1,3']));
});

test('a hole comes out as a second ring, so the middle is not enclosed', () => {
  const rings = traceBoundary(grid(5, 5, (x, y) => x >= 1 && x <= 3 && y >= 1 && y <= 3 && !(x === 2 && y === 2)), 5, 5);
  assert.equal(rings.length, 2);
  // Biggest first, so an outer boundary is never mistaken for a hole.
  assert.ok(rings[0].length >= rings[1].length);
  assert.equal(inRings(rings, 1.5, 1.5), true, 'ring of the donut should be enclosed');
  assert.equal(inRings(rings, 2.5, 2.5), false, 'the hole must not be enclosed');
  assert.equal(inRings(rings, 0.5, 0.5), false);
});

test('two cells touching only at a corner stay two loops', () => {
  // The case a single-valued edge map gets wrong: the shared vertex owns two
  // outgoing edges, and keeping one splices both lobes into one ring.
  const rings = traceBoundary(grid(2, 2, (x, y) => x === y), 2, 2);
  assert.equal(rings.length, 2, 'a pinch must not merge the lobes');
  for (const r of rings) assert.equal(r.length, 4);
});

test('an empty region traces nothing', () => {
  assert.deepEqual(traceBoundary(grid(4, 4, () => false), 4, 4), []);
  assert.deepEqual(traceBoundary(null, 4, 4), []);
});

test('every traced face encloses exactly the cells the game lets you paint', () => {
  // This is the whole point of tracing: the line and the brush cannot disagree.
  const offenders = [];
  for (const [family, items] of Object.entries(CATALOG)) {
    if (family === 'canvas') continue;
    for (const item of items) {
      for (const face of item.faces) {
        const info = faceInfo(item.id, face.id);
        if (!info || !info.off) continue; // no cell list to agree with
        const mask = maskFor(item.id, face.id);
        const o = boardOutline(item.id, face.id);
        let bad = 0;
        for (let y = 0; y < info.h; y++) {
          for (let x = 0; x < info.w; x++) {
            if (inRings(o.rings, x + 0.5, y + 0.5) !== (mask[y * info.w + x] === 1)) bad++;
          }
        }
        if (bad) offenders.push(`${item.id}.${face.id} ${bad} cells`);
      }
    }
  }
  assert.deepEqual(offenders, [], 'outline disagrees with paintable cells: ' + offenders.join(', '));
});

test('the traced outline is not the shape the catalog lines drew', () => {
  // Locks in the bug this replaced, so it cannot come back quietly. The trousers
  // front is paintable as one rectangle; the catalog's maskLines are two leg
  // rectangles that leave the crotch between them outside any ring.
  const info = faceInfo('trousers', 'front');
  const mask = maskFor('trousers', 'front');
  const traced = boardOutline('trousers', 'front');
  let linesBad = 0;
  for (let y = 0; y < info.h; y++) {
    for (let x = 0; x < info.w; x++) {
      if (inRings(info.rings, x + 0.5, y + 0.5) !== (mask[y * info.w + x] === 1)) linesBad++;
    }
  }
  assert.ok(linesBad > 500, `expected the catalog lines to miss the crotch, got ${linesBad} cells`);
  assert.equal(traced.rings.length, 1, 'the paintable trousers front is one piece');
  assert.deepEqual(traced.rings[0].length, 4, 'and it is a rectangle');
});

test('a mesh island is still offered for the 3D clip, untouched', () => {
  // The 3D preview clips one panel that really is one UV island, so it must keep
  // getting the mesh ring and not the traced board outline.
  const island = outlineFor('tshirt', 'front');
  const board = boardOutline('tshirt', 'front');
  assert.ok(Array.isArray(island.ring), 'mesh ring still available on its own');
  assert.ok(board.rings, 'the board gets rings');
  assert.notDeepEqual(board.rings[0], island.ring, 'the two are different shapes');
});

test('the book keeps its guide lines and blocks nothing', () => {
  // No cell list, so nothing to trace: the spine and covers are drawn as guides,
  // and a guide must never arrive as a boundary.
  const book = boardOutline('book', 'tall');
  assert.equal(book.rings, undefined, 'the book has no paintable edge to draw');
  assert.ok(book.guides.length >= 3, 'spine plus two covers');
  const mask = maskFor('book', 'tall');
  assert.equal(mask.length, 150 * 84);
  assert.equal(mask.every((v) => v === 1), true, 'every cell of the book paints');
});

test('a traced face is cheap to stroke', () => {
  // The board redraws the outline on every frame it is shown, so a tracer that
  // emitted one vertex per cell step would cost thousands of lineTo.
  let worst = 0;
  let where = '';
  for (const [family, items] of Object.entries(CATALOG)) {
    if (family === 'canvas') continue;
    for (const item of items) {
      for (const face of item.faces) {
        const o = boardOutline(item.id, face.id);
        if (!o || !o.rings) continue;
        const pts = o.rings.reduce((s, r) => s + r.length, 0);
        if (pts > worst) {
          worst = pts;
          where = `${item.id}.${face.id}`;
        }
      }
    }
  }
  assert.ok(worst < 400, `${where} strokes ${worst} vertices`);
});
