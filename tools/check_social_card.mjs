/*
 * Verifies assets/img/social-card.png by decoding it and looking at the pixels,
 * because "the file was written" and "the card says the right thing" are not the
 * same claim - and nobody can see a share card that shipped with a clipped title.
 *
 *   node tools/check_social_card.mjs
 *
 * Checks: size, that each block of text left the ink it should have in the region
 * it was drawn in, that the board has paper and painted cells, that all 13 palette
 * groups reach the bottom strip, and that nothing was drawn outside the canvas.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILE = path.join(ROOT, 'assets/img/social-card.png');
const buf = fs.readFileSync(FILE);

/* ------------------------------------------------------------ decode PNG */

function readChunks(b) {
  const out = [];
  let i = 8; // signature
  while (i < b.length) {
    const len = b.readUInt32BE(i);
    const type = b.toString('ascii', i + 4, i + 8);
    out.push({ type, data: b.subarray(i + 8, i + 8 + len) });
    i += 12 + len;
  }
  return out;
}

const chunks = readChunks(buf);
const ihdr = chunks.find((c) => c.type === 'IHDR').data;
const W = ihdr.readUInt32BE(0);
const H = ihdr.readUInt32BE(4);
const depth = ihdr[8];
const ctype = ihdr[9];
if (depth !== 8 || ctype !== 6) throw new Error(`expected 8-bit RGBA, got depth ${depth} type ${ctype}`);

const idat = Buffer.concat(chunks.filter((c) => c.type === 'IDAT').map((c) => c.data));
const raw = zlib.inflateSync(idat);
const stride = W * 4;
const px = Buffer.alloc(W * H * 4);
for (let y = 0; y < H; y++) {
  const filter = raw[y * (stride + 1)];
  if (filter !== 0) throw new Error(`row ${y} uses filter ${filter}; this decoder only reads filter 0`);
  raw.copy(px, y * stride, y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
}

const at = (x, y) => {
  const i = (y * W + x) * 4;
  return [px[i], px[i + 1], px[i + 2]];
};
const hex = (x, y) => '#' + at(x, y).map((v) => v.toString(16).padStart(2, '0')).join('');

let bad = 0;
const fail = (m) => { bad++; console.log('FAIL ' + m); };
const ok = (m) => console.log('ok   ' + m);

/** How many pixels in a box are exactly this colour. */
function count(x0, y0, x1, y1, want) {
  let n = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (hex(x, y) === want) n++;
  return n;
}

/* ------------------------------------------------------------- assertions */

if (W !== 1200 || H !== 630) fail(`card is ${W}x${H}, og:image wants 1200x630`);
else ok(`1200x630, ${(buf.length / 1024).toFixed(1)} KB`);

// Text blocks: the colour must appear, and in the band it was drawn in.
// A title that slid off-canvas or a scale that clipped reads as "no ink here".
const BLOCKS = [
  ['HEARTOPIA', 64, 96, 790, 159, '#fdab34', 400],
  ['PAINTING TOOL', 64, 176, 790, 239, '#f7f2ea', 500],
  ['tagline', 64, 274, 790, 302, '#b9a99a', 150],
  ['chips', 64, 336, 790, 389, '#f7f2ea', 150],
  ['promise', 64, 424, 790, 445, '#b9a99a', 100],
  ['no-install', 64, 464, 790, 485, '#b9a99a', 80],
  ['url', 64, 566, 790, 587, '#f7f2ea', 150],
  ['open source', 790, 566, 1136, 587, '#b9a99a', 60],
];
for (const [label, x0, y0, x1, y1, colour, min] of BLOCKS) {
  const n = count(x0, y0, x1, y1, colour);
  if (n < min) fail(`"${label}" has ${n}px of ${colour} in its band, expected at least ${min}`);
  else ok(`"${label}" ${n}px of ink`);
}

// The board: paper inside the frame, painted heart cells, grid lines.
const BX = 814, BY = 96, PAD = 18;
if (count(BX + PAD, BY + PAD, BX + PAD + 286, BY + PAD + 260, '#f2e8dc') < 20000) {
  fail('board has no paper - the panel did not draw');
} else ok('board paper present');
for (const [c, name, min] of [['#ea696d', 'heart body', 2000], ['#cf354d', 'heart shade', 300], ['#f5aca6', 'heart pale', 100]]) {
  const n = count(BX, BY, BX + 322, BY + 296, c);
  if (n < min) fail(`board has ${n}px of ${name}, expected at least ${min}`);
  else ok(`${name} ${n}px`);
}
if (count(BX + PAD, BY + PAD, BX + PAD + 286, BY + PAD + 260, '#ddcec0') < 100) fail('no grid lines on the board');
else ok('grid lines present');

// Cursors: two players, two colours, each with a nickname chip.
for (const [c, who] of [['#40b678', 'ADA'], ['#2981c0', 'KO']]) {
  const n = count(BX, BY, BX + 322, BY + 340, c);
  if (n < 100) fail(`cursor ${who} has ${n}px, expected a visible arrow and chip`);
  else ok(`cursor ${who} ${n}px`);
}

// Bottom strip: all 13 group mains, edge to edge.
const palette = JSON.parse(fs.readFileSync(path.join(ROOT, 'assets/data/heartopia-palette.json'), 'utf8'));
const strip = new Set();
for (let x = 0; x < W; x++) strip.add(hex(x, 524));
const missing = palette.groups.map((g) => g.mainColor.toLowerCase()).filter((h) => !strip.has(h));
if (missing.length) fail(`bottom strip is missing ${missing.join(', ')}`);
else ok(`bottom strip carries all ${palette.groups.length} group colours`);

// Nothing drawn outside the frame. The top corners are the checker background;
// the bottom two are inside the footer band, which is meant to cover them.
for (const [x, y, want] of [
  [0, 0, ['#221b17', '#271f1a']],
  [W - 1, 0, ['#221b17', '#271f1a']],
  [0, H - 1, ['#191411']],
  [W - 1, H - 1, ['#191411']],
]) {
  if (!want.includes(hex(x, y))) fail(`corner ${x},${y} is ${hex(x, y)}, expected ${want.join(' or ')}`);
}
ok('corners are the colours they should be');

// A card that is mostly one colour is a card that failed to draw.
const seen = new Set();
for (let y = 0; y < H; y += 7) for (let x = 0; x < W; x += 7) seen.add(hex(x, y));
if (seen.size < 12) fail(`only ${seen.size} distinct colours sampled - the card looks blank`);
else ok(`${seen.size} distinct colours sampled`);

console.log(bad ? `\n${bad} problem(s)` : '\nsocial card checks pass');
process.exit(bad ? 1 : 0);
