/*
 * A 5x7 bitmap font, because this board paints cells and nothing else.
 *
 * The obvious way to do a text tool is `ctx.fillText` into an offscreen canvas
 * and threshold the alpha. That is what `game/stamps.js` does for imported
 * brush tips, and here it would be wrong: the glyph would come out different on
 * every device, because it depends on a font that may not be installed, on
 * subpixel hinting, and on the browser's own idea of what 7 pixels tall means.
 * A board is supposed to be reproducible by hand in Heartopia - that is the
 * entire export story - so a letter has to be the same seven rows of cells for
 * everyone who opens the room.
 *
 * So the glyphs are data. Each is seven rows of five bits, bit 4 is the leftmost
 * cell, written in binary so a wrong letter is readable as a wrong letter rather
 * than as a mysterious number.
 *
 * Uppercase only, like the 8-bit fonts this is drawn from: the cells are few and
 * a lowercase 'i' at five rows is a smudge. Input is folded up, and the option
 * row shows the text exactly as it will be painted, so nothing is silently
 * changed under the player.
 */

export const GLYPH_W = 5;
export const GLYPH_H = 7;
/** One blank column between letters, one blank row between lines. */
export const TRACKING = 1;
export const LEADING = 1;

export const FONT = {
  ' ': [0, 0, 0, 0, 0, 0, 0],
  A: [0b01110, 0b10001, 0b10001, 0b11111, 0b10001, 0b10001, 0b10001],
  B: [0b11110, 0b10001, 0b10001, 0b11110, 0b10001, 0b10001, 0b11110],
  C: [0b01110, 0b10001, 0b10000, 0b10000, 0b10000, 0b10001, 0b01110],
  D: [0b11100, 0b10010, 0b10001, 0b10001, 0b10001, 0b10010, 0b11100],
  E: [0b11111, 0b10000, 0b10000, 0b11110, 0b10000, 0b10000, 0b11111],
  F: [0b11111, 0b10000, 0b10000, 0b11110, 0b10000, 0b10000, 0b10000],
  G: [0b01110, 0b10001, 0b10000, 0b10111, 0b10001, 0b10001, 0b01110],
  H: [0b10001, 0b10001, 0b10001, 0b11111, 0b10001, 0b10001, 0b10001],
  I: [0b11111, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100, 0b11111],
  J: [0b00111, 0b00010, 0b00010, 0b00010, 0b00010, 0b10010, 0b01100],
  K: [0b10001, 0b10010, 0b10100, 0b11000, 0b10100, 0b10010, 0b10001],
  L: [0b10000, 0b10000, 0b10000, 0b10000, 0b10000, 0b10000, 0b11111],
  M: [0b10001, 0b11011, 0b10101, 0b10001, 0b10001, 0b10001, 0b10001],
  N: [0b10001, 0b11001, 0b10101, 0b10011, 0b10001, 0b10001, 0b10001],
  O: [0b01110, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01110],
  P: [0b11110, 0b10001, 0b10001, 0b11110, 0b10000, 0b10000, 0b10000],
  Q: [0b01110, 0b10001, 0b10001, 0b10001, 0b10101, 0b10010, 0b01101],
  R: [0b11110, 0b10001, 0b10001, 0b11110, 0b10100, 0b10010, 0b10001],
  S: [0b01111, 0b10000, 0b10000, 0b01110, 0b00001, 0b00001, 0b11110],
  T: [0b11111, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100],
  U: [0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01110],
  V: [0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01010, 0b00100],
  W: [0b10001, 0b10001, 0b10001, 0b10101, 0b10101, 0b11011, 0b01010],
  X: [0b10001, 0b10001, 0b01010, 0b00100, 0b01010, 0b10001, 0b10001],
  Y: [0b10001, 0b10001, 0b01010, 0b00100, 0b00100, 0b00100, 0b00100],
  Z: [0b11111, 0b00001, 0b00010, 0b00100, 0b01000, 0b10000, 0b11111],
  '0': [0b01110, 0b10001, 0b10011, 0b10101, 0b11001, 0b10001, 0b01110],
  '1': [0b00100, 0b01100, 0b00100, 0b00100, 0b00100, 0b00100, 0b01110],
  '2': [0b01110, 0b10001, 0b00001, 0b00010, 0b00100, 0b01000, 0b11111],
  '3': [0b11111, 0b00010, 0b00100, 0b00010, 0b00001, 0b10001, 0b01110],
  '4': [0b00010, 0b00110, 0b01010, 0b10010, 0b11111, 0b00010, 0b00010],
  '5': [0b11111, 0b10000, 0b11110, 0b00001, 0b00001, 0b10001, 0b01110],
  '6': [0b01110, 0b10000, 0b10000, 0b11110, 0b10001, 0b10001, 0b01110],
  '7': [0b11111, 0b00001, 0b00010, 0b00100, 0b01000, 0b01000, 0b01000],
  '8': [0b01110, 0b10001, 0b10001, 0b01110, 0b10001, 0b10001, 0b01110],
  '9': [0b01110, 0b10001, 0b10001, 0b01111, 0b00001, 0b00010, 0b01100],
  '.': [0, 0, 0, 0, 0, 0b01100, 0b01100],
  ',': [0, 0, 0, 0, 0b01100, 0b00100, 0b01000],
  '!': [0b00100, 0b00100, 0b00100, 0b00100, 0b00100, 0, 0b00100],
  '?': [0b01110, 0b10001, 0b00001, 0b00110, 0b00100, 0, 0b00100],
  "'": [0b00100, 0b00100, 0, 0, 0, 0, 0],
  '"': [0b01010, 0b01010, 0, 0, 0, 0, 0],
  '-': [0, 0, 0, 0b01110, 0, 0, 0],
  '+': [0, 0, 0, 0b01110, 0b11111, 0b01110, 0],
  ':': [0, 0, 0b01100, 0, 0, 0b01100, 0],
  '(': [0b00010, 0b00100, 0b01000, 0b01000, 0b01000, 0b00100, 0b00010],
  ')': [0b01000, 0b00100, 0b00010, 0b00010, 0b00010, 0b00100, 0b01000],
  '*': [0, 0b00100, 0b10101, 0b11111, 0b10101, 0b00100, 0],
  '/': [0b00001, 0b00010, 0b00010, 0b00100, 0b01000, 0b01000, 0b10000],
  '#': [0b01010, 0b11111, 0b01010, 0b01010, 0b11111, 0b01010, 0],
  '%': [0b11001, 0b11010, 0b00010, 0b00100, 0b01000, 0b01011, 0b10011],
  '&': [0b01100, 0b10010, 0b10100, 0b01000, 0b10101, 0b10010, 0b01101],
  '@': [0b01110, 0b10001, 0b10111, 0b10101, 0b10111, 0b10000, 0b01110],
  '=': [0, 0, 0b11111, 0, 0b11111, 0, 0],
  _: [0, 0, 0, 0, 0, 0, 0b11111],
  '<': [0b00010, 0b00100, 0b01000, 0b10000, 0b01000, 0b00100, 0b00010],
  '>': [0b01000, 0b00100, 0b00010, 0b00001, 0b00010, 0b00100, 0b01000],
  // Heartopia's own mark. The one glyph that is not a letter anyone needs.
  // Quoted because a heart is not a legal bare identifier.
  '♥': [0b01010, 0b11111, 0b11111, 0b11111, 0b01110, 0b00100, 0],
};

