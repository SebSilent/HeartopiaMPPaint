import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeStamp, stampOffsets, pool } from '../assets/js/game/stamps.js';

const fill = (w, h, fn) => {
  const a = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) a[y * w + x] = fn(x, y);
  return a;
};
const solid = (w, h) => fill(w, h, () => 255);
const key = (o) => o.map(([x, y]) => `${x},${y}`).sort().join(' ');

test('makeStamp trims to the art, not the canvas', () => {
  // A 20x20 image with a 6x6 blob in the corner: the empty margin must not
  // spend half the brush size on nothing.
  const s = makeStamp(20, 20, fill(20, 20, (x, y) => (x >= 10 && x < 16 && y >= 2 && y < 8 ? 255 : 0)));
  assert.deepEqual(s.box, { x: 10, y: 2, w: 6, h: 6 });
  assert.equal(s.on, 36);
});

test('makeStamp rejects empty and short data', () => {
  assert.equal(makeStamp(4, 4, new Uint8Array(16)), null);
  assert.equal(makeStamp(4, 4, new Uint8Array(9)), null);
  assert.equal(makeStamp(0, 3, new Uint8Array(3)), null);
});

test('a solid tip paints every cell of the footprint', () => {
  const offs = stampOffsets(makeStamp(10, 10, solid(10, 10)), 5);
  assert.equal(offs.length, 25);
  assert.equal(new Set(offs.map((o) => o.join(','))).size, 25, 'no duplicate cells');
  // Centred: the middle cell is the cursor cell, and it reaches both edges.
  assert.ok(offs.some(([x, y]) => x === 0 && y === 0));
  assert.deepEqual([Math.min(...offs.map((o) => o[0])), Math.max(...offs.map((o) => o[0]))], [-2, 2]);
  assert.deepEqual([Math.min(...offs.map((o) => o[1])), Math.max(...offs.map((o) => o[1]))], [-2, 2]);
});

test('a flat brush stays flat and sits on the cursor row', () => {
  const s = makeStamp(20, 6, fill(20, 6, (x, y) => (y === 3 ? 255 : 0)));
  const offs = stampOffsets(s, 5);
  assert.ok(offs.every(([x, y]) => y === 0), `all on one row: ${key(offs)}`);
  assert.equal(offs.length, 5);
  assert.deepEqual(offs.map((o) => o[0]).sort((a, b) => a - b), [-2, -1, 0, 1, 2]);
});

test('a hairline survives being shrunk, which sampling would lose', () => {
  // One pixel wide, 60 tall. Nearest-neighbour at size 5 would land on it or
  // miss it depending on rounding; max-pooling must always keep it.
  const s = makeStamp(60, 60, fill(60, 60, (x) => (x === 17 ? 255 : 0)));
  const offs = stampOffsets(s, 5);
  assert.equal(new Set(offs.map((o) => o[0])).size, 1, 'still one column');
  assert.equal(offs.length, 5);
  assert.equal(offs[0][0], 0, 'centred on the cursor column');
});

test('aspect ratio is kept, not squashed into a square', () => {
  const s = makeStamp(20, 5, solid(20, 5));
  const offs = stampOffsets(s, 10);
  const xs = new Set(offs.map((o) => o[0]));
  const ys = new Set(offs.map((o) => o[1]));
  assert.ok(xs.size >= ys.size * 2, `wide beats tall: ${xs.size} vs ${ys.size}`);
  assert.equal(xs.size, 10);
});

test('faint pixels below the threshold do not paint', () => {
  const s = makeStamp(10, 10, fill(10, 10, (x, y) => (x < 5 ? 255 : 40)));
  const offs = stampOffsets(s, 4);
  assert.ok(offs.every(([x]) => x <= 0), `only the dark half: ${key(offs)}`);
});

test('no tip means one cell, never an empty brush', () => {
  assert.deepEqual(stampOffsets(null, 7), [[0, 0]]);
});

test('pool reads the strongest pixel of a cell', () => {
  const s = makeStamp(4, 4, fill(4, 4, (x, y) => (x === 1 && y === 1 ? 200 : 10)));
  // A 2x2 grid over a 4x4 tip: cell [0,0] owns x,y in [0,2) so it sees the 200;
  // cell [1,1] owns [2,4) and only ever sees the 10s.
  assert.equal(pool(s, s.box, 0, 0, 2, 2), 200);
  assert.equal(pool(s, s.box, 1, 1, 2, 2), 10);
});

test('a tip is pooled once per size, not once per pointer move', () => {
  // _paint asks for the footprint on every move; the pool scan over the whole
  // art is the expensive part, so the second call must reuse the first.
  const s = makeStamp(10, 10, solid(10, 10));
  const first = stampOffsets(s, 5);
  assert.ok(stampOffsets(s, 5) === first, 'same stamp, same size: same array');
  assert.notEqual(stampOffsets(s, 7), first, 'a different size is a different footprint');
  assert.notEqual(stampOffsets(makeStamp(10, 10, solid(10, 10)), 5), first, 'a re-imported tip is pooled fresh');
  assert.deepEqual(stampOffsets(s, 5, 40), stampOffsets(s, 5, 40), 'the threshold is part of the key too');
  assert.notEqual(stampOffsets(s, 5, 40), first, 'a different threshold does not hand back the other scan');
});
