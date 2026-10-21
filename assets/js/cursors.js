/*
 * Live cursors.
 *
 * Each remote pointer (mouse, Apple Pencil, finger - and every finger on a
 * multitouch screen separately) keeps a short history of positions stamped on
 * the room clock. We then draw the whole room at `now - renderDelay`, so
 * packets that arrive out of order or in bursts still play back in the right
 * order for everybody. That delay is the whole trick behind "always in sync":
 * a small, identical buffer on every screen instead of a jagged live feed.
 */

import CONFIG from './config.js';
import { rgbaStr as hexA, readableInk as readableOn } from './util.js';

const SAMPLE_TTL = 1200; // ms of history kept per pointer
const POINTER_TTL = 2500; // idle pointer disappears
const CLIENT_TTL = 6000; // idle player disappears

export class Cursors {
  constructor({ room }) {
    this.room = room;
    this.clients = new Map(); // clientId -> { nick, color, device, pointers: Map }
    this.visible = true;
    this._off = [];
    this._bind();
  }

  _bind() {
    const r = this.room;
    this._off.push(
      r.on('ptr', (ev) => this._onPtr(ev)),
      r.on('leave', ({ id }) => this.clients.delete(id)),
      r.on('roster', (roster) => {
        for (const e of roster) {
          const c = this.clients.get(e.id);
          if (c) {
            c.nick = e.nick;
            c.color = e.color;
            c.device = e.device;
          }
        }
      })
    );
  }

  destroy() {
    for (const off of this._off) off();
    this._off = [];
  }

  _client(id, slot) {
    let c = this.clients.get(id);
    if (!c) {
      const known = this.room._roster?.get(id);
      c = {
        id,
        slot,
        nick: known?.nick || 'player',
        color: known?.color || '#ea696d',
        device: known?.device || 'desktop',
        pointers: new Map(),
        seen: Date.now(),
      };
      this.clients.set(id, c);
    }
    c.seen = Date.now();
    return c;
  }

  _onPtr(ev) {
    const c = this._client(ev.from, ev.slot);
    const offset = this.room.clock.offset;
    const base = (ev.sentAt || Date.now()) + offset;
    for (const p of ev.points || []) {
      if (!Array.isArray(p) || p.length < 4) continue;
      const [pid, x, y, type, down] = p;
      let s = c.pointers.get(pid);
      if (!s) {
        s = { pid, samples: [], type: 'mouse', down: false };
        c.pointers.set(pid, s);
      }
      s.type = type || s.type;
      s.down = !!down;
      s.t = base;
      s.samples.push({ x, y, t: base });
      if (s.samples.length > 24) s.samples.shift();
    }
  }

  /** Draw every remote pointer at the room's playback time. */
  draw(ctx, view) {
    if (!this.visible) return;
    const playT = this.room.clock.now() - CONFIG.timings.renderDelayMs;
    const now = Date.now();

    for (const [cid, c] of this.clients) {
      if (now - c.seen > CLIENT_TTL) {
        this.clients.delete(cid);
        continue;
      }
      for (const [pid, s] of c.pointers) {
        // drop dead history
        while (s.samples.length && playT - s.samples[0].t > SAMPLE_TTL) s.samples.shift();
        if (!s.samples.length) {
          if (now - s.t > POINTER_TTL) c.pointers.delete(pid);
          continue;
        }
        const pos = interpolate(s.samples, playT);
        if (!pos) continue;
        const p = view.toScreen(pos.x, pos.y);
        drawPointer(ctx, {
          x: p.x,
          y: p.y,
          type: s.type || c.device,
          down: s.down,
          color: c.color,
          nick: c.nick,
          scale: view.scale,
          t: playT,
        });
      }
    }
  }
}

/** Binary search-ish bracket then lerp. Samples arrive in room-time order. */
export function interpolate(samples, t) {
  const n = samples.length;
  if (!n) return null;
  if (t <= samples[0].t) return samples[0];
  if (t >= samples[n - 1].t) {
    // Past the last packet: hold at the newest position rather than teleport.
    return samples[n - 1];
  }
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (samples[mid].t <= t) lo = mid;
    else hi = mid;
  }
  const a = samples[lo];
  const b = samples[hi];
  const span = b.t - a.t;
  const f = span > 0 ? (t - a.t) / span : 0;
  return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, t };
}

export function drawPointer(ctx, o) {
  const { x, y, type, down, color, nick, scale } = o;
  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineWidth = 1.5;
  const ink = '#241a10';

  if (type === 'touch') {
    const r = Math.max(7, scale * 0.9);
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = hexA(color, down ? 0.55 : 0.28);
    ctx.fill();
    ctx.strokeStyle = hexA(color, 0.95);
    ctx.stroke();
    if (down) {
      ctx.beginPath();
      ctx.arc(x, y, r + 5, 0, Math.PI * 2);
      ctx.strokeStyle = hexA(color, 0.35);
      ctx.stroke();
    }
  } else if (type === 'pen') {
    ctx.translate(x, y);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(3.5, 9);
    ctx.lineTo(9, 3.5);
    ctx.closePath();
    ctx.fillStyle = hexA(color, 0.95);
    ctx.fill();
    ctx.strokeStyle = ink;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(0, 0, down ? 3 : 2, 0, Math.PI * 2);
    ctx.fillStyle = hexA(color, 0.5);
    ctx.fill();
  } else {
    // mouse: classic arrow, tip at (x,y)
    ctx.translate(x, y);
    const s = 1.15;
    ctx.scale(s, s);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(0, 15);
    ctx.lineTo(4, 11.5);
    ctx.lineTo(7, 17.5);
    ctx.lineTo(9.6, 16.3);
    ctx.lineTo(6.6, 10.4);
    ctx.lineTo(11.5, 10.4);
    ctx.closePath();
    ctx.fillStyle = hexA(color, 0.98);
    ctx.fill();
    ctx.strokeStyle = ink;
    ctx.stroke();
  }
  ctx.restore();

  label(ctx, x, y, nick, color);
}

function label(ctx, x, y, text, color) {
  ctx.save();
  ctx.font = '600 11px ui-rounded, "Segoe UI", system-ui, sans-serif';
  const w = ctx.measureText(text).width;
  const padX = 6;
  const bx = x + 12;
  const by = y + 14;
  roundRect(ctx, bx, by, w + padX * 2, 17, 8);
  ctx.fillStyle = hexA(color, 0.92);
  ctx.fill();
  ctx.strokeStyle = 'rgba(36,26,16,0.35)';
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.fillStyle = readableOn(color);
  ctx.textBaseline = 'middle';
  ctx.fillText(text, bx + padX, by + 9);
  ctx.restore();
}

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}


