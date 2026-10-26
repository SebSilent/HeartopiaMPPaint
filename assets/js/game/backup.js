/*
 * Local board backup.
 *
 * A crash, a swallowed tab or a phone reclaiming the page should not cost a
 * picture. The board is copied into localStorage once a change settles, and
 * offered back when you come to the same room and find it empty.
 *
 * It is a rescue, not a second source of truth. The room is the truth, so a
 * backup is only ever applied to a board nothing has painted - never to a room
 * that already has a picture on it, and never silently over someone else's.
 *
 * Storage is injected so this can be tested without a browser, and every call
 * is wrapped: private mode, a full quota or a corrupted row must degrade into
 * "no backup", never into a broken board.
 */

import { b64ToBytes } from '../util.js';

const PREFIX = 'hmpaint.board.v1.';

/** Past this age a backup is a stale picture, not a rescue. Two weeks. */
export const MAX_AGE_MS = 1000 * 60 * 60 * 24 * 14;

function store_(store) {
  return store !== undefined ? store : globalThis.localStorage;
}

/**
 * The key a board is kept under.
 *
 * An offline board has no room code to hang on - every `?local=1` session is
 * 'LOCAL' - so it hangs on the garment instead. Otherwise painting a hat would
 * overwrite the dress you left half-finished in the same sandbox.
 */
export function backupKey(code, itemId) {
  const c = String(code || 'LOCAL').toUpperCase();
  return PREFIX + (c === 'LOCAL' ? `LOCAL:${itemId || '?'}` : c);
}

/** Store a board. Returns false when the browser will not take it. */
export function saveBoard(code, itemId, snapshot, store) {
  const s = store_(store);
  if (!s || !snapshot) return false;
  const key = backupKey(code, itemId);
  // An empty board never overwrites a picture that is still worth rescuing.
  // This is the decline path: the player was offered their board back, said no,
  // and the blank canvas they are now looking at must not silently delete the
  // only copy. A deliberate clear is not this - it calls clearBackup.
  if (!snapshotPainted(snapshot)) {
    const existing = loadBoard(code, itemId, s);
    if (existing && savedCount(existing)) return false;
  }
  const body = JSON.stringify({ saved: Date.now(), item: snapshot.item, snapshot });
  try {
    s.setItem(key, body);
    return true;
  } catch (err) {
    // Almost always QuotaExceededError. Give up the oldest boards and try once
    // more; if that still fails, this board simply is not backed up.
    if (pruneOldest(s, key)) {
      try {
        s.setItem(key, body);
        return true;
      } catch (_) {}
    }
    return false;
  }
}

/** Read a board back, or null when there is nothing usable. */
export function loadBoard(code, itemId, store) {
  const s = store_(store);
  if (!s) return null;
  let raw = null;
  try {
    raw = s.getItem(backupKey(code, itemId));
  } catch (_) {
    return null;
  }
  if (!raw) return null;
  try {
    const row = JSON.parse(raw);
    if (!row || typeof row !== 'object') return null;
    const s_ = row.snapshot;
    if (!s_ || !Array.isArray(s_.faces) || !s_.faces.length) return null;
    if (!(row.saved > 0) || Date.now() - row.saved > MAX_AGE_MS) return null;
    return row;
  } catch (_) {
    return null; // a half-written row is not a board
  }
}

/** Forget a board's backup, e.g. after the player deliberately clears it. */
export function clearBackup(code, itemId, store) {
  const s = store_(store);
  if (!s) return false;
  try {
    s.removeItem(backupKey(code, itemId));
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Drop the oldest backups to make room. Returns true if anything went away.
 * Only ever touches this module's own keys.
 */
export function pruneOldest(store, exceptKey) {
  const s = store_(store);
  if (!s) return false;
  const rows = [];
  try {
    for (let i = 0; i < s.length; i++) {
      const k = s.key(i);
      if (!k || !k.startsWith(PREFIX) || k === exceptKey) continue;
      let saved = 0;
      try {
        saved = JSON.parse(s.getItem(k) || '{}').saved || 0;
      } catch (_) {}
      rows.push([k, saved]);
    }
  } catch (_) {
    return false;
  }
  if (!rows.length) return false;
  rows.sort((a, b) => a[1] - b[1]);
  try {
    s.removeItem(rows[0][0]);
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Would this snapshot land cleanly on this design?
 *
 * Design.applySnapshot throws when the face count or any face's size disagrees
 * with the item it is loaded onto, and it only rebuilds the design for an item
 * it can find in the catalogue. A backup taken on another build's garment could
 * therefore half-apply, which is exactly the kind of desync this file is trying
 * not to cause - so the shape is checked here, before anything is written.
 */
export function fitsDesign(row, design) {
  const s = row && row.snapshot;
  if (!s || !design) return false;
  if (s.item !== design.id) return false;
  if (!Array.isArray(s.faces) || s.faces.length !== design.faces.length) return false;
  for (let i = 0; i < s.faces.length; i++) {
    const f = s.faces[i];
    const g = design.faces[i];
    if (!f || f.w !== g.w || f.h !== g.h) return false;
  }
  return true;
}

/** Does the board have nothing on it? A backup never competes with paint. */
export function designIsEmpty(design) {
  if (!design) return true;
  for (const g of design.faces) if (!g.isEmpty()) return false;
  return true;
}

/** How many cells the saved picture has painted, for the offer's wording. */
export function savedCount(row) {
  return snapshotPainted(row && row.snapshot);
}

/** How many cells a snapshot has painted. Junk base64 reads as unpainted. */
export function snapshotPainted(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.faces)) return 0;
  let n = 0;
  for (const f of snapshot.faces) n += decodeCount(f.cells);
  return n;
}

/** base64 cell buffer -> the painted-cell count. A row this fails on is junk. */
function decodeCount(b64) {
  try {
    const cells = b64ToBytes(b64 || '');
    let n = 0;
    for (let i = 0; i < cells.length; i++) if (cells[i]) n++;
    return n;
  } catch (_) {
    return 0;
  }
}
