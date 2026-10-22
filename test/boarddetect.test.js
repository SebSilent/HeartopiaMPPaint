/*
 * The screenshot detector, against synthetic boards built here rather than
 * photographs: a synthetic board has a known rectangle, a known cell size and
 * known colours, so "it worked" is a fact and not a vibe.
 *
 * The images are plain RGBA buffers, which is exactly what detectBoard takes,
 * so this runs in Node with no canvas and no browser.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectBoard, liftBoard, guessSlot } from '../assets/js/cv/boarddetect.js';
import { palette } from '../assets/js/color/science.js';

const COLS = 12;
const ROWS = 8;
const PITCH = 16;
const PAD = 40; // board origin, in px
const W = PAD * 2 + COLS * PITCH;
const H = PAD * 2 + ROWS * PITCH;

/** A board on a noisy background, with grid lines and guide lines drawn on top. */
function makeBoard(o = {}) {
  const data = new Uint8ClampedArray(W * H * 4);
  const put = (x, y, r, g, b) => {
    const p = (y * W + x) * 4;
    data[p] = r;
    data[p + 1] = g;
    data[p + 2] = b;
    data[p + 3] = 255;
  };
  // Background: mid grey with hard horizontal streaks, so the detector cannot
  // mistake texture for structure.
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const v = 120 + ((x * 7 + y * 13) % 11) * 3;
      put(x, y, v, v, v);
    }
  }
  const cells = [];
  for (let cy = 0; cy < ROWS; cy++) {
    for (let cx = 0; cx < COLS; cx++) {
      // Distinct, saturated colours, so a wrong cell is never "close enough".
      const r = 30 + ((cx * 17 + cy * 5) % 200);
      const g = 30 + ((cx * 3 + cy * 29) % 200);
      const b = 30 + ((cx * 31 + cy * 11) % 200);
      cells.push([r, g, b]);
      for (let y = 0; y < PITCH; y++) {
        for (let x = 0; x < PITCH; x++) put(PAD + cx * PITCH + x, PAD + cy * PITCH + y, r, g, b);
      }
    }
  }
  if (o.gridLines !== false) {
    // Grid lines on the cell borders.
    for (let i = 0; i <= COLS; i++) for (let y = 0; y < ROWS * PITCH; y++) put(PAD + i * PITCH, PAD + y, 0, 0, 0);
    for (let i = 0; i <= ROWS; i++) for (let x = 0; x < COLS * PITCH; x++) put(PAD + x, PAD + i * PITCH, 0, 0, 0);
  }
  if (o.guideLines !== false) {
    // The game's guide lines cut straight through the middle of every cell.
    // Sampling the mean would blend them into every colour; the median must
    // throw them out.
    for (let y = 0; y < ROWS * PITCH; y++) put(PAD + Math.floor(COLS * PITCH / 2), PAD + y, 255, 255, 255);
    for (let x = 0; x < COLS * PITCH; x++) put(PAD + x, PAD + Math.floor(ROWS * PITCH / 2), 255, 255, 255);
  }
  return { data, width: W, height: H, cells };
}

test('a synthetic board is found at the right place and pitch', () => {
  const img = makeBoard();
  const det = detectBoard(img);
  assert.ok(det, 'detection must not give up');
  assert.equal(det.cols, COLS, `expected ${COLS} columns, got ${det.cols}`);
  assert.equal(det.rows, ROWS, `expected ${ROWS} rows, got ${det.rows}`);
  assert.equal(det.pitch, PITCH, 'the comb pitch is the cell size');
  // The frame is at PAD; allow a pixel of slop from the peak/refine search.
  assert.ok(Math.abs(det.rect.x - PAD) <= 2, `x ${det.rect.x} vs ${PAD}`);
  assert.ok(Math.abs(det.rect.y - PAD) <= 2, `y ${det.rect.y} vs ${PAD}`);
});

test('every lifted cell is the colour that was actually there', () => {
  const img = makeBoard();
  const lifted = liftBoard(img);
  assert.ok(lifted);
  assert.equal(lifted.cols, COLS);
  assert.equal(lifted.rows, ROWS);
  const pi = palette();
  let exact = 0;
  for (let i = 0; i < lifted.cells.length; i++) {
    const [r, g, b] = img.cells[i];
    // The median must have picked the cell colour, not the guide line crossing
    // it, so the nearest palette shade is the one for the true colour.
    if (lifted.cells[i] === pi.nearest(r, g, b)) exact++;
  }
  assert.ok(exact === lifted.cells.length, `${exact}/${lifted.cells.length} cells matched`);
});

test('guide lines do not survive median sampling', () => {
  const withLines = liftBoard(makeBoard());
  const without = liftBoard(makeBoard({ guideLines: false }));
  assert.deepEqual([...withLines.cells], [...without.cells], 'the white lines must be invisible to the result');
});

test('a board with no grid lines is still measured by its colour edges', () => {
  // Real screenshots always have lines, but the detector should not depend on
  // them being black: cell-to-cell colour change is structure too.
  const det = detectBoard(makeBoard({ gridLines: false }));
  assert.ok(det, 'still finds something');
  assert.ok(det.cols >= 6 && det.cols <= COLS, `plausible column count, got ${det.cols}`);
});

test('a picture with no board in it is refused, not guessed at', () => {
  const noise = new Uint8ClampedArray(200 * 200 * 4);
  for (let i = 0; i < noise.length; i += 4) {
    const v = (i * 2654435761) & 255;
    noise[i] = v;
    noise[i + 1] = v;
    noise[i + 2] = v;
    noise[i + 3] = 255;
  }
  const det = detectBoard({ data: noise, width: 200, height: 200 });
  assert.equal(det, null, 'no confident rectangle must mean no result');
});

test('the detected cell count maps back onto a real Heartopia face', () => {
  const faces = [
    { id: 'front', label: 'Front', w: 64, h: 80 },
    { id: 'sleeve', label: 'Left sleeve', w: 64, h: 48 },
    { id: 'duvet', label: 'Duvet top', w: 256, h: 128 },
  ];
  assert.equal(guessSlot(64, 80, faces).id, 'front');
  assert.equal(guessSlot(64, 48, faces).id, 'sleeve');
  assert.equal(guessSlot(256, 128, faces).id, 'duvet');
  // A board that is not any of them must not be forced onto one.
  assert.equal(guessSlot(37, 51, faces), null);
});

test('a 30x30 canvas lifts to exactly 900 cells', () => {
  const C = 30;
  const P = 9;
  const size = C * P + 60;
  const data = new Uint8ClampedArray(size * size * 4);
  const put = (x, y, v) => {
    const p = (y * size + x) * 4;
    data[p] = v;
    data[p + 1] = v;
    data[p + 2] = v;
    data[p + 3] = 255;
  };
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) put(x, y, 128);
  for (let cy = 0; cy < C; cy++) {
    for (let cx = 0; cx < C; cx++) {
      const v = (cx * 8 + cy * 3) % 250;
      for (let y = 0; y < P; y++) for (let x = 0; x < P; x++) put(30 + cx * P + x, 30 + cy * P + y, v);
    }
  }
  for (let i = 0; i <= C; i++) {
    for (let k = 0; k < C * P; k++) {
      put(30 + i * P, 30 + k, 10);
      put(30 + k, 30 + i * P, 10);
    }
  }
  const det = detectBoard({ data, width: size, height: size });
  assert.ok(det);
  assert.equal(det.cols, C, `cols ${det.cols}`);
  assert.equal(det.rows, C, `rows ${det.rows}`);
  const lifted = liftBoard({ data, width: size, height: size });
  assert.equal(lifted.cells.length, 900);
});
