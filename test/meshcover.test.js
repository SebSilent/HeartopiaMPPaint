// The 3D texture's alpha comes from where the MESH samples, not from where the
// game lets you paint. Those two sets differ, and using the paint ring for the
// mesh is what punched see-through holes in real cloth.
import test from 'node:test';
import assert from 'node:assert/strict';

import { loadMesh } from '../assets/js/game/meshdata.js';
import { coverageFor } from '../assets/js/game/meshcover.js';
import { maskFor } from '../assets/js/game/faces.js';
import { CLOTHING } from '../assets/js/game/slots.js';

if (typeof globalThis.atob !== 'function') {
  globalThis.atob = (s) => Buffer.from(s, 'base64').toString('binary');
}

async function cover(id) {
  const item = CLOTHING.find((c) => c.id === id);
  const mesh = await loadMesh(id);
  return { item, mesh, cov: coverageFor(mesh, item.faces) };
}

test('every face of a garment gets a coverage map', async () => {
  for (const item of CLOTHING) {
    const mesh = await loadMesh(item.id);
    const cov = coverageFor(mesh, item.faces);
    for (const f of item.faces) {
      const c = cov.get(f.id);
      assert.ok(c, `${item.id}.${f.id} has no coverage map`);
      assert.equal(c.length, f.w * f.h, `${item.id}.${f.id} map is the wrong size`);
      let n = 0;
      for (let i = 0; i < c.length; i++) n += c[i];
      assert.ok(n > f.w * f.h * 0.2, `${item.id}.${f.id} covers only ${n} of ${f.w * f.h}`);
    }
  }
});

test('the map is the garment footprint, not the whole rectangle', async () => {
  const { cov, item } = await cover('tshirt');
  const f = item.faces.find((x) => x.id === 'front');
  const c = cov.get('front');
  // The corner of a face rectangle is not cloth, and if it is made opaque it
  // sticks out of the silhouette as a white tab.
  assert.equal(c[0], 0, 'the top-left corner was covered');
  assert.equal(c[c.length - 1], 0, 'the bottom-right corner was covered');
  let n = 0;
  for (let i = 0; i < c.length; i++) n += c[i];
  assert.ok(n < f.w * f.h * 0.95, `coverage is ${n} of ${f.w * f.h}: that is the whole rect again`);
});

test('cloth that the paint ring disables is still covered', async () => {
  // Mary Janes is the worst case measured in tools/meshmask.mjs: the mesh reads
  // over a thousand texels the game refuses to paint. Clipping the texture to
  // the ring made those transparent, so the shoe had holes in it.
  const { cov, item } = await cover('maryjanes');
  let past = 0;
  for (const f of item.faces) {
    const mask = maskFor('maryjanes', f.id);
    const c = cov.get(f.id);
    if (!mask) continue;
    for (let i = 0; i < c.length; i++) if (c[i] && !mask[i]) past++;
  }
  assert.ok(past > 100, `the mesh only reaches ${past} texels past the ring - the test's premise is stale`);
});

test('coverage is computed from the mesh, and cached against it', async () => {
  const a = await cover('maryjanes');
  const b = await cover('maryjanes');
  for (const f of a.item.faces) {
    // The same mesh must hand back the same map: faceTexture runs on every
    // stroke, and re-rasterising 1,400 triangles each time would not be free.
    assert.equal(a.cov.get(f.id), b.cov.get(f.id), `${f.id}: coverage was rebuilt`);
    // Every texel the mesh samples is opaque. That is the whole fix: under the
    // paint ring, Mary Janes had 1,321 sampled texels punched transparent.
    const c = a.cov.get(f.id);
    // A triangle's centroid is inside it by construction, so the renderer must
    // be reading a texel the map calls covered. Corners are not a safe probe:
    // a vertex sits on the boundary of its own triangle and the texel holding
    // it can have its centre just outside.
    let checked = 0;
    for (let t = 0; t < a.mesh.tris; t++) {
      if (a.mesh.faces[a.mesh.idx[t * 4 + 3]] !== f.id) continue;
      let su = 0;
      let sv = 0;
      for (const k of [0, 1, 2]) {
        const vi = a.mesh.idx[t * 4 + k];
        su += a.mesh.uv[vi * 2];
        sv += a.mesh.uv[vi * 2 + 1];
      }
      const x = Math.floor((su / 3) * f.w);
      const y = Math.floor((1 - sv / 3) * f.h);
      if (x < 0 || y < 0 || x >= f.w || y >= f.h) continue;
      checked++;
      assert.equal(c[y * f.w + x], 1, `${f.id} triangle ${t} samples a texel its own map leaves transparent`);
    }
    assert.ok(checked > 50, `${f.id}: only ${checked} centroids checked`);
  }
});
