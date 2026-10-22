/*
 * Boot: profile -> nickname gate -> room -> view/input/cursors/panels.
 *
 * This file owns the state object and glues the modules together. It is the
 * only place that knows about all of them at once, which is why the undo
 * handler, the 3D preview and the import flow live here rather than being
 * smeared across the things they connect.
 */

import CONFIG from './config.js';
import { Room } from './net/room.js';
import { View } from './view.js';
import { Cursors } from './cursors.js';
import { Input, TOOLS } from './input.js';
import { StrokeDisplay } from './net/display.js';
import { UI, cleanNick, validateNick, groupForIndex } from './ui.js';
import { FLAT_COLORS, HEARTOPIA_GROUPS } from './data/heartopia-palette.js';
import { BRUSH_SIZES, DEFAULTS } from './presets.js';
import { makeRoomCode, normalizeRoomCode, detectDevice, clamp } from './util.js';
import { History, patchWrite } from './game/history.js';
import { Blueprint } from './ui/blueprint.js';
import { Preview3D } from './game/render3d.js';
import { findItem, itemIdForBoard, cellTotal } from './game/slots.js';
import { loadImage, rasterize, photoToCells, screenshotToCells, applyCellsToFace, matchSlot } from './ui/importer.js';
import { palette } from './color/science.js';

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
const startItem = params.get('item') || itemIdForBoard(DEFAULTS.ratio, DEFAULTS.level);

const state = {
  nick: cleanNick(profile.nick || ''),
  color: profile.color || HEARTOPIA_GROUPS[(Math.random() * HEARTOPIA_GROUPS.length) | 0].main,
  ratio: DEFAULTS.ratio,
  level: DEFAULTS.level,
  item: findItem(startItem) ? startItem : itemIdForBoard(DEFAULTS.ratio, DEFAULTS.level),
  tool: TOOLS.BRUSH,
  colorIdx: 16, // a warm mid-tone that reads well on the paper
  colorHex: FLAT_COLORS[16],
  brush: 1,
  brushSizes: BRUSH_SIZES,
  brushShape: 'square',
  sprayDensity: 0.45,
  shapeFilled: false,
  fillGlobal: false,
  fillTolerance: 0,
  mirror: 0,
  showGrid: true,
  groupIndex: null,
  roomPlayers: 1,
  roomLocked: false,
  designItem: null,
  designFamily: 'canvas',
  importMode: 'photo',
  import: { fit: 'cover', dither: 'none', maxColors: 24, brightness: 0, contrast: 0, saturation: 0, trim: 16 },
};

let room = null;
let view = null;
let cursors = null;
let input = null;
/** The undo stack. Named `undo`, not `history`, so it cannot shadow the global. */
let undo = null;
let blueprint = null;
let preview3d = null;
let d3raf = null;
let importSrc = null; // the decoded image behind the import panel
let importOut = null; // the cells it produced

const actions = {
  onLayout: () => layout(),
  setTool: (t) => {
    ui.setTool(t);
    state.tool = t;
    input.poly = [];
  },
  setBrush: (s) => {
    ui.setBrush(s);
    state.brush = s;
  },
  setBrushShape: (s) => {
    state.brushShape = s;
    ui.setTool(state.tool);
  },
  setSprayDensity: (v) => {
    state.sprayDensity = clamp(v, 0.05, 1);
  },
  setShapeFilled: (v) => {
    state.shapeFilled = !!v;
    ui.setTool(state.tool);
  },
  setFillGlobal: (v) => {
    state.fillGlobal = !!v;
    ui.setTool(state.tool);
  },
  setMirror: (v) => {
    state.mirror = clamp(v | 0, 0, 3);
    ui.setTool(state.tool);
    view.markDirty();
  },
  setColor: (idx) => {
    ui.setColorIdx(idx);
    // In colour mode the lit shade follows what you pick, because you are
    // about to key that shade in.
    if (blueprint && blueprint.mode === 'colour') {
      blueprint.focus = idx;
      view.markDirty();
      refreshTrace();
    }
  },
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
  setItem: (id) => setItem(id),
  switchFace: (i) => switchFace(i),
  leave: () => leaveRoom(),
  undo: () => step(-1),
  redo: () => step(1),
  // trace panel
  blueprintMode: () => (blueprint ? blueprint.mode : 'off'),
  setTraceMode: (m) => {
    blueprint.setMode(m);
    if (m === 'colour') blueprint.focus = state.colorIdx;
    ui.syncTrace(m, blueprint.block);
    refreshTrace();
  },
  setBlockSize: (n) => {
    blueprint.setBlock(n);
    ui.syncTrace(blueprint.mode, n);
    refreshTrace();
  },
  focusLegend: (idx) => {
    if (blueprint.mode === 'colour') {
      blueprint.focus = idx;
      view.markDirty();
    }
    refreshTrace();
  },
  refreshTrace: () => refreshTrace(),
  tickBlock: () => {
    if (!blueprint.toggleLast()) {
      ui.toast('Nothing painted on this face to tick yet', 'info', 1600);
      return;
    }
    refreshTrace();
    view.markDirty();
  },
  // import panel
  loadImport: (file) => loadImport(file),
  previewImport: () => previewImport(),
  applyImport: () => applyImport(),
  // 3D panel
  open3d: () => open3d(),
  close3d: () => close3d(),
  reset3d: () => {
    if (preview3d) preview3d.reset();
  },
};

