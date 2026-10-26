// The garment meshes, checked against what the mesh promises.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { loadMesh } from '../assets/js/game/meshdata.js';
import { Preview3D } from '../assets/js/game/render3d.js';
import { CLOTHING } from '../assets/js/game/slots.js';
import { FACE_DATA } from '../assets/js/data/heartopia-faces.js';

// atob lives in the browser; node has it from 18 on, but the module is written
// for the browser so make the dependency explicit here.
if (typeof globalThis.atob !== 'function') {
  globalThis.atob = (s) => Buffer.from(s, 'base64').toString('binary');
}

const mkCanvas = () => {
  const ctx = {
    imageSmoothingEnabled: false,
    setTransform() {},
    clearRect() {},
    fillRect() {},
    save() {},
    restore() {},
    beginPath() {},
    moveTo() {},
    lineTo() {},
    closePath() {},
    clip() {},
    fill() {},
    drawImage() {},
    // The mesh overlay interpolates its shade across large triangles, so a
    // gradient is now part of what a frame asks the canvas for.
    createLinearGradient() {
      return { addColorStop() {} };
    },
  };
  return { width: 0, height: 0, getContext: () => ctx, getBoundingClientRect: () => ({ width: 400, height: 300 }) };
};

const bake = () => {
  const c = { width: 4, height: 4 };
  return c;
};

test('every clothing item has a mesh, and it decodes', async () => {
  for (const item of CLOTHING) {
    const mesh = await loadMesh(item.id);
    assert.ok(mesh, `${item.id} has no mesh`);
    assert.ok(mesh.tris > 400, `${item.id} is too coarse: ${mesh.tris} triangles`);
    assert.ok(mesh.tris <= 2000, `${item.id} is too heavy for a canvas preview: ${mesh.tris}`);
    assert.equal(mesh.pos.length, (mesh.pos.length / 3) * 3);
    // Faces must be the item's own, in its own order.
    for (let f = 0; f < mesh.faces.length; f++) {
      assert.ok(item.faces.some((x) => x.id === mesh.faces[f]), `${item.id}: face ${mesh.faces[f]} is not on the item`);
    }
  }
});

test('the mesh UVs honour u = x/w and v = 1 - y/h in cells', async () => {
  const mesh = await loadMesh('tshirt');
  const face = CLOTHING.find((c) => c.id === 'tshirt').faces[0]; // front, 64x80
  const ring = FACE_DATA.tshirt.front.rings[0];
  let x0 = Infinity;
  let x1 = -Infinity;
  let y0 = Infinity;
  let y1 = -Infinity;
  for (const [x, y] of ring) {
    x0 = Math.min(x0, x);
    x1 = Math.max(x1, x);
    y0 = Math.min(y0, y);
    y1 = Math.max(y1, y);
  }
  // Front triangles sample the front face only, and inside its outline.
  let seen = 0;
  for (let t = 0; t < mesh.tris; t++) {
    if (mesh.faces[mesh.idx[t * 4 + 3]] !== 'front') continue;
    for (const k of [0, 1, 2]) {
      const vi = mesh.idx[t * 4 + k];
      const u = mesh.uv[vi * 2];
      const v = mesh.uv[vi * 2 + 1];
      assert.ok(u >= x0 / face.w - 0.04 && u <= x1 / face.w + 0.04, `u ${u} outside ${x0}/${x1} of ${face.w}`);
      assert.ok(v >= 1 - y1 / face.h - 0.04 && v <= 1 - y0 / face.h + 0.04, `v ${v} outside ${y0}/${y1} of ${face.h}`);
      seen++;
    }
  }
  assert.ok(seen > 200, `too few front triangles sampled: ${seen}`);
});

test('positions sit inside one body-sized box, centred', async () => {
  const mesh = await loadMesh('dress');
  let r = 0;
  for (let i = 0; i < mesh.pos.length; i += 3) {
    r = Math.max(r, Math.hypot(mesh.pos[i], mesh.pos[i + 1], mesh.pos[i + 2]));
  }
  assert.ok(r > 0.4 && r < 1.6, `dress radius ${r} is not body sized`);
});

test('a mesh build produces textured triangles and costs no work when idle', async () => {
  globalThis.window = { devicePixelRatio: 1 };
  const canvas = mkCanvas();
  const p = new Preview3D(canvas, bake, null);
  const item = CLOTHING.find((c) => c.id === 'tshirt');
  const mesh = await loadMesh('tshirt');
  p.setMesh(mesh);
  const n = p.build(item);
  assert.equal(n, mesh.tris);
  for (const t of p._tris) {
    assert.ok(t.face, 'a triangle lost its face');
    assert.ok(t.tex, 'a triangle has no texture');
    assert.ok(t.n, 'a triangle has no normal to cull and light by');
    // Texture rows count down the face, so v never runs past the face height.
    const f = item.faces.find((x) => x.id === t.face);
    assert.ok(t.v[1] >= -1 && t.v[1] <= f.h + 1, `texture row ${t.v[1]} off a ${f.h} face`);
  }
  p.render();
  // Nothing changed, so a second render must not touch the picture at all.
  let draws = 0;
  const spy = canvas.getContext();
  spy.drawImage = () => {
    draws++;
  };
  p.render();
  assert.equal(draws, 0, 'an idle frame still repainted');
  p.markDirty();
  p.render();
  assert.ok(draws > 0, 'markDirty did not bring the frame back');
});

