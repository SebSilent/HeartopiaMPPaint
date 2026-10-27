/**
 * The board as text, for pasting somewhere else.
 *
 * The point of this app is to finish up in Heartopia, and the last step is
 * always the same: key the board into the game by hand, cell by cell. A PNG is
 * no help there - you cannot read a colour off a screenshot and name it. What
 * works is a grid of the game's own colour codes, one token per cell, that you
 * can put next to the game and tick off.
 *
 * Three formats, because they serve three jobs:
 *   code   the game's own `06-1` group-shade labels. What you type in Heartopia.
 *   index  the palette index this app stores. What you feed another tool.
 *   hex    `#ee6f72`. What you paste into a colour picker.
 *
 * Tab-separated rows, newline-terminated columns: a spreadsheet paste lands one
 * cell per column, which is the only format worth having. A cell nobody painted
 * is a dot in all three - the absence of paint is not a colour, and `0` in an
 * index column reads like a colour that does not exist.
 */

import { FLAT_COLORS, COLOR_CODES } from '../data/heartopia-palette.js';

/** What an unpainted cell looks like, in every format. */
export const EMPTY = '.';

/** The formats the dock offers, in the order it offers them. */
export const FORMATS = ['code', 'index', 'hex'];

/**
 * One face of one board, as pasteable text.
 *
 * @param {{w:number,h:number,color:ArrayLike<number>}} grid
 * @param {'code'|'index'|'hex'} fmt
 * @returns {string} `w` tokens per row, `h` rows, tabs between cells, \n between rows,
 *   no trailing newline (a trailing one pastes an empty row into a spreadsheet).
 */
export function gridText(grid, fmt = 'code') {
  if (!FORMATS.includes(fmt)) throw new Error(`gridText: unknown format "${fmt}"`);
  const w = grid ? grid.w | 0 : 0;
  const h = grid ? grid.h | 0 : 0;
  if (w < 1 || h < 1) return '';
  const at = typeof grid.colorAt === 'function' ? (x, y) => grid.colorAt(x, y) : (x, y) => grid.color[y * w + x];
  const rows = new Array(h);
  for (let y = 0; y < h; y++) {
    const cells = new Array(w);
    for (let x = 0; x < w; x++) cells[x] = token(at(x, y), fmt);
    rows[y] = cells.join('\t');
  }
  return rows.join('\n');
}

/**
 * One cell's token.
 *
 * Anything out of range - empty, negative, past the end of the palette - is the
 * empty token. A board that somehow holds a bad index should paste as a gap, not
 * as `undefined` sitting in the middle of a column you are trying to read.
 */
export function token(idx, fmt = 'code') {
  if (typeof idx !== 'number' || !Number.isInteger(idx) || idx <= 0 || idx >= FLAT_COLORS.length) return EMPTY;
  if (fmt === 'index') return String(idx);
  if (fmt === 'hex') return (FLAT_COLORS[idx] || EMPTY).toLowerCase();
  return COLOR_CODES[idx] || EMPTY;
}

/**
 * How many cells this text says are painted, in `fmt`. Used by the dock to say
 * "copied 34 of 102x154 cells" instead of a bare "copied", and by the tests to
 * check a round trip without re-parsing the grid.
 */
export function countPainted(text, fmt = 'code') {
  if (!text) return 0;
  let n = 0;
  for (const row of String(text).split('\n')) {
    for (const cell of row.split('\t')) if (cell !== EMPTY && cell !== '') n++;
  }
  return n;
}
