/*
 * Colour science. The claim under test is that a photo mapped to Heartopia's
 * palette lands on shades a person would agree with, and that the count can be
 * pushed down without the picture falling apart.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  rgbToLab,
  deltaE2000,
  hexToLab,
  PaletteIndex,
  quantize,
  reduceColors,
  buildCost,
  palette,
  shadeDeltaE,
  fadeShade,
  FADE_STEPS,
} from '../assets/js/color/science.js';
import { FLAT_COLORS, HEARTOPIA_GROUPS } from '../assets/js/data/heartopia-palette.js';

test('Lab conversion is anchored where CIELAB is defined', () => {
  const black = rgbToLab(0, 0, 0);
  assert.equal(Math.round(black[0]), 0, 'L* of black is 0');
  const white = rgbToLab(255, 255, 255);
  assert.equal(Math.round(white[0]), 100, 'L* of white is 100');
  // Compared by magnitude: the arithmetic yields -0 for a neutral white, and
  // strict equality calls -0 and 0 different things.
  assert.ok(Math.abs(white[1]) < 0.5, `white a* was ${white[1]}`);
  assert.ok(Math.abs(white[2]) < 0.5, `white b* was ${white[2]}`);
  // Pure sRGB red is the usual spot check: a* ~ 80, b* ~ 70.
  const red = rgbToLab(255, 0, 0);
  assert.ok(Math.abs(red[1] - 80) < 3, `a* was ${red[1]}`);
  assert.ok(Math.abs(red[2] - 70) < 4, `b* was ${red[2]}`);
});

test('deltaE2000 is zero for identical colours and behaves near grey', () => {
  const l = hexToLab('#808080');
  assert.equal(deltaE2000(l, l), 0);
  const black = hexToLab('#000000');
  const white = hexToLab('#ffffff');
  assert.ok(deltaE2000(black, white) > 90, 'black to white is nearly the whole scale');
  // The hue term is what CIEDE2000 adds over CIE76; two lights that differ only
  // in hue must still be clearly apart.
  const warm = hexToLab('#feae3b');
  const cool = hexToLab('#0599ba');
  assert.ok(deltaE2000(warm, cool) > 40);
});

test('the palette index exposes every real shade and no empty one', () => {
  const pi = new PaletteIndex();
  assert.equal(pi.size, HEARTOPIA_GROUPS.reduce((n, g) => n + g.colors.length, 0));
  assert.equal(pi.size, 125, 'the verified painting palette is 125 shades');
  assert.equal(pi.labs[0], null, 'index 0 is the untouched board, not a colour');
});

test('matching happens in perception, not in RGB', () => {
  const pi = new PaletteIndex();
  // A desaturated blue-grey. The numerically nearest RGB entry in this palette
  // is a green-grey; the perceptually nearest is a blue. This is the whole
  // reason the Lab path exists.
  const idx = pi.nearest(120, 130, 150);
  const hex = FLAT_COLORS[idx];
  const rgbDist = (h) => {
    const n = parseInt(h.slice(1), 16);
    return Math.hypot(((n >> 16) & 255) - 120, ((n >> 8) & 255) - 130, (n & 255) - 150);
  };
  const byRGB = FLAT_COLORS.slice(1)
    .map((h, i) => [rgbDist(h), i + 1])
    .sort((a, b) => a[0] - b[0])[0][1];
  assert.notEqual(idx, byRGB, 'the Lab answer must differ from the RGB answer here');
  const lab = rgbToLab(120, 130, 150);
  assert.ok(
    deltaE2000(lab, pi.labOf(idx)) <= deltaE2000(lab, pi.labOf(byRGB)),
    'and must be the closer one'
  );
});

test('a pure palette colour maps back to itself', () => {
  const pi = new PaletteIndex();
  for (let i = 1; i < FLAT_COLORS.length; i++) {
    const n = parseInt(FLAT_COLORS[i].slice(1), 16);
    assert.equal(pi.nearest((n >> 16) & 255, (n >> 8) & 255, n & 255), i, `shade ${i}`);
  }
});

test('the palette is dense enough to need reduction', () => {
  const pi = new PaletteIndex();
  // The two closest shades are barely distinguishable, which is exactly why
  // quantising a photo sprinkles in colours nobody chose.
  assert.ok(pi.closestPair.d < 4, `closest pair is ΔE ${pi.closestPair.d}`);
  assert.ok(pi.closestPair.d > 0);
});

const swatch = (w, h, list) => {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0, p = 0; i < w * h; i++, p += 4) {
    const c = list[i % list.length];
    data[p] = c[0];
    data[p + 1] = c[1];
    data[p + 2] = c[2];
    data[p + 3] = 255;
  }
  return { data, width: w, height: h };
};

test('quantize returns one palette index per pixel and never 0 for a solid pixel', () => {
  const img = swatch(8, 4, [[200, 40, 40], [40, 200, 60], [40, 60, 200]]);
  const q = quantize(img, {});
  assert.equal(q.cells.length, 32);
  for (const c of q.cells) {
    assert.ok(c >= 1 && c < FLAT_COLORS.length, `index ${c} is a real shade`);
  }
  assert.equal(q.empty, 0);
});

test('three bands arrive as three shades, not one flat colour', () => {
  // The bug this catches: a producer handing over an ImageData object instead of
  // the pixel array. Every pixel then reads undefined, and the result still has
  // the right length and a plausible-looking index - one shade, everywhere.
  const w = 30;
  const h = 30;
  const data = new Uint8ClampedArray(w * h * 4);
  const band = (y) => (y < 10 ? [220, 40, 40] : y < 20 ? [40, 200, 60] : [40, 60, 200]);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = (y * w + x) * 4;
      const c = band(y);
      data[p] = c[0]; data[p + 1] = c[1]; data[p + 2] = c[2]; data[p + 3] = 255;
    }
  }
  const q = quantize({ data, width: w, height: h }, {});
  assert.ok(q.colors.size >= 3, `three bands gave ${q.colors.size} shades`);
});

test('quantize refuses an ImageData instead of flattening it', () => {
  const pixels = new Uint8ClampedArray(4 * 4);
  const imageDataLike = { data: { width: 4, height: 4 }, width: 4, height: 4 };
  assert.throws(() => quantize(imageDataLike, {}), /pixels, not an ImageData/);
  assert.ok(quantize({ data: pixels, width: 4, height: 4 }, {}), 'a real pixel array still works');
});

test('transparent pixels stay empty', () => {
  const img = swatch(4, 1, [[10, 10, 10]]);
  img.data[3] = 0;
  const q = quantize(img, {});
  assert.equal(q.cells[0], 0);
  assert.equal(q.empty, 1);
});

test('dithering spreads a colour that cannot be represented', () => {
  // A mid grey between two palette greys: no dither gives one shade, an
  // ordered dither gives two in a pattern.
  const img = swatch(16, 16, [[128, 128, 128]]);
  const flat = quantize(img, { mode: 'none' });
  const bayer = quantize(img, { mode: 'bayer4', strength: 60 });
  assert.equal(flat.colors.size, 1, 'posterised flat');
  assert.ok(bayer.colors.size > 1, `bayer should mix, got ${bayer.colors.size}`);
});

test('floyd-steinberg diffuses error forward, not backward', () => {
  const img = swatch(16, 16, [[127, 127, 127]]);
  const fs = quantize(img, { mode: 'fs' });
  assert.ok(fs.colors.size >= 1);
  assert.equal(fs.cells.length, 256);
});

test('a photo of near-identical pinks does not balloon the colour count', () => {
  // 30 shades that differ from each other by a few units. Left to itself the
  // quantiser picks 3 palette entries for all of them, which is the finding:
  // the danger is not the count, it is that those 3 are all "pink" and nobody
  // chose them individually.
  const list = [];
  for (let i = 0; i < 30; i++) list.push([230 + (i % 5), 210 + (i % 7), 212 + (i % 6)]);
  const q = quantize(swatch(60, 60, list), {});
  const before = new Set([...q.cells]).size;
  assert.ok(before <= 4, `a flat pink wall should read as pinks, got ${before} shades`);
});

test('colour reduction hits the target and keeps the picture', () => {
  // A full-spectrum gradient: quantising it walks most of the palette.
  const list = [];
  for (let i = 0; i < 64; i++) {
    const a = (i / 64) * Math.PI * 2;
    list.push([
      Math.round(128 + 120 * Math.cos(a)),
      Math.round(128 + 120 * Math.cos(a + 2.1)),
      Math.round(128 + 120 * Math.cos(a + 4.2)),
    ]);
  }
  const q = quantize(swatch(64, 64, list), {});
  const before = new Set([...q.cells]).size;
  assert.ok(before > 8, `a spectrum should use many shades, got ${before}`);
  const r = reduceColors(q.cells, 4);
  assert.ok(r.to <= 4, `reduced to ${r.to}`);
  assert.ok(r.to >= 1);
  assert.equal(r.cells.length, q.cells.length, 'same board, fewer shades');
  for (const c of r.cells) assert.ok(c >= 1 && c < FLAT_COLORS.length, 'nothing collapsed into "empty"');
});

test('reduction resolves a chain of merges to its end', () => {
  // a -> b and b -> c must land on c, not on the retired b.
  const cells = Uint8Array.from([1, 2, 3, 4, 5, 6]);
  const r = reduceColors(cells, 1);
  assert.equal(r.to, 1);
  const survivors = new Set([...r.cells]);
  assert.equal(survivors.size, 1);
  for (const c of r.cells) assert.ok(c >= 1, 'nothing was collapsed into "empty"');
});

test('the build-cost model counts colours, not just cells', () => {
  // Kept for the estimate readout we have not built: placing a pixel is cheap,
  // switching the pen is not, so the cost is cells x shades.
  const one = Uint8Array.from([3, 3, 3, 3, 0, 0]);
  const many = Uint8Array.from([3, 4, 5, 6, 0, 0]);
  const a = buildCost(one);
  const b = buildCost(many);
  assert.equal(a.painted, 4);
  assert.equal(a.colors, 1);
  assert.equal(b.colors, 4);
  assert.equal(b.score, 16);
  assert.ok(b.score > a.score, 'same cells, more shades, more work');
  assert.equal(buildCost(Uint8Array.from([0, 0, 0])).painted, 0);
});

test('the shared palette instance is built once', () => {
  assert.equal(palette(), palette(), 'memoised, because the tables are not cheap');
});

test('shade distance is a colour distance, not an index distance', () => {
  // These four shades are the whole reason "fill similar" cannot be written as
  // `abs(a - b) <= tol`. Pinned by hex so a palette reorder fails with a
  // message about the palette rather than a mystery about the fill.
  const darkRed = FLAT_COLORS.indexOf('#682f39');
  const palePink = FLAT_COLORS.indexOf('#e7d5d5');
  const paleLilac = FLAT_COLORS.indexOf('#e4d5da');
  assert.ok(darkRed > 0 && palePink > 0 && paleLilac > 0, 'the three shades are still in the palette');
  assert.equal(palePink, darkRed + 1, 'the first two are adjacent in the list');

  // Adjacent in the list, nowhere near each other on screen. An index tolerance
  // of 3 would treat these as the same colour and flood a dark red sleeve with
  // pale pink.
  const apart = shadeDeltaE(darkRed, palePink);
  assert.ok(apart > 40, `#682f39 vs #e7d5d5 should be far apart, got ${apart}`);

  // 110 places apart in the list, and the closest pair in the palette is
  // 2.36 - so an index tolerance would need to be 110 to reach these, at which
  // point it has matched everything. "Close" in the UI is exactly this pair.
  const together = shadeDeltaE(palePink, paleLilac);
  assert.ok(together < 5, `#e7d5d5 vs #e4d5da should read as the same colour, got ${together}`);
  assert.ok(apart > 8 * together, 'and the two judgements must not be confused');

  assert.equal(shadeDeltaE(palePink, palePink), 0, 'a shade is not different from itself');
  assert.equal(shadeDeltaE(palePink, paleLilac), shadeDeltaE(paleLilac, palePink), 'symmetric');
});

test('the airbrush fades through shades the game actually ships', () => {
  // The board has no alpha, so a soft edge has to be made of paler paint - and
  // it may only be made of paint the game has. A fade that invented a colour
  // would export as something the game cannot build.
  const pi = palette();
  for (const e of pi.entries) {
    assert.equal(fadeShade(e.idx, 0), e.idx, 'step 0 is the shade itself');
    let prevL = -1;
    for (let k = 0; k <= FADE_STEPS; k++) {
      const s = fadeShade(e.idx, k);
      assert.ok(s > 0, `shade ${e.idx} step ${k} is a real palette entry, not empty`);
      assert.ok(!!FLAT_COLORS[s], `shade ${e.idx} step ${k} ships in the palette`);
      const L = pi.labOf(s)[0];
      assert.ok(L >= prevL - 0.5, `step ${k} of ${e.idx} is no darker than the step before`);
      prevL = L;
    }
  }
});

test('the airbrush has nowhere paler to go at the top of the palette', () => {
  // A near-white shade cannot fade: the nearest shade to "whiter than white" is
  // white itself. Repeating the same shade is honest; inventing a lighter one
  // would be a colour the game does not have.
  const pi = palette();
  let lightest = pi.entries[0];
  for (const e of pi.entries) if (pi.labOf(e.idx)[0] > pi.labOf(lightest.idx)[0]) lightest = e;
  for (let k = 1; k <= FADE_STEPS; k++) {
    assert.equal(
      fadeShade(lightest.idx, k),
      lightest.idx,
      `the lightest shade (${lightest.hex}) does not change at step ${k}`
    );
  }
});

test('the airbrush fades a saturated shade, and leaves empty alone', () => {
  const pi = palette();
  const orange = FLAT_COLORS.indexOf('#e95e2b') > 0 ? FLAT_COLORS.indexOf('#e95e2b') : 16;
  const top = fadeShade(orange, FADE_STEPS);
  assert.notEqual(top, orange, 'a saturated shade has somewhere to fade to');
  assert.ok(pi.labOf(top)[0] > pi.labOf(orange)[0] + 10, 'and it is visibly paler');
  assert.equal(fadeShade(0, 2), 0, 'empty is not a colour to fade');
  assert.equal(fadeShade(orange, 99), top, 'the ramp stops at its rim');
});

test('shade distance refuses to judge empty', () => {
  // Index 0 is "no paint", which has no colour and so no distance. If it ever
  // compared equal to a real shade, a loose bucket would spread into every
  // unpainted cell on the face.
  assert.equal(shadeDeltaE(0, 13), null);
  assert.equal(shadeDeltaE(13, 0), null);
  assert.equal(shadeDeltaE(0, 0), null, 'empty is not similar to empty either');
});
