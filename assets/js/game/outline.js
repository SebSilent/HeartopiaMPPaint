/*
 * The garment silhouette that belongs to each clothing face.
 *
 * Heartopia's own pattern data carries an outline in cell coordinates for every
 * garment face. It is not grid aligned, so a cell is decided by whether its
 * centre falls inside the polygon.
 */

import { OUTLINE_DATA } from '../data/heartopia-outlines.js';

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
