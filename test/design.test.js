/*
 * Multi-face state: the Design, the room's face axis, and undo.
 *
 * The property that matters is that a room converges. Two peers that see the
 * same packets in a different order must end with byte-identical grids on
 * every face, because the checksum that detects drift is computed over all of
 * them at once.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Design, SingleFaceDesign } from '../assets/js/game/design.js';
import {
  CLOTHING,
  FURNITURE,
  BOOK,
  CATALOG,
  FAMILIES,
  findItem,
  cellTotal,
  itemIdForBoard,
  boardForItem,
} from '../assets/js/game/slots.js';
import { History, newPatch, patchAdd, sealPatch, finishCapture } from '../assets/js/game/history.js';
import { GRID_DIMENSIONS } from '../assets/js/presets.js';
import { Room } from '../assets/js/net/room.js';
import { indicesToB64, b64ToIndices, bytesToB64 } from '../assets/js/util.js';
import { Grid } from '../assets/js/game/grid.js';

/* ---------------- the catalogue ---------------- */

test('every clothing item has the faces the game has', () => {
  const expected = {
    tshirt: [[64, 80], [64, 80], [64, 48], [64, 48]],
    tank: [[64, 64], [64, 64]],
    sweat: [[80, 88], [80, 88], [130, 70]],
    dress: [[102, 154], [76, 154], [168, 102]],
    skirt: [[128, 64], [128, 64]],
    shorts: [[102, 64], [102, 64]],
    trousers: [[80, 116], [80, 116]],
    bucket: [[126, 78], [126, 78], [100, 100]],
    cap: [[54, 60], [128, 62], [62, 52]],
    shoes: [[100, 90], [120, 60], [60, 60]],
    maryjanes: [[78, 64], [108, 64]],
  };
  assert.equal(CLOTHING.length, 11);
  for (const [id, sizes] of Object.entries(expected)) {
    const item = findItem(id);
    assert.ok(item, `${id} exists`);
    assert.deepEqual(item.faces.map((f) => [f.w, f.h]), sizes, id);
  }
});

test('every furniture item and the book have the faces the game has', () => {
  const expected = {
    bed1: [[200, 130], [200, 98]],
    bed2: [[256, 128], [256, 110]],
    sofa2: [[200, 110], [200, 110]],
    sofa1: [[60, 60], [60, 70]],
    wardrobe: [[128, 128]],
    nightstand: [[128, 128]],
    lowtable: [[128, 128]],
    chair: [[54, 28], [54, 28], [54, 54]],
    tablelamp: [[80, 46], [80, 46], [128, 28]],
    floorlamp: [[80, 52], [80, 52], [128, 16]],
    book: [[150, 114], [150, 84]],
  };
  assert.equal(FURNITURE.length, 10);
  for (const [id, sizes] of Object.entries(expected)) {
    const item = findItem(id);
    assert.ok(item, `${id} exists`);
    assert.deepEqual(item.faces.map((f) => [f.w, f.h]), sizes, id);
  }
  assert.equal(BOOK.faces.length, 2);
  assert.equal(BOOK.zones.length, 3);
});

test('face totals match the published cell counts', () => {
  assert.equal(cellTotal(findItem('tshirt')), 16384);
  assert.equal(cellTotal(findItem('dress')), 44548, 'the biggest garment');
  assert.equal(cellTotal(findItem('cap')), 14400);
  assert.equal(cellTotal(findItem('bed2')), 60928, 'the biggest furniture face set');
  assert.equal(cellTotal(findItem('floorlamp')), 10368);
});

