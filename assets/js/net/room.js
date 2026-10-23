/*
 * Room session: the protocol both transports speak, and the only place that
 * knows about canvas state.
 *
 * Roles
 *   authority  - the relay server, or (serverless) the client that owns the
 *                room id. Assigns slots, answers join/sync requests, publishes
 *                the room clock and a periodic state header.
 *   everyone   - applies ops, sends its own strokes and pointer positions.
 *
 * Staying in sync
 *   1. ops are idempotent last-writer-wins (see grid.js), so arrival order
 *      between peers does not matter;
 *   2. a new joiner gets one snapshot and starts from there;
 *   3. the authority publishes version+checksum every few seconds; anyone who
 *      disagrees asks for a fresh snapshot. A lost packet self-heals.
 *
 * What a room holds is a Design: the item everyone is working on, and one grid
 * per face of it. Every op, snapshot and checksum carries a face index, so a
 * guest painting a sleeve and you painting the front are the same mechanism
 * twice, not a special case.
 */

import { Design } from '../game/design.js';
import { RoomClock } from './clock.js';
import CONFIG from '../config.js';
import { indicesToB64, b64ToIndices, b64ToBytes } from '../util.js';
import { itemIdForBoard, boardForItem, findItem } from '../game/slots.js';
import { maskFor } from '../game/faces.js';
import { DEFAULTS } from '../presets.js';
import { createPeerTransport } from './transport-peer.js';
import { createWSTransport } from './transport-ws.js';

class Emitter {
  constructor() {
    this._h = new Map();
  }
  on(evt, fn) {
    if (!this._h.has(evt)) this._h.set(evt, []);
    this._h.get(evt).push(fn);
    return () => this.off(evt, fn);
  }
  off(evt, fn) {
    const a = this._h.get(evt);
    if (a) this._h.set(evt, a.filter((f) => f !== fn));
  }
  emit(evt, payload) {
    for (const fn of this._h.get(evt) || []) {
      try {
        fn(payload);
      } catch (e) {
        console.error(`room:${evt} handler failed`, e);
      }
    }
  }
}

export class Room extends Emitter {
  constructor({
    code,
    me,
    item = null,
    ratio = DEFAULTS.ratio,
    level = DEFAULTS.level,
    transportFactory = null,
  }) {
    super();
    this.code = code;
    this.me = { clientId: me.clientId, nick: me.nick, color: me.color, device: me.device, slot: null };
    this.clock = new RoomClock();
    this.design = new Design(item || itemIdForBoard(ratio, level));
    // The display copy is a browser concern; the relay never makes one.
    this.display = null;
    this.lamport = 0;
    this.status = 'idle';
    this.detail = '';
    this.authority = false;
    this.transport = null;
    // Transport connection id -> clientId. Only a message carrying a real
    // clientId tells us who is on the other end of a link.
    this._connOwners = new Map();
    this._factory = transportFactory;
    this._roster = new Map();
    // slot 0 is reserved (it marks snapshot baselines), players start at 1
    this._slotCounter = 1;
    this._timers = [];
    this._lastHdr = 0;
  }

  /* ------------------------- the board, as read by the view ------------------------- */

  /** The face you are looking at. Everything single-board used to work with. */
  get grid() {
    return this.design.grid;
  }

  get faces() {
    return this.design.faces;
  }

  get face() {
    return this.design.face;
  }

  /** Kept so old links (?room=CODE&ratio=4:3) and the relay's header still work. */
  get room() {
    return { ...this.design.board, item: this.design.id };
  }

  set room(v) {
    if (v && v.item) this.design.setItem(v.item);
    else if (v && v.ratio) this.design.setItem(itemIdForBoard(v.ratio, v.level));
  }

  /* ------------------------- connection ------------------------- */

