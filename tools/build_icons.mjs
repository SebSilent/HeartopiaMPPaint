/*
 * Builds the install icons from the same motif as the inline SVG favicon in
 * index.html - four palette squares on the game's warm brown - at the sizes a
 * manifest, iOS and Android actually ask for.
 *
 *   node tools/build_icons.mjs
 *
 * Why generated: the favicon is an SVG data URI, which iOS ignores for
 * "Add to Home Screen" and which no manifest can list. Hand-exporting PNGs from
 * an image editor means the next colour change leaves four stale binaries nobody
 * remembers. These are derived from the same four hex values, so they cannot
 * drift from the favicon.
 *
 * The motif is defined once, on the favicon's own 32x32 grid, and scaled by an
 * integer unit per size. Integer because a fractional unit would make the four
 * squares different sizes from each other at 192px, which reads as a rendering
 * bug on a home screen.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Surface, hexToRgba } from './png.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUTDIR = path.join(ROOT, 'assets', 'img');

const BG = '#74584d';
// [x, y, hex] on the favicon's 32x32 grid; every square is 10x10.
const SQUARES = [
  [5, 5, '#ea696d'],
  [17, 5, '#fdab34'],
  [5, 17, '#40b678'],
  [17, 17, '#2981c0'],
];
const SQUARE = 10;
const GRID = 32;

/**
 * @param {number} size    output edge, px
 * @param {number} unit    px per grid cell - must be an integer
 * @param {number} offset  px of background left around the motif
 */
function drawIcon(size, unit, offset) {
  if (!Number.isInteger(unit)) throw new Error(`unit ${unit} is not an integer; the squares would differ`);
  const motif = GRID * unit;
  if (motif + offset * 2 > size) throw new Error(`motif ${motif} + ${offset * 2} padding exceeds ${size}`);
  const s = new Surface(size, size, hexToRgba(BG));
  for (const [gx, gy, hex] of SQUARES) {
    s.rect(offset + gx * unit, offset + gy * unit, SQUARE * unit, SQUARE * unit, hexToRgba(hex));
  }
  return s;
}

// Maskable icons get cropped to a circle, a squircle or a rounded square
// depending on the launcher, and the spec keeps the outer 20% as unsafe - so the
// motif is drawn at 384px inside 512, not edge to edge.
const TARGETS = [
  ['icon-192.png', 192, 6, 0, 'any'],
  ['icon-512.png', 512, 16, 0, 'any'],
  ['icon-maskable-512.png', 512, 12, 64, 'maskable'],
  ['apple-touch-icon.png', 180, 5, 10, 'apple'],
];

fs.mkdirSync(OUTDIR, { recursive: true });
for (const [name, size, unit, offset] of TARGETS) {
  const png = drawIcon(size, unit, offset).encode();
  const file = path.join(OUTDIR, name);
  fs.writeFileSync(file, png);
  console.log(`wrote assets/img/${name}  ${size}x${size}  ${(png.length / 1024).toFixed(1)} KB`);
}
