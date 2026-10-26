/**
 * The shades this player reached for last.
 *
 * A small thing that changes how the dock feels: Heartopia has 125 shades in 13
 * groups, and a person painting a duvet lives in three of them. Without a recent
 * row every return to that green is a group click and a hunt.
 *
 * It is kept in its own key rather than in the profile, because the profile is
 * written whole by more than one call site - `saveProfile({ nick, color, device })`
 * replaces the object, it does not merge - so a field added there is quietly lost
 * the next time someone joins a room. Storage is injected for the same reason the
 * backup module injects it: a phone in private mode has a localStorage that throws
 * on write, and that has to be a missing convenience, not a broken paint app.
 *
 * Nothing here is room state. Recent shades are a fact about one person's hand,
 * not about the board, so they never cross the wire and cannot make two boards
 * disagree.
 */

import { FLAT_COLORS } from '../data/heartopia-palette.js';

const KEY = 'heartopia.recents.v1';

/** Eight is a row that fits the dock without becoming a second palette. */
export const RECENT_MAX = 8;

function resolve(store) {
  return store !== undefined ? store : globalThis.localStorage;
}

/**
 * A list of palette indices, most recent first, or an empty list.
 *
 * Anything unusable reads as nothing: a store that throws, a row that is not an
 * array, an entry that is not an in-range integer. Index 0 is empty - the absence
 * of a colour - and is dropped, because a "recent" of blank is not a shade
 * anybody meant to come back to.
 */
export function loadRecents(store) {
  const s = resolve(store);
  if (!s) return [];
  let raw;
  try {
    raw = JSON.parse(s.getItem(KEY) || '[]');
  } catch (_) {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  return clean(raw);
}

/** Write the list. False means it did not land, and the caller keeps going. */
export function saveRecents(list, store) {
  const s = resolve(store);
  if (!s) return false;
  try {
    s.setItem(KEY, JSON.stringify(clean(Array.isArray(list) ? list : [])));
    return true;
  } catch (_) {
    // Quota, or private mode refusing the write. The row still works for this
    // session from memory; it just will not be there next time.
    return false;
  }
}

/**
 * Put `idx` at the front of the list and return the new list.
 *
 * Pure - the caller reassigns, so a UI redraw can never be looking at a half
 * updated array. Choosing a shade you already chose moves it up rather than
 * adding a duplicate, which is what "recent" means.
 */
export function pushRecent(list, idx, max = RECENT_MAX) {
  const next = clean([idx, ...(Array.isArray(list) ? list : [])]);
  return next.slice(0, Math.max(1, max | 0));
}

/** Valid, deduped, in order, no empty. Shared by load and save so neither can
 *  be more trusting than the other. */
export function clean(list) {
  const out = [];
  for (const v of list) {
    if (typeof v !== 'number' || !Number.isInteger(v)) continue;
    if (v <= 0 || v >= FLAT_COLORS.length) continue;
    if (out.includes(v)) continue;
    out.push(v);
  }
  return out;
}

export const STORAGE_KEY = KEY;
