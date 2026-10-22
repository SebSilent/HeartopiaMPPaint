/*
 * The display copy: the grid is the truth immediately, the screen catches up.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Room } from '../assets/js/net/room.js';
import { StrokeDisplay } from '../assets/js/net/display.js';
import { Grid } from '../assets/js/game/grid.js';
import { indicesToB64, randomId } from '../assets/js/util.js';

function makeRoom(smooth = {}) {
  const r = new Room({
    code: 'TEST',
    me: { clientId: 'me', nick: 'me', color: '#ffffff', device: 'desktop' },
    ratio: '1:1',
    level: 0,
  });
  r.me.slot = 1;
  const d = new StrokeDisplay(r, { delayMs: 90, spreadMs: 60, backlogCells: 40, ...smooth });
  r.display = d;
  return { r, d };
}

const truth = (r, cells) => cells.map((i) => r.grid.color[i]);
const screen = (d, cells) => cells.map((i) => d.cells[i]);

test('a remote burst is true immediately and drawn slowly', () => {
  const { r, d } = makeRoom();
  const t0 = r.clock.now();
  const cells = [0, 1, 2, 3];
  r._onOp({ from: 'other', k: 'op', c: 4, seq: 7, rt: t0, cells: indicesToB64(cells) }, 2);

  assert.deepEqual(truth(r, cells), [4, 4, 4, 4], 'the grid never waits');
  assert.deepEqual(screen(d, cells), [0, 0, 0, 0], 'the screen is still behind');

  d.tick(t0 + 50);
  assert.deepEqual(screen(d, cells), [0, 0, 0, 0], 'still inside the delay');

  d.tick(t0 + 100); // 10 ms into a 60 ms spread
  const shown = screen(d, cells).filter((v) => v === 4).length;
  assert.ok(shown > 0 && shown < 4, `expected a partial line, got ${shown}/4`);

  d.tick(t0 + 200);
  assert.deepEqual(screen(d, cells), [4, 4, 4, 4], 'the picture finishes');
});

test('our own stroke is true and visible on the same call', () => {
  const { r, d } = makeRoom();
  r.paint([5], 9);
  assert.equal(r.grid.color[5], 9);
  assert.equal(d.cells[5], 9, 'the pen must never be smoothed');
});

test('a slow-revealed cell shows whatever is true when it is revealed', () => {
  const { r, d } = makeRoom();
  const t0 = r.clock.now();
  r._onOp({ from: 'other', k: 'op', c: 3, seq: 5, rt: t0, cells: indicesToB64([8]) }, 2);
  r.paintLocal([8], 11, 6); // someone paints over it first

  d.tick(t0 + 500);
  assert.equal(d.cells[8], 11, 'no stale pixel can be left on screen');
  assert.equal(r.grid.color[8], 11);
});

test('an erased cell stays erased once revealed', () => {
  const { r, d } = makeRoom();
  const t0 = r.clock.now();
  r.paint([12], 6);
  r._onOp({ from: 'other', k: 'op', c: 0, seq: 9, rt: t0, cells: indicesToB64([12]) }, 2);
  d.tick(t0 + 500);
  assert.equal(r.grid.color[12], 0);
  assert.equal(d.cells[12], 0);
});

test('the picture equals the truth the moment the queue empties', () => {
  const { r, d } = makeRoom();
  const t0 = r.clock.now();
  r._onOp({ from: 'other', k: 'op', c: 4, seq: 1, rt: t0, cells: indicesToB64([0, 1, 2]) }, 2);
  d.tick(t0 + 500);
  assert.equal(d.queue.length, 0);
  assert.deepEqual([...d.cells], [...r.grid.color], 'byte for byte');
});

test('every release reports work done, which is what asks for a repaint', () => {
  const { r, d } = makeRoom();
  const t0 = r.clock.now();
  r._onOp({ from: 'other', k: 'op', c: 4, seq: 2, rt: t0, cells: indicesToB64([0, 1, 2, 3, 4, 5]) }, 2);
  // main.js turns a non-zero return into view.markDirty().
  const first = d.tick(t0 + 100);
  const second = d.tick(t0 + 130);
  assert.ok(first > 0 && first < 6, `a frame should reveal part of it, got ${first}`);
  assert.ok(second > 0 && first + second < 6, `and more next frame, still not all`);
  assert.ok(d.tick(t0 + 160) > 0, 'the remainder lands by due + spread');
  assert.equal(d.queue.length, 0, 'finished');
  assert.equal(d.tick(t0 + 300), 0, 'an idle tick must not ask for a repaint');
});

test('a backlog we cannot drain is drained, not queued forever', () => {
  const { r, d } = makeRoom({ backlogCells: 8 });
  const t0 = r.clock.now();
  for (let i = 0; i < 6; i++) {
    r._onOp({ from: 'other', k: 'op', c: 4, seq: 100 + i, rt: t0, cells: indicesToB64([i, i + 10, i + 20]) }, 2);
  }
  assert.equal(d.waiting, 0);
  assert.equal(d.queue.length, 0);
  assert.deepEqual(screen(d, [0, 1, 2, 3, 4, 5]), [4, 4, 4, 4, 4, 4]);
});

test('an op with no send time is paced from when it arrived', () => {
  const { r, d } = makeRoom();
  r._onOp({ from: 'other', k: 'op', c: 6, seq: 1, cells: indicesToB64([2]) }, 3);
  assert.equal(d.cells[2], 0);
  d.tick(r.clock.now() + 500);
  assert.equal(d.cells[2], 6);
});

test('clearing the board snaps the picture to it', () => {
  const { r, d } = makeRoom();
  r.paint([0, 1, 2], 5);
  const t0 = r.clock.now();
  r._onOp({ from: 'other', k: 'op', c: 4, seq: 3, rt: t0, cells: indicesToB64([6, 7]) }, 2);
  r.clear();
  assert.equal(d.queue.length, 0);
  assert.deepEqual(screen(d, [0, 1, 2, 6, 7]), [0, 0, 0, 0, 0]);
});

test('a board resize reallocates the picture instead of reading past it', () => {
  const { r, d } = makeRoom();
  const before = r.grid.color.length;
  r.setBoard('4:3', 2);
  assert.notEqual(r.grid.color.length, before);
  assert.equal(d.cells.length, r.grid.color.length, 'same size or the copy is garbage');
  assert.deepEqual([...d.cells], [...r.grid.color]);
});

test('a snapshot snaps the picture to it', () => {
  const { r, d } = makeRoom();
  r.paint([0], 7);
  const t0 = r.clock.now();
  r._onOp({ from: 'other', k: 'op', c: 4, seq: 3, rt: t0, cells: indicesToB64([1]) }, 2);
  assert.equal(d.cells[1], 0, 'not on screen yet');

  // A snapshot from elsewhere, where cell 1 is still empty.
  const elsewhere = new Grid(r.grid.w, r.grid.h);
  elsewhere.paint([0], 7, 9, 5);
  r._onSnapshot(elsewhere.toSnapshot(9));

  assert.equal(d.queue.length, 0, 'a snapshot is the whole truth, so stop animating');
  assert.deepEqual([...d.cells], [...r.grid.color], 'picture equals grid, byte for byte');
  assert.equal(d.cells[1], 0, 'nothing pending survives it');
});

test('the host is paced exactly like a guest, on the screen only', () => {
  const { r, d } = makeRoom();
  r.authority = true;
  const t0 = r.clock.now();
  r._onOp({ from: 'other', k: 'op', c: 7, seq: 1, rt: t0, cells: indicesToB64([3]) }, 2);
  assert.equal(r.grid.color[3], 7, 'the authority grid is never behind the wire');
  assert.equal(d.cells[3], 0, 'but it still draws smoothly');
});

test('taking over the room stops animating and matches the truth', () => {
  const { r, d } = makeRoom();
  const t0 = r.clock.now();
  r._onOp({ from: 'other', k: 'op', c: 4, seq: 3, rt: t0, cells: indicesToB64([0, 1, 2, 3, 4]) }, 2);
  d.tick(t0 + 100);
  assert.ok(d.queue.length, 'mid-animation when the host vanished');
  r.roleChanged(true);
  assert.equal(d.queue.length, 0);
  assert.deepEqual([...d.cells], [...r.grid.color], 'a published checksum must match what we hold');
});

/* ---------------- the roster: a link is not a person ---------------- */

