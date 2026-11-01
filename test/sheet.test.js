/**
 * The reference sheet's arithmetic.
 *
 * The layout is the part that can be wrong in a way nobody notices until the
 * page is printed: a legend that lists empty as a colour, a board that runs off
 * the canvas, a ruler that labels 154 rows into grey noise. All of that is
 * numbers, so it is tested as numbers. `drawSheet` needs a canvas and is checked
 * in a browser by tools/probe_sheet.mjs.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { usedShades, rulerMarks, sheetLayout, buildSheet, LEGEND_W, PAD, RULER } from '../assets/js/game/sheet.js';
import { FLAT_COLORS, COLOR_CODES } from '../assets/js/data/heartopia-palette.js';

/** A grid stand-in: sheet.js only ever reads w, h, n and color. */
function fake(w, h, paints = []) {
  const color = new Uint8Array(w * h);
  for (const [x, y, c] of paints) color[y * w + x] = c;
  return { w, h, n: w * h, color };
}

test('the legend lists the shades on the board, and how many cells each', () => {
  const g = fake(4, 2, [
    [0, 0, 7],
    [1, 0, 7],
    [2, 0, 7],
    [3, 0, 9],
  ]);
  const s = usedShades(g);
  assert.equal(s.length, 2);
  assert.equal(s[0].idx, 7, 'the bigger job first');
  assert.equal(s[0].count, 3);
  assert.equal(s[1].idx, 9);
  assert.equal(s[1].count, 1);
  assert.equal(s[0].hex, FLAT_COLORS[7], 'the hex is the real palette colour');
  assert.equal(s[0].code, COLOR_CODES[7], 'and the code is the one the game shows');
});

test('empty is not a colour', () => {
  // Index 0 is unpainted. Listing it would tell someone to paint cells the game
  // leaves bare, which is the one mistake a worksheet must not invite.
  const g = fake(3, 3, [
    [0, 0, 12],
    [1, 1, 0],
  ]);
  const s = usedShades(g);
  assert.equal(s.length, 1);
  assert.ok(
    s.every((x) => x.idx !== 0),
    'no zero index in the legend'
  );
});

test('a blank board has no shades, and says so rather than inventing one', () => {
  assert.deepEqual(usedShades(fake(8, 8)), []);
});

test('ties fall back to index, so the same board always prints the same sheet', () => {
  const g = fake(4, 1, [
    [0, 0, 30],
    [1, 0, 11],
    [2, 0, 22],
  ]);
  assert.deepEqual(
    usedShades(g).map((s) => s.idx),
    [11, 22, 30]
  );
});

test('the counts add up to the painted cells', () => {
  const g = fake(5, 5, [
    [0, 0, 3],
    [1, 0, 3],
    [2, 2, 4],
    [3, 3, 5],
    [4, 4, 5],
    [0, 4, 5],
  ]);
  const total = usedShades(g).reduce((n, s) => n + s.count, 0);
  let painted = 0;
  for (let i = 0; i < g.n; i++) if (g.color[i]) painted++;
  assert.equal(total, painted, 'nothing counted twice, nothing missed');
});

test('ruler marks are 1-based and stay inside the axis', () => {
  const r = rulerMarks(10, 12);
  assert.ok(
    r.marks.every((m) => m.cell >= 1 && m.cell <= 10),
    'every label is a real row'
  );
  assert.equal(r.marks[r.marks.length - 1].cell, 10, 'the far edge gets a number');
  assert.deepEqual(
    r.marks.map((m) => m.at),
    r.marks.map((m) => m.cell * 12),
    'and it sits at that cell, not one off'
  );
});

test('the ruler thins out as cells get small, and never below one number', () => {
  assert.equal(rulerMarks(100, 16).step, 5, 'big cells, a number every five');
  assert.equal(rulerMarks(100, 8).step, 10);
  assert.equal(rulerMarks(100, 2).step, 20, 'tiny cells, only every twenty');
  assert.ok(rulerMarks(3, 16).marks.length >= 0, 'an axis shorter than the step is simply unlabelled');
  assert.equal(rulerMarks(3, 16).marks.length, 0, 'and nothing is invented for it');
});

test('the layout never puts a board or the legend off the page', () => {
  const faces = [
    { w: 102, h: 154, label: 'Front' },
    { w: 64, h: 80, label: 'Sleeve' },
  ];
  const L = sheetLayout(faces, 12);
  assert.ok(L.cell >= 2 && L.cell <= 16, `cell ${L.cell} stays printable`);
  for (const b of L.boards) {
    assert.ok(b.x + b.w <= L.width - PAD + 1, `${b.label} fits across`);
    assert.ok(b.y + b.h <= L.height - PAD + 1, `${b.label} fits down`);
    assert.ok(b.x >= PAD + RULER - 1, 'the left ruler has room');
  }
  assert.ok(L.legend.x + L.legend.w <= L.width - PAD + 1, 'the legend fits');
  assert.ok(L.legend.y + L.legend.h <= L.height - PAD + 1, 'and is not cut by the page bottom');
});

test('faces stack downward instead of fighting over one axis', () => {
  const L = sheetLayout(
    [
      { w: 102, h: 154, label: 'Front' },
      { w: 64, h: 80, label: 'Sleeve' },
    ],
    4
  );
  assert.equal(L.boards.length, 2);
  assert.ok(L.boards[1].y > L.boards[0].y + L.boards[0].h, 'the second board starts below the first');
  assert.equal(L.boards[1].x, L.boards[0].x, 'and both share the left edge');
});

test('the legend is wide enough for the codes it prints, whatever the board', () => {
  const L = sheetLayout([{ w: 8, h: 8, label: 'Face' }], 30);
  assert.equal(L.legend.w, LEGEND_W);
  assert.ok(L.legend.h > 30 * 10, '30 rows of shades need real height');
});

test('a shade used on two faces is one legend row with both counts', () => {
  const faces = [
    { w: 3, h: 3, grid: fake(3, 3, [[0, 0, 7]]) },
    { w: 3, h: 3, grid: fake(3, 3, [[1, 1, 7], [2, 2, 7]]) },
  ];
  const sheet = buildSheet(faces, [{ label: 'Front' }, { label: 'Back' }]);
  assert.equal(sheet.shades.length, 1, 'one shade in use');
  assert.equal(sheet.shades[0].count, 3, 'three cells across the design');
});

test('an empty design still lays out, and reports no shades', () => {
  const sheet = buildSheet([{ w: 10, h: 10, grid: fake(10, 10) }], [{ label: 'Only' }]);
  assert.deepEqual(sheet.shades, []);
  assert.ok(sheet.layout.width > 0 && sheet.layout.height > 0, 'the page still exists');
  assert.equal(sheet.layout.boards.length, 1);
});

test('the grid flag follows the caller, so the sheet honours the export toggle', () => {
  const faces = [{ w: 4, h: 4, grid: fake(4, 4, [[0, 0, 5]]) }];
  assert.equal(buildSheet(faces, [{ label: 'A' }]).grid, false, 'off unless asked');
  assert.equal(buildSheet(faces, [{ label: 'A' }], { grid: true }).grid, true);
});

test('a face with no label in meta still gets named', () => {
  const sheet = buildSheet([{ w: 4, h: 4, grid: fake(4, 4) }], [{}]);
  assert.ok(sheet.layout.boards[0].label, 'something is printed');
  assert.notEqual(sheet.layout.boards[0].label, 'undefined');
});
