/*
 * End-to-end sync test: drives the actual browser Room class (assets/js/net/room.js)
 * against the actual relay server (server/relay.js) over real WebSockets.
 * No mocks - if the protocol or the shared canvas model is broken, this fails.
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import CONFIG from '../assets/js/config.js';
import { Room } from '../assets/js/net/room.js';
import { createServer } from '../server/relay.js';
import { randomId } from '../assets/js/util.js';
import { itemIdForBoard } from '../assets/js/game/slots.js';

const { server, sweep } = createServer();
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
CONFIG.transport = 'ws';
CONFIG.relayUrl = `ws://127.0.0.1:${server.address().port}`;

const open = [];

function makeRoom(code, nick, opts = {}) {
  const room = new Room({
    code,
    me: { clientId: randomId(6), nick, color: '#ea696d', device: 'desktop' },
    ratio: opts.ratio || '1:1',
    level: opts.level ?? 1,
  });
  room.connect();
  open.push(room);
  return room;
}

async function until(fn, what, ms = 4000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    let v;
    try {
      v = fn();
    } catch (_) {
      v = false;
    }
    if (v) return v;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for ${what}`);
}

function events(room, name) {
  const got = [];
  room.on(name, (p) => got.push(p));
  return got;
}

after(() => {
  for (const r of open) {
    try {
      r.close();
    } catch (_) {}
  }
  clearInterval(sweep);
  server.close();
});

test('two players get a slot and never slot 0', async () => {
  const code = 'SLOT1';
  const a = makeRoom(code, 'ada');
  const b = makeRoom(code, 'boris');
  await until(() => a.canPaint && b.canPaint, 'both players to be ready');
  assert.notEqual(a.me.slot, null);
  assert.notEqual(b.me.slot, null);
  assert.notEqual(a.me.slot, 0, 'slot 0 is reserved for snapshot baselines');
  assert.notEqual(b.me.slot, 0);
  assert.notEqual(a.me.slot, b.me.slot);
  assert.equal(a.roster.length, 2);
  assert.equal(b.roster.length, 2);
});

test('a stroke from one player lands on every other player', async () => {
  const code = 'STROKE1';
  const a = makeRoom(code, 'ada');
  const b = makeRoom(code, 'boris');
  const c = makeRoom(code, 'cleo');
  await until(() => a.canPaint && b.canPaint && c.canPaint, 'three players ready');

  const cells = [0, 1, 2, 101, 102];
  a.paint(cells, 42);

  await until(() => b.grid.color[101] === 42 && c.grid.color[101] === 42, 'stroke to fan out');
  assert.equal(b.grid.checksum(), c.grid.checksum());
  assert.equal(a.grid.checksum(), b.grid.checksum(), 'all three agree on the picture');
  assert.equal(c.grid.color[0], 42);
});

test('a player who joins later receives the whole picture', async () => {
  const code = 'LATE1';
  const a = makeRoom(code, 'ada');
  await until(() => a.canPaint, 'first player ready');
  a.paint([5, 6, 50], 77);
  await until(() => a.grid.color[50] === 77, 'local paint');

  const b = makeRoom(code, 'latecomer');
  await until(() => b.canPaint, 'latecomer ready');
  await until(() => b.grid.color[5] === 77 && b.grid.color[50] === 77, 'snapshot to arrive');
  assert.equal(a.grid.checksum(), b.grid.checksum());
});

test('concurrent edits to the same cell converge on every client', async () => {
  const code = 'LWW1';
  const a = makeRoom(code, 'ada');
  const b = makeRoom(code, 'boris');
  await until(() => a.canPaint && b.canPaint, 'two players ready');

  // Same cell, same moment, different colours.
  a.paint([60], 10);
  b.paint([60], 20);

  await until(
    () => a.grid.color[60] === b.grid.color[60] && a.grid.checksum() === b.grid.checksum(),
    'convergence'
  );
  assert.equal(a.grid.checksum(), b.grid.checksum());
});

test('erasing and clearing propagate', async () => {
  const code = 'CLEAR1';
  const a = makeRoom(code, 'ada');
  const b = makeRoom(code, 'boris');
  await until(() => a.canPaint && b.canPaint, 'two players ready');

  a.paint([0, 1, 2], 30);
  await until(() => b.grid.color[1] === 30, 'paint to propagate');
  a.clear();
  await until(() => b.grid.isEmpty(), 'clear to propagate');
  assert.equal(a.grid.checksum(), b.grid.checksum());
});

test('pointer messages carry the sender id and are not echoed back', async () => {
  const code = 'PTR1';
  const a = makeRoom(code, 'ada');
  const b = makeRoom(code, 'boris');
  await until(() => a.canPaint && b.canPaint, 'two players ready');

  const seenB = events(b, 'ptr');
  const seenA = events(a, 'ptr');
  a.sendPointers([[1, 3.5, 4.25, 'pen', 1]]);

  await until(() => seenB.length > 0, 'pointer to arrive at b');
  assert.equal(seenB[0].from, a.me.clientId);
  assert.equal(seenB[0].points[0][3], 'pen');
  assert.equal(seenB[0].points[0][4], 1);
  assert.equal(seenA.length, 0, 'a must not receive its own pointer');
});

test('the room clock converges and reports a sane latency', async () => {
  const code = 'CLK1';
  const a = makeRoom(code, 'ada');
  await until(() => a.canPaint, 'player ready');
  await until(() => a.clock.samples >= 2, 'two clock samples');
  assert.ok(Number.isFinite(a.clock.offset), 'offset is a number');
  assert.ok(a.clock.latencyMs >= 0 && a.clock.latencyMs < 500, `latency looks silly: ${a.clock.latencyMs}`);
  // Room time and local time should be within a few ms on localhost.
  assert.ok(Math.abs(a.clock.now() - Date.now()) < 250);
});

test('a drifted client repairs itself from the relay', async () => {
  const code = 'DRIFT1';
  const a = makeRoom(code, 'ada');
  const b = makeRoom(code, 'boris');
  await until(() => a.canPaint && b.canPaint, 'two players ready');

  a.paint([9], 60);
  await until(() => b.grid.color[9] === 60, 'paint to propagate');

  // Simulate a lost packet: b forgets a pixel that the room still has.
  b.grid.color[9] = 0;
  b.grid.color[100] = 3;
  const syncs = events(b, 'sync');
  assert.notEqual(b.grid.checksum(), a.grid.checksum());

  // The relay publishes a state header every 8s; wait for the repair.
  await until(() => b.grid.color[9] === 60 && b.grid.color[100] === 0, 'automatic repair', 15000);
  assert.equal(b.grid.checksum(), a.grid.checksum());
  assert.ok(syncs.some((s) => s.drift), 'a drift event was reported');
});

test('the board size comes from the room, not from the joiner', async () => {
  const code = 'BOARD1';
  const a = makeRoom(code, 'ada', { ratio: '16:9', level: 2 }); // 100 x 56
  await until(() => a.canPaint, 'host ready');
  assert.equal(a.grid.w, 100);
  assert.equal(a.grid.h, 56);

  const b = makeRoom(code, 'boris', { ratio: '1:1', level: 0 }); // asks for 30x30
  await until(() => b.canPaint, 'joiner ready');
  await until(() => b.grid.w === 100 && b.grid.h === 56, 'joiner to adopt the room board');
  assert.equal(b.room.ratio, '16:9');
});

test('the design host can resize the room', async () => {
  const code = 'AUTH2';
  const a = makeRoom(code, 'ada', { ratio: '1:1', level: 0 });
  await until(() => a.canPaint, 'host ready');
  const b = makeRoom(code, 'boris', { ratio: '1:1', level: 0 });
  await until(() => b.canPaint, 'guest ready');

  assert.equal(a.isDesignHost, true, 'the first player owns the design');
  assert.equal(a.setItem(itemIdForBoard('16:9', 2)), true);
  await until(() => b.grid.w === 100 && b.grid.h === 56, 'guest to follow the host resize');
});

test('a guest cannot resize the room, and is repaired if it tries', async () => {
  const code = 'AUTH1';
  const a = makeRoom(code, 'ada', { ratio: '16:9', level: 2 }); // 100 x 56
  await until(() => a.canPaint, 'host ready');
  const b = makeRoom(code, 'boris', { ratio: '16:9', level: 2 });
  await until(() => b.canPaint, 'guest ready');
  await until(() => b.grid.w === 100, 'guest to adopt the board');

  a.paint([0, 1, 2], 12);
  await until(() => b.grid.color[2] === 12, 'paint to propagate');

  // A guest that bypasses its own UI is ignored by the relay, which hands the
  // real picture back instead of letting the room go stale.
  b._send({ k: 'design', item: itemIdForBoard('1:1', 0), seq: b.nextSeq() });
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(a.grid.w, 100, 'host board untouched');
  assert.equal(a.grid.color[2], 12, 'the picture survived');
  await until(() => b.grid.w === 100 && b.grid.color[2] === 12, 'guest repaired from the relay');
  assert.equal(a.grid.checksum(), b.grid.checksum());

  // And the guest's own picker is a no-op, so it never desyncs itself.
  assert.equal(b.isDesignHost, false);
  assert.equal(b.setItem(itemIdForBoard('1:1', 0)), false);
  assert.equal(b.grid.w, 100, 'guest did not resize itself');
});

test('the design host role passes to the next player when the host leaves', async () => {
  const code = 'AUTH3';
  const a = makeRoom(code, 'ada', { ratio: '1:1', level: 0 });
  await until(() => a.canPaint, 'host ready');
  const b = makeRoom(code, 'boris', { ratio: '1:1', level: 0 });
  await until(() => b.canPaint, 'guest ready');
  assert.equal(b.isDesignHost, false);

  a.close();
  await until(() => b.isDesignHost, 'boris to inherit the design');
  assert.equal(b.setItem(itemIdForBoard('16:9', 2)), true);
  await until(() => b.grid.w === 100, 'boris to resize the room');
});

test('unknown message types are dropped instead of relayed', async () => {
  const code = 'SAFE1';
  const a = makeRoom(code, 'ada');
  await until(() => a.canPaint, 'player ready');
  const before = a.grid.version;
  a._send({ k: 'nonsense', cells: 'AAAA' });
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(a.grid.version, before);
});
