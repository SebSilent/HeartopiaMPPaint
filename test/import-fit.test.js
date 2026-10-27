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

/** A picture and target chosen so the box cannot land on whole cells. */
const ODD = { width: 333, height: 200 };

test('the box lands on whole cells by default', () => {
  for (const rot of [0, 90, 180, 270]) {
    for (const fit of ['cover', 'contain', 'stretch']) {
      const r = fitRect(ODD, T.w, T.h, { fit, rot });
      for (const k of ['dx', 'dy', 'sw', 'sh', 'dw', 'dh']) {
        assert.ok(Number.isInteger(r[k]), `rot ${rot} ${fit}: ${k} is ${r[k]}, not a whole cell`);
      }
    }
  }
});

test('the continuous box is still available, and it really is fractional', () => {
  const free = fitRect(ODD, T.w, T.h, { fit: 'cover', snap: false });
  assert.ok(!Number.isInteger(free.dw), `unsnapped width ${free.dw} is between cells`);
  const snapped = fitRect(ODD, T.w, T.h, { fit: 'cover' });
  assert.notEqual(snapped.dw, free.dw, 'and snapping changed it, so the test above is not vacuous');
});

test('a drag smaller than a cell does nothing, which is the point', () => {
  const still = fitRect(ODD, T.w, T.h, { fit: 'cover' });
  // 0.1 of a cell on a 100-cell face: there is nowhere between cells to go.
  const nudge = fitRect(ODD, T.w, T.h, { fit: 'cover', ox: 0.001, oy: 0.001 });
  assert.equal(nudge.dx, still.dx, `${still.dx} -> ${nudge.dx}`);
  assert.equal(nudge.dy, still.dy);
});

test('a drag of exactly one cell moves it exactly one cell', () => {
  const a = fitRect(ODD, T.w, T.h, { fit: 'cover' });
  const b = fitRect(ODD, T.w, T.h, { fit: 'cover', ox: 1 / T.w, oy: 1 / T.h });
  assert.equal(b.dx - a.dx, 1, `${a.dx} -> ${b.dx}`);
  assert.equal(b.dy - a.dy, 1);
});

test('snapping does not shove the picture off centre', () => {
  // Rounding can move an edge by at most half a cell, so the centre has to stay
  // within half a cell of where the unrounded box would have put it. Anything
  // worse than that is a systematic shift, not a rounding.
  for (const width of [101, 213, 333, 400, 641]) {
    for (const height of [99, 150, 200, 377]) {
      const img = { width, height };
      for (const fit of ['cover', 'contain']) {
        const s = fitRect(img, T.w, T.h, { fit });
        const free = fitRect(img, T.w, T.h, { fit, snap: false });
        const cx = s.dx + s.sw / 2;
        const fx = free.dx + free.sw / 2;
        assert.ok(Math.abs(cx - fx) <= 0.75, `${width}x${height} ${fit}: centre moved ${cx - fx}`);
        const cy = s.dy + s.sh / 2;
        const fy = free.dy + free.sh / 2;
        assert.ok(Math.abs(cy - fy) <= 0.75, `${width}x${height} ${fit}: centre moved ${cy - fy} vertically`);
      }
    }
  }
});

test('a turned picture snaps the turned box, not the unturned one', () => {
  // The quarter turn swaps which size becomes which edge, so the rounding has to
  // happen before the swap or the occupied box comes out fractional again.
  const r = fitRect(ODD, T.w, T.h, { fit: 'contain', rot: 90 });
  assert.ok(Number.isInteger(r.sw) && Number.isInteger(r.sh), `${r.sw}x${r.sh}`);
  assert.equal(r.sw, r.dh, 'and the turned box still describes the turned picture');
  assert.equal(r.sh, r.dw);
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