function hostRoom(clientId) {
  const r = new Room({
    code: 'TEST',
    me: { clientId, nick: 'host', color: '#ffffff', device: 'desktop' },
    ratio: '1:1',
    level: 0,
  });
  r.me.slot = 1;
  r.authority = true;
  // What connect() does for us in a real room.
  r._roster.set(clientId, {
    id: clientId,
    slot: 1,
    nick: 'host',
    color: '#ffffff',
    device: 'desktop',
    seen: Date.now(),
  });
  return r;
}

test('opening a connection does not invent a player', () => {
  const r = hostRoom('host-1');
  r.handle({ k: 'peer-hello', id: 'hmpaint-g-abc123' }, 'hmpaint-g-abc123');
  assert.equal(r._roster.size, 1, 'just the host');
  assert.equal(r.roster.some((e) => e.nick === 'guest'), false, 'no nameless ghost');
});

test('a player appears once, from their own message, with their name', () => {
  const r = hostRoom('host-1');
  const link = 'hmpaint-g-abc123';
  const me = 'client-77';
  r.handle({ k: 'peer-hello', id: link }, link);
  r.handle({ k: 'hello', from: me, nick: 'Seb', device: 'ipad' }, link);
  assert.equal(r._roster.size, 2, 'host + Seb, nobody else');
  const seb = r._roster.get(me);
  assert.equal(seb.nick, 'Seb');
  assert.equal(seb.device, 'ipad');
});

