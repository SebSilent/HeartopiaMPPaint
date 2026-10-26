/*
 * Serverless (peer) path protocol test.
 *
 * The default transport is WebRTC, which cannot run in Node. But the *protocol*
 * on top of it - host assigns slots, host relays guest traffic, host answers
 * sync requests, host hands over when it dies - is plain room.js logic and can
 * be driven by a fake star transport that mirrors transport-peer.js exactly.
 *
 * This is the code that runs for every player who joins without a relay server,
 * so it is worth covering.
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { Room } from '../assets/js/net/room.js';
import { randomId } from '../assets/js/util.js';
import { itemIdForBoard } from '../assets/js/game/slots.js';

/** Mirrors the WebRTC star: one host, everyone else reaches them through it. */
class Mesh {
  constructor() {
    this.rooms = new Map();
    this.live = [];
  }

  room(code) {
    if (!this.rooms.has(code)) this.rooms.set(code, { host: null, guests: [] });
    return this.rooms.get(code);
  }

  factory() {
    return ({ roomCode, me, onMessage, onStatus, onAuthority, board }) => {
      const room = this.room(roomCode);
      const t = {
        kind: 'peer',
        me,
        room,
        code: roomCode,
        isAuthority: false,
        closed: false,
        handlers: { onMessage, onStatus, onAuthority },
        receive(msg, fromId) {
          if (t.closed) return;
          t.handlers.onMessage(structuredClone(msg), fromId);
        },
        send(obj) {
          if (t.closed) return 0;
          let n = 0;
          if (t.isAuthority) {
            for (const g of room.guests) {
              if (g !== t && !g.closed) {
                g.receive(obj, obj.from);
                n++;
              }
            }
          } else {
            const host = room.host;
            if (!host || host.closed) return 0;
            host.receive(obj, obj.from);
            for (const g of room.guests) {
              if (g !== t && g !== host && !g.closed) {
                g.receive(obj, obj.from); // host relays to the other guests
                n++;
              }
            }
            n++;
          }
          return n;
        },
        close() {
          t.closed = true;
          if (room.host === t) room.host = null;
          room.guests = room.guests.filter((g) => g !== t);
        },
        peerCount() {
          return room.guests.length;
        },
      };

      if (!room.host) {
        room.host = t;
        t.isAuthority = true;
      } else {
        room.guests.push(t);
      }
      this.live.push(t);

      // Real transports are asynchronous; so are the callbacks they fire.
      queueMicrotask(() => {
        if (t.closed) return;
        t.handlers.onStatus('online', t.isAuthority ? 'host' : 'guest');
        if (t.isAuthority) t.handlers.onAuthority(true);
        else {
          if (room.host && !room.host.closed) {
            room.host.receive({ k: 'peer-hello', id: me.clientId }, me.clientId);
          }
        }
      });
      return t;
    };
  }

  /** The host tab vanishes: one guest wins the re-claim race, the rest reconnect. */
  killHost(code) {
    const room = this.room(code);
    const dead = room.host;
    if (!dead) throw new Error('no host to kill');
    dead.close();
    const winner = room.guests[0];
    if (!winner) return null;
    room.guests = room.guests.filter((g) => g !== winner);
    room.host = winner;
    winner.isAuthority = true;
    winner.handlers.onAuthority(true);
    for (const g of room.guests) g.handlers.onStatus('online', 'guest');
    return winner;
  }
}

const mesh = new Mesh();
const rooms = [];

function join(code, nick, opts = {}) {
  const r = new Room({
    code,
    me: { clientId: randomId(6), nick, color: '#ea696d', device: 'desktop', shade: opts.shade ?? null },
    ratio: opts.ratio || '1:1',
    level: opts.level ?? 0,
    transportFactory: mesh.factory(),
  });
  r.connect();
  rooms.push(r);
  return r;
}

async function until(fn, what, ms = 2000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    let v;
    try {
      v = fn();
    } catch (_) {
      v = false;
    }
    if (v) return v;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}

after(() => {
  for (const r of rooms) {
    try {
      r.close();
    } catch (_) {}
  }
});

test('the first player becomes host and the next gets a slot and the picture', async () => {
  const code = 'P2P1';
  const a = join(code, 'ada');
  await until(() => a.authority && a.canPaint, 'a to host');
  assert.equal(a.me.slot, 1, 'slot 0 stays reserved');

  a.paint([3, 4], 55);
  const b = join(code, 'boris');
  await until(() => b.canPaint, 'b to be ready');
  await until(() => b.grid.color[3] === 55, 'snapshot to reach b');

  assert.equal(b.authority, false);
  assert.equal(b.me.slot, 2);
  assert.equal(a.grid.checksum(), b.grid.checksum());
});

test('guest-to-guest traffic is relayed by the host and not echoed back', async () => {
  const code = 'P2P2';
  const host = join(code, 'host');
  await until(() => host.canPaint, 'host ready');
  const a = join(code, 'ada');
  const b = join(code, 'boris');
  await until(() => a.canPaint && b.canPaint, 'both guests ready');

  const seenByHost = [];
  const seenByB = [];
  const seenByA = [];
  a.on('grid', (i) => seenByA.push(i));
  b.on('grid', (i) => seenByB.push(i));
  host.on('grid', (i) => seenByHost.push(i));

  a.paint([10, 11], 20);

  await until(() => b.grid.color[11] === 20, 'b to see a stroke from a fellow guest');
  assert.equal(host.grid.color[11], 20);
  assert.equal(a.grid.color[11], 20);
  // nobody receives their own op back
  assert.equal(seenByA.filter((e) => !e.local).length, 0);
  assert.equal(a.grid.checksum(), b.grid.checksum());
  assert.equal(a.grid.checksum(), host.grid.checksum());
});