const ui = new UI({
  state,
  actions,
  onJoin: (p) => startRoom(p),
});

/* ---------------- join ---------------- */

function startRoom({ nick, color, device, room: code, ratio, level, item }) {
  const err = validateNick(nick);
  if (err) {
    ui.toast(err, 'warn');
    return;
  }
  state.nick = nick;
  state.color = color;
  state.item = item || itemIdForBoard(ratio, level);
  saveProfile({ nick, color, device });

  room = new Room({
    code,
    me: { clientId: CONFIG.clientId, nick, color, device },
    item: state.item,
  });

  ui.setLocked(true, 'Waiting for the room…');
  room.connect();
  mount(room);
  ui.setRoom(code);
  // closeGate() reveals the app on a timer and calls actions.onLayout() from
  // that callback, which is the only moment the stage has a real box. A layout()
  // run synchronously here measures a display:none element and is wasted.
  ui.closeGate();
  // window.history, spelled out: a module-scope `history` for the undo stack
  // would otherwise shadow the global and throw here.
  window.history.replaceState(null, '', `?room=${code}&item=${state.item}`);
}

/**
 * Offline sandbox (?local=1): the real board and tools with no room attached.
 * Lets you try brushes before joining, and lets the UI be inspected without a
 * network. Room.paint still writes to the grid; _send is a no-op with no
 * transport, so nothing leaves the page.
 */
function startLocal() {
  const room = new Room({ code: 'LOCAL', me: { clientId: CONFIG.clientId, nick: state.nick || 'alone', color: state.color, device: detectDevice() }, item: state.item });
  room.me.slot = 1;
  room.status = 'online';
  mount(room);
  ui.setRoom('LOCAL');
  ui.setLocked(false);
  ui.closeGate(); // reveals the app and calls onLayout() when it does
  ui.toast('Offline board - nothing you paint leaves this page', 'info', 4000);
}

