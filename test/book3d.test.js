import test from 'node:test';
import assert from 'node:assert/strict';
import { bookMesh, proceduralFor } from '../assets/js/game/book3d.js';
import { BOOK } from '../assets/js/game/slots.js';

const FACE_W = BOOK.faces[0].w;
const FACE_H = BOOK.faces[0].h;

const m = bookMesh();
// Positions are normalised body units (the renderer multiplies by 100), but the
// face and its zones are counted in cells, so read the mesh back in cells.
const CELLS = 100;
const v = (i) => [m.pos[i * 3] * CELLS, m.pos[i * 3 + 1] * CELLS, m.pos[i * 3 + 2] * CELLS];
const n = (i) => [m.nrm[i * 3], m.nrm[i * 3 + 1], m.nrm[i * 3 + 2]];
const uvOf = (i) => [m.uv[i * 2], m.uv[i * 2 + 1]];

test('the book is a mesh the garment path can already draw', () => {
  // Same shape as a baked garment, or the preview would need a second renderer.
  assert.ok(m.pos instanceof Float32Array && m.nrm instanceof Float32Array);
  assert.ok(m.uv instanceof Float32Array && m.idx instanceof Uint16Array);
  assert.equal(m.pos.length / 3, m.nrm.length / 3);
  assert.equal(m.pos.length / 3, m.uv.length / 2);
  assert.equal(m.idx.length % 4, 0, 'four indices per triangle, the fourth the face');
  assert.equal(m.tris, m.idx.length / 4);
  assert.deepEqual(m.faces, ['tall'], 'one face, and every triangle names it');
  for (let t = 0; t < m.idx.length; t += 4) {
    assert.equal(m.idx[t + 3], 0);
    for (let k = 0; k < 3; k++) assert.ok(m.idx[t + k] < m.pos.length / 3);
  }
});

test('the cover folds front, spine, back, matching the face rings', () => {
  // Sample the cover's centre line and check it is laid out like the face:
  // 0..66 front, 66..84 spine, 84..150 back.
  const at = (u) => {
    let best = 0;
    let bd = Infinity;
    for (let i = 0; i < m.uv.length / 2; i++) {
      const d = Math.abs(uvOf(i)[0] - u / FACE_W);
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
    return { p: v(best), n: n(best) };
  };
  const front = at(10);
  const spine = at(75);
  const back = at(140);
  assert.ok(front.p[2] > 0, 'the front cover is on top');
  assert.ok(back.p[2] < 0, 'the back cover is underneath');
  assert.ok(spine.p[2] > front.p[2] - 26 && spine.p[2] < front.p[2] + 1, 'the spine is between them');
  assert.ok(Math.abs(front.n[2]) > 0.9, 'the front cover faces up');
  assert.ok(Math.abs(back.n[2]) > 0.9, 'the back cover faces down');
  assert.ok(spine.n[0] < -0.5, 'the middle of the spine faces outward, off the covers');
});

test('the cover is one unbroken strip, with no step where the spine joins', () => {
  // The fold has to be continuous: the front cover, the spine and the back cover
  // meet at the same x or the solid has a crack down its side, which is exactly
  // the "hole in the clothing" failure again.
  const edge = -66 / 2;
  const at = (u) => {
    let best = 0;
    let bd = Infinity;
    for (let i = 0; i < m.uv.length / 2; i++) {
      const d = Math.abs(uvOf(i)[0] - u / FACE_W);
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
    return v(best);
  };
  assert.ok(Math.abs(at(66)[0] - edge) < 0.5, `front cover ends at ${at(66)[0]}, expected ${edge}`);
  assert.ok(Math.abs(at(84)[0] - edge) < 0.5, `back cover starts at ${at(84)[0]}, expected ${edge}`);
  assert.ok(Math.abs(at(66)[2] - at(84)[2]) > 20, 'and they are on opposite sides of the book');
});

test('the spine is rounded, not a mitred corner', () => {
  // Walk the spine zone and require the outline to bow outward and turn
  // continuously: no two adjacent samples may share a normal.
  const spine = [];
  for (let i = 0; i < m.uv.length / 2; i++) {
    const u = uvOf(i)[0] * FACE_W;
    if (u >= 66 && u <= 84 && Math.abs(v(i)[1]) < 1) spine.push({ p: v(i), n: n(i) });
  }
  spine.sort((a, b) => a.p[2] - b.p[2]);
  // The covers are the 66-cell zones, so the book is 66 wide and its spine edge
  // sits at -33. Anything further out than that is the round.
  const edge = -66 / 2;
  const xs = spine.map((s) => s.p[0]);
  assert.ok(Math.min(...xs) < edge - 2, `the spine should stand proud of ${edge}, got ${Math.min(...xs)}`);
  assert.ok(Math.max(...xs) > Math.min(...xs) + 1, 'and curves back in again');
  // A mitre would be one corner; a curve has many distinct normals.
  const dirs = new Set(spine.map((s) => Math.round(Math.atan2(s.n[0], s.n[2]) * 100)));
  assert.ok(dirs.size > 8, `expected a run of turning normals, got ${dirs.size}`);
});

test('every normal is a unit vector and every UV is inside the face', () => {
  for (let i = 0; i < m.pos.length / 3; i++) {
    const [x, y, z] = n(i);
    assert.ok(Math.abs(Math.hypot(x, y, z) - 1) < 1e-6, `normal ${i} is not unit`);
    const [u, vv] = uvOf(i);
    assert.ok(u >= 0 && u <= 1, `u ${u} off the face`);
    assert.ok(vv >= 0 && vv <= 1, `v ${vv} off the face`);
  }
});

test('no triangle degenerates to a point in UV, or the renderer skips it', () => {
  // drawTri bails on a near-zero UV determinant, so a solid whose faces collapse
  // in texture space would silently render as holes.
  let worst = Infinity;
  for (let t = 0; t < m.idx.length; t += 4) {
    const a = uvOf(m.idx[t]);
    const b = uvOf(m.idx[t + 1]);
    const c = uvOf(m.idx[t + 2]);
    const det = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    worst = Math.min(worst, Math.abs(det));
  }
  assert.ok(worst > 1e-9, `a collapsed triangle, det ${worst}`);
});

test('only the book is procedural', () => {
  assert.ok(proceduralFor('book'));
  assert.equal(proceduralFor('tshirt'), null);
  assert.equal(proceduralFor('bed1'), null);
});