test('every catalogue entry is a real, resolvable item with faces', () => {
  // The canvas family used to be a hand-rolled {id, ratio} stub with no faces
  // and an id findItem() could not resolve. It crashed the design picker, and
  // no test caught it because every other test built ids through
  // itemIdForBoard() instead of reading CATALOG.
  for (const family of FAMILIES) {
    assert.ok(CATALOG[family].length, `${family} has items`);
    for (const item of CATALOG[family]) {
      assert.ok(Array.isArray(item.faces) && item.faces.length, `${item.id} needs faces`);
      for (const f of item.faces) {
        assert.ok(f.w > 0 && f.h > 0, `${item.id} face size`);
        assert.ok(typeof f.label === 'string' && f.label, `${item.id} face label`);
      }
      const back = findItem(item.id);
      assert.ok(back, `findItem('${item.id}') must resolve`);
      assert.equal(back.faces.length, item.faces.length, item.id);
      assert.equal(item.family, family, item.id);
    }
  }
});

test('a canvas card still offers all four sizes', () => {
  // The picker shows one card per ratio; the level is chosen next to it.
  assert.equal(CATALOG.canvas.length, 5);
  for (const card of CATALOG.canvas) {
    for (let level = 0; level < 4; level++) {
      const id = itemIdForBoard(card.ratio, level);
      const item = findItem(id);
      assert.ok(item, id);
      assert.deepEqual([item.faces[0].w, item.faces[0].h], GRID_DIMENSIONS[card.ratio][level], id);
    }
  }
});

test('a canvas maps both ways through ratio and level', () => {
  for (const ratio of ['16:9', '4:3', '1:1', '3:4', '9:16']) {
    for (let level = 0; level < 4; level++) {
      const id = itemIdForBoard(ratio, level);
      const item = findItem(id);
      assert.equal(item.family, 'canvas', id);
      assert.equal(item.faces.length, 1);
      assert.deepEqual(boardForItem(id), { ratio, level });
    }
  }
  assert.equal(findItem('canvas-99:99-1'), null, 'an unknown ratio is not a design');
});

/* ---------------- the design ---------------- */

test('a design is one grid per face', () => {
  const d = new Design('tshirt');
  assert.equal(d.faces.length, 4);
  assert.deepEqual(d.faces.map((g) => [g.w, g.h]), [[64, 80], [64, 80], [64, 48], [64, 48]]);
  assert.equal(d.active, 0);
  assert.equal(d.grid, d.faces[0]);
  assert.equal(d.w, 64);
});

test('painting targets the active face and nothing else', () => {
  const d = new Design('tshirt');
  d.paint([0], 7, 1, 1);
  assert.equal(d.faces[0].color[0], 7);
  for (let i = 1; i < 4; i++) assert.equal(d.faces[i].color[0], 0, `face ${i} untouched`);
  d.setActive(2);
  d.paint([0], 9, 2, 1);
  assert.equal(d.faces[2].color[0], 9);
  assert.equal(d.faces[0].color[0], 7, 'the first face keeps its paint');
});

test('switching faces wraps and clamps', () => {
  const d = new Design('cap');
  assert.equal(d.setActive(3).id, 'front', 'past the end wraps to the start');
  assert.equal(d.setActive(-1).id, 'brim', 'and before the start wraps to the end');
});

test('the checksum covers every face', () => {
  const a = new Design('tshirt');
  const b = new Design('tshirt');
  assert.equal(a.checksum(), b.checksum(), 'two empty T-shirts agree');
  a.paint([0], 5, 1, 1, 3); // only the right sleeve
  assert.notEqual(a.checksum(), b.checksum(), 'a change on any face is a change to the design');
});

test('usage counts across faces', () => {
  const d = new Design('tshirt');
  d.paint([0, 1], 4, 1, 1, 0);
  d.setActive(1);
  d.paint([0], 4, 2, 1);
  d.paint([5], 9, 3, 1);
  const u = d.usage();
  assert.equal(u.get(4), 3, 'two shades on one face, one on another');
  assert.equal(u.get(9), 1);
  assert.equal(d.usedCells(), 4);
});

