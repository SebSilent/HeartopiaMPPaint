/*
 * Boot: profile -> nickname gate -> room -> view/input/cursors.
 */

import CONFIG from './config.js';
import { Room } from './net/room.js';
import { View } from './view.js';
import { Cursors } from './cursors.js';
import { Input, TOOLS } from './input.js';
import { StrokeDisplay } from './net/display.js';
import { UI, cleanNick, validateNick, groupForIndex } from './ui.js';
import { FLAT_COLORS, HEARTOPIA_GROUPS } from './data/heartopia-palette.js';
import { BRUSH_SIZES, DEFAULTS, dimsFor } from './presets.js';
import { makeRoomCode, normalizeRoomCode, detectDevice, clamp } from './util.js';

const STORE = 'hmpaint.profile.v1';

function loadProfile() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE) || '{}');
    if (raw.nick && raw.color) return raw;
  } catch (_) {}
  return {};
}

function saveProfile(p) {
  try {
    localStorage.setItem(STORE, JSON.stringify(p));
  } catch (_) {}
}

const params = new URLSearchParams(location.search);
const profile = loadProfile();

const state = {
  nick: cleanNick(profile.nick || ''),
  color: profile.color || HEARTOPIA_GROUPS[(Math.random() * HEARTOPIA_GROUPS.length) | 0].main,
  ratio: DEFAULTS.ratio,
  level: DEFAULTS.level,
  tool: TOOLS.BRUSH,
  colorIdx: 16, // a warm mid-tone that reads well on the paper
  colorHex: FLAT_COLORS[16],
  brush: 1,
  brushSizes: BRUSH_SIZES,
  showGrid: true,
  groupIndex: null,
  roomPlayers: 1,
};

let room = null;
let view = null;
let cursors = null;
let input = null;

const actions = {
  onLayout: () => layout(),
  setTool: (t) => {
    ui.setTool(t);
    state.tool = t;
  },
  setBrush: (s) => {
    ui.setBrush(s);
    state.brush = s;
  },
  setColor: (idx) => ui.setColorIdx(idx),
  setGridVisible: (v) => {
    if (view) view.showGrid = v;
  },
  zoom: (f) => {
    if (view) {
      view.zoomBy(f);
      ui.setZoom(view.zoomPercent);
    }
  },
  fit: () => {
    if (view) {
      view.fit();
      ui.setZoom(view.zoomPercent);
    }
  },
  copyInvite: () => copyInvite(),
  exportPNG: () => exportPNG(),
  clearBoard: () => clearBoard(),
  setBoard: (ratio, level) => setBoard(ratio, level),
  leave: () => leaveRoom(),
};

const ui = new UI({
  state,
  actions,
  onJoin: (p) => startRoom(p),
});

/* ---------------- join ---------------- */

function startRoom({ nick, color, device, room: code, ratio, level }) {
  const err = validateNick(nick);
  if (err) {
    ui.toast(err, 'warn');
    return;
  }
  state.nick = nick;
  state.color = color;
  saveProfile({ nick, color, device });

  room = new Room({
    code,
    me: { clientId: CONFIG.clientId, nick, color, device },
    ratio,
    level,
  });

  ui.setLocked(true, 'Waiting for the room…');
  room.connect();
  wireRoom(room);
  mount(room);
  ui.setRoom(code);
  ui.closeGate();
  history.replaceState(null, '', `?room=${code}`);
}

/**
 * Offline sandbox (?local=1): the real board and tools with no room attached.
 * Lets you try brushes before joining, and lets the UI be inspected without a
 * network. Room.paint still writes to the grid; _send is a no-op with no
 * transport, so nothing leaves the page.
 */
function startLocal() {
  const room = new Room({
    code: 'LOCAL',
    me: { clientId: CONFIG.clientId, nick: state.nick || 'alone', color: state.color, device: detectDevice() },
    ratio: state.ratio,
    level: state.level,
  });
  room.me.slot = 1;
  room.status = 'online';
  wireRoom(room);
  mount(room);
  ui.setRoom('LOCAL');
  ui.setLocked(false);
  ui.closeGate();
  ui.toast('Offline board - nothing you paint leaves this page', 'info', 4000);
}

