/**
 * The turn/placement maths behind import. `fitRect` is the single source of
 * truth for both the preview you drag and the buffer that gets committed, so a
 * wrong box here means the picture lands somewhere other than where it was
 * shown - and rotation is where that is easiest to get wrong, because a quarter
 * turn swaps which edge has to fit.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fitRect } from '../assets/js/ui/importer.js';

// A wide picture: 400 x 200 into a square target makes the swap obvious.
const IMG = { width: 400, height: 200 };
const T = { w: 100, h: 100 };

test('no turn behaves exactly as it always did', () => {
  const r = fitRect(IMG, T.w, T.h, { fit: 'cover' });
  assert.equal(r.rot, 0);
  // cover on a 2:1 into 1:1: scale by the wider edge, overflow the other.
  assert.deepEqual([r.sw, r.sh], [100 * 2, 100], 'the picture fills the width and overflows the height');
  assert.deepEqual([r.dw, r.dh], [r.sw, r.sh], 'unturned, the draw size is the occupied size');
  // cover overflows on purpose: the box is wider than the target, so it starts
  // outside it on the left and is centred.
  assert.equal(r.dx, -50);
  assert.equal(r.dy, 0);
  assert.equal(r.dx + r.sw / 2, T.w / 2, 'centred whatever the overflow');
});

test('a quarter turn fits the box the picture occupies after turning', () => {
  const straight = fitRect(IMG, T.w, T.h, { fit: 'cover' });
  const turned = fitRect(IMG, T.w, T.h, { fit: 'cover', rot: 90 });
  // The turned picture is 200 wide x 400 tall as far as the target is concerned,
  // so cover scales by the tall edge: the occupied box is the swap of the flat one.
  assert.deepEqual([turned.sw, turned.sh], [straight.sh, straight.sw], 'the occupied box swaps edges');
  assert.deepEqual([turned.dw, turned.dh], [turned.sh, turned.sw], 'the draw size is the un-turned pair');
  assert.equal(turned.rot, 90);
  // And it still covers: neither edge of the occupied box may be under the target.
  assert.ok(turned.sw >= T.w && turned.sh >= T.h, `cover must still cover after a turn, got ${turned.sw}x${turned.sh}`);
});

test('90 and 270 occupy the same box, 180 occupies the flat one', () => {
  const a = fitRect(IMG, T.w, T.h, { fit: 'contain', rot: 90 });
  const b = fitRect(IMG, T.w, T.h, { fit: 'contain', rot: 270 });
  assert.deepEqual([a.sw, a.sh, a.dx, a.dy], [b.sw, b.sh, b.dx, b.dy], 'a half-turn apart is the same footprint');
  const c = fitRect(IMG, T.w, T.h, { fit: 'contain', rot: 180 });
  assert.deepEqual([c.sw, c.sh], [a.sh, a.sw], 'a half turn is not a quarter turn');
});

test('contain leaves the turned picture inside the face', () => {
  const r = fitRect(IMG, T.w, T.h, { fit: 'contain', rot: 90 });
  assert.ok(r.sw <= T.w && r.sh <= T.h, `contain must not overflow, got ${r.sw}x${r.sh}`);
  assert.equal(r.dx + r.sw / 2, T.w / 2, 'and it stays centred');
  assert.equal(r.dy + r.sh / 2, T.h / 2);
});

test('turn angles arrive as strings from a select and as nonsense from a bad URL', () => {
  // A <select> value is text, and this state is also settable from a query
  // string. Neither may reach the draw call as NaN, which would blank the board.
  assert.equal(fitRect(IMG, T.w, T.h, { rot: '90' }).rot, 90);
  assert.equal(fitRect(IMG, T.w, T.h, { rot: 'abc' }).rot, 0, 'unreadable is no turn, not a broken one');
  assert.equal(fitRect(IMG, T.w, T.h, { rot: undefined }).rot, 0);
  assert.equal(fitRect(IMG, T.w, T.h, { rot: 360 }).rot, 0);
  assert.equal(fitRect(IMG, T.w, T.h, { rot: -90 }).rot, 270, 'anti-clockwise is still a quarter turn');
  assert.equal(fitRect(IMG, T.w, T.h, { rot: 450 }).rot, 90);
  assert.deepEqual(
    [fitRect(IMG, T.w, T.h, { rot: '90' }).sw, fitRect(IMG, T.w, T.h, { rot: 90 }).sw],
    [100, 100],
    'text and number agree'
  );
});

test('scale and pan survive a turn', () => {
  const r = fitRect(IMG, T.w, T.h, { fit: 'contain', rot: 90, zoom: 2 });
  const one = fitRect(IMG, T.w, T.h, { fit: 'contain', rot: 90 });
  assert.equal(r.sw, one.sw * 2, 'zoom doubles the occupied box');
  assert.equal(r.sh, one.sh * 2);

  // Compared against the same zoom: pan is a fraction of the target, so it must
  // not care how big the picture currently is.
  const p = fitRect(IMG, T.w, T.h, { fit: 'contain', rot: 90, ox: 0.25, oy: -0.5 });
  assert.equal(p.dx, one.dx + 0.25 * T.w, 'pan is in fractions of the target, whatever the turn');
  assert.equal(p.dy, one.dy - 0.5 * T.h);
});