/** The glyph for a character, folded to uppercase, or null if it has none. */
export function glyphFor(ch) {
  return FONT[ch] || FONT[String(ch).toUpperCase()] || null;
}

/** True when this character can be painted. Used to warn instead of surprising. */
export function hasGlyph(ch) {
  return !!glyphFor(ch);
}

/**
 * The text as it will actually be painted: uppercase, and every character with
 * no glyph dropped rather than substituted, so what the option row shows is the
 * board you get.
 */
export function prepare(text) {
  const out = [];
  const skipped = new Set();
  // Walked in the player's own case, so a dropped character can be reported back
  // as the one they typed: "no glyph for ï" is only useful if it is spelled the
  // way it is in the box.
  for (const ch of String(text == null ? '' : text)) {
    if (ch === '\n') {
      out.push(ch);
      continue;
    }
    const up = ch.toUpperCase();
    if (!FONT[up]) {
      skipped.add(ch);
      continue;
    }
    out.push(up);
  }
  return { text: out.join(''), skipped: [...skipped] };
}

function lines(text) {
  return String(text).split('\n');
}

/**
 * Size of the block, in board cells.
 * @returns {{w:number,h:number,lines:number,longest:number}}
 */
export function measure(text, scale = 1) {
  const t = prepare(text).text;
  const s = Math.max(1, scale | 0);
  // Nothing to say is nothing to place. Without this an empty string reports a
  // width of -5 and `textMask` builds a Uint8Array of -35, which throws.
  if (!t.replace(/\n/g, '')) return { w: 0, h: 0, lines: 0, longest: 0 };
  const ls = lines(t);
  const longest = ls.reduce((m, l) => Math.max(m, l.length), 0);
  return {
    w: (longest * (GLYPH_W + TRACKING) - TRACKING) * s,
    h: (ls.length * GLYPH_H + (ls.length - 1) * LEADING) * s,
    lines: ls.length,
    longest,
  };
}

/**
 * The cells to paint, as [dx, dy] offsets from the top-left of the block.
 *
 * Offsets rather than absolute cells because the caller knows where the pointer
 * landed and which face is active, and because the preview and the commit must
 * agree exactly - one function, used by both, is how that stays true.
 */
export function textCells(text, scale = 1) {
  const s = Math.max(1, scale | 0);
  const t = prepare(text).text;
  const cells = [];
  let dy0 = 0;
  for (const line of lines(t)) {
    let dx = 0;
    for (const ch of line) {
      const g = FONT[ch];
      if (!g) continue;
      for (let r = 0; r < GLYPH_H; r++) {
        const bits = g[r];
        if (!bits) continue;
        for (let c = 0; c < GLYPH_W; c++) {
          if (!(bits & (1 << (GLYPH_W - 1 - c)))) continue;
          for (let sy = 0; sy < s; sy++)
            for (let sx = 0; sx < s; sx++) cells.push([(dx + c) * s + sx, (dy0 + r) * s + sy]);
        }
      }
      dx += GLYPH_W + TRACKING;
    }
    dy0 += GLYPH_H + LEADING;
  }
  return cells;
}

/**
 * A grid of 0/1 for the hover preview, so the ghost is drawn from the same data
 * as the paint rather than from a second copy of the loop above.
 */
export function textMask(text, scale = 1) {
  const m = measure(text, scale);
  const g = new Uint8Array(m.w * m.h);
  for (const [x, y] of textCells(text, scale)) g[y * m.w + x] = 1;
  return { ...m, g };
}
