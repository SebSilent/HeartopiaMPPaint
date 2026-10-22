/*
 * Remote stroke pacing: bursts wait, then paint in. Our own strokes never do.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Room } from '../assets/js/net/room.js';
import { StrokePacer } from '../assets/js/net/pacer.js';
import { indicesToB64 } from '../assets/js/util.js';

function makeRoom(smooth = {}) {
  const r = new Room({
    code: 'TEST',
    me: { clientId: 'me', nick: 'me', color: '#ffffff', device: 'desktop' },
    ratio: '1:1',
    level: 0,
  });
  r.me.slot = 1;
  const p = new StrokePacer(r, { delayMs: 90, spreadMs: 60, backlogCells: 40, ...smooth });
  r.pacer = p;
  return { r, p };
}

test('a remote burst waits its turn before it draws', () => {
  const { r, p } = makeRoom();
  const t0 = r.clock.now();
  p.add([0, 1, 2, 3], { c: 4, seq: 7, rt: t0 }, 2);

  assert.equal(r.grid.color[0], 0, 'nothing should be on the board yet');

  p.tick(t0 + 50);
  assert.equal(r.grid.color[0], 0, 'still inside the delay window');

  p.tick(t0 + 100); // 10 ms into a 60 ms spread: part of the burst
  const drawn = [0, 1, 2, 3].filter((i) => r.grid.color[i] === 4).length;
  assert.ok(drawn > 0 && drawn < 4, `expected a partial line, got ${drawn}/4`);

  p.tick(t0 + 200);
  assert.deepEqual([0, 1, 2, 3].map((i) => r.grid.color[i]), [4, 4, 4, 4], 'the burst finishes');
});

test('our own stroke lands on the same call, not on a timer', () => {
  const { r } = makeRoom();
  r.paint([5], 9);
  assert.equal(r.grid.color[5], 9, 'local prediction must be immediate');
});

test('a late burst cannot overwrite something drawn after it', () => {
  const { r, p } = makeRoom();
  const t0 = r.clock.now();
  p.add([8], { c: 3, seq: 5, rt: t0 }, 2);
  r.paintLocal([8], 11, 6); // newer stamp, same cell

  p.tick(t0 + 500);
  assert.equal(r.grid.color[8], 11, 'the older remote write must be rejected');
});

test('each released slice repaints the board', () => {
  const { r, p } = makeRoom();
  const t0 = r.clock.now();
  let events = 0;
  r.on('grid', (info) => {
    if (!info.local) events++;
  });
  p.add([0, 1, 2, 3, 4, 5], { c: 4, seq: 2, rt: t0 }, 2);
  p.tick(t0 + 100);
  p.tick(t0 + 130);
  assert.ok(events >= 2, `expected a repaint per slice, got ${events}`);
});

test('a backlog we cannot drain is drained, not queued forever', () => {
  const { r, p } = makeRoom({ backlogCells: 8 });
  const t0 = r.clock.now();
  const cells = [];
  for (let i = 0; i < 6; i++) {
    const run = [i, i + 10, i + 20];
    cells.push(...run);
    p.add(run, { c: 4, seq: 100 + i, rt: t0 }, 2);
  }
  assert.equal(p.waiting, 0, 'the forced drain should leave nothing waiting');
  assert.equal(p.queue.length, 0);
  for (const i of cells) assert.equal(r.grid.color[i], 4, 'every cell still got drawn');
});

test('a burst arriving from the wire goes through the pacer', () => {
  const { r } = makeRoom();
  const t0 = r.clock.now();
  r._onOp({ from: 'someone-else', k: 'op', c: 6, seq: 1, rt: t0, cells: indicesToB64([0, 1]) }, 3);
  assert.equal(r.grid.color[0], 0, 'queued, not applied');
  r.pacer.tick(t0 + 500);
  assert.equal(r.grid.color[0], 6);
  assert.equal(r.grid.color[1], 6);
});

test('an op with no send time is paced from when it arrived', () => {
  const { r } = makeRoom();
  r._onOp({ from: 'someone-else', k: 'op', c: 6, seq: 1, cells: indicesToB64([2]) }, 3);
  assert.equal(r.grid.color[2], 0);
  r.pacer.tick(r.clock.now() + 500);
  assert.equal(r.grid.color[2], 6);
});

test('replacing the board forgets what was still queued', () => {
  const { r, p } = makeRoom();
  const t0 = r.clock.now();
  p.add([0, 1, 2], { c: 4, seq: 3, rt: t0 }, 2);
  assert.equal(p.queue.length, 1);

  r.clear();
  assert.equal(p.queue.length, 0, 'a clear must not resurrect paced cells');

  p.add([0, 1, 2], { c: 4, seq: 9, rt: t0 }, 2);
  r.setBoard('4:3', 1);
  assert.equal(p.queue.length, 0, 'stale indices against a new grid size');
});

test('a snapshot drops the queue too', () => {
  const { r, p } = makeRoom();
  p.add([0], { c: 4, seq: 3, rt: r.clock.now() }, 2);
  r._onSnapshot(r.grid.toSnapshot());
  assert.equal(p.queue.length, 0);
});

test('the host applies guest strokes straight away, never on a schedule', () => {
  const { r } = makeRoom();
  r.authority = true; // peer mode: the host tab is also the room authority
  r._onOp({ from: 'other', k: 'op', c: 7, seq: 1, rt: r.clock.now(), cells: indicesToB64([3]) }, 2);
  assert.equal(r.grid.color[3], 7, 'a host that lags the wire looks desynced to everyone');
  assert.equal(r.pacer.queue.length, 0);
});

test('flush draws everything still animating', () => {
  const { r, p } = makeRoom();
  p.add([0, 1, 2, 3, 4], { c: 4, seq: 3, rt: r.clock.now() }, 2);
  assert.equal(r.grid.color[4], 0);
  p.flush();
  assert.equal(p.queue.length, 0);
  assert.deepEqual([0, 1, 2, 3, 4].map((i) => r.grid.color[i]), [4, 4, 4, 4, 4]);
});

test('a relay with no pacer still applies ops straight away', () => {
  const r = new Room({
    code: 'TEST',
    me: { clientId: 'me', nick: 'me', color: '#ffffff', device: 'desktop' },
    ratio: '1:1',
    level: 0,
  });
  r.me.slot = 1;
  r._onOp({ from: 'other', k: 'op', c: 7, seq: 1, rt: r.clock.now(), cells: indicesToB64([4]) }, 2);
  assert.equal(r.grid.color[4], 7, 'the authority must never lag the wire');
});
