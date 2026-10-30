/*
 * Builds assets/img/social-card.png - the 1200x630 image every og:image and
 * twitter:image points at.
 *
 *   node tools/build_social_card.mjs
 *
 * Why a generator and not a committed binary from an image editor: the card is
 * made of the two things this repo already treats as data - the 5x7 bitmap font
 * in `game/pixeltext.js` and the 125 shades in `assets/data/heartopia-palette.json`.
 * Drawing it from those means the card cannot drift from the product (a shade
 * that ships in the game, a letter a player can actually paint), and it can be
 * re-run in CI or after a palette fix with no design tool installed.
 *
 * There is no canvas here and no dependency: PNG is a zlib stream of scanlines
 * with a CRC per chunk, and Node ships zlib. The whole encoder is ~40 lines.
 *
 * Every string is measured before it is drawn and the build FAILS if it does not
 * fit its column, because a clipped word on a share card is invisible to the
 * person who committed it and seen by everyone else.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { textCells, measure } from '../assets/js/game/pixeltext.js';
import { Surface } from './png.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'assets', 'img', 'social-card.png');

const W = 1200;
const H = 630;

/* ---------------------------------------------------------------- palette */

const palette = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'assets/data/heartopia-palette.json'), 'utf8')
);
const GROUP_MAINS = palette.groups.map((g) => g.mainColor);

function rgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 255];
}

const INK = {
  bg: rgb('#221b17'),
  bgAlt: rgb('#271f1a'),
  band: rgb('#191411'),
  paper: rgb('#f2e8dc'),
  grid: rgb('#ddcec0'),
  frame: rgb('#3a2f28'),
  title: rgb('#f7f2ea'),
  accent: rgb('#fdab34'),
  sub: rgb('#b9a99a'),
  chipBg: rgb('#332922'),
  chipLine: rgb('#4a3c32'),
  heart: rgb('#ea696d'),
  heartDark: rgb('#cf354d'),
  heartPale: rgb('#f5aca6'),
  cursorA: rgb('#40b678'),
  cursorB: rgb('#2981c0'),
};

/* --------------------------------------------------------------- surface */

// The encoder and the drawing primitives live in tools/png.mjs, shared with the
// icon generator. Aliased rather than called as methods so the layout code below
// reads as drawing, not as object plumbing.
const surface = new Surface(W, H, INK.bg);
const px = (x, y, c) => surface.px(x, y, c);
const rect = (x, y, w, h, c) => surface.rect(x, y, w, h, c);
const outlineRect = (x, y, w, h, t, c) => surface.outlineRect(x, y, w, h, t, c);

/**
 * The repo's own bitmap font, so every letter on the card is a letter a player
 * can paint on a board. Returns the width it occupied, for laying out beside.
 */
function text(str, x, y, scale, c) {
  const m = measure(str, scale);
  for (const [dx, dy] of textCells(str, scale)) px(x + dx, y + dy, c);
  return m.w;
}

/** Draw it, but refuse to ship it if it does not fit the space it was given. */
function textFit(str, x, y, scale, c, maxWidth, label) {
  const m = measure(str, scale);
  if (m.w > maxWidth) {
    throw new Error(
      `social card: "${label || str}" is ${m.w}px at scale ${scale}, ` +
        `only ${maxWidth}px available - lower the scale or shorten it`
    );
  }
  return text(str, x, y, scale, c);
}

/* ------------------------------------------------------------ background */

rect(0, 0, W, H, INK.bg);
// A faint 32px checker, the same idea as the board's own transparency checker:
// enough texture that the card is not a flat slab in a busy feed.
for (let y = 0; y < H; y += 32) {
  for (let x = 0; x < W; x += 32) {
    if (((x / 32) | 0) % 2 === ((y / 32) | 0) % 2) rect(x, y, 32, 32, INK.bgAlt);
  }
}

/* ------------------------------------------------------- left: the words */

const MX = 64; // left margin
const LEFT_W = 726; // text column, stops clear of the board panel

textFit('HEARTOPIA', MX, 96, 9, INK.accent, LEFT_W, 'HEARTOPIA');
textFit('PAINTING TOOL', MX, 176, 9, INK.title, LEFT_W, 'PAINTING TOOL');
textFit('MULTIPLAYER PIXEL ART STUDIO', MX, 274, 4, INK.sub, LEFT_W, 'tagline');

// Feature chips. Sized from the text, so a longer word cannot overflow one.
const CHIPS = ['125 SHADES', 'LIVE CO-OP', '3D PREVIEW'];
const CHIP_SCALE = 3;
const CHIP_PAD_X = 16;
const CHIP_H = 53;
let cx = MX;
for (const label of CHIPS) {
  const m = measure(label, CHIP_SCALE);
  const w = m.w + CHIP_PAD_X * 2;
  if (cx + w > MX + LEFT_W) throw new Error(`social card: chip row overflows at "${label}"`);
  rect(cx, 336, w, CHIP_H, INK.chipBg);
  outlineRect(cx, 336, w, CHIP_H, 3, INK.chipLine);
  text(label, cx + CHIP_PAD_X, 336 + (CHIP_H - m.h) / 2, CHIP_SCALE, INK.title);
  cx += w + 20;
}