test('a flapping connection cannot stack up ghosts', () => {
  const r = hostRoom('host-1');
  const link = 'hmpaint-g-abc123';
  const me = 'client-77';
  for (let i = 0; i < 5; i++) {
    r.handle({ k: 'peer-hello', id: link }, link);
    r.handle({ k: 'hello', from: me, nick: 'Seb' }, link);
  }
  assert.equal(r._roster.size, 2);
});

test('closing a link evicts the player behind it', () => {
  const r = hostRoom('host-1');
  const link = 'hmpaint-g-abc123';
  const me = 'client-77';
  r.handle({ k: 'hello', from: me, nick: 'Seb' }, link);
  assert.equal(r._roster.size, 2);
  r.handle({ k: 'peer-gone', id: link }, link);
  assert.equal(r._roster.size, 1, 'Seb left with his connection');
  assert.equal(r._roster.has(me), false);
});

test('traffic keeps a player alive, so nobody blinks off the roster', () => {
  const r = hostRoom('host-1');
  const link = 'hmpaint-g-abc123';
  const me = 'client-77';
  r.handle({ k: 'hello', from: me, nick: 'Seb' }, link);
  const entry = r._roster.get(me);
  entry.seen = Date.now() - 20000; // quiet for 20 s, still under the 24 s cutoff

  r.handle({ k: 'ptr', from: me, p: [] }, link); // they only moved their cursor
  assert.ok(r._roster.get(me).seen > Date.now() - 1000, 'seen was refreshed');

  r._tick();
  assert.equal(r._roster.has(me), true, 'still here');
});

test('a player who goes truly silent is swept, once', () => {
  const r = hostRoom('host-1');
  const me = 'client-77';
  r.handle({ k: 'hello', from: me, nick: 'Seb' }, 'link-1');
  r._roster.get(me).seen = Date.now() - 60000;
  r._tick();
  assert.equal(r._roster.has(me), false);
  r._tick();
  assert.equal(r._roster.size, 1, 'the sweep does not re-announce them');
});

test('a transport event about a link never maps the link to itself', () => {
  const r = hostRoom('host-1');
  const link = 'hmpaint-g-abc123';
  const me = 'client-77';
  r.handle({ k: 'hello', from: me, nick: 'Seb' }, link);
  r.handle({ k: 'peer-gone', id: link }, link); // fromId === msg.id, as the transport sends it
  assert.equal(r._connOwners.has(link), false, 'the event must not re-register the link');
  assert.equal(r._roster.has(me), false, 'and Seb still left with it');
});

test('the host itself is never mapped or swept', () => {
  const r = hostRoom('host-1');
  r.handle({ k: 'profile', from: 'host-1', nick: 'host' }, 'some-link');
  assert.equal(r._connOwners.size, 0, 'a host is not someone behind a link');
  r._roster.get('host-1').seen = Date.now() - 60000;
  r._tick();
  assert.equal(r._roster.has('host-1'), true, 'we never evict ourselves');
});

test('a room with no display still applies ops', () => {
  const r = new Room({
    code: 'TEST',
    me: { clientId: 'me', nick: 'me', color: '#ffffff', device: 'desktop' },
    ratio: '1:1',
    level: 0,
  });
  r.me.slot = 1;
  r._onOp({ from: 'other', k: 'op', c: 7, seq: 1, rt: r.clock.now(), cells: indicesToB64([4]) }, 2);
  assert.equal(r.grid.color[4], 7, 'the relay has no screen and needs none');
});
