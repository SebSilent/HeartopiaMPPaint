import test from 'node:test';
import assert from 'node:assert/strict';

import { Preview3D } from '../assets/js/game/render3d.js';
import { CLOTHING, canvasItem } from '../assets/js/game/slots.js';
import { outlineFor } from '../assets/js/game/outline.js';

// The renderer only ever touches a canvas through a handful of 2D calls, so a
// recorder stands in for the browser and lets the geometry be checked for real.
function recorder() {
  const log = { save: 0, restore: 0, clip: 0, paths: [], draws: 0 };
  let open = 0;
  const ctx = {
    imageSmoothingEnabled: false,
    fillStyle: '',
    setTransform() {},
    clearRect() {},
    save() {
      log.save++;
      open++;
    },
    restore() {
      log.restore++;
      open--;
    },
    beginPath() {
      log.paths.push([]);
    },
    moveTo(x, y) {
      log.paths[log.paths.length - 1].push([x, y]);
    },
    lineTo(x, y) {
      log.paths[log.paths.length - 1].push([x, y]);
    },
    closePath() {},
    clip() {
      log.clip++;
    },
    fill() {},
    drawImage() {
      log.draws++;
    },
  };
  return { ctx, log, depth: () => open };
}

function preview(item, withOutline = true) {
  const { ctx, log, depth } = recorder();
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => ctx,
    getBoundingClientRect: () => ({ width: 400, height: 300 }),
  };
  globalThis.window = { devicePixelRatio: 1 };
  const p = new Preview3D(
    canvas,
    () => ({ width: 4, height: 4 }),
    withOutline ? (id, faceId) => outlineFor(id, faceId) : null
  );
  return { p, log, depth, faces: item.faces.map((f) => ({ id: f.id, w: f.w, h: f.h })) };
}

test('a garment builds triangles and carries its silhouette', () => {
  const tshirt = CLOTHING.find((i) => i.id === 'tshirt');
  const { p } = preview(tshirt);
  const n = p.build(tshirt);
  assert.ok(n > 0, 'no triangles');
  const loops = new Set(p._tris.filter((t) => t.loop).map((t) => t.loop));
  // Four faces, four distinct silhouettes.
  assert.equal(loops.size, 4, `expected 4 loops, got ${loops.size}`);
  for (const t of p._tris) {
    assert.ok(t.loop, `panel ${t.face} reached the renderer without a clip`);
    assert.equal(t.loop.length, outlineFor('tshirt', t.face).ring.length, t.face);
  }
  assert.ok(p.radius > 0);
});

test('the silhouette is scaled with its panel, not left in cell units', () => {
  const dress = CLOTHING.find((i) => i.id === 'dress');
  const { p } = preview(dress);
  p.build(dress);
  const t = p._tris.find((x) => x.face === 'dress.front' || x.face === 'front');
  const face = dress.faces.find((f) => f.id === t.face);
  const ring = outlineFor(dress.id, t.face).ring;
  const spanRing = Math.max(...ring.map((p) => p[0])) - Math.min(...ring.map((p) => p[0]));
  const spanLoop = Math.max(...t.loop.map((p) => p[0])) - Math.min(...t.loop.map((p) => p[0]));
  // The panel is face.w model units across and the ring is face.w cells across,
  // so the loop must span exactly what the ring spans.
  assert.ok(Math.abs(spanLoop - spanRing) < 1e-6, `ring ${spanRing} vs loop ${spanLoop}`);
  assert.ok(spanLoop < face.w && spanLoop > face.w * 0.3, `loop spans ${spanLoop} of a ${face.w} wide panel`);
});

test('a plain canvas has no silhouette and no clip', () => {
  const board = canvasItem('1:1', 1);
  const { p } = preview(board);
  const n = p.build({ id: board.id, faces: board.faces });
  assert.ok(n > 0);
  assert.ok(p._tris.every((t) => t.loop === null));
});

test('render clips every textured panel and leaves the context balanced', () => {
  const tshirt = CLOTHING.find((i) => i.id === 'tshirt');
  const { p, log, depth } = preview(tshirt);
  p.build(tshirt);
  p.render();
  assert.ok(log.draws > 0, 'nothing drawn');
  assert.equal(log.save, log.restore, 'context stack leaked');
  assert.equal(depth(), 0, 'clip left open');
  // drawTri clips to the triangle; the silhouette adds one more per triangle.
  const looped = p._tris.filter((t) => t.loop).length;
  assert.equal(log.clip, p._tris.length + looped, 'a triangle was drawn without its silhouette');
  const sizes = new Set(log.paths.filter((pts) => pts.length > 6).map((pts) => pts.length));
  for (const f of ['front', 'back', 'sleeveL', 'sleeveR']) {
    assert.ok(sizes.has(outlineFor('tshirt', f).ring.length), `${f} ring never became a clip path`);
  }
});

test('a ring that leaves the camera is dropped instead of drawn wrong', () => {
  const tshirt = CLOTHING.find((i) => i.id === 'tshirt');
  const { p, log } = preview(tshirt);
  p.build(tshirt);
  p.zoom = 40;
  p.render();
  assert.equal(log.save, log.restore);
});

test('orbiting keeps the clip welded to the panel', () => {
  const tshirt = CLOTHING.find((i) => i.id === 'tshirt');
  const { p, log } = preview(tshirt);
  p.build(tshirt);
  p.yaw = 60;
  p.pitch = -20;
  p.render();
  const ring = outlineFor('tshirt', 'front').ring.length;
  assert.ok(log.paths.some((pts) => pts.length === ring), 'no front clip at this angle');
  assert.equal(log.save, log.restore);
});
