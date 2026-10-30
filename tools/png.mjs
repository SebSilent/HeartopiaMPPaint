/*
 * A PNG encoder, because the tools that generate images for this repo (the share
 * card, the install icons) run in Node with no dependencies and no canvas - and
 * `npm install canvas` on a project whose published site has zero dependencies
 * would be a poor trade for two build-time scripts.
 *
 * PNG is a small format: a signature, then chunks, each a length, a four-byte
 * type, the data and a CRC32 of type+data. An 8-bit RGBA image is one IDAT
 * holding a zlib stream of scanlines, each prefixed by a filter byte. We only
 * ever write filter 0 (none), which is legal for every row and lets the decoder
 * in tools/check_social_card.mjs stay equally small.
 */

import zlib from 'node:zlib';

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

export function crc32(b) {
  let c = -1;
  for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 255] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

export function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/**
 * @param {number} w
 * @param {number} h
 * @param {Buffer} rgba  w*h*4 bytes, row-major, no filter bytes
 */
export function encodePNG(w, h, rgba) {
  if (rgba.length !== w * h * 4) {
    throw new Error(`encodePNG: buffer is ${rgba.length} bytes, ${w}x${h} RGBA needs ${w * h * 4}`);
  }
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: truecolour with alpha
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * A tiny RGBA surface with the handful of drawing primitives the generators
 * need. Deliberately not a canvas API: no paths, no antialiasing, no transforms.
 * Everything here paints whole pixels, which is the point of a pixel-art repo.
 */
export class Surface {
  constructor(w, h, bg = [0, 0, 0, 0]) {
    this.w = w;
    this.h = h;
    this.buf = Buffer.alloc(w * h * 4);
    if (bg) this.rect(0, 0, w, h, bg);
  }

  px(x, y, c) {
    x |= 0;
    y |= 0;
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const i = (y * this.w + x) * 4;
    this.buf[i] = c[0];
    this.buf[i + 1] = c[1];
    this.buf[i + 2] = c[2];
    this.buf[i + 3] = c[3] === undefined ? 255 : c[3];
  }

  rect(x, y, w, h, c) {
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) this.px(x + i, y + j, c);
  }

  outlineRect(x, y, w, h, t, c) {
    this.rect(x, y, w, t, c);
    this.rect(x, y + h - t, w, t, c);
    this.rect(x, y, t, h, c);
    this.rect(x + w - t, y, t, h, c);
  }

  /** The colour at a pixel, as [r,g,b,a]. Out of bounds reads as transparent. */
  at(x, y) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return [0, 0, 0, 0];
    const i = (y * this.w + x) * 4;
    return [this.buf[i], this.buf[i + 1], this.buf[i + 2], this.buf[i + 3]];
  }

  encode() {
    return encodePNG(this.w, this.h, this.buf);
  }
}

export function hexToRgba(hex) {
  const n = parseInt(String(hex).replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 255];
}
