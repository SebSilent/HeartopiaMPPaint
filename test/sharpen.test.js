/**
 * The unsharp mask behind the import's Sharpen slider.
 *
 * A sharpen filter is easy to write and easy to get subtly wrong: it invents
 * dark rings at picture edges, turns transparent borders black, and adds
 * speckle to flat areas. On a board every one of those becomes a colour that was
 * never in the picture, in a cell the player then has to key in.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { sharpen, quantize } from '../assets/js/color/science.js';

/** RGBA helper: a grey image, `vals[y][x]` 0..255, fully opaque. */
function grey(rows, alpha = 255) {
  const h = rows.length;
  const w = rows[0].length;
  const d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = (y * w + x) * 4;
      const v = rows[y][x];
      d[p] = d[p + 1] = d[p + 2] = v;
      d[p + 3] = Array.isArray(alpha) ? alpha[y][x] : alpha;
    }
  }
  return { data: d, width: w, height: h };
}

const at = (img, x, y) => img.data[(y * img.width + x) * 4];

test('amount 0 hands back the same pixels, in a new array', () => {
  const img = grey([[10, 200, 10], [200, 30, 200], [10, 200, 10]]);
  const out = sharpen(img.data, img.width, img.height, 0);
  assert.notEqual(out, img.data, 'a copy, so the caller cannot alias the input');
  assert.deepEqual([...out], [...img.data]);
});

test('the input array is never modified', () => {
  const img = grey([[10, 200, 10], [200, 30, 200], [10, 200, 10]]);
  const before = [...img.data];
  sharpen(img.data, img.width, img.height, 1);
  assert.deepEqual([...img.data], before, 'quantize still reads the original raster if it wants it');
});

test('a flat image stays flat - it does not invent texture', () => {
  // The common failure: a filter that is not actually zero-mean turns a clear
  // sky into 125 shades of nearly-the-same-blue, and the import loses its
  // max-colours budget to noise nobody can see.
  const w = 9;
  const h = 7;
  const img = grey(Array.from({ length: h }, () => new Array(w).fill(128)));
  const out = sharpen(img.data, w, h, 1);
  for (let i = 0; i < w * h; i++) {
    assert.equal(out[i * 4], 128, `pixel ${i} is still 128`);
    assert.equal(out[i * 4 + 3], 255, 'and still opaque');
  }
});

test('a step edge overshoots, which is the whole point', () => {
  const img = grey([
    [40, 40, 40, 40, 200, 200, 200],
    [40, 40, 40, 40, 200, 200, 200],
    [40, 40, 40, 40, 200, 200, 200],
  ]);
  const out = sharpen(img.data, img.width, img.height, 0.25);
  const left = (img, x) => at({ data: out, width: img.width }, x, 1);
  assert.ok(left(img, 3) < 40, `the dark side of the edge went darker: ${left(img, 3)}`);
  assert.ok(left(img, 4) > 200, `the bright side went brighter: ${left(img, 4)}`);
  assert.equal(left(img, 0), 40, 'and the far side of the picture is untouched');
});

test('more slider means more overshoot, and it stops at the slider end', () => {
  const img = grey([
    [40, 40, 40, 40, 200, 200, 200],
    [40, 40, 40, 40, 200, 200, 200],
    [40, 40, 40, 40, 200, 200, 200],
  ]);
  const edge = (a) => at({ data: sharpen(img.data, img.width, img.height, a), width: img.width }, 3, 1);
  const soft = edge(0.2);
  const hard = edge(1);
  assert.ok(hard < soft, `${hard} should be darker than ${soft}`);
  assert.ok(edge(5) >= 0, 'an out-of-range amount is clamped, not wrapped or NaN');
  assert.ok(Number.isFinite(edge(5)), 'and stays a number');
});

test('no dark ring at the picture border', () => {
  // Out-of-frame neighbours read as black in the naive version, so every import
  // gets a charcoal frame around it - and on a garment that frame is cells the
  // player has to paint out by hand.
  const w = 7;
  const h = 5;
  const img = grey(Array.from({ length: h }, () => new Array(w).fill(220)));
  const out = sharpen(img.data, w, h, 1);
  const g = { data: out, width: w };
  for (const [x, y] of [
    [0, 0],
    [w - 1, 0],
    [0, h - 1],
    [w - 1, h - 1],
    [3, 0],
    [0, 2],
  ]) {
    assert.equal(at(g, x, y), 220, `corner (${x},${y}) kept its brightness`);
  }
});

