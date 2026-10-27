/**
 * Import: a picture in, a Heartopia board out.
 *
 * Two doors. A photo/illustration goes through crop -> quantise -> reduce. A
 * screenshot of the game goes through the detector in cv/boarddetect.js first,
 * which finds the board, works out the cell size, ignores the grid lines and
 * hands back cells that are already the right shape.
 *
 * Both end the same way: a Uint8Array of palette indices sized to the face you
 * are about to paint, previewed before anything is committed, and applied as
 * one undoable op. Nothing here writes to the room until you say so.
 */

import { palette, quantize, reduceColors, DITHER } from '../color/science.js';
import { detectBoard, liftBoard, guessSlot } from '../cv/boarddetect.js';
import { FLAT_COLORS } from '../data/heartopia-palette.js';
import { CLOTHING, FURNITURE, BOOK } from '../game/slots.js';

export const FITS = ['cover', 'contain', 'stretch'];

/** File or object URL -> a decoded image. */
export function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onerror = () => reject(new Error('could not read that image'));
    if (src instanceof File || src instanceof Blob) {
      const url = URL.createObjectURL(src);
      img.onload = () => {
        URL.revokeObjectURL(url);
        resolve(img);
      };
      img.src = url;
    } else {
      img.src = src;
    }
  });
}

/**
 * Where the source image lands in the target box, in target pixels.
 *
 * The preview that lets you drag a picture around has to draw it in exactly the
 * place `rasterize` will sample, so the two share this one rect instead of each
 * working out the fit arithmetic on its own.
 *
 * `rot` turns the picture before it is placed, in quarter degrees, because a
 * phone photo is sideways more often than not and cropping it back is a chore.
 * A quarter turn swaps which of the source's edges faces the target's width, so
 * the fit is measured against the *turned* box - `sw`/`sh` stay the box the
 * picture occupies in target space, and `dw`/`dh` are the size to hand
 * `drawImage` after the context has been rotated.
 *
 * @param {number} zoom  1 = fill the target box
 * @param {number} ox/oy -0.5..0.5 pan, in fractions of the target
 * @param {number} rot   0/90/180/270 degrees, clockwise
 */
export function fitRect(img, w, h, o = {}) {
  const fit = o.fit || 'cover';
  const scale = o.zoom ?? 1;
  // Normalised here rather than trusted from a <select>, whose values are
  // strings, so every caller gets a number without repeating the parse.
  const rot = ((Math.round(Number(o.rot) || 0) % 360) + 360) % 360;
  const quarter = rot === 90 || rot === 270;
  // What has to fit the target is the box the picture occupies *after* the turn.
  const bw = quarter ? img.height : img.width;
  const bh = quarter ? img.width : img.height;
  let k;
  if (fit === 'stretch') k = 1;
  else k = fit === 'cover' ? Math.max(w / bw, h / bh) : Math.min(w / bw, h / bh);
  const dw = img.width * k * scale;
  const dh = img.height * k * scale;
  const sw = quarter ? dh : dw;
  const sh = quarter ? dw : dh;
  return {
    dx: (w - sw) / 2 + (o.ox || 0) * w,
    dy: (h - sh) / 2 + (o.oy || 0) * h,
    sw,
    sh,
    rot,
    dw,
    dh,
  };
}

/**
 * Draw an image into a w x h pixel buffer, cropped and scaled.
 * @param {number} zoom  1 = fill the target box
 * @param {number} ox/oy -0.5..0.5 pan, in fractions of the target
 */
export function rasterize(img, w, h, o = {}) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  const fit = o.fit || 'cover';
  const scale = o.zoom ?? 1;
  const { dx, dy, sw, sh, rot, dw, dh } = fitRect(img, w, h, o);
  ctx.imageSmoothingEnabled = fit !== 'stretch' || scale === 1;
  if (!rot) {
    ctx.drawImage(img, dx, dy, sw, sh);
  } else {
    // Rotate about the centre of the box the picture is meant to occupy. The
    // context turns, the picture is drawn at its own un-turned size centred on
    // the origin, and what lands on the target is the turned bounding box -
    // which is exactly the `sw`/`sh` fitRect measured.
    ctx.save();
    ctx.translate(dx + sw / 2, dy + sh / 2);
    ctx.rotate((rot * Math.PI) / 180);
    ctx.drawImage(img, -dw / 2, -dh / 2, dw, dh);
    ctx.restore();
  }
  // The pixel array, not the ImageData wrapper: `quantize` and the detector
  // both index `data` numerically, and an ImageData object reads `undefined`
  // for every pixel - which does not throw, it quietly returns one flat shade.
  const imageData = ctx.getImageData(0, 0, w, h);
  return { data: imageData.data, width: w, height: h };
}

/**
 * The full photo pipeline, in the order that matters: adjust, match, then tidy.
 * Method before noise before reduction is the order that gives a predictable
 * result; doing reduction first just removes colours you were about to need.
 */
