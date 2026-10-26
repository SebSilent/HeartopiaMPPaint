/*
 * Optional relay server for Heartopia Multiplayer Paint.
 *
 * You do NOT need this to run the game - the site works with serverless
 * peer-to-peer rooms on GitHub Pages alone. Deploy this if you want rooms that
 * stay up after every player leaves, rooms bigger than one laptop can relay, or
 * a fixed server-side clock (the same idea Multiplayer Piano uses).
 *
 * It speaks exactly the same message contract as assets/js/net/transport-peer.js,
 * so the browser code is unchanged either way.
 */

import { WebSocketServer } from 'ws';
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { Design } from '../assets/js/game/design.js';
import { b64ToIndices, indicesToB64 } from '../assets/js/util.js';
import { itemIdForBoard, findItem } from '../assets/js/game/slots.js';
import { isValidRatio, clampLevel } from '../assets/js/presets.js';

const PORT = Number(process.env.PORT || 8787);
const ROOM_PREFIX = 'hmpaint-v1'; // must match CONFIG.prefix
const EMPTY_ROOM_TTL_MS = 10 * 60 * 1000; // keep a room's picture this long after everyone leaves
const IDLE_MEMBER_MS = 45 * 1000;
const TIME_MS = 2000;
const HDR_MS = 8000;
const MAX_MEMBERS = Number(process.env.MAX_MEMBERS || 24);

class RelayRoom {
  constructor(code, ratio, level, item = null) {
    this.code = code;
    this.members = new Map(); // id -> {ws, slot, nick, color, device, seen}
    this.slotCounter = 1; // 0 is reserved for snapshot baselines
    this.lamport = 0;
    // A room is one design: the item, plus one grid per face of it. An old
    // client still announces {ratio, level}, and that maps to a canvas item.
    this.itemId = findItem(item) ? item : itemIdForBoard(isValidRatio(ratio) ? ratio : '1:1', clampLevel(level));
    this.design = new Design(this.itemId);
    this.lastActive = Date.now();
  }

  get grid() {
    return this.design.grid;
  }

  addMember(ws, profile) {
    let m = this.members.get(profile.id);
    if (!m) {
      if (this.members.size >= MAX_MEMBERS) return null;
      m = { id: profile.id, ws, slot: this.slotCounter++, seen: Date.now() };
      this.members.set(profile.id, m);
    } else {
      m.ws = ws; // reconnect replaced the socket; the slot stays put
      m.seen = Date.now();
    }
    Object.assign(m, {
      nick: profile.nick || m.nick || 'player',
      color: profile.color || m.color || '#ea696d',
      device: profile.device || m.device || 'desktop',
      // The palette shade they are painting with, for the player legend. Index 0
      // is a real shade, so this cannot use `||`.
      shade: profile.shade !== undefined ? profile.shade : m.shade ?? null,
    });
    return m;
  }

  roster() {
    return [...this.members.values()]
      .sort((a, b) => a.slot - b.slot)
      // Every field the clients render has to be listed here: `roster()` is a
      // whitelist, and a field left out is dropped without a sound.
      .map(({ id, slot, nick, color, device, shade }) => ({ id, slot, nick, color, device, shade }));
  }

  /**
   * The longest-present member owns the shared design: the lowest slot.
   *
   * Slots are handed out once and survive reconnects, so this is stable, and
   * the role passes on by itself when that member drops - no handover message,
   * no window where nobody may resize. Clients derive the same answer from the
   * roster they already receive, so the two never disagree.
   */
  designHostId() {
    let id = null;
    let slot = Infinity;
    for (const m of this.members.values()) {
      if (m.slot < slot) {
        slot = m.slot;
        id = m.id;
      }
    }
    return id;
  }

  snapshot() {
    return {
      k: 'welcome',
      ...this.design.toSnapshot(this.lamport),
      room: { ...this.design.board, item: this.itemId },
      roster: this.roster(),
    };
  }

  send(ws, obj) {
    if (ws && ws.readyState === 1) {
      try {
        ws.send(JSON.stringify(obj));
      } catch (_) {}
    }
  }

  /** Deliver to everyone except `exceptId`. */
  fanout(obj, exceptId) {
    const text = JSON.stringify(obj);
    for (const m of this.members.values()) {
      if (m.id === exceptId || m.ws.readyState !== 1) continue;
      try {
        m.ws.send(text);
      } catch (_) {}
    }
  }
}