  connect() {
    const common = {
      roomCode: this.code,
      me: this.me,
      onMessage: (msg, from) => this.handle(msg, from),
      onStatus: (s, detail) => this._onTransportStatus(s, detail),
    };
    // transportFactory exists so the room protocol can be driven by a fake
    // transport in tests; production always takes one of the two real paths.
    if (this._factory) {
      this.transport = this._factory({ ...common, board: this.room, onAuthority: (a) => this.roleChanged(a) });
    } else if (CONFIG.transport === 'ws' && CONFIG.relayUrl) {
      this.transport = createWSTransport({ ...common, url: CONFIG.relayUrl, board: this.room });
    } else {
      this.transport = createPeerTransport({
        ...common,
        onAuthority: (isAuth) => this.roleChanged(isAuth),
      });
    }
    this._roster.set(this.me.clientId, {
      id: this.me.clientId,
      slot: null,
      nick: this.me.nick,
      color: this.me.color,
      device: this.me.device,
      seen: Date.now(),
    });
    this._timers.push(
      setInterval(() => this._sendTimeReq(), CONFIG.timings.timeSyncMs),
      setInterval(() => this._tick(), 1000)
    );
    return this;
  }

  _onTransportStatus(s, detail) {
    this.status = s;
    this.detail = detail || '';
    if (s === 'online') {
      // Announce ourselves; the authority answers with our slot + the picture.
      this._send({ k: 'hello', nick: this.me.nick, color: this.me.color, device: this.me.device });
      if (!this.authority) this._send({ k: 'sync-req' });
      // The interval below cannot fire before the socket opens, so ask now.
      this._sendTimeReq();
    }
    this.emit('status', { status: s, detail });
  }

  roleChanged(isAuth) {
    const now = !!isAuth;
    if (now === this.authority) return;
    this.authority = now;
    if (now) {
      // We inherited the room (host left, we won the re-claim race). Keep the
      // roster we already have and take over numbering from it.
      // Stop animating and match the truth exactly, before publishing a
      // checksum for it.
      if (this.display) this.display.drop();
      this._initAuthoritySlots();
      this._broadcastRoster();
      this._send({ k: 'state-hdr', version: this.design.version, checksum: this.design.checksum(), seq: this.lamport });
    } else {
      this._send({ k: 'hello', nick: this.me.nick, color: this.me.color, device: this.me.device });
      this._send({ k: 'sync-req' });
    }
    this.emit('authority', now);
  }

  /** Take over slot numbering without disturbing slots already in use. */
  _initAuthoritySlots() {
    let max = 0;
    for (const e of this._roster.values()) max = Math.max(max, e.slot || 0);
    this._slotCounter = Math.max(this._slotCounter, max + 1);
    const mine = this._roster.get(this.me.clientId);
    if (mine && mine.slot == null) mine.slot = this._slotCounter++;
    if (this.me.slot == null) this.me.slot = mine ? mine.slot : this._slotCounter++;
  }

  get roster() {
    return [...this._roster.values()].sort((a, b) => a.slot - b.slot);
  }

  get canPaint() {
    return this.me.slot != null && this.status === 'online';
  }

  get stats() {
    return {
      transport: this.transport?.kind || CONFIG.transport,
      role: this.authority ? 'host' : 'guest',
      players: this._roster.size,
      latency: this.clock.latencyMs,
      version: this.design.version,
      checksum: this.design.checksum(),
      cells: `${this.design.w}x${this.design.h}`,
      faces: this.design.faces.length,
      item: this.design.id,
    };
  }

  /* ------------------------- sending ------------------------- */

  _send(obj) {
    if (!this.transport) return 0;
    const msg = { ...obj, from: this.me.clientId, slot: this.me.slot, ts: Date.now() };
    return this.transport.send(msg);
  }

  /** Take a stamp for a new stroke. One stamp per stroke, reused by its batches. */
  nextSeq() {
    return ++this.lamport;
  }

  /** Apply to our own grid without broadcasting (local prediction). */
  paintLocal(indices, colorIdx, seq, faceIdx = this.design.active) {
    const allowed = this._paintable(indices, faceIdx);
    if (!allowed.length) return 0;
    const changed = this.design.paint(allowed, colorIdx, seq, this.me.slot || 0, faceIdx);
    // Your own pen is never made to wait for a schedule.
    if (this.display) this.display.reveal(faceIdx, allowed);
    if (changed) this.emit('grid', { local: true, changed, face: faceIdx });
    return changed;
  }

