/*
 * Regression test for the join-handshake race.
 *
 * The relay answers a join with up to three snapshots (connect-welcome,
 * hello-welcome, sync-req answer) and any of them can still be in flight when
 * the first local stroke goes out. A snapshot that predates an op we already
 * sent cannot contain that op, so adopting it would wipe the stroke - which is
 * exactly what made the fan-out test in relay.test.js flaky under load.
 *
 * Driven through Room.handle() with a fake transport: no server, no timing, so
 * the race is deterministic here. relay.test.js covers the real wire.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Room } from '../assets/js/net/room.js';
import { Design } from '../assets/js/game/design.js';
import { itemIdForBoard } from '../assets/js/game/slots.js';
import { randomId } from '../assets/js/util.js';

function makeRoom() {
  const room = new Room({
    code: 'RACE1',
    me: { clientId: randomId(6), nick: 'ada', color: '#ea696d', device: 'desktop' },
    ratio: '1:1',
    level: 1,
  });
  // A transport that always "sends" (returns 1) and records what left, so
  // _send's seq tracking runs exactly as it does on the real wire.
  room.transport = {
    kind: 'ws',
    isAuthority: false,
    peerCount: () => 1,
    send(obj) {
      sent.push(obj);
      return 1;
    },
  };
  room.status = 'online';
  const sent = [];
  return { room, sent };
}

test('a snapshot older than our own sent stroke cannot wipe it', () => {
  const { room } = makeRoom();

  // Join: the relay's welcome assigns our slot and delivers the empty picture.
  const empty = new Design(itemIdForBoard('1:1', 1));
  room.handle({ k: 'welcome', slot: 1, ...empty.toSnapshot(2) }, 'relay');
  assert.equal(room.me.slot, 1);
  assert.equal(room.design.checksum(), empty.checksum());

  // We paint. The op goes out on the wire (seq 3) before any answer to it.
  room.paint([0, 1, 2], 42);
  assert.equal(room.grid.color[0], 42);

  // The sync-req answer, taken before our stroke, lands late.
  room.handle({ k: 'welcome', slot: 1, ...empty.toSnapshot(2) }, 'relay');
  assert.equal(room.grid.color[0], 42, 'a stale snapshot must not wipe a stroke we already sent');

  // A snapshot that does postdate our op is still adopted - the repair path.
  const merged = new Design(itemIdForBoard('1:1', 1));
  merged.paint([5], 7, 9, 1, 0);
  room.handle({ k: 'snapshot', to: room.me.clientId, ...merged.toSnapshot(9) }, 'relay');
  assert.equal(room.grid.color[5], 7, 'a newer snapshot is still adopted');
});

test('a send the transport refuses does not arm the guard', () => {
  const { room } = makeRoom();
  room.transport.send = () => 0; // socket not open - the op cannot leave

  const empty = new Design(itemIdForBoard('1:1', 1));
  room.handle({ k: 'welcome', slot: 1, ...empty.toSnapshot(2) }, 'relay');
  room.paint([0, 1, 2], 42);
  assert.equal(room.grid.color[0], 42);

  // The op never reached the wire, so the room's picture without it is the
  // truth: the stale welcome is adopted and the undelivered stroke goes with
  // it. Only an op that actually left may veto a snapshot.
  room.handle({ k: 'welcome', slot: 1, ...empty.toSnapshot(2) }, 'relay');
  assert.equal(room.grid.color[0], 0, 'an op that never left cannot veto the wire');
});

test('after a connection drop, snapshots are adopted again', () => {
  const { room } = makeRoom();

  const empty = new Design(itemIdForBoard('1:1', 1));
  room.handle({ k: 'welcome', slot: 1, ...empty.toSnapshot(2) }, 'relay');
  room.paint([0, 1, 2], 42);
  assert.equal(room.grid.color[0], 42);

  // The socket dies: ops in flight are unknowable, so we stop refusing and
  // converge to whatever the wire says on reconnect.
  room._onTransportStatus('reconnecting', 'closed(1006)');
  room.handle({ k: 'welcome', slot: 1, ...empty.toSnapshot(2) }, 'relay');
  assert.equal(room.grid.color[0], 0, 'after a drop we converge to the wire');
});