test('a transparent border does not turn the edge of the subject black', () => {
  // PNGs store black inside fully transparent pixels. Averaging those in drags
  // every silhouette edge toward zero, which is a dark outline on a board that
  // had none.
  const a = [
    [0, 0, 0, 0, 0],
    [0, 255, 255, 255, 0],
    [0, 255, 255, 255, 0],
    [0, 255, 255, 255, 0],
    [0, 0, 0, 0, 0],
  ];
  const v = [
    [0, 0, 0, 0, 0],
    [0, 200, 200, 200, 0],
    [0, 200, 200, 200, 0],
    [0, 200, 200, 200, 0],
    [0, 0, 0, 0, 0],
  ];
  const img = grey(v, a);
  const out = sharpen(img.data, 5, 5, 1);
  const g = { data: out, width: 5 };
  assert.equal(at(g, 1, 1), 200, 'the corner of the subject is still 200, not a dark rim');
  assert.equal(at(g, 2, 1), 200, 'and so is the middle of its edge');
  assert.equal(out[((1 * 5 + 1) * 4) + 3], 255, 'still opaque where the subject was');
  assert.equal(out[3], 0, 'still transparent where it was not');
});

test('a transparent pixel is left exactly as it was', () => {
  const img = grey(
    [
      [99, 99, 99],
      [99, 10, 99],
      [99, 99, 99],
    ],
    [
      [255, 255, 255],
      [255, 0, 255],
      [255, 255, 255],
    ]
  );
  const out = sharpen(img.data, 3, 3, 1);
  const p = (1 * 3 + 1) * 4;
  assert.equal(out[p + 3], 0, 'alpha untouched');
  // The hole's own stored colour is 10, and it must come back as 10: the filter
  // skips transparent centres rather than writing a sharpened value into a pixel
  // nobody can see, which would show up the moment something composites over it.
  assert.equal(out[p], 10, 'its stored colour is not smeared by its neighbours');
});

test('an image too small to have a ring comes back unchanged', () => {
  for (const [w, h] of [
    [1, 1],
    [2, 5],
    [5, 2],
  ]) {
    const d = new Uint8ClampedArray(w * h * 4).fill(70);
    for (let i = 3; i < d.length; i += 4) d[i] = 255;
    assert.deepEqual([...sharpen(d, w, h, 1)], [...d], `${w}x${h}`);
  }
});

test('values stay inside a byte - overshoot clamps instead of wrapping', () => {
  // A wrap would put a bright pixel at 0 and print a black cell in the middle of
  // a highlight.
  const img = grey([
    [255, 255, 255, 255, 0, 0, 0],
    [255, 255, 255, 255, 0, 0, 0],
    [255, 255, 255, 255, 0, 0, 0],
  ]);
  const out = sharpen(img.data, img.width, img.height, 1);
  for (let i = 0; i < out.length; i += 4) {
    assert.ok(out[i] >= 0 && out[i] <= 255, `channel in range: ${out[i]}`);
    assert.ok(Number.isInteger(out[i]), `and a whole byte, not ${out[i]}`);
  }
});

test('quantize: sharpness 0 and no sharpness at all are the same board', () => {
  const img = grey([
    [30, 60, 200, 180],
    [40, 90, 210, 170],
    [50, 120, 190, 160],
    [35, 70, 205, 175],
  ]);
  const a = quantize({ data: img.data, width: 4, height: 4 }, {});
  const b = quantize({ data: img.data, width: 4, height: 4 }, { sharpness: 0 });
  assert.deepEqual([...a.cells], [...b.cells]);
});

test('quantize: a strong sharpen actually changes the cells', () => {
  // A soft two-tone block: blur is what the slider has to fight, so the test
  // image is deliberately blurry.
  const rows = [
    [20, 40, 120, 200, 230],
    [20, 45, 125, 205, 235],
    [20, 40, 120, 200, 230],
    [22, 42, 122, 202, 232],
    [20, 40, 120, 200, 230],
  ];
  const img = grey(rows);
  const soft = quantize({ data: img.data, width: 5, height: 5 }, {});
  const crisp = quantize({ data: img.data, width: 5, height: 5 }, { sharpness: 100 });
  assert.notEqual([...soft.cells].join(), [...crisp.cells].join(), 'the slider does something');
  assert.equal(soft.cells.length, crisp.cells.length, 'and does not change the shape');
});

test('quantize still refuses an ImageData where it wants the pixels', () => {
  // The restructure that added sharpness touched the guard, so the guard is the
  // thing being tested here: an ImageData reads undefined for every pixel and
  // quietly returns one flat shade.
  assert.throws(() => quantize({ width: 2, height: 2 }), /pixels, not an ImageData/);
  assert.throws(() => quantize({ data: null, width: 2, height: 2 }), /pixels, not an ImageData/);
});