/** Build the canvas, cursors, input, blueprint and 3D on top of a room. */
function mount(room) {
  undo = new History();
  view = new View({
    base: document.getElementById('base'),
    fx: document.getElementById('fx'),
    grid: room.grid,
  });
  cursors = new Cursors({ room });
  blueprint = new Blueprint(room);
  view.overlay = blueprint;
  view.onFrame((ctx, v) => cursors.draw(ctx, v));
  // The grid is the room's truth; the screen is a copy of it that catches up on
  // a schedule. Host and guests render identically, but nothing that has to be
  // correct - checksums, snapshots, handover - ever reads the lagging copy.
  const display = new StrokeDisplay(room.design);
  room.display = display;
  view.display = display;
  view.onTick(() => {
    if (display.tick(room.clock.now())) view.markDirty();
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
    // The input layer's option is still called `history`; the local must not be,
    // or it shadows window.history for the whole module.
    history: undo,
    onHistory: () => ui.setUndoState(undo),
  });
  ui.setZoom(view.zoomPercent);

  ui.showGroup(groupForIndex(state.colorIdx));
  ui.setColorIdx(state.colorIdx);
  ui.setTool(state.tool);
  ui.setBrush(state.brush);
  ui.setPlayers(room.roster, room.me.clientId);
  syncFaces();
  ui.setUndoState(undo);
  ui.syncTrace(blueprint.mode, blueprint.block);
  wireRoom(room);
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

  r.on('ready', ({ room: roomInfo }) => {
    state.roomLocked = !r.authority;
    state.designItem = r.design.id;
    state.designFamily = r.design.family || 'canvas';
    ui._join.item = r.design.id;
    ui._join.family = r.design.family || 'canvas';
    ui._buildItemPick();
    ui.showDims();
    ui.setLocked(!r.canPaint, r.canPaint ? '' : 'Waiting for the room…');
    syncFaces();
    report();
    if (roomInfo && roomInfo.item) ui.toast(`Design: ${r.design.item.name} · ${r.design.faces.length} faces`, 'info', 2200);
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
    syncFaces();
    report();
  });

  r.on('leave', ({ id }) => {
    const p = r._roster?.get(id);
    if (p && p.id !== r.me.clientId) ui.toast(`${p.nick} left`, 'info', 1800);
    seenNicks.delete(id);
    syncFaces();
  });

  r.on('design', ({ item }) => {
    state.item = item;
    state.designItem = item;
    state.designFamily = findItem(item)?.family || 'canvas';
    view.setFace(r.grid, r.design.active);
    view.fit();
    ui.setZoom(view.zoomPercent);
    syncFaces();
    refreshTrace();
    rebuild3d();
  });

  r.on('face', () => {
    view.setFace(r.grid, r.design.active);
    view.fit();
    ui.setZoom(view.zoomPercent);
    syncFaces();
    refreshTrace();
  });

  r.on('blueprint', () => refreshTrace());

  r.on('grid', (info) => {
    if (info.resized || info.snapshot) {
      view.rebuildStateCanvas();
      view.fit();
      ui.setZoom(view.zoomPercent);
      syncFaces();
      rebuild3d();
      refreshTrace();
    }
    view.markDirty();
    if (preview3d) preview3d.invalidate();
  });

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

/* ---------------- faces ---------------- */

function syncFaces() {
  if (!room) return;
  ui.setFaces(room.design.item.faces, room.design.active, cursors ? cursors.elsewhere() : []);
}

function switchFace(i) {
  if (!room) return;
  room.switchFace(i);
  if (preview3d) preview3d.invalidate();
}

/* ---------------- undo / redo ---------------- */

function step(dir) {
  if (!room || !room.canPaint) return;
  // undo() and redo() only pop when there is something, so a miss costs nothing.
  const entry = dir < 0 ? undo.undo() : undo.redo();
  if (!entry) {
    ui.toast(dir < 0 ? 'Nothing to undo' : 'Nothing to redo', 'info', 1400);
    return;
  }
  const { indices, values } = patchWrite(entry);
  const face = entry.face;
  const g = room.design.faceAt(face);
  if (!g) return;
  const byColor = new Map();
  for (let i = 0; i < indices.length; i++) {
    const c = values[i];
    if (!byColor.has(c)) byColor.set(c, []);
    byColor.get(c).push(indices[i]);
  }
  const seq = room.nextSeq();
  for (const [c, list] of byColor) {
    room.paintLocal(list, c, seq, face);
    room.sendOp(list, c, seq, face);
  }
  if (face !== room.design.active) room.switchFace(face);
  view.markDirty();
  // undo() already moved the entry onto the redo stack; the buttons just need
  // to be told, or they stay greyed while there is clearly something to redo.
  ui.setUndoState(undo);
  refreshTrace();
}

/* ---------------- trace ---------------- */

function refreshTrace() {
  if (!room || !blueprint) return;
  const face = room.design.active;
  const legend = blueprint.legend(face);
  const flags = blueprint.flags(face);
  let done = 0;
  for (let i = 0; i < flags.length; i++) if (flags[i]) done++;
  // In block mode "left to key in" means left in the blocks you have not
  // ticked; otherwise it is simply everything painted on this face.
  const left = blueprint.mode === 'block' ? blueprint.remaining(face) : room.design.grid.usedCount();
  ui.refreshLegend(legend, left, blueprint.mode === 'block' ? done : null);
}

/* ---------------- import ---------------- */

async function loadImport(file) {
  ui.setImportInfo('Reading…', false);
  try {
    importSrc = await loadImage(file);
    ui.el.dropText.textContent = file.name;
    previewImport();
  } catch (e) {
    ui.setImportInfo(e.message, false);
  }
}

function previewImport() {
  if (!importSrc || !room) return;
  const face = room.face;
  const o = { ...state.import, mode: state.importMode };
  let out;
  if (o.mode === 'screenshot') {
    // Ask first for the board the current face expects; the answer is faster and
    // much harder to fool than an unconstrained hunt.
    out = screenshotToCells(importSrc, { trim: (o.trim ?? 16) / 100, cols: face.w, rows: face.h });
    if (!out) {
      ui.setImportInfo('No board found in that screenshot. Crop closer to the grid and try again.', false);
      importOut = null;
      return;
    }
    const pitch = out.detect.pitch.toFixed(1);
    const match = matchSlot(out.w, out.h);
    if (!out.matchedSlot && (out.w !== face.w || out.h !== face.h)) {
      // Found a board, just not this face's. Say which one it is instead of
      // blaming the crop, and say plainly that only the overlap will land.
      ui.setImportInfo(
        `Found a ${out.w} × ${out.h} board, not this face (${face.w} × ${face.h}) · ${pitch}px grid · ` +
          `${out.colors.size} shades${match ? ` · that is ${match.itemName || ''} ${match.label}` : ' · unknown slot'}. ` +
          `Only the part that fits this face will be painted.`,
        false
      );
    } else {
      ui.setImportInfo(
        `${out.w} × ${out.h} cells · grid ${pitch}px · ${out.colors.size} shades${
          match ? ` · looks like ${match.itemName || ''} ${match.label}` : ' · unknown slot, you pick the face'
        }`,
        true
      );
    }
  } else {
    // The source is resampled to the face's own cell count, so one source pixel
    // per cell makes the smoothing look right at that distance.
    const raster = rasterize(importSrc, face.w, face.h, o);
    out = photoToCells(importSrc, face.w, face.h, { ...o, raw: raster });
    const note = out.from > out.to ? ` · reduced ${out.from} → ${out.to} shades` : ` · ${out.to} shades`;
    ui.setImportInfo(`${face.w} × ${face.h} onto ${face.label}${note}`, true);
  }
  importOut = out;
  drawImportPreview(out);
}

/**
 * The preview is drawn at exactly one pixel per cell and scaled up in CSS with
 * `image-rendering: pixelated`. A preview resampled to look smooth would not be
 * showing you the board you are about to get.
 */
function drawImportPreview(out) {
  const w = out.w;
  const h = out.h;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  const img = ctx.createImageData(w, h);
  const u32 = new Uint32Array(img.data.buffer);
  for (let i = 0; i < out.cells.length; i++) {
    const hex = FLAT_COLORS[out.cells[i]];
    if (!hex) continue;
    const n = parseInt(hex.slice(1), 16);
    u32[i] = (255 << 24) | ((n & 255) << 16) | (((n >> 8) & 255) << 8) | ((n >> 16) & 255);
  }
  ctx.putImageData(img, 0, 0);
  c.style.width = `${Math.min(240, Math.max(90, w))}px`;
  ui.setImportPreview(c);
}

function applyImport() {
  if (!importOut || !room || !room.canPaint) return;
  const face = room.face;
  const { changed, clipped } = applyCellsToFace(room, input, importOut.cells, importOut.w, importOut.h, room.design.active);
  if (!changed) {
    ui.toast('Nothing to paint - that board shares no cells with this face', 'warn');
    return;
  }
  // A board that overhangs the face loses rows and columns; hiding that would
  // be the tool quietly throwing away someone's work.
  ui.toast(
    `Painted ${changed.toLocaleString()} cells onto ${face.label}` + (clipped ? ` · ${clipped.toLocaleString()} cells fell outside the face` : ''),
    clipped ? 'warn' : 'good'
  );
  ui.hidePanel('importPanel');
  importOut = null;
  view.markDirty();
  refreshTrace();
}

/* ---------------- 3D ---------------- */

function open3d() {
  if (!room) return;
  const cv = document.getElementById('d3Canvas');
  if (!preview3d) {
    preview3d = new Preview3D(cv, (faceId) => faceTexture(faceId));
    bindOrbit(cv);
  }
  rebuild3d();
  if (!d3raf) {
    const loop = () => {
      d3raf = requestAnimationFrame(loop);
      if (document.getElementById('d3Panel').hidden) return;
      preview3d.render();
    };
    d3raf = requestAnimationFrame(loop);
  }
}

function close3d() {
  if (d3raf) cancelAnimationFrame(d3raf);
  d3raf = null;
}

/** A face as an image at exactly one pixel per cell - the 3D texture. */
function faceTexture(faceId) {
  const idx = room.design.item.faces.findIndex((f) => f.id === faceId);
  const g = room.design.faceAt(idx);
  if (!g) return null;
  const c = document.createElement('canvas');
  c.width = g.w;
  c.height = g.h;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, g.w, g.h);
  const img = ctx.createImageData(g.w, g.h);
  g.fillRGBA(new Uint32Array(img.data.buffer), room.display ? room.display.cellsFor(idx) : null);
  ctx.putImageData(img, 0, 0);
  return c;
}