textFit('PAINT IT TOGETHER. EXPORT IT EXACT.', MX, 424, 3, INK.sub, LEFT_W, 'promise');
textFit('NO INSTALL. NO ACCOUNT.', MX, 464, 3, INK.sub, LEFT_W, 'no-install');

/* ------------------------------------------------- right: a real board */

// A heart on a canvas board, in shades that actually ship, with two other
// players' cursors on it - the whole pitch in one picture: pixel editor,
// multiplayer, real palette.
const HEART = [
  '.XX.....XX.',
  'XXXX...XXXX',
  'XXXXXXXXXXX',
  'XXXXXXXXXXX',
  'XXXXXXXXXXX',
  '.XXXXXXXXX.',
  '..XXXXXXX..',
  '...XXXXX...',
  '....XXX....',
  '.....X.....',
];
const CELL = 26;
const PAD = 18;
const BW = HEART[0].length * CELL;
const BH = HEART.length * CELL;
const BX = 814;
const BY = 96;

rect(BX, BY, BW + PAD * 2, BH + PAD * 2, INK.paper);
outlineRect(BX, BY, BW + PAD * 2, BH + PAD * 2, 4, INK.frame);
// Grid lines, because a board with no grid reads as a picture of a heart rather
// than as a picture of the tool.
for (let c = 1; c < HEART[0].length; c++) rect(BX + PAD + c * CELL, BY + PAD, 1, BH, INK.grid);
for (let r = 1; r < HEART.length; r++) rect(BX + PAD, BY + PAD + r * CELL, BW, 1, INK.grid);

for (let r = 0; r < HEART.length; r++) {
  for (let c = 0; c < HEART[r].length; c++) {
    if (HEART[r][c] !== 'X') continue;
    // Pale at the top-left lobe, dark toward the point: two extra shades from
    // the same group, which is exactly what the in-game airbrush does.
    const col = r + c <= 2 ? INK.heartPale : r >= 7 ? INK.heartDark : INK.heart;
    rect(BX + PAD + c * CELL + 1, BY + PAD + r * CELL + 1, CELL - 1, CELL - 1, col);
  }
}

/** A pointer arrow with a nickname chip, the way the app draws a remote player. */
const ARROW = ['X.....', 'XX....', 'XXX...', 'XXXX..', 'XXXXX.', 'XXXXXX', 'XXXX.X', 'XX..X.', 'X...X.'];
function cursor(ax, ay, col, nick) {
  const S = 3;
  // Dark pass offset by one cell, then the colour: an outline that survives any
  // board underneath it.
  for (const pass of [INK.frame, col]) {
    const off = pass === INK.frame ? S : 0;
    for (let r = 0; r < ARROW.length; r++)
      for (let c = 0; c < ARROW[r].length; c++)
        if (ARROW[r][c] === 'X') rect(ax + c * S + off, ay + r * S + off, S, S, pass);
  }
  const m = measure(nick, 2);
  const cw = m.w + 14;
  const chx = ax + 14;
  const chy = ay + ARROW.length * S + 6;
  rect(chx, chy, cw, 24, col);
  text(nick, chx + 7, chy + (24 - m.h) / 2, 2, INK.band);
}
cursor(BX + PAD + 2 * CELL, BY + PAD + 2 * CELL, INK.cursorA, 'ADA');
cursor(BX + PAD + 7 * CELL, BY + PAD + 6 * CELL, INK.cursorB, 'KO');

/* ------------------------------------------------------ bottom: palette */

const BAND_Y = 520;
rect(0, BAND_Y, W, H - BAND_Y, INK.band);
// All 13 group mains, edge to edge: the palette is the product's constraint and
// the thing a Heartopia player recognises first.
const segW = W / GROUP_MAINS.length;
GROUP_MAINS.forEach((hex, i) => {
  rect(Math.round(i * segW), BAND_Y, Math.round((i + 1) * segW) - Math.round(i * segW), 14, rgb(hex));
});

const URL = 'SEBSILENT.GITHUB.IO/HEARTOPIAMPPAINT';
const urlW = textFit(URL, MX, 566, 3, INK.title, 700, 'url');
const RIGHT = 'FREE + OPEN SOURCE';
const rm = measure(RIGHT, 3);
const rx = W - MX - rm.w;
if (rx < MX + urlW + 24) throw new Error('social card: bottom band texts collide');
text(RIGHT, rx, 566, 3, INK.sub);

/* ------------------------------------------------------------ PNG write */

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, surface.encode());

const kb = (fs.statSync(OUT).size / 1024).toFixed(1);
console.log(`wrote ${path.relative(ROOT, OUT)}  ${W}x${H}  ${kb} KB`);
