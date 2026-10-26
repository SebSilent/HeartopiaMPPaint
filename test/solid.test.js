// Which items have a 3D preview, and which do not. The toolbar greys its 3D
// button off from this, so getting it wrong either hides a preview that works or
// opens an empty panel.
import test from 'node:test';
import assert from 'node:assert/strict';

import { sourceFor, has3d, loadSolid } from '../assets/js/game/solid.js';
import { CLOTHING } from '../assets/js/game/slots.js';
import { BOOK } from '../assets/js/game/slots.js';

if (typeof globalThis.atob !== 'function') {
  globalThis.atob = (s) => Buffer.from(s, 'base64').toString('binary');
}

test('every garment claims a mesh', () => {
  for (const item of CLOTHING) assert.equal(sourceFor(item.id), 'mesh', item.id);
});

test('the book is the procedural solid', () => {
  assert.equal(sourceFor(BOOK.id), 'solid');
  assert.ok(has3d(BOOK.id));
});

test('an item we do not know has nothing to show', () => {
  assert.equal(sourceFor('not_a_real_item'), null);
  assert.equal(has3d('not_a_real_item'), false);
  assert.equal(sourceFor(''), null);
  assert.equal(sourceFor(undefined), null);
});

test('the solid is generated once and handed back the same', async () => {
  const a = await loadSolid(BOOK.id);
  const b = await loadSolid(BOOK.id);
  assert.ok(a && a.idx.length, 'the book must build a mesh');
  assert.equal(a, b, 'regenerating a thousand triangles per call would cost a frame');
});

test('a garment never resolves a solid, so the mesh is not overwritten', async () => {
  // loadSolid runs alongside loadMesh in rebuild3d. If it returned anything for
  // a garment, whichever promise settled last would win and the real geometry
  // could be replaced by a flat panel.
  for (const item of CLOTHING) {
    assert.equal(await loadSolid(item.id), null, item.id);
  }
  assert.equal(await loadSolid('not_a_real_item'), null);
});