test('a snapshot round-trips every face', () => {
  const src = new Design('dress');
  src.paint([0, 1, 2], 11, 1, 1, 0);
  src.setActive(1);
  src.paint([40], 12, 2, 1);
  src.setActive(2);
  src.paint([100], 13, 3, 1);
  const wire = JSON.parse(JSON.stringify(src.toSnapshot(9)));

  const dst = new Design(itemIdForBoard('1:1', 1));
  dst.applySnapshot(wire);
  assert.equal(dst.id, 'dress', 'the room owns the item, not whatever we picked');
  assert.equal(dst.faces.length, 3);
  assert.equal(dst.checksum(), src.checksum());
  for (let i = 0; i < 3; i++) assert.deepEqual([...dst.faces[i].color], [...src.faces[i].color]);
});

test('a snapshot naming an item we do have rebuilds us to it', () => {
  // This is the join path: a guest picks a T-shirt, the room is a dress.
  const src = new Design('tshirt');
  src.paint([0], 3, 1, 1);
  const dst = new Design('tank');
  dst.applySnapshot(JSON.parse(JSON.stringify(src.toSnapshot())));
  assert.equal(dst.id, 'tshirt');
  assert.equal(dst.faces.length, 4);
});

test('a snapshot with no item and the wrong face count is refused', () => {
  // Without an item name there is nothing to rebuild towards, and half-adopting
  // a picture of unknown shape is how a room ends up permanently desynced.
  const src = new Design('tshirt');
  src.paint([0], 3, 1, 1);
  const wire = JSON.parse(JSON.stringify(src.toSnapshot()));
  delete wire.item;
  const dst = new Design('tank'); // 2 faces, not 4
  assert.throws(() => dst.applySnapshot(wire), /faces/);
});

test('a face of the wrong size is refused rather than half-applied', () => {
  const src = new Design('tank');
  const wire = JSON.parse(JSON.stringify(src.toSnapshot()));
  wire.faces[0].w = 65;
  const dst = new Design('tank');
  assert.throws(() => dst.applySnapshot(wire), /65x64/);
});

test('an empty or malformed snapshot throws instead of blanking the board', () => {
  const d = new Design('tshirt');
  d.paint([0], 5, 1, 1);
  assert.throws(() => d.applySnapshot({}));
  assert.throws(() => d.applySnapshot({ faces: [] }));
  assert.equal(d.faces[0].color[0], 5, 'the board survived the bad packet');
});

test('SingleFaceDesign speaks the same face axis', () => {
  const g = new Grid(10, 10);
  const d = new SingleFaceDesign(g);
  assert.equal(d.faceAt(0), g);
  assert.equal(d.faceAt(1), null);
  assert.equal(d.paint([0], 4, 1, 1, 0), 1);
  assert.equal(d.paint([1], 4, 1, 1, 5), 0, 'a write to a face that does not exist does nothing');
  assert.equal(d.w, 10);
});

/* ---------------- the room's face axis ---------------- */

function room(clientId, item = 'tshirt') {
  const r = new Room({ code: 'T', me: { clientId, nick: clientId, color: '#fff', device: 'desktop' }, item });
  r.me.slot = 1;
  return r;
}

test('an op lands on the face it names', () => {
  const a = room('a');
  a.handle({ k: 'op', from: 'b', slot: 2, f: 2, c: 8, seq: 3, cells: indicesToB64([0, 1]) }, 'link');
  assert.equal(a.design.faces[2].color[0], 8);
  assert.equal(a.design.faces[0].color[0], 0);
});

test('an op with no face goes to the first one, not to whatever is on screen', () => {
  // An older peer, or a hand-built packet. Defaulting to the *local* active
  // face would put someone else's pixels on a random face of ours.
  const a = room('a');
  a.design.setActive(3);
  a.handle({ k: 'op', from: 'b', slot: 2, c: 6, seq: 3, cells: indicesToB64([0]) }, 'link');
  assert.equal(a.design.faces[0].color[0], 6, 'face 0');
  assert.equal(a.design.faces[3].color[0], 0, 'the face we happen to be looking at');
});