test('a cloth shell is drawn whole, with nothing culled away', async () => {
  globalThis.window = { devicePixelRatio: 1 };
  const canvas = mkCanvas();
  let drawn = 0;
  canvas.getContext().drawImage = () => {
    drawn++;
  };
  const p = new Preview3D(canvas, bake, null);
  const item = CLOTHING.find((c) => c.id === 'tshirt');
  p.setMesh(await loadMesh('tshirt'));
  p.build(item);
  p.render();
  const total = p._tris.length;
  // This test used to demand the opposite: that well under the whole mesh was
  // drawn, which was back-face culling working as designed. The mesh is a single
  // cloth shell rather than a solid, so the away-facing triangles are the only
  // thing behind a neck, a cuff or a hem, and dropping them punched see-through
  // holes at exactly the openings a garment genuinely has. Nothing may be culled.
  assert.ok(drawn > total * 0.95, `only ${drawn} of ${total} triangles drawn: something is being culled, and on a shell that means a hole`);
});

test('the same mesh from the far side is still drawn whole', async () => {
  globalThis.window = { devicePixelRatio: 1 };
  const canvas = mkCanvas();
  let drawn = 0;
  canvas.getContext().drawImage = () => {
    drawn++;
  };
  const p = new Preview3D(canvas, bake, null);
  const item = CLOTHING.find((c) => c.id === 'tshirt');
  p.setMesh(await loadMesh('tshirt'));
  p.build(item);
  // Turning a garment right around must not change how much of it is there: a
  // shell has no front half to lose. Counting draws from both sides is the whole
  // point - a large drop was the previous behaviour, and it read as holes.
  p.yaw = 0;
  p.render(true);
  const front = drawn;
  drawn = 0;
  p.yaw = Math.PI;
  p.render(true);
  const back = drawn;
  assert.ok(front > 0 && back > 0, `nothing was drawn (front ${front}, back ${back})`);
  assert.ok(Math.abs(front - back) / front < 0.15, `front ${front} vs back ${back}: one side of the shell is being dropped`);
});

test('an item with no mesh falls back to the flat panels', async () => {
  const mesh = await loadMesh('chair');
  assert.equal(mesh, null, 'a furniture id must not resolve to a garment');
});

test('the lining is painted before the face, never over it', async () => {
  globalThis.window = { devicePixelRatio: 1 };
  const canvas = mkCanvas();
  const p = new Preview3D(canvas, bake, null);
  const item = CLOTHING.find((c) => c.id === 'tshirt');
  p.setMesh(await loadMesh('tshirt'));
  p.build(item);
  for (const yaw of [0, -24, 60, 140, 250]) {
    p.yaw = yaw;
    p.pitch = 14;
    p.render(true);
    const order = p._drawn;
    const back = order.filter((v) => !v.front);
    const face = order.filter((v) => v.front);
    assert.ok(back.length && face.length, `one pass was empty at yaw ${yaw}`);
    // Every away-facing triangle must precede every toward-facing one. This is
    // what stops the inside of a sleeve painting over the outside of the chest.
    const lastBack = order.reduce((m, v, i) => (!v.front && i > m ? i : m), -1);
    const firstFace = order.findIndex((v) => v.front);
    assert.ok(lastBack < firstFace, `yaw ${yaw}: a lining triangle was drawn at ${lastBack}, after the face started at ${firstFace}`);
    // And within each pass, far first.
    for (const list of [back, face]) {
      for (let i = 1; i < list.length; i++) {
        assert.ok(list[i].z >= list[i - 1].z - 1e-6, 'a pass was not sorted far to near');
      }
    }
  }
});

test('the inside of the shell reads darker than the outside', async () => {
  globalThis.window = { devicePixelRatio: 1 };
  const canvas = mkCanvas();
  const p = new Preview3D(canvas, bake, null);
  const item = CLOTHING.find((c) => c.id === 'tshirt');
  p.setMesh(await loadMesh('tshirt'));
  p.build(item);
  p.yaw = 0;
  p.pitch = 0;
  p.render(true);
  const face = p._drawn.filter((v) => v.front);
  const back = p._drawn.filter((v) => !v.front);
  const litFace = Math.max(...face.map((v) => v.lit));
  const litBack = Math.max(...back.map((v) => v.lit));
  assert.ok(litBack < litFace, `lining peaks at ${litBack}, outside at ${litFace}: nothing dims the inside`);
});

test('orbiting reorders the paint, because depth is measured from the camera', async () => {
  // The sort key used to be the model's own z, captured once at build. That is
  // a fixed number, so turning the garment changed nothing about what was drawn
  // in what order, and far surfaces painted over near ones at every angle off
  // the front - the "wall hack". A view-space key must reorder as the camera
  // moves.
  globalThis.window = { devicePixelRatio: 1 };
  const canvas = mkCanvas();
  const p = new Preview3D(canvas, bake, null);
  const item = CLOTHING.find((c) => c.id === 'tshirt');
  p.setMesh(await loadMesh('tshirt'));
  p.build(item);
  const seq = (yaw) => {
    p.yaw = yaw;
    p.pitch = 0;
    p.render(true);
    return p._drawn.map((v) => v.t.face + ':' + (v.front ? 'f' : 'b')).join(',');
  };
  const a = seq(0);
  const b = seq(80);
  assert.notEqual(a, b, 'the draw order did not change at all when the model turned');
});
