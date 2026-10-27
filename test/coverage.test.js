/**
 * The hole rule, on synthetic masks.
 *
 * These are the cases the real garments produce, drawn as arrays so the
 * distinction between "air you should see through" and "hole that is a defect"
 * can be pinned rather than eyeballed in a preview.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { enclosedHoles, cavityShade } from '../assets/js/game/coverage.js';

/** Build a coverage array from ASCII: '#' covered, '.' uncovered. */
function fromRows(rows) {
  const h = rows.length;
  const w = rows[0].length;
  const cov = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    assert.equal(rows[y].length, w, `row ${y} is a different width`);
    for (let x = 0; x < w; x++) cov[y * w + x] = rows[y][x] === '#' ? 1 : 0;
  }
  return { cov, w, h };
}

test('nothing covered is all air', () => {
  const { cov, w, h } = fromRows(['.....', '.....', '.....']);
  const r = enclosedHoles(cov, w, h);
  assert.equal(r.holes, 0);
  assert.equal(r.px, 0, 'and nothing to fill');
});

test('a solid shape with no gap has nothing enclosed', () => {
  const { cov, w, h } = fromRows(['#####', '#####', '#####']);
  const r = enclosedHoles(cov, w, h);
  assert.equal(r.holes, 0);
  assert.equal(r.px, 0);
});

test('a ring traps the pixel in its middle', () => {
  const { cov, w, h } = fromRows(['.###.', '#...#', '#...#', '#...#', '.###.']);
  const r = enclosedHoles(cov, w, h, 48);
  assert.equal(r.holes, 1, 'one enclosed region');
  assert.equal(r.kept, 1);
  assert.equal(r.px, 9, 'the whole 3x3 inside it');
  assert.equal(r.fill[1 * w + 2], 1, 'the middle is marked');
  assert.equal(r.fill[0], 0, 'the outside is not');
});

test('a shape open to the border is air, not a hole', () => {
  // The C is the neck opening: you can walk from it to the edge of the frame.
  const { cov, w, h } = fromRows(['#####', '#....', '#####']);
  const r = enclosedHoles(cov, w, h, 48);
  assert.equal(r.holes, 0, 'nothing is enclosed');
  assert.equal(r.px, 0);
});

test('a big enclosed region is left alone', () => {
  // Under an arm, or inside a hood. Painting it would be worse than the gap.
  const { cov, w, h } = fromRows([
    '#######',
    '#.....#',
    '#.....#',
    '#.....#',
    '#######',
  ]);
  const r = enclosedHoles(cov, w, h, 4);
  assert.equal(r.holes, 1, 'found it');
  assert.equal(r.kept, 0, 'and refused to fill it: 15 px is a gap, not a pinhole');
  assert.equal(r.px, 0);
});

test('two islands, one a crack and one a cavity, are judged separately', () => {
  const { cov, w, h } = fromRows([
    '##########',
    '#..####..#',
    '#..####..#',
    '#..####..#',
    '##########',
  ]);
  const r = enclosedHoles(cov, w, h, 8);
  assert.equal(r.holes, 2);
  assert.equal(r.kept, 2, 'both are 6 px');
  assert.equal(r.px, 12);
});

test('depth is measured from the cloth, so the fill can shade like a cavity', () => {
  const { cov, w, h } = fromRows([
    '#########',
    '#.......#',
    '#.......#',
    '#.......#',
    '#########',
  ]);
  const r = enclosedHoles(cov, w, h, 48);
  assert.equal(r.dist[1 * w + 1], 1, 'the rim pixel of the hole');
  assert.equal(r.dist[2 * w + 4], 2, 'two in');
  assert.ok(r.dist[1 * w + 4] >= 1, 'the middle is at least as deep as the rim');
  assert.ok(r.dist[2 * w + 4] > r.dist[1 * w + 1], 'and deeper than it');
});

test('every filled pixel knows a covered pixel to borrow colour from', () => {
  const { cov, w, h } = fromRows(['.###.', '#.#.#', '#.###', '.###.']);
  const r = enclosedHoles(cov, w, h, 48);
  assert.ok(r.px > 0, 'there is something to test');
  for (let p = 0; p < cov.length; p++) {
    if (!r.fill[p]) continue;
    assert.ok(r.dist[p] > 0, `pixel ${p} has a depth`);
    assert.ok(r.src[p] >= 0 && r.src[p] < cov.length, `pixel ${p} has a source`);
    assert.equal(cov[r.src[p]], 1, `and its source ${r.src[p]} is cloth, not more hole`);
  }
});

test('a diagonal crack counts as backdrop to fill, not as two air gaps', () => {
  // 4-connected labelling means a thread of backdrop that only touches itself
  // diagonally is still enclosed, which is the hairline the defect shows as.
  const { cov, w, h } = fromRows([
    '#####',
    '#.#.#',
    '##.##',
    '#.#.#',
    '#####',
  ]);
  const r = enclosedHoles(cov, w, h, 48);
  // Five pixels, each walled in on all four sides, none of them reachable.
  assert.equal(r.holes, 5, 'every one of them is enclosed');
  assert.equal(r.kept, 5);
  assert.equal(r.fill[1 * w + 1], 1, 'the one at row 1 col 1');
  assert.equal(r.fill[2 * w + 2], 1, 'and the one dead centre');
  assert.equal(r.fill[0], 0, 'the border is cloth, not a hole');
});

test('a hole with an island in it is still a hole', () => {
  const { cov, w, h } = fromRows([
    '#######',
    '#.....#',
    '#..#..#',
    '#.....#',
    '#######',
  ]);
  const r = enclosedHoles(cov, w, h, 48);
  assert.equal(r.holes, 1, 'one region, with a covered pixel inside it');
  assert.equal(r.fill[1 * w + 1], 1);
  assert.equal(r.fill[2 * w + 3], 0, 'the island itself is cloth and is not filled');
});

test('degenerate masks answer nothing rather than throwing', () => {
  assert.equal(enclosedHoles(new Uint8Array(0), 0, 0).px, 0);
  assert.equal(enclosedHoles(new Uint8Array(4), 2, 2).px, 0, 'below the minimum size');
  const { cov, w, h } = fromRows(['##', '##']);
  assert.equal(enclosedHoles(cov, w, h).holes, 0);
  const short = enclosedHoles(new Uint8Array(3), 4, 4);
  assert.equal(short.px, 0, 'a coverage array shorter than the frame is ignored');
});

test('the cavity shade gets darker going in, and stops somewhere sane', () => {
  assert.equal(cavityShade(0), 1, 'depth 0 is the cloth itself, unshaded');
  const a = cavityShade(1);
  const b = cavityShade(4);
  const c = cavityShade(40);
  assert.ok(a > b && b > c, 'monotonically darker with depth');
  assert.ok(c > 0.4, 'and it flattens instead of going black');
  assert.ok(c < 0.55, 'deep enough to read as a shadowed inside');
  // Deceleration has to be compared per unit of depth, or a wide interval looks
  // steeper than a narrow one and the test measures the interval, not the curve.
  const step = (d) => cavityShade(d) - cavityShade(d + 1);
  assert.ok(step(1) > step(5), 'each extra pixel in darkens less than the last');
  assert.ok(step(5) > step(20), 'and less still the deeper it goes');
  assert.ok(step(1) > 0, 'always darker going in');
  assert.ok(cavityShade(-5) > 0.9, 'a nonsense depth does not become a nonsense shade');
});