test('a face index out of range is clamped, not trusted', () => {
  const a = room('a');
  a.handle({ k: 'op', from: 'b', slot: 2, f: 99, c: 5, seq: 1, cells: indicesToB64([0]) }, 'link');
  assert.equal(a.design.faces[3].color[0], 5, 'the last face took it');
  assert.equal(a.design.faces.length, 4);
});

test('two peers converge on every face', () => {
  const a = room('a');
  const b = room('b');
  const packets = [
    { k: 'op', from: 'x', slot: 4, f: 0, c: 3, seq: 5, cells: indicesToB64([0, 1, 2]) },
    { k: 'op', from: 'y', slot: 5, f: 1, c: 4, seq: 6, cells: indicesToB64([10]) },
    { k: 'op', from: 'x', slot: 4, f: 3, c: 7, seq: 2, cells: indicesToB64([3]) },
    { k: 'op', from: 'y', slot: 5, f: 3, c: 9, seq: 8, cells: indicesToB64([3, 4]) },
  ];
  for (const p of packets) a.handle(p, 'l');
  for (const p of [...packets].reverse()) b.handle(p, 'l');
  assert.equal(a.design.checksum(), b.design.checksum(), 'same picture, different order');
  for (let f = 0; f < 4; f++) {
    assert.deepEqual([...a.design.faces[f].color], [...b.design.faces[f].color], `face ${f} byte-identical`);
  }
});

test('changing the item replaces every face for the room', () => {
  const a = room('a');
  a.design.paint([0], 4, 1, 1, 0);
  let seen = null;
  a.on('design', (d) => (seen = d));
  a.handle({ k: 'design', from: 'b', slot: 2, seq: 9, item: 'bed2' }, 'link');
  assert.equal(a.design.id, 'bed2');
  assert.equal(a.design.faces.length, 2);
  assert.deepEqual(boardForItem(a.design.id), null, 'furniture has no ratio');
  assert.ok(seen);
  assert.equal(a.design.usedCells(), 0, 'a new item starts blank');
});

test('an unknown item on the wire is ignored', () => {
  const a = room('a');
  a.design.paint([0], 4, 1, 1, 0);
  a.handle({ k: 'design', from: 'b', slot: 2, seq: 9, item: 'spaceship' }, 'link');
  assert.equal(a.design.id, 'tshirt', 'we keep what we had');
  assert.equal(a.design.faces[0].color[0], 4);
});

test('a legacy board resize still moves the whole room', () => {
  const a = room('a');
  a.handle({ k: 'board', from: 'b', slot: 2, seq: 4, ratio: '16:9', level: 2 }, 'link');
  assert.equal(a.design.id, 'canvas-16:9-2');
  assert.deepEqual([a.design.w, a.design.h], [100, 56]);
});

test('block progress is delivered per face', () => {
  const a = room('a');
  const got = [];
  a.on('blocks', (e) => got.push(e));
  const flags = Uint8Array.from([1, 0, 1, 1]);
  a.handle({ k: 'blocks', from: 'b', slot: 2, f: 1, flags: bytesToB64(flags) }, 'link');
  assert.equal(got.length, 1);
  assert.equal(got[0].face, 1);
  assert.deepEqual([...got[0].flags], [1, 0, 1, 1]);
});

test('a corrupt block blob is dropped, not thrown', () => {
  const a = room('a');
  a.handle({ k: 'blocks', from: 'b', slot: 2, f: 0, flags: 'not base64 !!!' }, 'link');
  assert.ok(true, 'the room is still standing');
});

test('pointers carry the face, so a cursor is never drawn on the wrong one', () => {
  const a = room('a');
  const got = [];
  a.on('ptr', (e) => got.push(e));
  a.handle({ k: 'ptr', from: 'b', slot: 2, f: 2, p: [[1, 3, 4, 'mouse', 1]] }, 'link');
  assert.equal(got[0].face, 2);
});