/** Build the canvas, cursors and input on top of a room. */
function mount(room) {
  view = new View({
    base: document.getElementById('base'),
    fx: document.getElementById('fx'),
    grid: room.grid,
  });
  cursors = new Cursors({ room });
  view.onFrame((ctx, v) => cursors.draw(ctx, v));
  // The grid is the room's truth; the screen is a copy of it that catches up on
  // a schedule. Host and guests render identically, but nothing that has to be
  // correct - checksums, snapshots, handover - ever reads the lagging copy.
  const display = new StrokeDisplay(room);
  room.display = display;
  view.display = display;
  view.onTick(() => {
    if (display.tick()) view.markDirty();
  });
  // One hook covers wheel, pinch, buttons and fit, so the readout can never
  // disagree with the camera.
  view.onZoom = (percent) => ui.setZoom(percent);
  input = new Input({
    room,
    view,
    getState: () => state,
    setState: (patch) => {
      if (patch.brush !== undefined) ui.setBrush(patch.brush);
      if (patch.tool !== undefined) ui.setTool(patch.tool);
      if (patch.colorIdx !== undefined) ui.setColorIdx(patch.colorIdx);
      Object.assign(state, patch);
    },
  });
  ui.setZoom(view.zoomPercent);

  ui.showGroup(groupForIndex(state.colorIdx));
  ui.setColorIdx(state.colorIdx);
  ui.setTool(state.tool);
  ui.setBrush(state.brush);
  ui.setPlayers(room.roster, room.me.clientId);
  view.start();
  layout();
}

/* ---------------- room wiring ---------------- */

function wireRoom(r) {
  const seenNicks = new Set();

  r.on('status', (s) => report(s));
  r.on('authority', (isHost) => {
    ui.toast(isHost ? 'You are now hosting this room' : 'Connected to the room host', isHost ? 'good' : 'info');
    report();
  });

  r.on('ready', ({ slot, room: roomInfo }) => {
    ui.showDims(roomInfo.ratio, roomInfo.level, !r.authority);
    ui.setLocked(!r.canPaint, r.canPaint ? '' : 'Waiting for the room…');
    report();
  });

  r.on('roster', (roster) => {
    state.roomPlayers = roster.length;
    ui.setPlayers(roster, r.me.clientId);
    for (const p of roster) {
      if (!seenNicks.has(p.id)) {
        seenNicks.add(p.id);
        if (p.id !== r.me.clientId) ui.toast(`${p.nick} joined`, 'good', 1800);
      }
    }
    // Two people with the same name is confusing - the newcomer yields.
    const clash = roster.find((p) => p.id !== r.me.clientId && p.nick === r.me.nick && p.slot < r.me.slot);
    if (clash && !r._renamed) {
      r._renamed = true;
      const next = `${r.me.nick}·${(r.me.slot ?? 0) + 1}`;
      if (!validateNick(cleanNick(next))) {
        r.setProfile({ nick: next });
        state.nick = next;
        saveProfile({ nick: next, color: r.me.color, device: r.me.device });
        ui.toast(`Name taken here - you are "${next}"`, 'info');
      }
    }
    report();
  });

  r.on('leave', ({ id}) => {
    const p = r._roster?.get(id);
    if (p && p.id !== r.me.clientId) ui.toast(`${p.nick} left`, 'info', 1800);
    seenNicks.delete(id);
  });

  r.on('grid', (info) => {
    if (info.snapshot || info.resized) {
      view.rebuildStateCanvas();
      view.fit();
      ui.setZoom(view.zoomPercent);
      ui.showDims(r.room.ratio, r.room.level, !r.authority);
    }
    view.markDirty();
  });

  r.on('board', (b) => ui.toast(`Board is now ${dimsFor(b.ratio, b.level).w} × ${dimsFor(b.ratio, b.level).h}`, 'info'));

  r.on('sync', (s) => {
    if (s.drift) ui.toast('Desync detected - pulling a fresh copy', 'warn');
    else if (s.ok === false) ui.toast('Bad state packet ignored', 'warn');
  });

  r.on('blocked', () => ui.toast('Still connecting to the room…', 'warn', 1500));
}

let lastStatus = '';
function report(s) {
  if (s) lastStatus = s.status;
  const st = r2s();
  ui.setNet(st);
  ui.setLocked(!st.ready, st.ready ? '' : 'Waiting for the room…');
}

function r2s() {
  if (!room) return { status: 'idle', role: '-', transport: CONFIG.transport, latency: null, ready: false };
  const st = room.stats;
  return {
    status: room.status,
    detail: room.detail,
    role: room.authority ? 'host' : 'guest',
    transport: st.transport,
    latency: room.clock.latencyMs,
    ready: room.canPaint,
  };
}

/* ---------------- layout ---------------- */

function layout() {
  if (!view) return;
  view.measure();
  view.fit();
  ui.setZoom(view.zoomPercent);
  // The dock changes height with the board size and orientation; keep the
  // toasts clear of it instead of guessing in CSS.
  const dock = document.getElementById('dock');
  if (dock) document.documentElement.style.setProperty('--dock-h', `${Math.round(dock.getBoundingClientRect().height)}px`);
}

let resizeTimer = null;
function onViewportChange() {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(layout, 120);
}

