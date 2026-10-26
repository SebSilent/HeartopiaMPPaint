/*
 * Local board backup. The claim under test is not "it saves" - it is that a
 * rescue can never become a hazard: it must not overwrite a live board, not
 * leak one room's picture into another, not survive past the point it is
 * useful, and above all not crash or corrupt a board when storage itself fails.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  backupKey,
  saveBoard,
  loadBoard,
  clearBackup,
  pruneOldest,
  fitsDesign,
  designIsEmpty,
  savedCount,
  MAX_AGE_MS,
} from '../assets/js/game/backup.js';
import { b64ToBytes, bytesToB64 } from '../assets/js/util.js';
import { Design } from '../assets/js/game/design.js';

/** A localStorage that can be made to misbehave on demand. */
class Store {
  constructor() {
    this.map = new Map();
    this.throwOn = new Set(); // 'set' | 'get' | 'remove'
    this.setFails = 0; // number of setItem calls that should fail first
  }
  _no(op) {
    if (this.throwOn.has(op)) throw new Error(`${op} denied`);
  }
  get length() {
    return this.map.size;
  }
  key(i) {
    return [...this.map.keys()][i] ?? null;
  }
  getItem(k) {
    this._no('get');
    const v = this.map.get(k);
    return v === undefined ? null : v;
  }
  setItem(k, v) {
    this._no('set');
    if (this.setFails > 0) {
      this.setFails--;
      throw Object.assign(new Error('quota'), { name: 'QuotaExceededError' });
    }
    this.map.set(k, String(v));
  }
  removeItem(k) {
    this._no('remove');
    this.map.delete(k);
  }
  /** Write a row behind the module's back, to test what it reads. */
  raw(code, itemId, text) {
    this.map.set(backupKey(code, itemId), text);
  }
}

/** A tshirt with three cells on one face and one on another. */
function painted() {
  const d = new Design('tshirt');
  d.paint([0, 1, 2], 7, 1, 0, 0);
  d.paint([5], 3, 2, 0, 1);
  return d;
}

test('backup: an offline board is keyed by garment, a room by code', () => {
  // Every ?local=1 session is 'LOCAL' - without the item, a hat would overwrite
  // the dress left half-finished in the same sandbox.
  assert.notEqual(backupKey(null, 'tshirt'), backupKey(null, 'book'));
  assert.notEqual(backupKey('LOCAL', 'tshirt'), backupKey('LOCAL', 'book'));
  assert.equal(backupKey('abcd', 'tshirt'), backupKey('abcd', 'book'));
  assert.equal(backupKey('abcd'), backupKey('ABCD'), 'room codes are case-insensitive');
});

test('backup: save, read back, and the picture is the picture', () => {
  const s = new Store();
  const d = painted();
  assert.equal(saveBoard('ROOM1', d.id, d.toSnapshot(), s), true);
  const row = loadBoard('room1', d.id, s);
  assert.ok(row);
  assert.equal(row.item, d.id);
  assert.equal(fitsDesign(row, d), true);
  assert.equal(savedCount(row), 4, 'three cells on one face, one on another');
  assert.equal(designIsEmpty(d), false);
});

test('backup: the decoded cells are exactly what was painted', () => {
  // The restore replays these bytes through the import path, so a cell that
  // came back with the wrong index or the wrong shade would repaint the board
  // wrongly rather than rescue it.
  const s = new Store();
  const d = painted();
  saveBoard('R', d.id, d.toSnapshot(), s);
  const row = loadBoard('R', d.id, s);
  for (let i = 0; i < row.snapshot.faces.length; i++) {
    const got = b64ToBytes(row.snapshot.faces[i].cells);
    const want = d.faces[i].color;
    assert.equal(got.length, want.length, `face ${i} length`);
    for (let c = 0; c < want.length; c++) assert.equal(got[c], want[c], `face ${i} cell ${c}`);
  }
});

test('backup: a board nobody painted is empty, and emptying it again counts', () => {
  assert.equal(designIsEmpty(new Design('tshirt')), true);
  const d = painted();
  assert.equal(designIsEmpty(d), false);
  d.paint([0, 1, 2], 0, 9, 0, 0); // erase back to bare
  d.paint([5], 0, 9, 0, 1);
  assert.equal(designIsEmpty(d), true, 'a cleared board is empty, not "used to be painted"');
});

