/*
 * Builds the four README badges as static SVG in assets/img/.
 *
 *   node tools/build_badges.mjs
 *
 * They were shields.io URLs first. Two problems with that: the README then
 * depends on a third-party service being up and unblocked (it is not reachable
 * from every network, and a badge that fails to load renders as a broken image
 * in the one document that is supposed to sell the project), and the colours are
 * picked by name rather than taken from the palette this repo is about. These are
 * generated from the same hex values as the favicon and the share card, so the
 * README, the icon and the og:image cannot disagree about what the brand looks
 * like.
 *
 * Text colour is chosen by measured contrast against the segment, not hard-coded:
 * white on #fdab34 is 1.7:1 and unreadable, and a badge is exactly the kind of
 * small text that gets away with it until someone runs a checker.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUTDIR = path.join(ROOT, 'assets', 'img');

const LABEL_BG = '#3d342e';
const LIGHT = '#f7f2ea';
const DARK = '#221b17';

// A palette GROUP, not a hex. The segment colour is chosen from that group's real
// shades below, because the obvious ones are not all usable: group 10's main
// #2981c0 reaches only 4.04:1 against light ink and 4.35:1 against dark, so it
// fails AA with either, and a badge is small text.
const BADGES = [
  { file: 'badge-license.svg', label: 'license', value: 'MIT', group: 4 },
  { file: 'badge-build.svg', label: 'build', value: 'none', group: 7 },
  { file: 'badge-platform.svg', label: 'platform', value: 'any browser', group: 10 },
  { file: 'badge-palette.svg', label: 'palette', value: '125 shades', group: 2 },
];

const MIN_CONTRAST = 4.5; // WCAG AA for text this size

const palette = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'assets/data/heartopia-palette.json'), 'utf8')
);

/**
 * The group's own main shade if it can carry readable text, otherwise the first
 * shade in palette order that can. Staying inside the group is the point: the
 * badge should read as the same red or blue a player picks in the app.
 */
function segmentFor(groupNum) {
  const g = palette.groups.find((x) => x.group === groupNum);
  if (!g) throw new Error(`palette has no group ${groupNum}`);
  for (const hex of [g.mainColor, ...g.colors]) {
    const { ink, ratio } = inkFor(hex);
    if (ratio >= MIN_CONTRAST) return { colour: hex, ink, ratio };
  }
  throw new Error(`no shade in palette group ${groupNum} reaches ${MIN_CONTRAST}:1 with either ink`);
}

/* ------------------------------------------------------- contrast choice */

function luminance(hex) {
  const n = parseInt(hex.slice(1), 16);
  const chan = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * chan[0] + 0.7152 * chan[1] + 0.0722 * chan[2];
}

function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** Whichever of the two inks reads better on this background, and how well. */
function inkFor(bg) {
  const light = contrast(bg, LIGHT);
  const dark = contrast(bg, DARK);
  return dark > light ? { ink: DARK, ratio: dark } : { ink: LIGHT, ratio: light };
}

/* ------------------------------------------------------------- geometry */

// Verdana at 11px averages ~6.4px per character for the mixed-case and digit
// mixtures used here. Measured rather than guessed would need a font rasteriser;
// over-estimating by a fraction of a pixel per glyph only adds padding, which is
// invisible, while under-estimating clips - so the estimate is rounded up.
const CHAR_W = 6.4;
const PAD = 8;
const H = 20;
const textW = (s) => Math.ceil(s.length * CHAR_W);

function esc(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function badge({ label, value, group }) {
  const lw = textW(label) + PAD * 2;
  const vw = textW(value) + PAD * 2;
  const w = lw + vw;
  const seg = segmentFor(group);
  const { colour, ink: vInkColour, ratio: vRatio } = seg;
  const lInk = inkFor(LABEL_BG);
  if (vRatio < MIN_CONTRAST) throw new Error(`badge "${value}" on ${colour} is only ${vRatio.toFixed(2)}:1`);
  if (lInk.ratio < MIN_CONTRAST) throw new Error(`badge label on ${LABEL_BG} is only ${lInk.ratio.toFixed(2)}:1`);

  const text = (x, width, str, fill) =>
    `<text x="${x + width / 2}" y="14.5" fill="${fill}" text-anchor="middle" ` +
    `font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">${esc(str)}</text>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${H}" role="img" aria-label="${esc(label)}: ${esc(value)}">
<title>${esc(label)}: ${esc(value)}</title>
<rect width="${w}" height="${H}" rx="3" fill="${colour}"/>
<rect width="${lw}" height="${H}" rx="3" fill="${LABEL_BG}"/>
<rect x="${lw}" width="${w - lw}" height="${H}" fill="${colour}"/>
${text(0, lw, label, lInk.ink)}
${text(lw, vw, value, vInkColour)}
</svg>
`;
}

fs.mkdirSync(OUTDIR, { recursive: true });
for (const b of BADGES) {
  const svg = badge(b);
  fs.writeFileSync(path.join(OUTDIR, b.file), svg);
  const w = textW(b.label) + PAD * 2 + textW(b.value) + PAD * 2;
  const seg = segmentFor(b.group);
  console.log(
    `wrote assets/img/${b.file}  ${w}x${H}  ${b.label}: ${b.value}` +
    `  group ${b.group} -> ${seg.colour} at ${seg.ratio.toFixed(2)}:1`
  );
}
