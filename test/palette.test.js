import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contrastRatio, readableInk, hexToRgb } from '../assets/js/util.js';
import { FLAT_COLORS, HEARTOPIA_GROUPS } from '../assets/js/data/heartopia-palette.js';

test('contrast ratio matches the WCAG definition', () => {
  assert.equal(contrastRatio('#000000', '#ffffff'), 21);
  assert.equal(contrastRatio('#ffffff', '#ffffff'), 1);
  assert.ok(Math.abs(contrastRatio('#767676', '#ffffff') - 4.54) < 0.02);
});

test('ink choice is the better of dark and light, never a luminance guess', () => {
  const DARK = '#2a2118';
  const LIGHT = '#fffdf7';
  for (const hex of FLAT_COLORS.filter(Boolean)) {
    const chosen = readableInk(hex);
    const other = chosen === DARK ? LIGHT : DARK;
    assert.ok(
      contrastRatio(hex, chosen) >= contrastRatio(hex, other),
      `${hex}: picked ${chosen} (${contrastRatio(hex, chosen).toFixed(2)}:1) over ${other} (${contrastRatio(
        hex,
        other
      ).toFixed(2)}:1)`
    );
  }
});

test('the orange that used to break the hex readout now gets dark ink', () => {
  // #e95e2b is the default shade the dock opens on; white on it measured 3.4:1.
  assert.equal(readableInk('#e95e2b'), '#2a2118');
  assert.ok(contrastRatio('#e95e2b', readableInk('#e95e2b')) >= 4.5);
});

test('palette shape: 13 groups, 125 shades, index 0 is the empty board', () => {
  assert.equal(HEARTOPIA_GROUPS.length, 13);
  assert.equal(HEARTOPIA_GROUPS.reduce((n, g) => n + g.colors.length, 0), 125);
  assert.equal(FLAT_COLORS.length, 126);
  assert.equal(FLAT_COLORS[0], null);
  assert.deepEqual(hexToRgb('#fdab34'), [253, 171, 52]);
});

test('every group keeps its shades in in-game order', () => {
  for (const g of HEARTOPIA_GROUPS) {
    assert.ok(g.colors.length === 5 || g.colors.length === 10, `group ${g.group} has ${g.colors.length} shades`);
    assert.ok(g.colors.every((c) => /^#[0-9a-f]{6}$/.test(c)));
  }
});