test('backup: nothing is ever read across rooms', () => {
  const s = new Store();
  const d = painted();
  saveBoard('ROOM-A', d.id, d.toSnapshot(), s);
  assert.equal(loadBoard('ROOM-B', d.id, s), null);
  // Same room, different garment: the key is the room, so it does load - which
  // is why fitsDesign, not the key, is what stops it landing on the wrong board.
  const row = loadBoard('ROOM-A', 'book', s);
  assert.ok(row, 'the row exists');
  assert.equal(fitsDesign(row, new Design('book')), false);
});

test('backup: a row that is not a board reads as no backup', () => {
  const s = new Store();
  const junk = {
    'not json at all': 'half-written by a crash',
    'null': JSON.stringify(null),
    '42': '42',
    '"a string"': '"a string"',
    'no faces': JSON.stringify({ saved: Date.now(), snapshot: {} }),
    'empty faces': JSON.stringify({ saved: Date.now(), snapshot: { faces: [] } }),
    'no timestamp': JSON.stringify({ snapshot: { faces: [{ w: 2, h: 2, cells: '' }] } }),
    'future timestamp': JSON.stringify({ saved: -5, snapshot: { faces: [{ w: 2, h: 2, cells: '' }] } }),
  };
  for (const [name, text] of Object.entries(junk)) {
    s.raw('JUNK', 'tshirt', text);
    assert.equal(loadBoard('JUNK', 'tshirt', s), null, name);
  }
});

test('backup: an old picture is not a rescue', () => {
  const s = new Store();
  const d = painted();
  const snap = d.toSnapshot();
  const row = (age) => JSON.stringify({ saved: Date.now() - age, item: d.id, snapshot: snap });
  s.raw('OLD', d.id, row(MAX_AGE_MS + 60_000));
  assert.equal(loadBoard('OLD', d.id, s), null, 'past its shelf life');
  s.raw('NEW', d.id, row(MAX_AGE_MS - 60_000));
  assert.ok(loadBoard('NEW', d.id, s), 'still useful the day before it expires');
});

test('backup: unreadable storage is no backup, not a crash', () => {
  const s = new Store();
  const d = painted();
  saveBoard('X', d.id, d.toSnapshot(), s);
  s.throwOn.add('get');
  assert.equal(loadBoard('X', d.id, s), null);
  s.throwOn.delete('get');
  s.throwOn.add('remove');
  assert.equal(clearBackup('X', d.id, s), false);
});

test('backup: a store that will not take anything reports failure', () => {
  const s = new Store();
  s.throwOn.add('set');
  const d = painted();
  assert.equal(saveBoard('Q', d.id, d.toSnapshot(), s), false, 'private mode');
  assert.equal(s.map.size, 0);
  // Nothing to prune, so a quota failure is simply a failure.
  s.throwOn.delete('set');
  s.setFails = 1;
  assert.equal(saveBoard('Q', d.id, d.toSnapshot(), s), false, 'quota with no old boards to drop');
});

test('backup: when the quota is full the oldest picture goes, once', () => {
  const s = new Store();
  const d = painted();
  const snap = d.toSnapshot();
  // Two boards already parked, one clearly older, plus a key that is not ours.
  s.setItem(backupKey('OLD1', d.id), JSON.stringify({ saved: 1000, snapshot: snap }));
  s.setItem(backupKey('OLD2', d.id), JSON.stringify({ saved: 9000, snapshot: snap }));
  s.setItem('hmpaint.profile', 'do not touch me');
  s.setFails = 1; // the first attempt at the new board is refused
  assert.equal(saveBoard('NEW', d.id, snap, s), true, 'pruned and retried');
  assert.equal(s.getItem('hmpaint.profile'), 'do not touch me', 'foreign keys are never pruned');
  assert.equal(s.getItem(backupKey('OLD1', d.id)), null, 'the oldest went');
  assert.ok(s.getItem(backupKey('OLD2', d.id)), 'the newer one stayed');
  assert.ok(loadBoard('NEW', d.id, s), 'and the new board is readable');
});