test('the roster reaches everyone and names show up', async () => {
  const code = 'P2P3';
  const host = join(code, 'host');
  await until(() => host.canPaint, 'host ready');
  const a = join(code, 'ada');
  await until(() => a.canPaint, 'guest ready');
  await until(() => host.roster.length === 2 && a.roster.length === 2, 'roster to converge');
  assert.deepEqual(
    host.roster.map((p) => p.nick).sort(),
    ['ada', 'host']
  );
  assert.notDeepEqual(host.roster[0].slot, undefined);
});

test('the shade travels on hello, and black is never read as none', async () => {
  const code = 'P2P5';
  // Seeded at the constructor: a player who joins already holding a shade must
  // show it without having to click anything.
  const host = join(code, 'host', { shade: 7 });
  await until(() => host.canPaint, 'host ready');
  const a = join(code, 'ada');
  await until(() => a.canPaint, 'guest ready');
  await until(() => a.roster.find((p) => p.nick === 'host')?.shade === 7, "the hello shade to reach ada");

  // 0 is black. A `||` anywhere on this path shows nothing for the most common
  // first colour in the palette.
  a.setProfile({ shade: 0 });
  await until(() => host.roster.find((p) => p.id === a.me.clientId)?.shade === 0, 'black to reach the host');
  assert.equal(host.roster.find((p) => p.nick === 'ada').shade, 0);
  assert.equal(host.roster.find((p) => p.nick === 'host').shade, 7, 'each player keeps their own shade');
});

test('guests adopt the host clock, so remote events land on one timeline', async () => {
  const code = 'P2P4';
  const host = join(code, 'host');
  await until(() => host.canPaint, 'host ready');
  const a = join(code, 'ada');
  await until(() => a.canPaint, 'guest ready');

  // Same machine, so the offset should start out tiny.
  await until(() => a.clock.samples >= 1, 'a clock reply');
  assert.ok(Math.abs(a.clock.offset) < 100, `unexpected offset on localhost: ${a.clock.offset}`);

  // Now pretend the host's wall clock is five seconds ahead. It stamps replies
  // with Date.now(), so skew the stamp where it is produced.
  const realSend = host.transport.send.bind(host.transport);
  host.transport.send = (obj) => {
    if (obj && obj.k === 'time-res') obj = { ...obj, t: obj.t + 5000 };
    return realSend(obj);
  };

  // The room clock only re-asks every CONFIG.timings.timeSyncMs, so allow for
  // a full sync cycle here rather than pretending it is instant.
  await until(() => Math.abs(a.clock.offset - 5000) < 50, 'the guest to follow the host clock', 6000);
  assert.ok(a.clock.latencyMs !== null, 'latency is reported');
  assert.ok(a.clock.synced, 'the guest considers itself time-synced');
  // Room time, not local time, is what cursor playback uses.
  assert.ok(Math.abs(a.clock.now() - (Date.now() + 5000)) < 60);
  host.transport.send = realSend;
});

test('a newcomer after a host handover still gets the real picture', async () => {
  const code = 'P2P5';
  const host = join(code, 'host');
  await until(() => host.canPaint, 'host ready');
  const a = join(code, 'ada');
  await until(() => a.canPaint, 'guest ready');

  a.paint([7, 8, 9], 33);
  await until(() => host.grid.color[9] === 33, 'paint to reach the host');

  // The host tab closes.
  const promoted = mesh.killHost(code);
  const winnerRoom = rooms.find((r) => r.transport === promoted);
  assert.ok(winnerRoom, 'the promoted transport belongs to a known room');
  await until(() => winnerRoom.authority, 'promoted guest to take over');

  const late = join(code, 'late');
  await until(() => late.canPaint, 'late joiner ready');
  await until(() => late.grid.color[7] === 33 && late.grid.color[9] === 33, 'late joiner to get the picture');
  assert.equal(late.grid.checksum(), a.grid.checksum(), 'the painting survived the host swap');
});

test('a guest cannot resize the room in peer mode either', async () => {
  const code = 'P2P7';
  const host = join(code, 'host', { ratio: '16:9', level: 2 }); // 100 x 56
  await until(() => host.canPaint, 'host ready');
  const a = join(code, 'ada', { ratio: '16:9', level: 2 });
  await until(() => a.canPaint, 'guest ready');
  await until(() => a.grid.w === 100, 'guest to adopt the board');

  host.paint([4], 21);
  await until(() => a.grid.color[4] === 21, 'paint to propagate');

  // Bypass the local check: the host must still refuse to apply it.
  a._send({ k: 'design', item: itemIdForBoard('1:1', 0), seq: a.nextSeq() });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(host.grid.w, 100, 'host board untouched');
  assert.equal(host.grid.color[4], 21, 'the picture survived');
  assert.equal(a.grid.w, 100);

  assert.equal(a.isDesignHost, false, 'the host owns the design');
  assert.equal(a.setItem(itemIdForBoard('1:1', 0)), false);
  assert.equal(a.grid.w, 100, 'guest did not resize itself');
});

test('a guest that paints before it has a slot is still safe', async () => {
  const code = 'P2P6';
  const host = join(code, 'host');
  await until(() => host.canPaint, 'host ready');
  const a = join(code, 'ada');
  assert.equal(a.canPaint, false, 'not paintable before the welcome');
  a.paint([1], 44); // must not throw
  await until(() => a.canPaint, 'welcome');
  assert.equal(a.me.slot, 2);
});
