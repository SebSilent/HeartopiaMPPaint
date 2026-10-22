/*
 * New behaviour added while debugging the import check: the detector snapping
 * to an expected board, and the import reporting a board that is not this face.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectBoard, liftBoard } from '../assets/js/cv/boarddetect.js';

function board({ cols, rows, pitch, pad = 6, grid = true, guides = false }) {
  const W = pad * 2 + cols * pitch;
  const H = pad * 2 + rows * pitch;
  const data = new Uint8ClampedArray(W * H * 4);
  const put = (x, y, r, g, b) => {
    const p = (y * W + x) * 4;
    data[p] = r; data[p + 1] = g; data[p + 2] = b; data[p + 3] = 255;
  };
  const shades = [];
  for (let i = 0; i < 24; i++) shades.push([40 + i * 8, 200 - i * 6, 60 + ((i * 37) % 120)]);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (x < pad || y < pad || x >= pad + cols * pitch || y >= pad + rows * pitch) { put(x, y, 120, 128, 134); continue; }
      const lx = (x - pad) % pitch;
      const ly = (y - pad) % pitch;
      if (grid && (lx === 0 || ly === 0)) { put(x, y, 20, 20, 20); continue; }
      if (guides && ((x - pad) === Math.floor((cols * pitch) / 2) || (y - pad) === Math.floor((rows * pitch) / 2))) { put(x, y, 250, 250, 250); continue; }
      const c = shades[((Math.floor((x - pad) / pitch) * 5 + Math.floor((y - pad) / pitch) * 3) % shades.length)];
      put(x, y, c[0], c[1], c[2]);
    }
  }
  return { data, width: W, height: H, cols, rows, pitch };
}

test('an expected board snaps a measurement that is a row short', () => {
  // A screenshot cut a few pixels inside the far border measures 29 rows of a
  // 30-row board. Left alone it becomes a board that fits nothing in the game.
  const b = board({ cols: 30, rows: 30, pitch: 16 });
  const cropped = { data: b.data, width: b.width, height: b.height - 6 };
  const loose = detectBoard(cropped);
  assert.ok(loose, 'the crop is still detectable');
  assert.strictEqual(loose.rows, 29, 'measured honestly it is one row short');
  const snapped = detectBoard(cropped, { expectCols: 30, expectRows: 30 });
  assert.ok(snapped, 'with an expectation it is still found');
  assert.strictEqual(snapped.cols, 30);
  assert.strictEqual(snapped.rows, 30, 'and it becomes the board the game can actually use');
});

test('an expectation rejects a board that is not the one expected', () => {
  const b = board({ cols: 30, rows: 30, pitch: 16 });
  assert.strictEqual(detectBoard(b, { expectCols: 16, expectRows: 16 }), null, '30 is not 16');
  assert.strictEqual(detectBoard(b, { expectCols: 64, expectRows: 80 }), null, 'nor a t-shirt front');
  assert.ok(detectBoard(b, { expectCols: 30, expectRows: 30 }), 'and the right one passes');
});

test('snapping keeps the pitch instead of stretching the span', () => {
  // The bug this catches: a rect measured over 29 cells re-labelled as 30 made
  // every cell 3% too small. The colours all came back right, in the wrong
  // places - a lift that looks like success and is useless.
  const b = board({ cols: 30, rows: 30, pitch: 16, grid: true });
  const cropped = { data: b.data, width: b.width, height: b.height - 10 };
  const snapped = liftBoard(cropped, { expectCols: 30, expectRows: 30 });
  assert.ok(snapped);
  const det = snapped.detect;
  assert.ok(Math.abs(det.cell.w - 16) < 0.001, `cell width drifted to ${det.cell.w}`);
  assert.ok(Math.abs(det.cell.h - 16) < 0.001, `cell height drifted to ${det.cell.h}`);

  // The claim that actually matters: a board that is fully in frame lifts back
  // to the picture that was drawn. Cell (x,y) here is a colour that depends on
  // both x and y, so any drift across the grid shows up as a mismatch.
  const plain = board({ cols: 30, rows: 30, pitch: 16, grid: true });
  const back = liftBoard(plain, { expectCols: 30, expectRows: 30 });
  const shades = [];
  for (let i = 0; i < 24; i++) shades.push([40 + i * 8, 200 - i * 6, 60 + ((i * 37) % 120)]);
  let same = 0;
  for (let cy = 0; cy < 30; cy++) {
    for (let cx = 0; cx < 30; cx++) {
      const want = shades[(cx * 5 + cy * 3) % shades.length];
      const p = (cy * back.detect.image.width + cx) * 4;
      const got = [back.detect.image.data[p], back.detect.image.data[p + 1], back.detect.image.data[p + 2]];
      if (got[0] === want[0] && got[1] === want[1] && got[2] === want[2]) same++;
    }
  }
  assert.equal(same, 900, `only ${same} of 900 cells landed where they were drawn`);
});

test('the detector refuses an ImageData rather than reporting no board', () => {
  // "No board found in that screenshot" sent an investigator after the crop,
  // the resize and the pitch, when the pixels were never readable at all.
  const b = board({ cols: 8, rows: 8, pitch: 16 });
  assert.throws(
    () => detectBoard({ data: { width: b.width, height: b.height }, width: b.width, height: b.height }),
    /pixels, not an ImageData/
  );
});

test('the snap keeps the colours that were already right', () => {
  const b = board({ cols: 30, rows: 30, pitch: 16, grid: true, guides: true });
  const lifted = liftBoard(b, { expectCols: 30, expectRows: 30 });
  assert.ok(lifted);
  assert.strictEqual(lifted.cols, 30);
  assert.strictEqual(lifted.rows, 30);
  assert.ok(lifted.colors.size > 8, 'it still saw the many colours on the board');
});