  /**
   * Drop the cells the game itself refuses to paint. This is the only place the
   * rule is applied, so a local stroke and a received op are filtered by the
   * same code and the two cannot drift apart. Faces with no data (free canvas
   * boards) pass through untouched.
   */
  _paintable(indices, faceIdx) {
    if (!indices || !indices.length) return indices || [];
    const face = this.design.item.faces[faceIdx];
    if (!face) return indices;
    const m = maskFor(this.design.id, face.id);
    if (!m) return indices;
    const keep = [];
    for (const i of indices) if (m[i]) keep.push(i);
    return keep;
  }

  /** Broadcast an op that has already been applied locally. */
  sendOp(indices, colorIdx, seq, faceIdx = this.design.active) {
    if (!indices || !indices.length) return 0;
    // Room time at send, so the receiver can replay our rhythm instead of our
    // packet timing. See net/display.js.
    return this._send({
      k: 'op',
      f: faceIdx,
      c: colorIdx,
      seq,
      rt: this.clock.now(),
      cells: indicesToB64(indices),
    });
  }

  /** Paint a run of cells and tell the room, in one step. */
  paint(indices, colorIdx, faceIdx = this.design.active) {
    const seq = this.nextSeq();
    const changed = this.paintLocal(indices, colorIdx, seq, faceIdx);
    this.sendOp(indices, colorIdx, seq, faceIdx);
    return changed;
  }

  /**
   * Paint cells with per-cell values - what undo/redo and a pasted region need.
   * Still one op, still one stamp.
   */
  paintVaried(indices, values, faceIdx = this.design.active) {
    if (!indices.length) return 0;
    const seq = this.nextSeq();
    const g = this.design.faceAt(faceIdx);
    if (!g) return 0;
    const byColor = new Map();
    for (let i = 0; i < indices.length; i++) {
      const c = values[i] | 0;
      if (!byColor.has(c)) byColor.set(c, []);
      byColor.get(c).push(indices[i]);
    }
    let changed = 0;
    for (const [c, list] of byColor) {
      changed += this.paintLocal(list, c, seq, faceIdx);
      this.sendOp(list, c, seq, faceIdx);
    }
    return changed;
  }

  clear() {
    const seq = this.nextSeq();
    this.design.clearAll(seq, this.me.slot || 0);
    if (this.display) this.display.drop();
    this.emit('grid', { local: true, cleared: true });
    this._send({ k: 'clear', seq });
  }

  /** Switch the whole room to another Heartopia item. Destructive by design. */
  setItem(itemId) {
    if (!findItem(itemId)) return false;
    const seq = this.nextSeq();
    this.design.setItem(itemId);
    if (this.display) this.display.drop();
    this.emit('grid', { local: true, cleared: true, resized: true });
    this._send({ k: 'design', item: itemId, seq });
    this.emit('design', { item: itemId, faces: this.design.item.faces });
    return true;
  }

  /** Resize a canvas design. Same message, so both old and new clients follow. */
  setBoard(ratio, level) {
    return this.setItem(itemIdForBoard(ratio, level));
  }

  /** Which face is on screen. Local-only: nobody needs to know where your camera is. */
  switchFace(i) {
    const before = this.design.active;
    const face = this.design.setActive(i);
    if (before !== this.design.active) {
      if (this.display) this.display.sync(this.design.active);
      this.emit('face', { index: this.design.active, face });
    }
    return face;
  }

  /**
   * Block progress for one face, as a bit-per-block base64 blob. Small (a
   * 256x128 duvet at 5x5 is 1,352 blocks = 1.3 KB) and sent only on a change.
   */
  sendBlocks(faceIdx, flagsB64) {
    this._send({ k: 'blocks', f: faceIdx, flags: flagsB64, seq: this.nextSeq() });
  }

  setProfile(patch) {
    let touched = false;
    for (const key of ['nick', 'color', 'device']) {
      const v = patch[key];
      if (v !== undefined && v !== this.me[key]) {
        this.me[key] = v;
        touched = true;
      }
    }
    if (!touched) return;
    const e = this._roster.get(this.me.clientId);
    if (e) Object.assign(e, { nick: this.me.nick, color: this.me.color, device: this.me.device });
    if (this.authority) this._broadcastRoster();
    this._send({ k: 'profile', nick: this.me.nick, color: this.me.color, device: this.me.device });
    this.emit('self', { ...this.me });
  }