function rebuild3d() {
  if (!preview3d || !room) return;
  preview3d.invalidate();
  preview3d.build(room.design.item);
}

function bindOrbit(cv) {
  let drag = null;
  cv.addEventListener('pointerdown', (e) => {
    cv.setPointerCapture(e.pointerId);
    drag = { x: e.clientX, y: e.clientY };
  });
  cv.addEventListener('pointermove', (e) => {
    if (!drag) return;
    preview3d.orbit(e.clientX - drag.x, e.clientY - drag.y);
    drag = { x: e.clientX, y: e.clientY };
  });
  cv.addEventListener('pointerup', () => (drag = null));
  cv.addEventListener('pointercancel', () => (drag = null));
  cv.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      preview3d.setZoom(preview3d.zoom * Math.exp(-e.deltaY * 0.0016));
    },
    { passive: false }
  );
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
  const url = `${location.origin}${location.pathname}?room=${room ? room.code : ui.el.room.value}${
    room ? `&item=${room.design.id}` : ''
  }`;
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

/**
 * Export every face, each at exactly one pixel per cell - which is what the
 * game reads. A multi-face design goes out as one sheet with the faces laid
 * side by side and labelled, because four unlabeled strips is not a usable
 * reference.
 */
function exportPNG() {
  if (!room) return;
  const faces = room.design.faces;
  const meta = room.design.item.faces;
  const cell = clamp(Math.floor(1400 / Math.max(...faces.map((f) => Math.max(f.w, f.h)))), 2, 16);
  const gap = 8;
  const label = 18;
  let w = gap;
  for (const f of faces) w += f.w * cell + gap;
  let h = 0;
  for (const f of faces) h = Math.max(h, f.h * cell);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h + label + gap * 2;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.imageSmoothingEnabled = false; // Heartopia boards are pixel art
  let x = gap;
  faces.forEach((g, i) => {
    const off = document.createElement('canvas');
    off.width = g.w;
    off.height = g.h;
    const octx = off.getContext('2d');
    const img = octx.createImageData(g.w, g.h);
    g.fillRGBA(new Uint32Array(img.data.buffer));
    octx.putImageData(img, 0, 0);
    ctx.drawImage(off, x, gap + label, g.w * cell, g.h * cell);
    ctx.fillStyle = '#3a2a1c';
    ctx.font = `${Math.max(11, Math.min(15, cell * 4))}px "Baloo 2", system-ui, sans-serif`;
    ctx.fillText(`${meta[i].label} ${g.w}×${g.h}`, x, gap + label - 5);
    x += g.w * cell + gap;
  });
  const a = document.createElement('a');
  a.download = `heartopia-${room.design.id}-${room.code}-${new Date().toISOString().slice(0, 10)}.png`;
  a.href = c.toDataURL('image/png');
  a.click();
  ui.toast(faces.length > 1 ? `Saved ${faces.length} faces as PNG` : 'Saved as PNG', 'good', 1800);
}

