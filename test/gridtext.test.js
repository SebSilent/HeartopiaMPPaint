/**
 * The board as pasteable text.
 *
 * The property that matters most is the last one: the text has to say exactly
 * what the board says. A copied grid that is off by a column, or that drops a
 * row, is worse than no copy at all - it looks authoritative and sends someone
 * an hour of keying-in in the wrong shape.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { Grid } from '../assets/js/game/grid.js';
import { FLAT_COLORS, COLOR_CODES } from '../assets/js/data/heartopia-palette.js';
import { gridText, countPainted, token, EMPTY, FORMATS } from '../assets/js/game/gridtext.js';

/** A board with a known pattern: painted, empty, painted, in each format. */
function sample(w = 4, h = 3) {
  const g = new Grid(w, h);
  g.color[g.idx(0, 0)] = 16;
  g.color[g.idx(2, 0)] = 1;
  g.color[g.idx(3, 1)] = FLAT_COLORS.length - 1;
  g.color[g.idx(1, 2)] = 125;
  return g;
}

test('the text is w tokens by h rows, in every format', () => {
  const g = sample();
  for (const fmt of FORMATS) {
    const rows = gridText(g, fmt).split('\n');
    assert.equal(rows.length, g.h, `${fmt}: one row per cell row`);
    for (const r of rows) assert.equal(r.split('\t').length, g.w, `${fmt}: every row is the same width`);
  }
});

test('no trailing newline, and exactly the separators needed', () => {
  const g = sample(5, 4);
  const t = gridText(g, 'index');
  assert.ok(!t.endsWith('\n'), 'a trailing newline pastes an empty row into a spreadsheet');
  assert.equal((t.match(/\n/g) || []).length, 3, 'h-1 newlines');
  assert.equal((t.match(/\t/g) || []).length, 5 * 4 - 4, 'w-1 tabs on each of h rows');
});

test('an unpainted cell is a dot in all three formats', () => {
  const g = new Grid(2, 2); // all empty
  g.color[0] = 16;
  for (const fmt of FORMATS) {
    const rows = gridText(g, fmt).split('\n');
    assert.deepEqual(rows[0].split('\t')[0], token(16, fmt));
    assert.equal(rows[0].split('\t')[1], EMPTY, `${fmt} marks the gap`);
    assert.equal(rows[1].split('\t')[1], EMPTY);
  }
});

test('code format is the game\'s own group-shade label', () => {
  const g = new Grid(1, 1);
  g.color[0] = 16;
  assert.equal(gridText(g, 'code'), COLOR_CODES[16]);
  assert.match(COLOR_CODES[16], /^\d\d-\d$/, 'and it looks like the thing you type in game');
});

test('hex format is the palette colour, lowercase', () => {
  const g = new Grid(1, 1);
  g.color[0] = 16;
  const t = gridText(g, 'hex');
  assert.equal(t, FLAT_COLORS[16].toLowerCase());
  assert.match(t, /^#[0-9a-f]{6}$/, t);
});

test('index format is the number the app stores', () => {
  const g = new Grid(1, 1);
  g.color[0] = 16;
  assert.equal(gridText(g, 'index'), '16');
});

test('the text round-trips back to the exact board, in every format', () => {
  const g = sample(6, 5);
  const back = (fmt) => {
    const lookup = new Map();
    if (fmt === 'index') for (let i = 1; i < FLAT_COLORS.length; i++) lookup.set(String(i), i);
    else if (fmt === 'hex') for (let i = 1; i < FLAT_COLORS.length; i++) lookup.set(FLAT_COLORS[i].toLowerCase(), i);
    else for (let i = 1; i < FLAT_COLORS.length; i++) lookup.set(COLOR_CODES[i], i);
    return gridText(g, fmt)
      .split('\n')
      .flatMap((row) => row.split('\t').map((c) => (c === EMPTY ? 0 : lookup.get(c))));
  };
  for (const fmt of FORMATS) {
    const got = back(fmt);
    assert.equal(got.length, g.n, `${fmt}: same number of cells`);
    for (let i = 0; i < g.n; i++) {
      assert.notEqual(got[i], undefined, `${fmt}: token ${i} came back unknown`);
      assert.equal(got[i], g.color[i], `${fmt}: cell ${i} round-trips`);
    }
  }
});

test('an unknown format is refused out loud, not pasted as dots', () => {
  // A silent fallback would copy a board that looks blank and read like a bug in
  // the board. Better to throw where a test can catch it.
  assert.throws(() => gridText(new Grid(2, 2), 'rgb'), /unknown format/);
});

test('a board with no cells copies as nothing', () => {
  assert.equal(gridText(new Grid(0, 0), 'index'), '');
  assert.equal(gridText(null, 'index'), '');
  assert.equal(gridText({ w: 3, h: 0, color: [] }, 'code'), '');
});

test('a one-cell board is one token with no separators', () => {
  const g = new Grid(1, 1);
  g.color[0] = 1;
  assert.equal(gridText(g, 'index'), '1');
  assert.equal(gridText(g, 'code'), COLOR_CODES[1]);
});

test('a bad index reads as empty rather than as undefined', () => {
  // Out of range, negative, fractional or the absence of paint: all the same dot.
  assert.equal(token(0, 'index'), EMPTY);
  assert.equal(token(-1, 'index'), EMPTY);
  assert.equal(token(FLAT_COLORS.length, 'index'), EMPTY);
  assert.equal(token(2.5, 'code'), EMPTY);
  assert.equal(token(undefined, 'hex'), EMPTY);
  const g = { w: 2, h: 1, color: [999, 16] };
  assert.equal(gridText(g, 'index'), `${EMPTY}\t16`, 'and it does not shift the columns');
});

test('a plain object works as well as a Grid', () => {
  // The renderer and the tests both hold boards that are not Grid instances.
  const plain = { w: 2, h: 2, color: [16, 0, 0, 1] };
  assert.equal(gridText(plain, 'index').split('\n').length, 2);
  assert.equal(gridText(plain, 'index').split('\n')[1], '.\t1', 'row 2 is empty then index 1');
});

test('countPainted says how much of the copy is real', () => {
  const g = sample(4, 3);
  const painted = [...g.color].filter((c) => c !== 0).length;
  assert.equal(countPainted(gridText(g, 'code'), 'code'), painted);
  assert.equal(countPainted('', 'code'), 0);
  assert.equal(countPainted(`${EMPTY}\t${EMPTY}\n${EMPTY}\t${EMPTY}`, 'code'), 0, 'a blank board is zero');
});

test('a real dress-sized face stays the right shape', () => {
  // 102x154 is the biggest face in the game's catalogue. The point is that the
  // row/col count survives at size, and that the payload is not so large that a
  // clipboard write would be silly - both are asserted, neither is assumed.
  const g = new Grid(102, 154);
  for (let i = 0; i < g.n; i += 3) g.color[i] = 16;
  const t = gridText(g, 'code');
  const rows = t.split('\n');
  assert.equal(rows.length, 154);
  assert.ok(rows.every((r) => r.split('\t').length === 102), 'rectangular at size');
  assert.equal(countPainted(t, 'code'), Math.ceil(g.n / 3));
  assert.ok(t.length < 2_000_000, `payload ${t.length} chars`);
});