  _sendTimeReq() {
    if (this.transport) this._send({ k: 'time-req', q: Date.now() });
  }

  sendPointers(points) {
    this._send({ k: 'ptr', p: points, f: this.design.active });
  }

  /* ------------------------- receiving ------------------------- */

  handle(msg, fromId) {
    if (!msg || typeof msg !== 'object') return;
    if (typeof msg.seq === 'number' && msg.seq > this.lamport) this.lamport = msg.seq;
    const id = msg.from || fromId;
    const slot = typeof msg.slot === 'number' ? msg.slot : this._slotOf(id);

    if (this.authority && id && id !== this.me.clientId) {
      // Liveness is traffic. Without this, a connected player who stops moving
      // for 24 s is swept off the roster and only comes back when they paint.
      const e = this._roster.get(id);
      if (e) e.seen = Date.now();
      // A link is not a person. A guest's own packets carry its clientId while
      // `fromId` is the transport's id for the connection, so this is where the
      // two get tied together - and the only place we can learn it.
      //
      // Transport events (peer-gone) arrive with both set to the link id, so
      // guard on the id *differing*, not on there being a `from`.
      if (fromId && fromId !== id) this._connOwners.set(fromId, id);
    }

    switch (msg.k) {
      case 'hello':
        return this._onHello(msg.from || fromId, msg);
      case 'welcome':
        if (msg.to && msg.to !== this.me.clientId) return;
        return this._onWelcome(msg);
      case 'roster':
        return this._onRoster(msg.roster);
      case 'profile':
        return this._onProfile(msg.from || fromId, msg);
      case 'op':
        return this._onOp(msg, slot);
      case 'clear':
        return this._onClear(msg, slot);
      case 'design':
        return this._onDesign(msg, slot);
      // Older rooms announced a board resize instead of an item change.
      case 'board':
        return this._onBoard(msg, slot);
      case 'blocks':
        return this._onBlocks(msg);
      case 'snapshot':
        if (msg.to && msg.to !== this.me.clientId) return;
        return this._onSnapshot(msg);
      case 'sync-req':
        return this._onSyncReq(msg.from || fromId);
      case 'state-hdr':
        return this._onHdr(msg);
      case 'ptr':
        return this._onPtr(msg, msg.from || fromId, slot);
      case 'time':
        if (msg.from !== this.me.clientId && msg.t) return this._adoptTime(msg.t, msg.ts);
        return;
      case 'time-req':
        if (this.authority) this._send({ k: 'time-res', to: msg.from || fromId, q: msg.q, t: Date.now() });
        return;
      case 'time-res':
        if (msg.to !== this.me.clientId) return;
        this.clock.applyReply(msg.q, msg.t, Date.now());
        return this.emit('clock', { rtt: this.clock.rtt, offset: this.clock.offset });
      case 'bye':
        return this._dropClient(msg.from || fromId);
      case 'peer-hello':
        // A connection opened. That is not a player: roster entries are only
        // ever made from messages carrying a real clientId. Creating one here
        // put a nameless 'guest' beside every human in the room.
        return;
      case 'peer-gone':
        return this.authority ? this._dropConn(msg.id) : undefined;
      default:
        return;
    }
  }

  _slotOf(clientId) {
    return this._roster.get(clientId)?.slot ?? 0;
  }

  _onHello(clientId, msg) {
    if (!this.authority || !clientId || clientId === this.me.clientId) return;
    if (!this._roster.has(clientId)) {
      if (this._roster.size >= CONFIG.limits.maxRoster) return;
      this._roster.set(clientId, {
        id: clientId,
        slot: this._slotCounter++,
        nick: msg.nick || 'guest',
        color: msg.color || '#ea696d',
        device: msg.device || 'desktop',
        seen: Date.now(),
      });
      this._broadcastRoster();
    } else {
      // Reconnect: refresh identity and hand back the same slot.
      Object.assign(this._roster.get(clientId), {
        nick: msg.nick || this._roster.get(clientId).nick,
        color: msg.color || this._roster.get(clientId).color,
        device: msg.device || this._roster.get(clientId).device,
        seen: Date.now(),
      });
    }
    const entry = this._roster.get(clientId);
    this._send({
      k: 'welcome',
      to: clientId,
      slot: entry.slot,
      room: this.room,
      roster: this.roster,
      ...this.design.toSnapshot(this.lamport),
    });
  }

