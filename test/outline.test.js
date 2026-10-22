import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { CLOTHING } from '../assets/js/game/slots.js';
import { outlineFor, maskFor, hasOutline, maskInside } from '../assets/js/game/outline.js';

const here = join(dirname(fileURLToPath(import.meta.url)), '..');
const raw = JSON.parse(readFileSync(join(here, 'assets/data/heartopia-outlines.json'), 'utf8'));
const mod = readFileSync(join(here, 'assets/js/data/heartopia-outlines.js'), 'utf8');

test('every clothing face ships a silhouette of the exact catalogue size', () => {
  const missing = [];
  const wrong = [];
  for (const item of CLOTHING) {
    for (const face of item.faces) {
      const o = outlineFor(item.id, face.id);
      if (!o) missing.push(`${item.id}.${face.id}`);
      else if (o.w !== face.w || o.h !== face.h) wrong.push(`${item.id}.${face.id} ${o.w}x${o.h} != ${face.w}x${face.h}`);
    }
  }
  assert.deepEqual(missing, [], 'no outline for: ' + missing.join(', '));
  assert.deepEqual(wrong, [], 'size mismatch: ' + wrong.join(', '));
});

test('the browser module and the json agree', () => {
  const fromModule = JSON.parse(mod.slice(mod.indexOf('{'), mod.lastIndexOf('}') + 1));
  assert.deepEqual(Object.keys(fromModule).sort(), Object.keys(raw.items).sort());
  for (const id of Object.keys(raw.items)) {
    for (const face of Object.keys(raw.items[id])) {
      assert.deepEqual(fromModule[id][face], raw.items[id][face], `${id}.${face}`);
    }
  }
});

test('a lookup is by face id, and an unknown face gets nothing', () => {
  assert.equal(outlineFor('tshirt', 'front').w, 64);
  assert.equal(outlineFor('tshirt', 'nope'), null);
  assert.equal(outlineFor('nope', 'front'), null);
  assert.equal(hasOutline('tshirt', 'front'), true);
  assert.equal(hasOutline('tshirt', 'nope'), false);
});

test('the mask is inside the silhouette and empty outside it', () => {
  const m = maskFor('tshirt', 'front');
  const o = outlineFor('tshirt', 'front');
  assert.equal(m.length, o.w * o.h);
  // The collar notch at the top centre is outside the shirt.
  assert.equal(m[2 * o.w + 32], 0, 'cell under the collar should be out');
  // The middle of the chest is inside.
  assert.equal(m[40 * o.w + 32], 1);
  // Corners of the bounding box are outside: the ring is not a rectangle.
  assert.equal(m[0], 0);
  assert.equal(m[o.w - 1], 0);
  assert.equal(m[(o.h - 1) * o.w], 0);
});

test('front and back are different shapes, not one shape reused', () => {
  const a = maskFor('skirt', 'front');
  const b = maskFor('skirt', 'back');
  let diff = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diff++;
  assert.ok(diff > 0, 'skirt front and back mask identical');
  assert.ok(maskInside(a) > 0 && maskInside(b) > 0);
});

test('every silhouette sits inside its board and paints a real area', () => {
  for (const item of CLOTHING) {
    for (const face of item.faces) {
      const o = outlineFor(item.id, face.id);
      const m = maskFor(item.id, face.id);
      let minX = 1e9;
      let maxX = -1e9;
      let minY = 1e9;
      let maxY = -1e9;
      for (const [x, y] of o.ring) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
      assert.ok(minX >= 0 && maxX <= o.w && minY >= 0 && maxY <= o.h, `${item.id}.${face.id} ring leaves the board`);
      // A cell is in when its centre is in, so the painted extent should reach
      // the ring's own extent. If it does not, the mask came out wrong.
      let a = 1e9;
      let b = -1e9;
      let c = 1e9;
      let d = -1e9;
      for (let y = 0; y < o.h; y++) {
        for (let x = 0; x < o.w; x++) {
          if (!m[y * o.w + x]) continue;
          if (x < a) a = x;
          if (x > b) b = x;
          if (y < c) c = y;
          if (y > d) d = y;
        }
      }
      assert.ok(Math.abs(a - minX) <= 2 && Math.abs(b - maxX) <= 2, `${item.id}.${face.id} x span ${a}..${b} vs ${minX}..${maxX}`);
      assert.ok(Math.abs(c - minY) <= 2 && Math.abs(d - maxY) <= 2, `${item.id}.${face.id} y span ${c}..${d} vs ${minY}..${maxY}`);
      const share = maskInside(m) / m.length;
      assert.ok(share > 0.05 && share < 1, `${item.id}.${face.id} fills ${(share * 100).toFixed(0)}%`);
    }
  }
});

test('masks are cached, so redrawing does not re-run the point test', () => {
  const first = maskFor('dress', 'front');
  assert.equal(maskFor('dress', 'front'), first, 'same array back');
});