function clearBoard() {
  if (!room || !room.canPaint) return;
  if (!confirm('Clear the whole design for everyone in this room?')) return;
  room.clear();
  undo.clear();
  ui.setUndoState(undo);
  ui.toast('Design cleared', 'info');
  refreshTrace();
}

function setItem(id) {
  if (!room || !room.canPaint) return;
  const item = findItem(id);
  if (!item) return;
  const warn =
    room.design.usedCells() > 0
      ? `Switch to ${item.name}? It has ${item.faces.length} ${
          item.faces.length === 1 ? 'face' : 'faces'
        } and ${cellTotal(item).toLocaleString()} cells, and everything painted here will be wiped for everyone.`
      : `Switch to ${item.name}?`;
  if (!confirm(warn)) return;
  if (!room.setItem(id)) return;
  state.item = id;
  state.designItem = id;
  state.designFamily = item.family;
  undo.clear();
  ui.setUndoState(undo);
  view.setFace(room.grid, room.design.active);
  ui.toast(`${item.name} · ${item.faces.length} faces`, 'info');
}

function setBoard(ratio, level) {
  if (!room || !room.canPaint) return;
  if (!confirm('Resize the board? Everything currently painted will be lost for everyone.')) return;
  room.setBoard(ratio, level);
  state.ratio = ratio;
  state.level = level;
  state.item = itemIdForBoard(ratio, level);
  view.setFace(room.grid, room.design.active);
}