  _onWelcome(msg) {
    if (msg.slot != null) this.me.slot = msg.slot;
    if (msg.roster) this._onRoster(msg.roster);
    if (msg.faces) this._onSnapshot(msg);
    else if (msg.room && msg.room.item) this.design.setItem(msg.room.item);
    this.emit('ready', { slot: this.me.slot, room: { ...this.room } });
  }

  _onRoster(roster) {
    if (!Array.isArray(roster)) return;
    const prev = this._roster;
    this._roster = new Map();
    for (const r of roster.slice(0, CONFIG.limits.maxRoster)) {
      if (!r || !r.id) continue;
      this._roster.set(r.id, { seen: prev.get(r.id)?.seen ?? Date.now(), ...r });
    }
    const mine = this._roster.get(this.me.clientId);
    if (mine && mine.slot != null) this.me.slot = mine.slot;
    this.emit('roster', this.roster);
  }

  _onProfile(clientId, msg) {
    const e = this._roster.get(clientId);
    if (!e) return;
    Object.assign(e, {
      nick: msg.nick ?? e.nick,
      color: msg.color ?? e.color,
      device: msg.device ?? e.device,
      seen: Date.now(),
    });
    this.emit('roster', this.roster);
  }

  _onOp(msg, slot) {
    if (msg.from === this.me.clientId) return; // already applied locally
    const face = clampFace(msg.f, this.design.faces.length);
    const cells = b64ToIndices(msg.cells);
    if (!cells.length) return;
    // Truth first, on every machine: the grid always matches the wire the
    // instant a packet lands, so checksums and snapshots stay correct whether
    // or not anything is still being animated.
    const changed = this.design.paint(cells, msg.c | 0, msg.seq | 0, slot, face);
    // Then the screen, which is allowed to take its time catching up.
    if (this.display && changed) this.display.add(face, cells, msg);
    if (changed) this.emit('grid', { local: false, changed, face });
  }

  /** Apply someone else's cells to a grid, without rebroadcasting. */
  paintRemote(cells, colorIdx, seq, slot, faceIdx = this.design.active) {
    const changed = this.design.paint(cells, colorIdx, seq, slot, faceIdx);
    if (changed) this.emit('grid', { local: false, changed, face: faceIdx });
    return changed;
  }

  _onClear(msg, slot) {
    if (msg.from === this.me.clientId) return;
    this.design.clearAll(msg.seq | 0, slot);
    if (this.display) this.display.drop();
    this.emit('grid', { local: false, cleared: true });
  }

  _onDesign(msg, slot) {
    if (msg.from === this.me.clientId) return;
    if (!findItem(msg.item)) return;
    this.design.setItem(msg.item);
    this.design.clearAll(msg.seq | 0, slot);
    if (this.display) this.display.drop();
    this.emit('grid', { local: false, cleared: true, resized: true });
    this.emit('design', { item: msg.item, faces: this.design.item.faces });
  }

  /** Legacy: a peer that only knows ratio x level. */
  _onBoard(msg, slot) {
    if (msg.from === this.me.clientId) return;
    this._onDesign({ from: msg.from, item: itemIdForBoard(msg.ratio, msg.level), seq: msg.seq }, slot);
  }

  _onBlocks(msg) {
    if (msg.from === this.me.clientId) return;
    const face = clampFace(msg.f, this.design.faces.length);
    let flags;
    try {
      flags = b64ToBytes(msg.flags);
    } catch (_) {
      return;
    }
    if (!flags.length) return;
    this.emit('blocks', { face, flags });
  }

