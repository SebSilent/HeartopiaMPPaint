/*
 * The garment silhouette that belongs to each clothing face.
 *
 * Heartopia's own pattern data carries an outline in cell coordinates for every
 * garment face. It is not grid aligned, so a cell is decided by whether its
 * centre falls inside the polygon.
 */

import { OUTLINE_DATA } from '../data/heartopia-outlines.js';
import { FACE_DATA } from '../data/heartopia-faces.js';
import { maskFor as paintMask } from './faces.js';
import { traceBoundary } from './trace.js';

const cache = new Map();

function pointInRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** @param {string} faceId  the face id from slots.js, not a position */
export function outlineFor(itemId, faceId) {
  const faces = OUTLINE_DATA[itemId];
  if (!faces) return null;
  return faces[faceId] || null;
}

/**
 * The silhouette to draw on the board: the edge of the area you can actually paint.
 *
 * Three sources describe a garment face and none of them agree:
 *   disabledPixels - the cells the game blocks. This is what gates the brush, so it wins.
 *   maskLines      - the catalog's rings for the canvas. A simplification: the trousers
 *                    front is two leg rectangles and the crotch between them is paintable
 *                    but outside both rings.
 *   mesh ring      - one UV island from the mesh header. On a face the game splits in two
 *                    (both trouser legs, both shoe toes, the halves of a cap rear) it
 *                    encloses one half and leaves the other bare - 21-55% of the paintable
 *                    cells with no line around them on ten faces, and this is what the
 *                    board used to draw.
 * Where the game has enumerated the cells the outline is traced straight from them, so the
 * line and the brush cannot disagree by construction. Where it has not - the book, whose
 * maskLines are guides that block nothing - the lines are drawn as guides and never as a
 * limit. tools/outlinecheck.mjs measures the result instead of trusting this claim.
 *
 * outlineFor() still returns the mesh ring, and the 3D preview still wants it: there it
 * clips one panel that really is one island, so it is the correct shape for that job.
 */
export function boardOutline(itemId, faceId) {
  const key = 'board:' + itemId + ':' + faceId;
  if (cache.has(key)) return cache.get(key);
  const f = (FACE_DATA[itemId] || {})[faceId];
  const lines = f && f.rings && f.rings.length ? { w: f.w, h: f.h, rings: f.rings } : null;
  const island = outlineFor(itemId, faceId);
  let pick;
  if (f && f.off) {
    // The game enumerated the cells, so the cells are the truth and the outline is
    // traced straight from them. Both polygon sources are approximations of this
    // shape and each is wrong somewhere: the catalog lines leave out the crotch
    // wedge between the trousers legs and enclose a lamp rim that is paintable
    // right up to its edge, the mesh ring leaves out a whole island.
    const mask = paintMask(itemId, faceId);
    const rings = traceBoundary(mask, f.w, f.h);
    pick = rings.length ? { w: f.w, h: f.h, rings } : { w: f.w, h: f.h, rings: lines ? lines.rings : [island.ring] };
    // Tracing buys accuracy and costs shape. The trousers front is paintable as one
    // 62x94 rectangle, so its true boundary is a rectangle, while the catalog's two
    // leg rings say what the garment actually looks like. That is worth keeping - as
    // a guide, not as a limit - but only where the two shapes genuinely disagree.
    // Within a few percent of the board the lines are just a smudged version of the
    // edge, and drawing both would be a double line for no information.
    if (lines && rings.length) {
      const off = mismatch(mask, f.w, f.h, lines.rings);
      if (off > 0.05 * f.w * f.h) pick.guides = lines.rings;
    }
  } else {
    // No cell list to trace. The only such face in the game is the book, whose
    // maskLines are guides - a spine and two covers - that block no cells at all,
    // so they are drawn as guides and never as a limit on paint.
    pick = lines || island;
    if (lines) pick = { w: lines.w, h: lines.h, guides: lines.rings };
  }
  cache.set(key, pick);
  return pick;
}

/** How many cells a set of rings gets wrong against the paintable mask. */
function mismatch(mask, w, h, rings) {
  let n = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (inRings(rings, x + 0.5, y + 0.5) !== (mask[y * w + x] === 1)) n++;
    }
  }
  return n;
}

function inRings(rings, x, y) {
  let c = false;
  for (const r of rings) {
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const xi = r[i][0];
      const yi = r[i][1];
      const xj = r[j][0];
      const yj = r[j][1];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
    }
  }
  return c;
}

/** 1 where the cell centre is inside the silhouette, 0 outside. */
export function maskFor(itemId, faceId) {
  const key = itemId + ':' + faceId;
  if (cache.has(key)) return cache.get(key);
  const o = outlineFor(itemId, faceId);
  if (!o || !Array.isArray(o.ring) || o.ring.length < 3) {
    cache.set(key, null);
    return null;
  }
  const mask = new Uint8Array(o.w * o.h);
  for (let cy = 0; cy < o.h; cy++) {
    for (let cx = 0; cx < o.w; cx++) {
      mask[cy * o.w + cx] = pointInRing(cx + 0.5, cy + 0.5, o.ring) ? 1 : 0;
    }
  }
  cache.set(key, mask);
  return mask;
}

export function maskInside(mask) {
  let n = 0;
  for (let i = 0; i < mask.length; i++) n += mask[i];
  return n;
}

export function hasOutline(itemId, faceId) {
  return outlineFor(itemId, faceId) !== null;
}