export function photoToCells(img, w, h, o = {}) {
  const raster = o.raw || rasterize(img, w, h, o);
  const mode = o.dither && o.dither !== 'none' ? o.dither : 'none';
  const q = quantize(raster, {
    mode,
    brightness: o.brightness,
    contrast: o.contrast,
    saturation: o.saturation,
    // The softness a downsample introduces is what this corrects, so it has to
    // run on the rasterised board-size pixels - which is where we are.
    sharpness: o.sharpness,
    alphaCut: o.alphaCut ?? 8,
  });
  let cells = q.cells;
  let from = q.colors.size;
  let to = q.colors.size;
  if (o.maxColors && from > o.maxColors) {
    cells = reduceColors(cells, w, h, palette(), { max: o.maxColors, method: o.reduce || 'lab' });
    to = new Set(cells).size;
  }
  return { cells, w, h, colors: new Set(cells), from, to, dither: mode };
}

/**
 * A screenshot of the game, lifted back into cells.
 *
 * The detector wants `{ data: Uint8ClampedArray, width, height }` - it indexes
 * `data` numerically. Handing it an `ImageData` reads `undefined` for every
 * pixel and it reports no board at all, which is how this path stayed dead for
 * as long as it has been.
 *
 * `o.cols`/`o.rows` are the face you are on. The board is looked for under that
 * expectation first - faster, and far harder to fool - and only then blind, so
 * the caller can tell "bad crop" apart from "that is a different face".
 */
export function screenshotToCells(img, o = {}) {
  // Work at a bounded size, but never resample: the thing we are measuring is
  // a pixel pitch, and resampling changes it.
  const scale = Math.min(1, 1100 / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const src = document.createElement('canvas');
  src.width = w;
  src.height = h;
  const sctx = src.getContext('2d', { willReadFrequently: true });
  sctx.imageSmoothingEnabled = scale < 1;
  sctx.drawImage(img, 0, 0, w, h);
  const imageData = sctx.getImageData(0, 0, w, h);
  const image = { data: imageData.data, width: w, height: h };

  const expect = o.cols && o.rows ? { expectCols: o.cols, expectRows: o.rows } : {};
  let lifted = liftBoard(image, { ...o, ...expect });
  let matchedSlot = true;
  if (!lifted) {
    lifted = liftBoard(image, o); // no expectation: find whatever board is there
    matchedSlot = false;
  }
  if (!lifted) return null;
  return {
    cells: lifted.cells,
    w: lifted.cols,
    h: lifted.rows,
    detect: lifted.detect,
    colors: lifted.colors,
    confidence: lifted.confidence,
    matchedSlot,
  };
}

/** Every face the tool knows about, for "which slot is this screenshot?". */
export function allFaces() {
  const out = [];
  for (const i of [...CLOTHING, ...FURNITURE, BOOK]) {
    for (const f of i.faces) out.push({ ...f, item: i.id, itemName: i.name });
  }
  return out;
}

export function matchSlot(w, h) {
  return guessSlot(w, h, allFaces());
}

/** Paint a cell buffer onto a face, as one undoable op. */
export function applyCellsToFace(room, input, cells, w, h, faceIdx = room.design.active) {
  const g = room.design.faceAt(faceIdx);
  const indices = [];
  const values = [];
  const gw = g.w;
  const gh = g.h;
  // Only the overlap can land. The count that did not is measured, not derived,
  // so the tool can say exactly how much of your board it could not place.
  let clipped = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!cells[y * w + x]) continue;
      if (x >= gw || y >= gh) clipped++;
    }
  }
  for (let y = 0; y < Math.min(h, gh); y++) {
    for (let x = 0; x < Math.min(w, gw); x++) {
      const c = cells[y * w + x];
      if (!c) continue;
      indices.push(y * gw + x);
      values.push(c);
    }
  }
  if (!indices.length) return { changed: 0, clipped };
  // One colour per op is what the wire speaks, so group by shade and send the
  // lot under a single stamp: still one undo step.
  const byColor = new Map();
  for (let i = 0; i < indices.length; i++) {
    if (!byColor.has(values[i])) byColor.set(values[i], []);
    byColor.get(values[i]).push(indices[i]);
  }
  const seq = room.nextSeq();
  let changed = 0;
  // Capture first: after the write, the old values are gone.
  const patch = { face: faceIdx, indices, from: Uint8Array.from(indices, (i) => g.color[i]) };
  for (const [c, list] of byColor) {
    changed += room.paintLocal(list, c, seq, faceIdx);
    room.sendOp(list, c, seq, faceIdx);
  }
  patch.to = Uint8Array.from(indices, (i) => g.color[i]);
  patch.label = 'import';
  input.history.push(patch);
  return { changed, clipped };
}

export { DITHER, FLAT_COLORS, detectBoard };