export function createServer(opts = {}) {
  const rooms = new Map();
  const wss = new WebSocketServer({ noServer: true, maxPayload: 512 * 1024 });

  const server = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
      res.end(JSON.stringify({ ok: true, rooms: rooms.size, clients: [...rooms.values()].reduce((n, r) => n + r.members.size, 0) }));
      return;
    }
    res.writeHead(404);
    res.end('Heartopia Multiplayer Paint relay. Connect with a WebSocket to /?room=CODE');
  });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://localhost');
    const code = String(url.searchParams.get('room') || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!code || code.length > 8) {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, url));
  });

  function roomFor(code, ratio, level, item) {
    let r = rooms.get(code);
    if (!r) {
      r = new RelayRoom(code, ratio, level, item);
      rooms.set(code, r);
    }
    r.lastActive = Date.now();
    return r;
  }

  wss.on('connection', (ws, url) => {
    const profile = {
      id: String(url.searchParams.get('id') || '').slice(0, 32),
      nick: String(url.searchParams.get('nick') || '').slice(0, 24),
      color: String(url.searchParams.get('color') || '').slice(0, 9),
      device: String(url.searchParams.get('device') || '').slice(0, 12),
    };
    const code = String(url.searchParams.get('room') || '').toUpperCase();
    if (!profile.id) {
      ws.close(1008, 'missing id');
      return;
    }
    const room = roomFor(
      code,
      url.searchParams.get('ratio') || '1:1',
      Number(url.searchParams.get('level') || 1),
      url.searchParams.get('item') || null
    );
    const member = room.addMember(ws, profile);
    if (!member) {
      ws.send(JSON.stringify({ k: 'full', code }));
      ws.close(1013, 'room full');
      return;
    }

    const me = member;
    ws.isAlive = true;

    // 1. our picture for the joiner, 2. everyone learns the roster
    const snap = room.snapshot();
    room.send(ws, { ...snap, to: me.id, slot: me.slot });
    room.fanout({ k: 'roster', roster: room.roster() }, me.id);
    room.send(ws, { k: 'roster', roster: room.roster() });
    room.send(ws, { k: 'time', t: Date.now(), from: 'relay', ts: Date.now() });

    ws.on('pong', () => {
      ws.isAlive = true;
    });

    ws.on('message', (buf) => {
      let msg;
      try {
        msg = JSON.parse(buf.toString());
      } catch (_) {
        return;
      }
      if (!msg || typeof msg !== 'object') return;
      me.seen = Date.now();
      room.lastActive = Date.now();
      // The relay is the authority on identity: never trust a claimed slot.
      msg.from = me.id;
      msg.slot = me.slot;

      switch (msg.k) {
        case 'hello': {
          room.addMember(ws, { ...profile, nick: msg.nick, color: msg.color, device: msg.device, shade: msg.shade });
          const s = room.snapshot();
          room.send(ws, { ...s, to: me.id, slot: me.slot });
          room.fanout({ k: 'roster', roster: room.roster() }, me.id);
          return;
        }
        case 'sync-req': {
          const s = room.snapshot();
          room.send(ws, { ...s, to: me.id, slot: me.slot });
          return;
        }
        case 'time-req':
          room.send(ws, { k: 'time-res', to: me.id, q: msg.q, t: Date.now(), from: 'relay' });
          return;
        case 'op': {
          const seq = Number(msg.seq) || 0;
          if (seq > room.lamport) room.lamport = seq;
          const face = clampFace(msg.f, room.design.faces.length);
          room.design.paint(b64ToIndices(msg.cells), msg.c | 0, seq, me.slot, face);
          room.fanout(
            { k: 'op', from: me.id, slot: me.slot, ts: msg.ts, f: face, c: msg.c, seq, cells: msg.cells },
            me.id
          );
          return;
        }
        case 'clear': {
          const seq = Number(msg.seq) || 0;
          if (seq > room.lamport) room.lamport = seq;
          room.design.clearAll(seq, me.slot);
          room.fanout({ k: 'clear', from: me.id, slot: me.slot, ts: msg.ts, seq }, me.id);
          return;
        }
        case 'design': {
          const seq = Number(msg.seq) || 0;
          if (seq > room.lamport) room.lamport = seq;
          if (!findItem(msg.item)) return;
          // Only the design host may resize the room. A guest that asks anyway
          // is ignored and handed the real picture back, so a client that
          // applied the change optimistically repairs itself instead of
          // sitting there showing a design nobody else has.
          if (me.id !== room.designHostId()) {
            room.send(ws, { ...room.snapshot(), to: me.id, slot: me.slot });
            return;
          }
          room.itemId = msg.item;
          room.design.setItem(msg.item);
          room.design.clearAll(seq, me.slot);
          room.fanout({ k: 'design', from: me.id, slot: me.slot, ts: msg.ts, seq, item: msg.item }, me.id);
          return;
        }
        // An older client resizes by ratio x level instead of by item.
        case 'board': {
          const seq = Number(msg.seq) || 0;
          if (seq > room.lamport) room.lamport = seq;
          if (!isValidRatio(msg.ratio)) return;
          if (me.id !== room.designHostId()) {
            room.send(ws, { ...room.snapshot(), to: me.id, slot: me.slot });
            return;
          }
          room.itemId = itemIdForBoard(msg.ratio, clampLevel(msg.level));
          room.design.setItem(room.itemId);
          room.design.clearAll(seq, me.slot);
          room.fanout({ k: 'design', from: me.id, slot: me.slot, ts: msg.ts, seq, item: room.itemId }, me.id);
          return;
        }
        case 'guides': {
          const face = clampFace(msg.f, room.design.faces.length);
          room.design.setGuides(face, Array.isArray(msg.lines) ? msg.lines : []);
          room.fanout({ k: 'guides', from: me.id, slot: me.slot, ts: msg.ts, f: face, lines: msg.lines }, me.id);
          return;
        }
        // Block progress is per-face and small; the relay does not need to
        // understand it, it only has to not lose it.
        case 'blocks': {
          const face = clampFace(msg.f, room.design.faces.length);
          room.fanout({ k: 'blocks', from: me.id, slot: me.slot, ts: msg.ts, f: face, flags: msg.flags }, me.id);
          return;
        }
        case 'profile': {
          Object.assign(me, {
            nick: msg.nick ?? me.nick,
            color: msg.color ?? me.color,
            device: msg.device ?? me.device,
            shade: msg.shade ?? me.shade,
          });
          room.fanout({ k: 'roster', roster: room.roster() });
          return;
        }
        case 'ptr':
          room.fanout(
            { k: 'ptr', from: me.id, slot: me.slot, ts: msg.ts, f: clampFace(msg.f, room.design.faces.length), p: msg.p },
            me.id
          );
          return;
        case 'bye':
          drop();
          return;
        default:
          return; // anything unknown is dropped rather than blindly relayed
      }
    });

    function drop() {
      if (!room.members.has(me.id)) return;
      room.members.delete(me.id);
      room.fanout({ k: 'bye', from: me.id, slot: me.slot });
      room.fanout({ k: 'roster', roster: room.roster() });
      room.lastActive = Date.now();
    }

    ws.on('close', drop);
    ws.on('error', drop);
  });

  // Heartbeats + the periodic clock and state header the clients expect.
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [code, room] of rooms) {
      for (const m of [...room.members.values()]) {
        if (now - m.seen > IDLE_MEMBER_MS && m.ws.readyState === 1) {
          try {
            m.ws.ping();
          } catch (_) {}
        }
        if (m.ws.readyState !== 1) {
          room.members.delete(m.id);
          room.fanout({ k: 'bye', from: m.id, slot: m.slot });
        }
      }
      if (!room.members.size) {
        if (now - room.lastActive > EMPTY_ROOM_TTL_MS) rooms.delete(code);
        continue;
      }
      const text = JSON.stringify({ k: 'time', t: Date.now(), from: 'relay', ts: Date.now() });
      const hdr = JSON.stringify({
        k: 'state-hdr',
        from: 'relay',
        ts: Date.now(),
        version: room.design.version,
        checksum: room.design.checksum(),
        seq: room.lamport,
      });
      for (const m of room.members.values()) {
        if (m.ws.readyState !== 1) continue;
        try {
          m.ws.send(text);
        } catch (_) {}
      }
      if (now - (room._lastHdr || 0) > HDR_MS) {
        room._lastHdr = now;
        for (const m of room.members.values()) {
          if (m.ws.readyState !== 1) continue;
          try {
            m.ws.send(hdr);
          } catch (_) {}
        }
      }
    }
  }, TIME_MS);

  server.on('close', () => clearInterval(sweep));

  return { server, rooms, sweep };
}

/** A face index from the wire is untrusted: an old client sends none at all. */
function clampFace(f, n) {
  const i = Number.isFinite(f) ? f | 0 : 0;
  return Math.max(0, Math.min(n - 1, i));
}

/* Only run the listener when this file is executed directly, so the tests can
   import createServer() without opening a port. */
const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const { server, sweep } = createServer();
  server.listen(PORT, () => {
    console.log(`Heartopia paint relay listening on ws://localhost:${PORT}/?room=CODE`);
  });
  const shut = () => {
    clearInterval(sweep);
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', shut);
  process.on('SIGTERM', shut);
}