  _onSnapshot(msg) {
    try {
      this.design.applySnapshot(msg);
      if (typeof msg.seq === 'number' && msg.seq > this.lamport) this.lamport = msg.seq;
      // A snapshot is the whole truth: the screen stops animating and matches it.
      if (this.display) this.display.drop();
      this.emit('grid', { local: false, snapshot: true, resized: true });
      this.emit('sync', { ok: true });
    } catch (e) {
      console.error('rejected snapshot:', e.message);
      this.emit('sync', { ok: false, error: e.message });
    }
  }

  _onSyncReq(fromId) {
    if (!this.authority || fromId === this.me.clientId) return;
    this._send({ k: 'snapshot', to: fromId, ...this.design.toSnapshot(this.lamport) });
  }

  _onHdr(msg) {
    if (msg.from === this.me.clientId) return;
    if (!msg.checksum) return;
    if (msg.checksum !== this.design.checksum()) {
      this.emit('sync', { ok: false, drift: true });
      this._send({ k: 'sync-req' });
    }
  }

  _onPtr(msg, fromId, slot) {
    if (msg.from === this.me.clientId) return;
    this.emit('ptr', {
      from: fromId,
      slot,
      sentAt: msg.ts,
      face: clampFace(msg.f, this.design.faces.length),
      points: msg.p || [],
    });
  }

  /* ------------------------- authority housekeeping ------------------------- */

  _broadcastRoster() {
    if (!this.authority) return;
    this._send({ k: 'roster', roster: this.roster });
    this.emit('roster', this.roster);
  }

  _dropClient(clientId) {
    if (!clientId) return;
    for (const [conn, owner] of this._connOwners) if (owner === clientId) this._connOwners.delete(conn);
    this.emit('leave', { id: clientId });
    if (!this.authority || !this._roster.has(clientId)) return;
    this._roster.delete(clientId);
    this._broadcastRoster();
  }

  /** A link closed: evict whoever was talking over it, not the link's own id. */
  _dropConn(transportId) {
    if (!transportId) return;
    const clientId = this._connOwners.get(transportId);
    this._connOwners.delete(transportId);
    if (clientId) this._dropClient(clientId);
  }

  _tick() {
    if (this.transport) {
      const isAuth = !!this.transport.isAuthority;
      if (isAuth !== this.authority) this.roleChanged(isAuth);
    }
    if (this.authority) {
      const cutoff = Date.now() - CONFIG.timings.hostTimeoutMs * 2;
      let pruned = false;
      for (const [id, e] of this._roster) {
        if (id !== this.me.clientId && e.seen < cutoff) {
          this._roster.delete(id);
          pruned = true;
        }
      }
      if (pruned) this._broadcastRoster();
      this._send({ k: 'time', t: Date.now() });
      if (Date.now() - this._lastHdr >= CONFIG.timings.repairMs) {
        this._lastHdr = Date.now();
        this._send({
          k: 'state-hdr',
          version: this.design.version,
          checksum: this.design.checksum(),
          seq: this.lamport,
        });
      }
    } else {
      // Nobody to ask yet? Keep nudging until we have a slot.
      if (this.me.slot == null && this.status === 'online') {
        this._send({ k: 'hello', nick: this.me.nick, color: this.me.color, device: this.me.device });
      }
    }
    this.emit('tick');
  }

  /**
   * Unsolicited time heartbeat from the authority. There is no request to
   * match, so compare against when it says it sent it.
   */
  _adoptTime(authorityTime, sentAt) {
    const offset = authorityTime - (sentAt || Date.now());
    if (Math.abs(offset) <= 2) return; // clocks already agree
    if (!this.clock.synced) this.clock.offset = offset;
    else this.clock.offset = this.clock.offset * 0.9 + offset * 0.1;
  }

  /* ------------------------- teardown ------------------------- */

  leave() {
    this._send({ k: 'bye' });
    this.close();
  }

  close() {
    for (const t of this._timers) clearInterval(t);
    this._timers = [];
    if (this.transport) this.transport.close();
    this.status = 'offline';
  }
}

/** A face index from the wire is untrusted: an old peer sends none, a bad one sends anything. */
function clampFace(f, n) {
  const i = Number.isFinite(f) ? f | 0 : 0;
  return Math.max(0, Math.min(n - 1, i));
}

export { boardForItem };
