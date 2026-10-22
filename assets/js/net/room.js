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
 */

import { Grid } from '../game/grid.js';
import { RoomClock } from './clock.js';
import CONFIG from '../config.js';
import { indicesToB64, b64ToIndices } from '../util.js';
import { dimsFor, isValidRatio, clampLevel, DEFAULTS } from '../presets.js';
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
  constructor({ code, me, ratio = DEFAULTS.ratio, level = DEFAULTS.level, transportFactory = null }) {
    super();
    this.code = code;
    this.me = { clientId: me.clientId, nick: me.nick, color: me.color, device: me.device, slot: null };
    this.clock = new RoomClock();
    this.room = { ratio: isValidRatio(ratio) ? ratio : '1:1', level: clampLevel(level) };
    const d = dimsFor(this.room.ratio, this.room.level);
    this.grid = new Grid(d.w, d.h);
    this.lamport = 0;
    this.status = 'idle';
    this.detail = '';
    this.authority = false;
    this.transport = null;
    // Set by the browser only: paces how remote strokes reach the grid.
    this.pacer = null;
    this._factory = transportFactory;
    this._roster = new Map();
    // slot 0 is reserved (it marks snapshot baselines), players start at 1
    this._slotCounter = 1;
    this._timers = [];
    this._lastHdr = 0;
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
      // Everything we were still animating has to be on the grid before we
      // publish a checksum for it.
      if (this.pacer) this.pacer.flush();
      this._initAuthoritySlots();
      this._broadcastRoster();
      this._send({ k: 'state-hdr', version: this.grid.version, checksum: this.grid.checksum(), seq: this.lamport });
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
      version: this.grid.version,
      checksum: this.grid.checksum(),
      cells: `${this.grid.w}x${this.grid.h}`,
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
  paintLocal(indices, colorIdx, seq) {
    const changed = this.grid.paint(indices, colorIdx, seq, this.me.slot || 0);
    if (changed) this.emit('grid', { local: true, changed });
    return changed;
  }

  /** Broadcast an op that has already been applied locally. */
  sendOp(indices, colorIdx, seq) {
    if (!indices || !indices.length) return 0;
    // Room time at send, so the receiver can replay our rhythm instead of our
    // packet timing. See net/pacer.js.
    return this._send({ k: 'op', c: colorIdx, seq, rt: this.clock.now(), cells: indicesToB64(indices) });
  }

  /** Paint a run of cells and tell the room, in one step. */
  paint(indices, colorIdx) {
    const seq = this.nextSeq();
    const changed = this.paintLocal(indices, colorIdx, seq);
    this.sendOp(indices, colorIdx, seq);
    return changed;
  }

  clear() {
    const seq = this.nextSeq();
    this._dropPaced();
    this.grid.clearAll(seq, this.me.slot || 0);
    this.emit('grid', { local: true, cleared: true });
    this._send({ k: 'clear', seq });
  }

  /** Replace the board with a different Heartopia size. Destructive by design. */
  setBoard(ratio, level) {
    const seq = this.nextSeq();
    this.room = { ratio, level };
    const d = dimsFor(ratio, level);
    this._dropPaced();
    this.grid.resize(d.w, d.h);
    this.grid.clearAll(seq, this.me.slot || 0);
    this.emit('grid', { local: true, cleared: true, resized: true });
    this._send({ k: 'board', ratio, level, seq });
    this.emit('board', { ...this.room });
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
    this._send({ k: 'ptr', p: points });
  }

  /* ------------------------- receiving ------------------------- */

  handle(msg, fromId) {
    if (!msg || typeof msg !== 'object') return;
    if (typeof msg.seq === 'number' && msg.seq > this.lamport) this.lamport = msg.seq;
    const slot = typeof msg.slot === 'number' ? msg.slot : this._slotOf(msg.from || fromId);

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
      case 'board':
        return this._onBoard(msg, slot);
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
        return this.authority ? this._onHello(msg.id, {}) : undefined;
      case 'peer-gone':
        return this.authority ? this._dropClient(msg.id) : undefined;
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
      ...this.grid.toSnapshot(this.lamport),
    });
  }

  _onWelcome(msg) {
    if (msg.slot != null) this.me.slot = msg.slot;
    if (msg.room && isValidRatio(msg.room.ratio)) this.room = { ...msg.room };
    if (msg.roster) this._onRoster(msg.roster);
    if (msg.cells) this._onSnapshot(msg);
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
    Object.assign(e, { nick: msg.nick ?? e.nick, color: msg.color ?? e.color, device: msg.device ?? e.device, seen: Date.now() });
    this.emit('roster', this.roster);
  }

  _onOp(msg, slot) {
    if (msg.from === this.me.clientId) return; // already applied locally
    const cells = b64ToIndices(msg.cells);
    if (!cells.length) return;
    // Guests pace remote strokes so they draw in like they were drawn. The
    // authority applies them straight away: its grid is what every checksum and
    // every late joiner is measured against, and a host sitting 90 ms behind
    // the wire would look desynced to the whole room.
    if (this.pacer && !this.authority) return this.pacer.add(cells, msg, slot);
    this.paintRemote(cells, msg.c | 0, msg.seq | 0, slot);
  }

  /** Apply someone else's cells to our grid, without rebroadcasting. */
  paintRemote(cells, colorIdx, seq, slot) {
    const changed = this.grid.paint(cells, colorIdx, seq, slot);
    if (changed) this.emit('grid', { local: false, changed });
    return changed;
  }

  /** The board just got replaced wholesale - anything still queued is stale. */
  _dropPaced() {
    if (this.pacer) this.pacer.drop();
  }

  _onClear(msg, slot) {
    if (msg.from === this.me.clientId) return;
    this._dropPaced();
    this.grid.clearAll(msg.seq | 0, slot);
    this.emit('grid', { local: false, cleared: true });
  }

  _onBoard(msg, slot) {
    if (msg.from === this.me.clientId) return;
    if (!isValidRatio(msg.ratio)) return;
    this.room = { ratio: msg.ratio, level: clampLevel(msg.level) };
    const d = dimsFor(this.room.ratio, this.room.level);
    this._dropPaced();
    this.grid.resize(d.w, d.h);
    this.grid.clearAll(msg.seq | 0, slot);
    this.emit('grid', { local: false, cleared: true, resized: true });
    this.emit('board', { ...this.room });
  }

  _onSnapshot(msg) {
    try {
      this._dropPaced();
      this.grid.applySnapshot(msg);
      if (typeof msg.seq === 'number' && msg.seq > this.lamport) this.lamport = msg.seq;
      this.emit('grid', { local: false, snapshot: true });
      this.emit('sync', { ok: true });
    } catch (e) {
      console.error('rejected snapshot:', e.message);
      this.emit('sync', { ok: false, error: e.message });
    }
  }

  _onSyncReq(fromId) {
    if (!this.authority || fromId === this.me.clientId) return;
    this._send({ k: 'snapshot', to: fromId, ...this.grid.toSnapshot(this.lamport) });
  }

  _onHdr(msg) {
    if (msg.from === this.me.clientId) return;
    if (!msg.checksum) return;
    if (msg.checksum !== this.grid.checksum()) {
      this.emit('sync', { ok: false, drift: true });
      this._send({ k: 'sync-req' });
    }
  }

  _onPtr(msg, fromId, slot) {
    if (msg.from === this.me.clientId) return;
    this.emit('ptr', { from: fromId, slot, sentAt: msg.ts, points: msg.p || [] });
  }

  /* ------------------------- authority housekeeping ------------------------- */

  _broadcastRoster() {
    if (!this.authority) return;
    this._send({ k: 'roster', roster: this.roster });
    this.emit('roster', this.roster);
  }

  _dropClient(clientId) {
    if (!clientId) return;
    this.emit('leave', { id: clientId });
    if (!this.authority || !this._roster.has(clientId)) return;
    this._roster.delete(clientId);
    this._broadcastRoster();
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
        this._send({ k: 'state-hdr', version: this.grid.version, checksum: this.grid.checksum(), seq: this.lamport });
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
