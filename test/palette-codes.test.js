/*
 * The palette codes are only correct while our 13 groups line up with the
 * game's 13 detail rows, position for position. That is a claim about data from
 * two different sources, so it is checked rather than trusted.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { HEARTOPIA_GROUPS, FLAT_COLORS, COLOR_CODES, GAME_BASE } from '../assets/js/data/heartopia-palette.js';

const game = JSON.parse(readFileSync(new URL('../assets/data/heartopia-game-palette.json', import.meta.url), 'utf8'));

const rgb = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const drift = (a, b) => {
  const x = rgb(a);
  const y = rgb(b);
  return Math.max(Math.abs(x[0] - y[0]), Math.abs(x[1] - y[1]), Math.abs(x[2] - y[2]));
};

test('codes are parallel to the flat palette and index 0 stays empty', () => {
  assert.equal(COLOR_CODES.length, FLAT_COLORS.length);
  assert.equal(COLOR_CODES[0], null);
  assert.equal(FLAT_COLORS[0], null);
});

test('our groups line up with the game detail rows in count and order', () => {
  assert.equal(HEARTOPIA_GROUPS.length, game.detailKeys.length, 'group count');
  HEARTOPIA_GROUPS.forEach((g, gi) => {
    const key = game.detailKeys[gi];
    const row = game.detail[key];
    assert.equal(g.colors.length, row.length, `group ${g.group} vs game row ${key}`);
    assert.equal(row[0].code, `${key}-1`, `row ${key} codes itself`);
  });
});

test('every code is the game row key plus the shade position', () => {
  let i = 1;
  for (let gi = 0; gi < HEARTOPIA_GROUPS.length; gi++) {
    const key = game.detailKeys[gi];
    for (let si = 0; si < HEARTOPIA_GROUPS[gi].colors.length; si++, i++) {
      assert.equal(COLOR_CODES[i], `${key}-${si + 1}`, `flat index ${i}`);
    }
  }
  assert.equal(i - 1, 125, 'all 125 shades got a code');
});

test('each code points at the same colour the game lists at that code', () => {
  const byCode = new Map();
  for (const row of Object.values(game.detail)) for (const c of row) byCode.set(c.code, c.hex);
  const hist = new Map();
  const wide = [];
  for (let i = 1; i < COLOR_CODES.length; i++) {
    const theirs = byCode.get(COLOR_CODES[i]);
    assert.ok(theirs, `game has no colour ${COLOR_CODES[i]}`);
    const d = drift(FLAT_COLORS[i], theirs);
    hist.set(d, (hist.get(d) || 0) + 1);
    if (d > 2) wide.push({ code: COLOR_CODES[i], ours: FLAT_COLORS[i], game: theirs, drift: d });
  }
  assert.equal([...hist.values()].reduce((a, b) => a + b, 0), 125, 'every shade accounted for');
  assert.ok(hist.get(0) >= 60, `only ${hist.get(0)} exact hex matches`);
  assert.ok((hist.get(0) || 0) + (hist.get(1) || 0) + (hist.get(2) || 0) >= 120, 'most shades sit within 2 of the game table');
  // 15-7 is the one shade where the two sources genuinely disagree (delta 7).
  // It is listed rather than hidden, so the disagreement stays visible.
  assert.deepEqual(
    wide.map((w) => w.code),
    ['15-7'],
    `shades more than 2 apart: ${JSON.stringify(wide)}`
  );
});

test('the game base row is shipped for the picker to reference', () => {
  assert.equal(GAME_BASE.length, 16);
  assert.equal(GAME_BASE[0].code, '01');
  assert.equal(GAME_BASE[3].code, '04');
  assert.equal(GAME_BASE[3].hex, '#E5E5E0');
});
