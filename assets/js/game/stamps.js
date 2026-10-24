/*
 * Imported brush tips.
 *
 * Photoshop hands you a picture of a bristle blob and calls it a brush. This
 * board can only hold one palette colour per cell - no alpha, no soft edges,
 * nothing that survives the game's grid as a gradient - so a tip has to become
 * a *mask*: which cells of the brush footprint are on. That is what this does.
 *
 * The conversion is deliberately not nearest-neighbour sampling. A tip imported
 * at 512px and painted at 5 cells would otherwise thin to nothing wherever a
 * one-pixel-wide part of the art fell between two cells. Each target cell takes
 * the strongest pixel that lands inside it, so a hairline survives as a hairline
 * instead of vanishing.
 */

/**
 * @param {number} w
 * @param {number} h
 * @param {Uint8Array} alpha  one opacity per pixel, 0..255. The colour is not
 *   kept: the player picks the shade, the tip only decides the shape.
 */
export function makeStamp(w, h, alpha) {
  if (!(w > 0) || !(h > 0)) return null;
  if (!alpha || alpha.length < w * h) return null;
  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;
  let on = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (alpha[y * w + x] < 8) continue;
      on++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return null;
  return {
    w,
    h,
    alpha,
    on,
    // Trim to the art itself: a tip with 40% transparent margin should not
    // spend half the brush size on nothing.
    box: { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 },
  };
}

/**
 * Cell offsets the tip covers at `size` cells across, centred on [0,0].
 *
 * The longest side of the trimmed art sets the scale, so a wide flat brush stays
 * wide and flat rather than being squashed into a square.
 */
// Memoised per stamp: _paint asks for this on every pointer move, and the pool
// scan over the whole art is pure waste the second time. Keyed by size and
// threshold under the stamp, so a re-imported tip (a new object) starts fresh.
// Callers only read the array, never mutate it.
const stampCache = new WeakMap();

export function stampOffsets(stamp, size, threshold = 100) {
  if (!stamp) return [[0, 0]];
  const n = Math.max(1, Math.round(size));
  let per = stampCache.get(stamp);
  if (!per) {
    per = new Map();
    stampCache.set(stamp, per);
  }
  const key = `${n}|${threshold}`;
  const hit = per.get(key);
  if (hit) return hit;
  const b = stamp.box;
  // The longest side of the art spans `n` cells; the short side keeps its own
  // aspect, so a wide flat brush stays wide and flat instead of being squashed
  // into a square.
  const scale = Math.max(b.w, b.h) / n;
  const cols = Math.max(1, Math.round(b.w / scale));
  const rows = Math.max(1, Math.round(b.h / scale));
  const offs = [];
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const best = pool(stamp, b, i, j, cols, rows);
      // Centred on the art, not on the box it came from: a one-cell-tall bar has
      // to sit on the cursor's row, not two cells above it.
      if (best >= threshold) offs.push([Math.round(i - (cols - 1) / 2), Math.round(j - (rows - 1) / 2)]);
    }
  }
  const out = offs.length ? offs : [[0, 0]];
  per.set(key, out);
  return out;
}

/**
 * Strongest pixel of the tip that falls inside target cell [i,j].
 * Exported for the tests and for anything else that has to ask "would this cell
 * be painted" without going through the offset list.
 */
export function pool(stamp, box, i, j, cols, rows) {
  const sx = box.w / cols;
  const sy = box.h / rows;
  const x0 = Math.floor(box.x + i * sx);
  const x1 = Math.min(box.x + box.w, Math.max(x0 + 1, Math.ceil(box.x + (i + 1) * sx)));
  const y0 = Math.floor(box.y + j * sy);
  const y1 = Math.min(box.y + box.h, Math.max(y0 + 1, Math.ceil(box.y + (j + 1) * sy)));
  let best = 0;
  for (let y = Math.max(0, y0); y < Math.min(stamp.h, y1); y++) {
    for (let x = Math.max(0, x0); x < Math.min(stamp.w, x1); x++) {
      const a = stamp.alpha[y * stamp.w + x];
      if (a > best) best = a;
    }
  }
  return best;
}

/**
 * A tiny black-on-white picture of the mask, for the button that loads it.
 * Drawn from stampOffsets rather than from the alpha again, so the thumbnail is
 * literally the thing the brush will do and cannot drift from it.
 */
export function stampPreview(stamp, size = 28) {
  if (!stamp) return null;
  const cells = 21;
  const offs = stampOffsets(stamp, cells);
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = '#000';
  const px = size / cells;
  const mid = Math.floor(cells / 2);
  // offsets are [dx, dy]; centre them in the thumbnail.
  for (const [dx, dy] of offs) {
    const x = (mid + dx) * px;
    const y = (mid + dy) * px;
    if (x < -px || y < -px || x > size || y > size) continue;
    ctx.fillRect(Math.round(x), Math.round(y), Math.ceil(px), Math.ceil(px));
  }
  return c.toDataURL();
}

/**
 * Read a file as a tip. Kept out of the model so the model stays testable.
 * @param {File|Blob} file
 * @returns {Promise<{stamp: object, dataUrl: string}>}
 */
export async function stampFromFile(file) {
  const dataUrl = await new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = () => rej(r.error);
    r.readAsDataURL(file);
  });
  return stampFromDataUrl(dataUrl);
}

/**
 * The same, from a data URL - which is how a tip comes back from the profile
 * store on the next visit, without the player having to pick the file again.
 */
export async function stampFromDataUrl(dataUrl) {
  const img = await new Promise((res, rej) => {
    const i = new Image();
    i.onload = () => res(i);
    i.onerror = () => rej(new Error('not a readable image'));
    i.src = dataUrl;
  });
  // Cap the working size: the mask only ever needs a few hundred pixels, and a
  // 4000px brush photo would sit in memory for the whole session.
  const w = Math.min(256, Math.max(1, img.naturalWidth || img.width));
  const h = Math.min(256, Math.max(1, img.naturalHeight || img.height));
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, w, h);
  const d = ctx.getImageData(0, 0, w, h).data;
  const alpha = new Uint8Array(w * h);
  // Two different things get called a brush tip, and they are read opposite ways:
  // a white shape on a transparent PNG carries its shape in the alpha channel,
  // while a black shape on white - or any JPEG, which has no alpha at all -
  // carries it in how dark it is. Guessing per-pixel ("use alpha if there is
  // any") makes an opaque picture come out as one giant blob, so the decision is
  // made once for the whole image.
  let transparent = 0;
  for (let i = 0; i < w * h; i++) if (d[i * 4 + 3] < 250) transparent++;
  const useAlpha = transparent > w * h * 0.01;
  for (let i = 0; i < w * h; i++) {
    if (useAlpha) {
      alpha[i] = d[i * 4 + 3];
    } else {
      const lum = (d[i * 4] * 0.299 + d[i * 4 + 1] * 0.587 + d[i * 4 + 2] * 0.114) / 255;
      alpha[i] = Math.round((1 - lum) * 255);
    }
  }
  const stamp = makeStamp(w, h, alpha);
  if (!stamp) throw new Error('that image has no shape in it');
  return { stamp, dataUrl };
}
