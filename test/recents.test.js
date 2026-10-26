/**
 * The recent-shades store. Small, but it is the kind of small thing that fails
 * quietly: a phone in private mode has a localStorage that throws on every write,
 * a row left by an older build may not be an array, and index 0 is "empty" rather
 * than a colour. None of those are allowed to become a broken paint app.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  STORAGE_KEY,
  RECENT_MAX,
  clean,
  loadRecents,
  pushRecent,
  saveRecents,
} from '../assets/js/game/recents.js';
import { FLAT_COLORS } from '../assets/js/data/heartopia-palette.js';

/** A store that behaves, records what it was handed. */
function memStore(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
  };
}

/** A store that refuses, the way Safari in private mode does. */
function hostileStore() {
  return {
    getItem() {
      throw new Error('SecurityError');
    },
    setItem() {
      throw new Error('QuotaExceededError');
    },
  };
}

test('a chosen shade goes to the front, and choosing it again does not duplicate it', () => {
  let list = [];
  list = pushRecent(list, 16);
  list = pushRecent(list, 40);
  list = pushRecent(list, 16);
  assert.deepEqual(list, [16, 40], 'most recent first, and 40 is still behind it');
});

test('the row is capped, and the cap is the length the dock is built for', () => {
  let list = [];
  for (let i = 1; i <= 20; i++) list = pushRecent(list, i);
  assert.equal(list.length, RECENT_MAX);
  assert.equal(list[0], 20, 'the newest survived');
  assert.ok(!list.includes(1), 'and the oldest was dropped');
});

test('empty is not a colour and is never remembered', () => {
  // Index 0 is the absence of paint. A "recent" of blank is a swatch nobody
  // meant to come back to, and clicking it would look like the tool broke.
  assert.deepEqual(pushRecent([16, 40], 0), [16, 40]);
});

test('junk entries read as nothing rather than crashing the row', () => {
  const junk = [16, 0, -3, 9999, 2.5, '12', null, undefined, NaN, {}, 40];
  assert.deepEqual(clean(junk), [16, 40], 'in-range integers only');
  assert.deepEqual(clean('not an array'.toUpperCase().split('').map(() => 1)), [1], 'deduped');
});

test('the palette bounds are the palette, not a hard-coded 125', () => {
  const last = FLAT_COLORS.length - 1;
  assert.deepEqual(clean([last, last + 1]), [last], 'the final shade is in, one past it is out');
});

test('a stored row round-trips', () => {
  const store = memStore();
  assert.equal(saveRecents([40, 16], store), true);
  assert.deepEqual(loadRecents(store), [40, 16]);
  assert.ok(store.map.has(STORAGE_KEY), 'under its own key');
});

test('a corrupt, missing or non-array row loads as empty', () => {
  assert.deepEqual(loadRecents(memStore()), [], 'nothing stored');
  assert.deepEqual(loadRecents(memStore({ [STORAGE_KEY]: '{not json' })), [], 'half-written');
  assert.deepEqual(loadRecents(memStore({ [STORAGE_KEY]: '{"a":1}' })), [], 'an object, not a list');
  assert.deepEqual(loadRecents(memStore({ [STORAGE_KEY]: '"16,40"' })), [], 'a bare string');
  assert.deepEqual(loadRecents(memStore({ [STORAGE_KEY]: '[16,"x",40]' })), [16, 40], 'junk inside a good row');
});

test('a store that throws is a missing convenience, not an exception', () => {
  const hostile = hostileStore();
  assert.deepEqual(loadRecents(hostile), [], 'reading it must not throw');
  assert.equal(saveRecents([16], hostile), false, 'and writing it must report failure');
});

test('no store at all is still usable in memory', () => {
  assert.deepEqual(loadRecents(null), []);
  assert.equal(saveRecents([16], null), false);
  // The caller keeps the list in state either way, so the row still works for
  // this session; it simply will not be there next time.
  assert.deepEqual(pushRecent(loadRecents(null), 16), [16]);
});

test('saving cleans what it writes, so a bad list cannot poison the next load', () => {
  const store = memStore();
  saveRecents([16, 16, 0, 9999, 40], store);
  assert.equal(store.map.get(STORAGE_KEY), '[16,40]');
});

test('the key is versioned, so an old shape cannot be read as a new one', () => {
  assert.match(STORAGE_KEY, /v\d+$/, STORAGE_KEY);
});
