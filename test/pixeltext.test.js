import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FONT,
  GLYPH_H,
  GLYPH_W,
  LEADING,
  TRACKING,
  glyphFor,
  hasGlyph,
  measure,
  prepare,
  textCells,
  textMask,
} from '../assets/js/game/pixeltext.js';

test('every glyph is the full height and fits its own width', () => {
  for (const [ch, g] of Object.entries(FONT)) {
    assert.equal(g.length, GLYPH_H, `${ch} row count`);
    for (const row of g) {
      assert.ok(Number.isInteger(row) && row >= 0, `${ch} row ${row} is not a whole number`);
      assert.ok(row < 1 << GLYPH_W, `${ch} row ${row} overflows ${GLYPH_W} columns`);
    }
  }
});

test('the characters a player can type are all there', () => {
  const want = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 .,!?-:\'"()/*#%&@=<>_♥';
  for (const ch of want) assert.ok(hasGlyph(ch), `no glyph for ${JSON.stringify(ch)}`);
});

test('a glyph is the cells it is drawn from, with the leftmost bit on the left', () => {
  // 'I' is five across, a single column down the middle, five across. If the bit
  // order were reversed this would still be 'I', so 'L' checks it properly.
  assert.deepEqual(
    textCells('I', 1).filter(([x, y]) => y === 1),
    [[2, 1]]
  );
  assert.deepEqual(textCells('L', 1), [
    [0, 0], [0, 1], [0, 2], [0, 3], [0, 4], [0, 5],
    [0, 6], [1, 6], [2, 6], [3, 6], [4, 6],
  ]);
});

test('scaling multiplies every cell into a block, so a big letter stays blocky', () => {
  const one = textCells('S', 1);
  const two = textCells('S', 2);
  assert.equal(two.length, one.length * 4);
  for (const [x, y] of one) {
    for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
      assert.ok(two.some((c) => c[0] === x * 2 + dx && c[1] === y * 2 + dy), `no cell for ${x},${y}`);
    }
  }
  assert.equal(measure('S', 2).w, measure('S', 1).w * 2);
  assert.equal(measure('S', 2).h, measure('S', 1).h * 2);
});

test('a scale below one is one, and nothing to say paints nothing', () => {
  assert.deepEqual(textCells('A', 0), textCells('A', 1));
  assert.deepEqual(textCells('A', -3), textCells('A', 1));
  assert.deepEqual(textCells('', 2), []);
  assert.deepEqual(textCells(null, 1), []);
  assert.deepEqual(textCells('ï', 1), []);
  assert.equal(measure('', 1).w, 0);
  assert.equal(measure('', 1).h, 0);
});

test('letters advance by a glyph and a gap, lines drop by a glyph and a gap', () => {
  assert.equal(measure('A', 1).w, GLYPH_W);
  assert.equal(measure('AB', 1).w, 2 * GLYPH_W + TRACKING);
  assert.equal(measure('AB', 1).h, GLYPH_H);
  assert.equal(measure('A\nB', 1).h, 2 * GLYPH_H + LEADING);
  assert.equal(measure('A\nBB', 1).w, measure('BB', 1).w, 'width is the longest line');
  // The last letter does not pay for the gap after it, so the block is exactly
  // as wide as the ink in it.
  const cells = textCells('AB', 1);
  assert.equal(Math.max(...cells.map(([x]) => x)), measure('AB', 1).w - 1);
  assert.equal(Math.min(...cells.map(([x]) => x)), 0);
});

test('every cell lands inside what measure promises', () => {
  for (const s of ['HELLO WORLD', '2+2=4', 'A\nBC\nDEF', '♥ 1234567890', ' ', 'X']) {
    for (const scale of [1, 2, 3]) {
      const m = measure(s, scale);
      const cells = textCells(s, scale);
      assert.equal(cells.length, new Set(cells.map((c) => c.join(','))).size, 'no cell twice');
      for (const [x, y] of cells) {
        assert.ok(x >= 0 && x < m.w, `${JSON.stringify(s)} x=${x} outside w=${m.w}`);
        assert.ok(y >= 0 && y < m.h, `${JSON.stringify(s)} y=${y} outside h=${m.h}`);
      }
    }
  }
});

test('the mask and the cells are one painting seen two ways', () => {
  for (const s of ['HEART', 'a b', '9\n8', '']) {
    const m = textMask(s, 2);
    const cells = textCells(s, 2);
    let on = 0;
    for (const v of m.g) if (v) on++;
    assert.equal(on, cells.length, `${JSON.stringify(s)} mask agrees with cells`);
    assert.equal(m.g.length, m.w * m.h);
    for (const [x, y] of cells) assert.equal(m.g[y * m.w + x], 1, `${JSON.stringify(s)} cell ${x},${y}`);
  }
});

test('input is folded to what the board can hold, and what was dropped is said', () => {
  assert.deepEqual(prepare('heartopia'), { text: 'HEARTOPIA', skipped: [] });
  assert.deepEqual(prepare('A\nb'), { text: 'A\nB', skipped: [] }, 'a newline is not a dropped glyph');
  assert.deepEqual(prepare('naïve'), { text: 'NAVE', skipped: ['ï'] });
  // The spaces around the arrow are the player's and stay theirs: a dropped
  // character must not quietly close up the gap they typed around it.
  assert.deepEqual(prepare('a → b'), { text: 'A  B', skipped: ['→'] });
  assert.deepEqual(prepare('a→b'), { text: 'AB', skipped: ['→'] });
  assert.deepEqual(prepare(''), { text: '', skipped: [] });
  assert.deepEqual(prepare(null), { text: '', skipped: [] });
  assert.deepEqual(prepare(undefined), { text: '', skipped: [] });
});

test('glyphFor reads the case the player typed and misses quietly', () => {
  assert.deepEqual(glyphFor('a'), FONT.A);
  assert.deepEqual(glyphFor('A'), FONT.A);
  assert.deepEqual(glyphFor('1'), FONT['1']);
  assert.equal(glyphFor('ï'), null);
  assert.equal(glyphFor(''), null);
});

test('the same word is the same cells on every device, which is the whole point', () => {
  // This is why the font is data and not `fillText` thresholded: a board has to
  // be reproducible by hand in the game, so a letter cannot depend on which
  // fonts a phone happens to have installed.
  const lower = JSON.stringify(textCells('made with heartopia 2026', 2));
  const upper = JSON.stringify(textCells('MADE WITH HEARTOPIA 2026', 2));
  assert.equal(lower, upper);
  assert.ok(lower.length > 2000, 'and it is a real amount of text, not a stub');
});