function watchLayout() {
  const stage = document.getElementById('stage');
  if (window.ResizeObserver) new ResizeObserver(onViewportChange).observe(stage);
  window.addEventListener('resize', onViewportChange);
  window.addEventListener('orientationchange', () => setTimeout(layout, 350));
  if (window.visualViewport) window.visualViewport.addEventListener('resize', onViewportChange);
  document.addEventListener('visibilitychange', () => {
    if (!view) return;
    if (document.hidden) view.stop();
    else {
      view.start();
      layout();
    }
  });
}

/* ---------------- actions ---------------- */

function copyInvite() {
  const url = `${location.origin}${location.pathname}?room=${room ? room.code : ui.el.room.value}`;
  const done = () => ui.toast('Invite link copied', 'good', 1600);
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(url).then(done, () => fallbackCopy(url, done));
  } else fallbackCopy(url, done);
}

function fallbackCopy(text, done) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.cssText = 'position:fixed;top:-100px;opacity:0';
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand('copy');
    done();
  } catch (_) {
    ui.toast(text, 'info', 5000);
  }
  ta.remove();
}

function exportPNG() {
  if (!room) return;
  const g = room.grid;
  const cell = clamp(Math.floor(1200 / Math.max(g.w, g.h)), 2, 16);
  const c = document.createElement('canvas');
  c.width = g.w * cell;
  c.height = g.h * cell;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, c.width, c.height);
  const off = document.createElement('canvas');
  off.width = g.w;
  off.height = g.h;
  const octx = off.getContext('2d');
  const img = octx.createImageData(g.w, g.h);
  g.fillRGBA(new Uint32Array(img.data.buffer));
  octx.putImageData(img, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(off, 0, 0, c.width, c.height);
  const a = document.createElement('a');
  a.download = `heartopia-${room.code}-${new Date().toISOString().slice(0, 10)}.png`;
  a.href = c.toDataURL('image/png');
  a.click();
  ui.toast('Saved as PNG', 'good', 1600);
}

function clearBoard() {
  if (!room || !room.canPaint) return;
  if (!confirm('Clear the whole board for everyone in this room?')) return;
  room.clear();
  ui.toast('Board cleared', 'info');
}

function setBoard(ratio, level) {
  if (!room || !room.canPaint) return;
  if (!confirm('Resize the board? Everything currently painted will be lost for everyone.')) return;
  room.setBoard(ratio, level);
  state.ratio = ratio;
  state.level = level;
  view.rebuildStateCanvas();
  view.fit();
  ui.setZoom(view.zoomPercent);
}

function leaveRoom() {
  if (room) room.leave();
  location.href = location.pathname;
}

/* ---------------- keyboard ---------------- */

function bindKeys() {
  window.addEventListener('keydown', (e) => {
    if (e.target.matches('input, textarea')) return;
    const k = e.key.toLowerCase();
    if (!e.ctrlKey && !e.metaKey) {
      if (k === 'b') return actions.setTool(TOOLS.BRUSH);
      if (k === 'e') return actions.setTool(TOOLS.ERASER);
      if (k === 'i') return actions.setTool(TOOLS.PICK);
      if (k === 'g') {
        state.showGrid = !state.showGrid;
        document.getElementById('btnGrid').classList.toggle('active', state.showGrid);
        return actions.setGridVisible(state.showGrid);
      }
      if (k === '0') return actions.fit();
      if (k === '=' || k === '+') return actions.zoom(1.25);
      if (k === '-') return actions.zoom(1 / 1.25);
      if (k === '[' || k === ']') {
        const i = BRUSH_SIZES.indexOf(state.brush) + (k === ']' ? 1 : -1);
        return actions.setBrush(BRUSH_SIZES[clamp(i, 0, BRUSH_SIZES.length - 1)]);
      }
    }
    if ((e.ctrlKey || e.metaKey) && k === 's') {
      e.preventDefault();
      exportPNG();
    }
  });
}

/* ---------------- start ---------------- */

function boot() {
  const code = normalizeRoomCode(params.get('room')) || makeRoomCode();
  ui.el.room.value = code;
  if (params.get('nick')) ui.el.nick.value = cleanNick(params.get('nick'));
  ui.showGroup(groupForIndex(state.colorIdx));
  ui.setColorIdx(state.colorIdx);
  ui.setTool(state.tool);
  ui.setBrush(state.brush);
  watchLayout();
  bindKeys();

  if (params.get('local')) startLocal();
  else ui.openGate();

  if (CONFIG.transport === 'ws' && !CONFIG.relayUrl) {
    ui.toast('Relay URL missing - falling back to peer-to-peer rooms', 'warn', 5000);
  }
  setInterval(() => {
    if (room) report();
  }, 1000);
}

boot();
