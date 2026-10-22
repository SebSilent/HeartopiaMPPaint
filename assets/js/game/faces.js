// The game's own per-face silhouette for every design slot.
//
// Two things the game ships for each face, both in cell coordinates:
//   mask  - the boundary polygon, as one or more rings of {x, y} points
//   off   - every cell the game refuses to paint ("disabledPixels"), stored as
//           horizontal runs: "x:len" per run, ";" between rows
//
// The polygon is the outline you see; the cell list is the authority, because
// it is exactly what the game blocks. Free canvas boards have neither: they are
// plain rectangles.
import { FACE_DATA } from '../data/heartopia-faces.js';

const cache = new Map();

/**
 * Mark the disabled runs of one row into the mask.
 * "x:len,x:len" - an empty string means the whole row is paintable.
 */
function decodeRow(row, y, w, m) {
  if (!row) return;
  for (const run of row.split(',')) {
    const i = run.indexOf(':');
    const x = Number(run.slice(0, i));
    const len = Number(run.slice(i + 1));
    if (!Number.isFinite(x) || !Number.isFinite(len)) continue;
    for (let k = 0; k < len; k++) {
      const cx = x + k;
      if (cx >= 0 && cx < w) m[y * w + cx] = 0;
    }
  }
}

export function faceInfo(itemId, faceId) {
  const f = (FACE_DATA[itemId] || {})[faceId];
  return f || null;
}

export function hasFaceOutline(itemId, faceId) {
  const f = faceInfo(itemId, faceId);
  return !!f && ((f.rings && f.rings.length) || (f.off && f.off.length)) > 0;
}

/**
 * Boundary rings in cell coordinates, ready to stroke.
 * @returns {Array<Array<[number,number]>>}
 */
export function ringsFor(itemId, faceId) {
  const f = faceInfo(itemId, faceId);
  if (!f || !f.rings) return [];
  return f.rings;
}

/** 1 where the cell is paintable, 0 where the game disables it. */
export function maskFor(itemId, faceId) {
  const key = itemId + ':' + faceId;
  if (cache.has(key)) return cache.get(key);
  const f = faceInfo(itemId, faceId);
  if (!f) {
    cache.set(key, null);
    return null;
  }
  const m = new Uint8Array(f.w * f.h).fill(1);
  if (f.off) {
    const rows = typeof f.off === 'string' ? f.off.split(';') : [];
    for (let y = 0; y < rows.length && y < f.h; y++) decodeRow(rows[y], y, f.w, m);
  }
  cache.set(key, m);
  return m;
}

/** Cells the player can actually paint. */
export function paintable(itemId, faceId) {
  const m = maskFor(itemId, faceId);
  if (!m) return 0;
  let n = 0;
  for (let i = 0; i < m.length; i++) n += m[i];
  return n;
}