test('backup: a blank board never overwrites a picture worth rescuing', () => {
  // The decline path. The player was offered their board back and said no; the
  // empty canvas they are now staring at must not delete the only copy of it.
  const s = new Store();
  const d = painted();
  saveBoard('D', d.id, d.toSnapshot(), s);
  const blank = new Design('tshirt');
  assert.equal(saveBoard('D', blank.id, blank.toSnapshot(), s), false, 'refused');
  const row = loadBoard('D', d.id, s);
  assert.ok(row, 'the rescue is still there');
  assert.equal(savedCount(row), 4, 'and still the whole picture');
});

test('backup: a blank board is still savable when there is nothing to lose', () => {
  const s = new Store();
  const blank = new Design('tshirt');
  assert.equal(saveBoard('E', blank.id, blank.toSnapshot(), s), true, 'nothing parked, nothing protected');
  assert.equal(savedCount(loadBoard('E', blank.id, s)), 0);
  // Once the protected picture is deliberately forgotten, blanks write again.
  const d = painted();
  saveBoard('F', d.id, d.toSnapshot(), s);
  assert.equal(saveBoard('F', blank.id, blank.toSnapshot(), s), false);
  clearBackup('F', d.id, s);
  assert.equal(saveBoard('F', blank.id, blank.toSnapshot(), s), true);
});

test('backup: painting over an old picture replaces it', () => {
  const s = new Store();
  const first = painted();
  saveBoard('G', first.id, first.toSnapshot(), s);
  const second = new Design('tshirt');
  second.paint([40], 5, 3, 0, 2);
  assert.equal(saveBoard('G', second.id, second.toSnapshot(), s), true, 'real paint wins');
  const row = loadBoard('G', second.id, s);
  assert.equal(savedCount(row), 1);
  assert.equal(row.snapshot.faces[2].cells, second.faces[2].cellsB64());
});

test('backup: pruning has nothing to say when there is nothing of ours', () => {
  const s = new Store();
  s.setItem('hmpaint.profile', 'x');
  s.setItem('unrelated', 'y');
  assert.equal(pruneOldest(s), false);
  assert.equal(s.length, 2, 'and it left both alone');
});

test('backup: clearBackup forgets, and forgetting is idempotent', () => {
  const s = new Store();
  const d = painted();
  saveBoard('C', d.id, d.toSnapshot(), s);
  assert.equal(clearBackup('C', d.id, s), true);
  assert.equal(loadBoard('C', d.id, s), null);
  assert.equal(clearBackup('C', d.id, s), true, 'clearing what is already gone is not an error');
});

test('backup: fitsDesign refuses a board that is not this board', () => {
  const s = new Store();
  const d = painted();
  saveBoard('F', d.id, d.toSnapshot(), s);
  const row = loadBoard('F', d.id, s);
  assert.equal(fitsDesign(row, new Design('dress')), false, 'different garment');
  const wrongCount = structuredClone(row);
  wrongCount.snapshot.faces.pop();
  assert.equal(fitsDesign(wrongCount, d), false, 'fewer faces than the board has');
  const wrongSize = structuredClone(row);
  wrongSize.snapshot.faces[0].w += 8;
  assert.equal(fitsDesign(wrongSize, d), false, 'a face of the wrong shape');
  assert.equal(fitsDesign(null, d), false);
  assert.equal(fitsDesign(row, null), false);
});

test('backup: junk cell data counts as nothing painted', () => {
  // savedCount is what the offer quotes, and what gates the offer at all.
  const snap = { item: 'tshirt', faces: [{ w: 4, h: 4, cells: '@@@@not-base64@@@@' }] };
  assert.equal(savedCount({ saved: Date.now(), snapshot: snap }), 0);
  assert.equal(savedCount({ saved: Date.now(), snapshot: { faces: [{ w: 4, h: 4 }] } }), 0);
  assert.equal(savedCount(null), 0);
  // A real all-zero board is also zero, and a real one is not.
  assert.equal(savedCount({ saved: Date.now(), snapshot: { faces: [{ w: 4, h: 4, cells: bytesToB64(new Uint8Array(16)) }] } }), 0);
  const cells = new Uint8Array(16).fill(3);
  assert.equal(savedCount({ saved: Date.now(), snapshot: { faces: [{ w: 4, h: 4, cells: bytesToB64(cells) }] } }), 16);
});
