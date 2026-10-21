import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Grid, strokeCells, brushOffsets } from '../assets/js/game/grid.js';
import { FLAT_COLORS } from '../assets/js/data/heartopia-palette.js';

test('palette is the 13-group / 125-shade Heartopia set', () => {
  // index 0 is the empty board, so the flat list is shades + 1
  assert.equal(FLAT_COLORS.length, 126);
  assert.equal(FLAT_COLORS[0], null);
  assert.ok(FLAT_COLORS.every((c) => c === null || /^#[0-9a-f]{6}$/.test(c)));
});

test('paint stamps a cell and refuses older writes', () => {
  const g = new Grid(10, 10);
  g.paint([5], 3, 10, 1);
  assert.equal(g.color[5], 3);
  g.paint([5], 7, 9, 1); // older lamport -> ignored
  assert.equal(g.color[5], 3);
  g.paint([5], 7, 10, 2); // same lamport, higher slot -> wins
  assert.equal(g.color[5], 7);
  g.paint([5], 9, 10, 1); // same lamport, lower slot -> ignored
  assert.equal(g.color[5], 7);
});

test('two peers converge regardless of arrival order', () => {
  const a = new Grid(8, 8);
  const b = new Grid(8, 8);
  const ops = [
    { cells: [1, 2], c: 4, seq: 5, slot: 1 },
    { cells: [2, 3], c: 9, seq: 5, slot: 2 },
    { cells: [2], c: 11, seq: 4, slot: 3 },
  ];
  for (const o of ops) a.paint(o.cells, o.c, o.seq, o.slot);
  for (const o of [...ops].reverse()) b.paint(o.cells, o.c, o.seq, o.slot);
  assert.equal(a.checksum(), b.checksum());
  assert.equal(a.color[2], 9);
});

test('snapshot round-trips pixels and checksum', () => {
  const g = new Grid(16, 9);
  g.paint([0, 100, 143], 42, 1, 3);
  const snap = g.toSnapshot();
  const h = new Grid(16, 9);
  h.applySnapshot(snap);
  assert.equal(h.color[100], 42);
  assert.equal(h.checksum(), g.checksum());
});

test('applySnapshot resizes when the room uses a different board', () => {
  const g = new Grid(30, 30);
  g.paint([899], 7, 2, 1);
  const h = new Grid(50, 50);
  h.applySnapshot(g.toSnapshot());
  assert.equal(h.w, 30);
  assert.equal(h.h, 30);
  assert.equal(h.color[899], 7);
});

test('snapshot after a repair is never overwritten by older local writes', () => {
  const g = new Grid(10, 10);
  g.paint([1], 5, 3, 1);
  const repaired = new Grid(10, 10);
  repaired.paint([1], 8, 9, 2);
  g.applySnapshot(repaired.toSnapshot());
  assert.equal(g.color[1], 8);
  g.paint([1], 5, 4, 1); // stale in-flight op must not clobber it
  assert.equal(g.color[1], 8);
});

test('clearAll empties the board and raises the floor', () => {
  const g = new Grid(6, 6);
  g.paint([1, 2, 3], 5, 7, 1);
  assert.equal(g.isEmpty(), false);
  g.clearAll(8, 1);
  assert.equal(g.isEmpty(), true);
  g.paint([1], 5, 7, 2); // older than the clear -> dropped
  assert.equal(g.color[1], 0);
});

test('brush offsets are centred for odd sizes', () => {
  assert.deepEqual(brushOffsets(1), [0]);
  assert.deepEqual(brushOffsets(2), [0, 1]);
  assert.deepEqual(brushOffsets(3), [-1, 0, 1]);
  assert.deepEqual(brushOffsets(5), [-2, -1, 0, 1, 2]);
});

test('strokeCells leaves no gaps on a fast diagonal drag', () => {
  const g = new Grid(20, 20);
  const cells = strokeCells(g, 0, 0, 19, 19, 1);
  const set = new Set(cells);
  for (let d = 0; d < 20; d++) assert.ok(set.has(d * 20 + d), `diagonal cell ${d} missing`);
  // deduplicated
  assert.equal(cells.length, set.size);
});

test('strokeCells clips off-board cells instead of wrapping into other rows', () => {
  const g = new Grid(10, 10);
  // horizontal drag that starts and ends outside the board, brush 3 => rows 4..6
  const cells = strokeCells(g, -5, 5, 15, 5, 3);
  assert.ok(cells.length > 0);
  for (const i of cells) {
    assert.ok(i >= 0 && i < 100, `index ${i} out of range`);
    const y = Math.floor(i / 10);
    const x = i % 10;
    assert.ok(y >= 4 && y <= 6, `row ${y} should have been clipped`);
    assert.ok(x >= 0 && x <= 9);
  }
  // a corner stroke must not teleport to the next row
  const corner = strokeCells(g, -2, 0, -2, 9, 3);
  for (const i of corner) assert.equal(i % 10 <= 1, true, `col leaked: ${i % 10}`);
});

test('fillRGBA writes little-endian RGBA for a palette colour', () => {
  const g = new Grid(2, 1);
  const idx = FLAT_COLORS.findIndex((c) => c === '#051616');
  g.paint([0], idx, 1, 1);
  const buf = new ArrayBuffer(8);
  const u32 = new Uint32Array(buf);
  const u8 = new Uint8Array(buf);
  g.fillRGBA(u32);
  const [r, gg, b] = [0x05, 0x16, 0x16];
  assert.deepEqual([u8[0], u8[1], u8[2], u8[3]], [r, gg, b, 255]);
  assert.deepEqual([u8[4], u8[5], u8[6], u8[7]], [0, 0, 0, 0]); // empty cell
});