function leaveRoom() {
  if (room) room.leave();
  location.href = location.pathname;
}

/* ---------------- keyboard ---------------- */

const KEY_TOOLS = {
  b: TOOLS.BRUSH,
  e: TOOLS.ERASER,
  i: TOOLS.PICK,
  f: TOOLS.FILL,
  j: TOOLS.SPRAY,
  l: TOOLS.LINE,
  r: TOOLS.RECT,
  o: TOOLS.ELLIPSE,
  t: TOOLS.TRIANGLE,
  s: TOOLS.STAR,
  h: TOOLS.HEART,
  a: TOOLS.ARROW,
  p: TOOLS.POLYGON,
  d: TOOLS.GUIDE,
};

function bindKeys() {
  window.addEventListener('keydown', (e) => {
    if (e.target.matches('input, textarea, select')) return;
    const k = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && k === 'z') {
      e.preventDefault();
      return step(e.shiftKey ? 1 : -1);
    }
    if ((e.ctrlKey || e.metaKey) && k === 'y') {
      e.preventDefault();
      return step(1);
    }
    if ((e.ctrlKey || e.metaKey) && k === 's') {
      e.preventDefault();
      return exportPNG();
    }
    if (!e.ctrlKey && !e.metaKey && !e.altKey) {
      if (KEY_TOOLS[k]) return actions.setTool(KEY_TOOLS[k]);
      if (k === 'm') return actions.setMirror((state.mirror + 1) % 4);
      if (k === 'g') {
        state.showGrid = !state.showGrid;
        document.getElementById('btnGrid').classList.toggle('active', state.showGrid);
        return actions.setGridVisible(state.showGrid);
      }
      if (k === 'v') return ui.togglePanel('tracePanel');
      if (k === '0') return actions.fit();
      if (k === '=' || k === '+') return actions.zoom(1.25);
      if (k === '-') return actions.zoom(1 / 1.25);
      if (k === '[' || k === ']') {
        const i = BRUSH_SIZES.indexOf(state.brush) + (k === ']' ? 1 : -1);
        return actions.setBrush(BRUSH_SIZES[clamp(i, 0, BRUSH_SIZES.length - 1)]);
      }
      if (k === 'tab') {
        e.preventDefault();
        return switchFace(room.design.active + 1);
      }
    }
  });
}

/* ---------------- start ---------------- */

function boot() {
  const code = normalizeRoomCode(params.get('room')) || makeRoomCode();
  ui.el.room.value = code;
  if (params.get('nick')) ui.el.nick.value = cleanNick(params.get('nick'));
  state.designItem = state.item;
  state.designFamily = findItem(state.item)?.family || 'canvas';
  ui._join.item = state.item;
  ui._join.family = state.designFamily;
  ui._buildItemPick();
  ui.showGroup(groupForIndex(state.colorIdx));
  ui.setColorIdx(state.colorIdx);
  ui.setTool(state.tool);
  ui.setBrush(state.brush);
  watchLayout();
  bindKeys();
  // Touch the palette once so the perceptual tables are warm before a person
  // asks for an import; the first quantise is otherwise measurably slower.
  palette();

  if (params.get('local')) startLocal();
  else ui.openGate();

  if (CONFIG.transport === 'ws' && !CONFIG.relayUrl) {
    ui.toast('Relay URL missing - falling back to peer-to-peer rooms', 'warn', 5000);
  }
  setInterval(() => {
    if (room) {
      report();
      syncFaces();
    }
  }, 1000);
}

boot();