test('the snapshot the host answers with contains every face', () => {
  const a = room('a');
  a.authority = true;
  a.design.paint([0], 6, 1, 1, 2);
  const snap = a.design.toSnapshot(a.lamport);
  assert.equal(snap.faces.length, 4);
  assert.equal(snap.item, 'tshirt');
  const b = room('b');
  b.handle({ k: 'snapshot', from: 'a', ...JSON.parse(JSON.stringify(snap)) }, 'link');
  assert.equal(b.design.faces[2].color[0], 6);
  assert.equal(b.design.checksum(), a.design.checksum());
});

/* ---------------- undo ---------------- */

test('a patch records each cell once, at its original value', () => {
  const g = new Grid(4, 4);
  const d = new SingleFaceDesign(g);
  g.paint([0], 3, 1, 1);
  const p = newPatch(0);
  patchAdd(p, d, [0, 1]);
  patchAdd(p, d, [0, 1, 2]); // the brush crosses the same cells again
  assert.deepEqual(p.indices, [0, 1, 2], 'no duplicates');
  assert.deepEqual([...p.before], [3, 0, 0], 'and the value from before the stroke');
});

test('undo reverses a whole stroke as one write', () => {
  const g = new Grid(4, 4);
  const d = new SingleFaceDesign(g);
  g.paint([0], 3, 1, 1);
  const p = newPatch(0);
  patchAdd(p, d, [0, 1]);
  g.paint([0, 1], 8, 2, 1);
  const sealed = sealPatch(p);
  finishCapture(d, sealed);
  assert.deepEqual([...sealed.to], [8, 8]);
  assert.deepEqual([...sealed.from], [3, 0]);

  const h = new History();
  h.push(sealed);
  // undo() hands back `values`: the bytes to paint, which for an undo are the
  // ones that were there before the stroke.
  const back = h.undo();
  assert.deepEqual([...back.values], [3, 0], 'undo hands back what was there');
  assert.deepEqual([...back.indices], [0, 1]);
  assert.equal(back.face, 0);
});

test('sealing does not break the stroke still being painted into', () => {
  // Regression: sealPatch used to mutate the live patch and delete its dedupe
  // set, so the second batch of a stroke threw. Every stroke flushes early.
  const g = new Grid(8, 1);
  const d = new SingleFaceDesign(g);
  const p = newPatch(0);
  patchAdd(p, d, [0]);
  const sealed = sealPatch(p);
  assert.equal(sealed.from.length, 1);
  patchAdd(p, d, [1]); // still alive
  patchAdd(p, d, [1, 2]);
  assert.deepEqual(p.indices, [0, 1, 2]);
});

test('redo re-applies, and a new stroke clears the redo stack', () => {
  const h = new History();
  h.push({ face: 0, indices: [1], from: Uint8Array.from([2]), to: Uint8Array.from([5]) });
  assert.equal(h.undo().values[0], 2, 'undo paints the older value');
  assert.equal(h.redo().values[0], 5, 'redo paints the newer one back');
  h.push({ face: 0, indices: [2], from: Uint8Array.from([0]), to: Uint8Array.from([1]) });
  assert.equal(h.canRedo, false, 'you cannot redo across a new action');
});

test('an empty patch is never recorded', () => {
  const h = new History();
  h.push({ face: 0, indices: [], from: new Uint8Array(0), to: new Uint8Array(0) });
  assert.equal(h.canUndo, false);
});

test('the history is bounded', () => {
  const h = new History(3);
  for (let i = 0; i < 10; i++) h.push({ face: 0, indices: [i], from: Uint8Array.from([1]), to: Uint8Array.from([2]) });
  assert.equal(h.past.length, 3);
  assert.equal(h.past[0].indices[0], 7, 'the oldest strokes fall out');
});
