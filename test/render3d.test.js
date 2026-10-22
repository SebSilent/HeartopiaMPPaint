import test from 'node:test';
import assert from 'node:assert/strict';

import { Preview3D } from '../assets/js/game/render3d.js';
import { CLOTHING, canvasItem } from '../assets/js/game/slots.js';
import { outlineFor } from '../assets/js/game/outline.js';

// The renderer only ever touches a canvas through a handful of 2D calls, so a
// recorder stands in for the browser and lets the geometry be checked for real.
function recorder() {
  // Every path is recorded with the save depth it was built at, so a caller can
  // tell the per-triangle clip from the per-panel silhouette clip.
  const log = { save: 0, restore: 0, clip: 0, paths: [], depth: [], draws: 0, fills: [] };
  let open = 0;
  const ctx = {
    imageSmoothingEnabled: false,
    fillStyle: '',
    setTransform() {},
    clearRect() {},
    fillRect() {
      log.fills.push(ctx.fillStyle);
    },
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
      log.depth.push(open);
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
  /**
   * The garment's own outline polygons.
   *
   * A silhouette clip is opened once per panel and closed when the panel ends,
   * so those polygons are recorded at a save depth of exactly 1. A triangle's
   * own clip is opened inside that, at depth 2, and always has three points.
   */
  const loops = () => log.paths.filter((_, i) => log.depth[i] === 1 && log.paths[i].length > 3);
  return { ctx, log, depth: () => open, loops };
}

function preview(item, withOutline = true) {
  const { ctx, log, depth, loops } = recorder();
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
  return { p, log, depth, loops, faces: item.faces.map((f) => ({ id: f.id, w: f.w, h: f.h })) };
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
  const { p, log, depth, loops } = preview(tshirt);
  p.build(tshirt);
  p.render();
  assert.ok(log.draws > 0, 'nothing drawn');
  assert.equal(log.save, log.restore, 'context stack leaked');
  assert.equal(depth(), 0, 'clip left open');
  // drawTri clips to the triangle; the silhouette adds one more per triangle.
  const looped = p._tris.filter((t) => t.loop).length;
  assert.equal(log.clip, p._tris.length + looped, 'a triangle was drawn without its silhouette');
  const sizes = new Set(loops().map((pts) => pts.length));
  for (const f of ['front', 'back', 'sleeveL', 'sleeveR']) {
    assert.ok(sizes.has(outlineFor('tshirt', f).ring.length), `${f} ring never became a clip path`);
  }
});

test('every garment is framed inside the panel, not stranded in it', () => {
  // The old focal was a fixed number, so a model measured in cell units landed
  // at 2-3% of the panel. Framing has to follow each garment's own box: a dress
  // is 168 cells wide, trousers are 116 tall, and one shared radius cannot fit
  // both.
  const cover = (item) => {
    const { ctx, log, loops } = recorder();
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => ctx,
      getBoundingClientRect: () => ({ width: 400, height: 300 }),
    };
    globalThis.window = { devicePixelRatio: 1 };
    const p = new Preview3D(canvas, () => ({ width: 4, height: 4 }),
      (id, faceId) => outlineFor(id, faceId));
    p.build(item);
    p.render();
    // Only the silhouette clip paths describe the model's footprint. The
    // per-triangle clips are three points each and would swamp this.
    let w = 0;
    let h = 0;
    for (const pts of loops()) {
      const xs = pts.map((q) => q[0]);
      const ys = pts.map((q) => q[1]);
      w = Math.max(w, Math.max(...xs) - Math.min(...xs));
      h = Math.max(h, Math.max(...ys) - Math.min(...ys));
    }
    return { w, h, tris: p._tris.length };
  };
  const worst = [];
  for (const item of CLOTHING) {
    const c = cover(item);
    assert.ok(c.tris > 0, `${item.id} built nothing`);
    // 400x300 panel: nothing may run off it, and it must be big enough to see.
    assert.ok(c.w <= 400 && c.h <= 300, `${item.id} overflows the panel at ${c.w}x${c.h}`);
    worst.push({ id: item.id, fill: Math.max(c.w / 400, c.h / 300) });
  }
  const small = worst.filter((x) => x.fill < 0.25);
  assert.deepEqual(small, [], 'too small to read: ' + small.map((s) => `${s.id} ${(s.fill * 100) | 0}%`).join(', '));
});

test('the garment is lit white, never the brown that read as dark green', () => {
  const tshirt = CLOTHING.find((i) => i.id === 'tshirt');
  const { p, log } = preview(tshirt);
  p.build(tshirt);
  p.render();
  // The backdrop has to fall between the garment's lit and shaded extremes,
  // not above both, or a white garment reads as grey on white.
  assert.equal(log.fills[0], '#c2ccd3', 'first paint is the studio backdrop');
  // Turn the garment away from the lamp so the panels need shading, then read
  // only what this render produced. The log accumulates, so mark the length
  // first rather than slicing at a fixed offset.
  const angles = [[0, 0], [90, 0], [180, 0], [45, 60], [200, -40], [311, 77]];
  const lights = [];
  const turned = [];
  for (const [yaw, pitch] of angles) {
    p.yaw = yaw;
    p.pitch = pitch;
    const mark = log.fills.length;
    p.render();
    turned.push(...log.fills.slice(mark).filter((f) => /^rgba\(/.test(f)));
    for (const t of p._tris) lights.push(t.lit);
  }
  // The old bug was a 0.62 brightness floor multiplied by rgba(24,16,9,0.8):
  // 0.304 of near-black laid over the pixels, which is what read as dark green.
  // A face square to the lamp must come out white. Measured at the default
  // view too, which is the angle the panel actually opens at.
  assert.ok(Math.max(...lights) > 0.95, `nothing reaches white, best is ${Math.max(...lights)}`);
  p.yaw = -24;
  p.pitch = 14;
  p.build(tshirt);
  const atDefault = p._tris.map((t) => t.lit);
  assert.ok(Math.max(...atDefault) > 0.95, `the opening view is not lit, best is ${Math.max(...atDefault)}`);
  assert.ok(Math.min(...lights) >= 0.66, `a panel fell through the floor: ${Math.min(...lights)}`);
  // Neutral: equal channels. Any brown tint here is the old bug back again.
  for (const s of turned) {
    const m = s.match(/rgba\((\d+),(\d+),(\d+),([\d.]+)\)/);
    assert.ok(m, 'unexpected shade ' + s);
    assert.equal(m[1], m[2], 'shading is not grey: ' + s);
    assert.equal(m[2], m[3], 'shading is not grey: ' + s);
    assert.ok(Number(m[4]) <= 0.66, `shading too heavy at ${s}`);
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
  const { p, log, loops } = preview(tshirt);
  p.build(tshirt);
  p.yaw = 60;
  p.pitch = -20;
  p.render();
  const ring = outlineFor('tshirt', 'front').ring.length;
  assert.ok(loops().some((pts) => pts.length === ring), 'no front clip at this angle');
  assert.equal(log.save, log.restore);
});
