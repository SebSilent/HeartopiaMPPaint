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
import { stampFromFile, stampFromDataUrl, stampPreview } from './game/stamps.js';
import { BRUSH_SIZES, DEFAULTS, LEVELS } from './presets.js';
import { makeRoomCode, normalizeRoomCode, detectDevice, clamp, b64ToBytes } from './util.js';
import {
  saveBoard,
  loadBoard,
  clearBackup,
  fitsDesign,
  designIsEmpty,
  savedCount,
} from './game/backup.js';
import { History, patchWrite } from './game/history.js';
import { Blueprint } from './ui/blueprint.js';
import { Preview3D } from './game/render3d.js';
import { loadMesh } from './game/meshdata.js';
import { loadSolid, sourceFor } from './game/solid.js';
import { coverageFor } from './game/meshcover.js';
import { findItem, itemIdForBoard, boardForItem, cellTotal } from './game/slots.js';
import { outlineFor, boardOutline } from './game/outline.js';
import { faceInfo, paintable, maskFor } from './game/faces.js';
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
  // An imported brush tip, or null for the built-in square/round footprints.
  // Local to this player: it changes how a stroke is laid down, never what the
  // room stores, so remote players just see the cells it paints.
  stamp: null,
  brushShape: 'square',
  sprayDensity: 0.25,
  shapeFilled: false,
  fillGlobal: false,
  fillTolerance: 0,
  mirror: 0,
  showGrid: true,
  showOutline: true,
  groupIndex: null,
  roomPlayers: 1,
  roomLocked: false,
  canDesign: true,
  designItem: null,
  designFamily: 'canvas',
  importMode: 'photo',
  // zoom/ox/oy are the placement of the picture inside the face. They live here
  // because `rasterize` samples through them, so the preview you drag and the
  // cells you get are the same numbers - see ui/importer.js fitRect().
  import: { fit: 'cover', dither: 'none', maxColors: 24, brightness: 0, contrast: 0, saturation: 0, trim: 16, zoom: 1, ox: 0, oy: 0, rot: 0 },
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
let backupTimer = null; // the debounce behind the local board backup

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
    // One rule, so the row can never claim two things at once: choosing a
    // built-in block drops the imported tip. Picking a new tip takes it back.
    if (state.stamp) {
      state.stamp = null;
      saveProfile({ ...loadProfile(), nick: state.nick, color: state.color, tip: null });
      ui.setTip(null);
    }
    ui.setTool(state.tool);
  },
  setSprayDensity: (d) => {
    state.sprayDensity = d;
    ui.setTool(state.tool);
  },
  /**
   * Take a tip from an image file. Returns false with a message when the file
   * is not a usable tip, so the UI can say so instead of quietly doing nothing.
   */
  setStampFromFile: async (file) => {
    try {
      const { stamp, dataUrl } = await stampFromFile(file);
      state.stamp = stamp;
      saveProfile({ ...loadProfile(), nick: state.nick, color: state.color, tip: dataUrl });
      ui.setTip(stampPreview(stamp));
      return true;
    } catch (e) {
      ui.toast(`That file is not a brush tip: ${e.message}`, 'bad');
      return false;
    }
  },
  clearStamp: () => {
    state.stamp = null;
    saveProfile({ ...loadProfile(), nick: state.nick, color: state.color, tip: null });
    ui.setTip(null);
  },
  setShapeFilled: (v) => {
    state.shapeFilled = !!v;
    ui.setTool(state.tool);
  },
  setFillGlobal: (v) => {
    state.fillGlobal = !!v;
    ui.setTool(state.tool);
  },
  setFillTolerance: (v) => {
    // ΔE(2000) units. Past ~30 the palette is one big blob and the bucket stops
    // meaning anything, so the ceiling is real rather than cosmetic.
    state.fillTolerance = clamp(Number(v) || 0, 0, 30);
    ui.setTool(state.tool);
  },
  setMirror: (v) => {
    state.mirror = clamp(v | 0, 0, 3);
    ui.setTool(state.tool);
    view.markDirty();
  },
  setColor: (idx) => {
    ui.setColorIdx(idx);
    // Tell the room, so every avatar can show the shade this player is holding.
    // Presence, not truth: nothing here touches the grid, so a lost message
    // costs a stale dot and cannot make two boards disagree.
    if (room) room.setProfile({ shade: idx });
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
  setOutline: (v) => {
    state.showOutline = !!v;
    applyOutline();
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
    // Seeded with the shade we are already holding, so a player joining mid-
    // session sees the legend filled in rather than blank until someone clicks.
    me: { clientId: CONFIG.clientId, nick, color, device, shade: state.colorIdx },
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
  // Wait for the room to answer before offering anything: if it still has the
  // picture, there is nothing to rescue, and the offer must not even appear.
  setTimeout(offerBackup, 2200);
}

/**
 * Offline sandbox (?local=1): the real board and tools with no room attached.
 * Lets you try brushes before joining, and lets the UI be inspected without a
 * network. Room.paint still writes to the grid; _send is a no-op with no
 * transport, so nothing leaves the page.
 */
function startLocal() {
  // Assign the module-level room, do not shadow it: every action below (setItem,
  // setBoard, the design dialog) guards on `room`, so a local `const` here left
  // them all silently doing nothing in the offline sandbox.
  room = new Room({ code: 'LOCAL', me: { clientId: CONFIG.clientId, nick: state.nick || 'alone', color: state.color, device: detectDevice(), shade: state.colorIdx }, item: state.item });
  room.me.slot = 1;
  room.status = 'online';
  mount(room);
  ui.setRoom('LOCAL');
  ui.setLocked(false);
  ui.closeGate(); // reveals the app and calls onLayout() when it does
  ui.toast('Offline board - nothing you paint leaves this page', 'info', 4000);
  // Nothing can arrive to overwrite it, so the rescue is offered straight away.
  offerBackup();
}

/** Build the canvas, cursors, input, blueprint and 3D on top of a room. */
function mount(room) {
  undo = new History();
  view = new View({
    base: document.getElementById('base'),
    fx: document.getElementById('fx'),
    grid: room.grid,
  });
  // Controls that float permanently over the stage get their space reserved, so
  // the board is never drawn underneath something you have to tap.
  view.insetBox = stageInset;
  cursors = new Cursors({ room });
  blueprint = new Blueprint(room);
  view.overlay = blueprint;
  view.onFrame((ctx, v) => cursors.draw(ctx, v));
  view.onFace = () => applyOutline();
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
    // A finished stroke changes what is on the board, so the trace legend and
    // its "cells to key in" count are stale until they are rebuilt. This fires
    // once per stroke, not per batch, so the DOM rebuild is affordable.
    onHistory: () => {
      ui.setUndoState(undo);
      refreshTrace();
    },
  });
  ui.setZoom(view.zoomPercent);

  ui.showGroup(groupForIndex(state.colorIdx));
  ui.setColorIdx(state.colorIdx);
  ui.setTool(state.tool);
  ui.setBrush(state.brush);
  ui.setPlayers(room.roster, room.me.clientId);
  syncFaces();
  // The design event only fires on a change, so without this the 3D button
  // would describe whatever item the last room had.
  sync3dAvailability(room.design.item && room.design.item.id);
  ui.setUndoState(undo);
  ui.syncTrace(blueprint.mode, blueprint.block);
  wireRoom(room);
  // The room already knows its design, so the outline state can be set now
  // rather than waiting for an event that may have fired during construction.
  applyOutline();
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
    applyOutline();
    report();
    if (roomInfo && roomInfo.item) ui.toast(`Design: ${r.design.item.name} · ${r.design.faces.length} faces`, 'info', 2200);
  });

  r.on('roster', (roster) => {
    state.roomPlayers = roster.length;
    state.canDesign = r.isDesignHost;
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
    syncBoardState(item);
    view.setFace(r.grid, r.design.active);
    view.fit();
    ui.setZoom(view.zoomPercent);
    syncFaces();
    refreshTrace();
    applyOutline();
    sync3dAvailability(item.id);
    rebuild3d();
  });

  r.on('face', () => {
    view.setFace(r.grid, r.design.active);
    view.fit();
    ui.setZoom(view.zoomPercent);
    syncFaces();
    refreshTrace();
    applyOutline();
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
    // Re-bake the face textures in place: the triangles hold the canvases they
    // were built from, so clearing the cache alone would keep the old pixels up.
    if (preview3d) preview3d.refresh();
    scheduleBackup();
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
  // The design belongs to the room's longest-present player, so this can flip
  // when someone leaves - recompute it on every status change, not just once.
  state.canDesign = room ? room.isDesignHost : true;
  ui.setNet(st);
  // Lock only until the room hands us a slot. Slots survive reconnects, so
  // once we hold one the board on screen is still the room's truth: locking
  // on every transport flap dims the picture off and back for no reason (the
  // "reconnect flash"). Painting during a re-hand is already refused by
  // input.js with a toast, so the lock buys nothing here.
  const held = !!room && room.me.slot != null;
  ui.setLocked(!held, held ? '' : 'Waiting for the room…');
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
  // A triangle holds the canvas it was built from, so clearing the texture cache
  // on its own leaves the preview showing the face we just left.
  rebuild3d();
  applyOutline();
}

/* ---------------- garment outline ---------------- */

/**
 * Show the game's silhouette for the face on screen, when it has one. Free
 * canvas boards are plain rectangles, so the toggle has nothing to draw there.
 */
function setOutlineFor(faceId) {
  // 'has' is a property of the face and decides whether the toggle is offered at
  // all. 'on' is the user's choice. Passing 'on' where the UI reads 'has' would
  // disable the button whenever the outline is off, so it could never be turned
  // on a second time.
  // Read the item off the room, not off the mirror in state: 'ready' can land
  // before the handlers that fill the mirror in.
  const item = room.design.id;
  // Draw the game's own maskLines. One ring off the mesh header would outline only
  // one of the two islands on a split face - one trouser leg, one shoe toe - and
  // leave the rest of the paintable area bare. See boardOutline() for the numbers.
  const o = boardOutline(item, faceId);
  const on = state.showOutline && !!o;
  view.outline = on ? o : null;
  const cells = faceCells(item, faceId);
  // The number shown next to the toggle is the cells the game really lets you
  // paint. Clothing does carry a disabled list, so the fallback only ever applies
  // where the game ships no cell list at all: free canvas boards, and the book.
  const free = paintable(item, faceId) || cells;
  ui.setOutlineInfo(!!o, free, cells, room.design.item.name);
}

/**
 * The game's maskLines for a face, shaped the way the view draws one. Clothing
 * faces come from the mesh header instead, so this is what covers furniture,
 * the book, and anything the catalog has a silhouette for.
 */
function faceOutline(item, faceId) {
  const f = faceInfo(item, faceId);
  if (!f || !f.rings || !f.rings.length) return null;
  return { w: f.w, h: f.h, rings: f.rings };
}

/** Cells on a face, whether or not the game has data for it. */
function faceCells(item, faceId) {
  const f = faceInfo(item, faceId);
  if (f) return f.w * f.h;
  const o = outlineFor(item, faceId);
  return o ? o.w * o.h : 0;
}

function applyOutline() {
  if (!view || !room) return;
  setOutlineFor(room.design.face.id);
  view.markDirty();
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

// A phone photo dropped on the wrong tab is not a bug to chase, it is a frozen
// tab. The caps live in CONFIG.limits so they can be lowered for a test without
// shipping a 40-megapixel image at it.
async function loadImport(file) {
  ui.setImportInfo('Reading…', false);
  if (!file) return;
  if (file.type && !file.type.startsWith('image/')) {
    ui.setImportInfo(`That is a ${file.type || 'unknown'} file, not a picture`, false);
    return;
  }
  if (file.size > CONFIG.limits.importMaxBytes) {
    ui.setImportInfo(`That file is ${(file.size / 1048576).toFixed(0)} MB - too big to read here`, false);
    return;
  }
  try {
    importSrc = await loadImage(file);
    if (importSrc.naturalWidth * importSrc.naturalHeight > CONFIG.limits.importMaxPixels) {
      const mp = (importSrc.naturalWidth * importSrc.naturalHeight / 1e6).toFixed(0);
      ui.setImportInfo(
        `That picture is ${importSrc.naturalWidth} × ${importSrc.naturalHeight} (${mp} MP). ` +
          `Crop it closer before importing.`,
        false
      );
      importSrc = null;
      return;
    }
    ui.el.dropText.textContent = file.name;
    previewImport();
  } catch (e) {
    ui.setImportInfo(e.message, false);
  }
}

function previewImport() {
  if (!importSrc || !room) return;
  try {
    previewImportInner();
  } catch (e) {
    // This runs on every slider tick and every drag of the picture, so a throw
    // that escaped would repeat under a finger. Drop the result rather than
    // leave a stale one that Apply would happily paint.
    importOut = null;
    ui.setImportInfo(`Could not read that image: ${e.message}`, false);
  }
}

function previewImportInner() {
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
 *
 * For a photo it is also the thing you drag: the face is the board, the picture
 * is an object sitting on it, and moving the object is the whole point - at
 * `contain` or zoomed-out `cover` the default centred placement is not the
 * placement anyone wants.
 */
// One canvas, reused. A fresh element per preview would be dropped into the
// panel under a finger that is mid-drag, and re-parenting a captured pointer
// ends the drag - the picture would jump back to where you started.
let importPrevCv = null;

function drawImportPreview(out) {
  const w = out.w;
  const h = out.h;
  const c = importPrevCv || (importPrevCv = document.createElement('canvas'));
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
  // A screenshot board is already the exact grid; there is nothing to place.
  if (importSrc && state.importMode !== 'screenshot') wirePlacement(c);
  ui.setImportPreview(c);
}

/**
 * Drag the picture inside the face, wheel or pinch to scale it.
 *
 * The gesture writes the same `ox/oy/zoom` the sliders write, and the preview is
 * rebuilt through previewImport(), so what you drag is what gets rasterised -
 * there is no second copy of the placement maths to drift out of step.
 */
function wirePlacement(c) {
  c.classList.add('placeable');
  c.title = 'Drag the picture to place it. Scroll to scale it.';
  if (c.dataset.wired) return;
  c.dataset.wired = '1';
  let drag = null;
  // Read the geometry off the canvas every time, not from the call that wired
  // it: the element is reused across faces, and a sleeve is not the size of a
  // front panel.
  const px = (e) => {
    const r = c.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * c.width, y: ((e.clientY - r.top) / r.height) * c.height };
  };
  c.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    c.setPointerCapture(e.pointerId);
    drag = { at: px(e), ox: state.import.ox, oy: state.import.oy };
  });
  c.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const p = px(e);
    // Pan is stored as a fraction of the face, so it survives the face changing
    // size and matches fitRect() exactly.
    state.import.ox = clamp(drag.ox + (p.x - drag.at.x) / c.width, -1, 1);
    state.import.oy = clamp(drag.oy + (p.y - drag.at.y) / c.height, -1, 1);
    ui.syncImportPlacement();
    schedulePreview();
  });
  const end = () => (drag = null);
  c.addEventListener('pointerup', end);
  c.addEventListener('pointercancel', end);
  c.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      state.import.zoom = clamp(state.import.zoom * Math.exp(-e.deltaY * 0.0015), 0.2, 6);
      ui.syncImportPlacement();
      schedulePreview();
    },
    { passive: false }
  );
}

/**
 * One re-rasterise per frame, however many pointer events arrived.
 *
 * previewImport() resamples the picture and quantises it to the 125 shades -
 * real work, and a drag fires a pointermove per mouse tick. Coalescing to the
 * animation frame keeps the drag fluid instead of queuing a backlog of previews.
 */
let previewFrame = null;
function schedulePreview() {
  if (previewFrame != null) return;
  previewFrame = requestAnimationFrame(() => {
    previewFrame = null;
    previewImport();
  });
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
    preview3d = new Preview3D(
      cv,
      // The mesh is the one this preview is currently built from, so the texture
      // alpha can follow the garment instead of the paint ring. rebuild3d keeps
      // `meshLoaded` null until a garment mesh arrives, and null means panels.
      (faceId) => faceTexture(faceId, meshLoaded || null),
      // The same union the 2D layer uses: mesh outline for clothing, maskLines
      // for everything else.
      (itemId, faceId) => outlineFor(itemId, faceId) || faceOutline(itemId, faceId)
    );
    bindOrbit(cv);
  }
  rebuild3d();
  if (!d3raf) {
    // A throw inside a frame would otherwise repeat sixty times a second,
    // because the next frame is queued before the work runs. Stop on the first
    // one and say so; the panel stays closed until the user reopens it.
    const loop = () => {
      if (document.getElementById('d3Panel').hidden) {
        d3raf = requestAnimationFrame(loop);
        return;
      }
      try {
        preview3d.render();
        d3raf = requestAnimationFrame(loop);
      } catch (e) {
        d3raf = null;
        // The frame died somewhere between a clip and its restore. Left alone,
        // the next frame would paint inside that clip and the preview would stay
        // broken for a fault the user has already been told about.
        try {
          preview3d.resetState();
        } catch (_) {
          /* nothing else to try */
        }
        ui.toast(`3D preview stopped: ${e.message}`, 'warn', 5000);
        ui.hidePanel('d3Panel');
      }
    };
    d3raf = requestAnimationFrame(loop);
  }
}

function close3d() {
  if (d3raf) cancelAnimationFrame(d3raf);
  d3raf = null;
}

/**
 * Tell the toolbar whether this item has anything to show in 3D.
 *
 * Every item in the catalog does today, so this is not decoration: a room from
 * an older build, or an id the catalog has not caught up with, lands on the
 * fallback layout, and a fallback row of flat rectangles is not a 3D preview -
 * it is the 2D board with a rotation on it.
 */
function sync3dAvailability(itemId) {
  // Asked about a design that has not resolved yet: leave the button as it is
  // rather than light up an error path nobody can act on.
  if (!itemId) {
    ui.set3DAvailable(false, 'No design loaded yet');
    ui.set3DKind(null);
    return;
  }
  const source = sourceFor(itemId);
  ui.set3DAvailable(source !== null, source === null ? 'This item has no 3D model yet' : '');
  ui.set3DKind(source);
}

/** A face as an image at exactly one pixel per cell - the 3D texture.
 *
 * `mesh` is the garment mesh when the item has one. It changes only the alpha:
 * a mesh does not stop at the paint ring, so clipping its texture to the ring
 * punches real holes in the surface (see game/meshcover.js). Without a mesh the
 * flat panel schematic is clipped to the ring by its own silhouette, and the
 * ring mask stays the right gate.
 */
function faceTexture(faceId, mesh) {
  const idx = room.design.item.faces.findIndex((f) => f.id === faceId);
  const g = room.design.faceAt(idx);
  if (!g) return null;
  const c = document.createElement('canvas');
  c.width = g.w;
  c.height = g.h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  // Browsers cap how many canvas backing stores a page may hold, and a request
  // past the cap hands back null instead of throwing. This runs once per face,
  // so on a phone with the 2D board and the preview all alive it is the one
  // place the limit is actually reached.
  if (!ctx) return null;
  // Two opposite failures have both been shipped here, and the fix is the same
  // single pass that avoids both.
  //
  // 1. putImageData over a blank canvas replaces pixels rather than blending
  //    them, so untouched cells came back with alpha 0 and the whole garment
  //    was a hole the backdrop shone through.
  // 2. Filling the entire w x h rectangle with paper fixed that but made the
  //    rectangle opaque, and the corners of the rectangle stick out of the
  //    garment as white tabs.
  //
  // So: inside the mask an unpainted cell is paper, outside it is nothing. The
  // paint itself is composited in the same buffer, which is why one
  // putImageData is now correct where it used to be the bug.
  //
  // Which mask is the open question, and it is not the same answer with a mesh
  // and without one: the paint ring is where the GAME lets you paint, the mesh
  // coverage is where the GARMENT reads texture. They differ - Mary Janes by
  // 1,321 texels - and using the ring for the mesh made real cloth transparent.
  const item = room.design.item;
  const mask = mesh ? coverageFor(mesh, item.faces).get(faceId) : maskFor(item.id, faceId);
  const img = ctx.createImageData(g.w, g.h);
  const words = new Uint32Array(img.data.buffer);
  g.fillRGBA(words, room.display ? room.display.cellsFor(idx) : null);
  const PAPER = 0xffffffff; // white, opaque, and the same word order on any target
  for (let i = 0; i < words.length; i++) {
    if (mask && !mask[i]) {
      words[i] = 0;
      continue;
    }
    if (!words[i]) words[i] = PAPER;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

/**
 * The garment's real shape, fetched once per item.
 *
 * Furniture and the book have no mesh to fetch, so they keep the flat panel
 * schematic. A garment's mesh arrives a moment after the first frame, which is
 * why the panel shows the schematic immediately and swaps rather than blocking.
 */
let meshItem = null;
// undefined: still in flight. null: this item has no mesh. object: use it.
let meshLoaded;

function rebuild3d() {
  if (!preview3d || !room) return;
  const item = room.design.item;
  preview3d.invalidate();
  if (meshItem !== item.id) {
    meshItem = item.id;
    meshLoaded = undefined;
    // A garment's baked mesh wins; an item whose face folds up (the book) gets a
    // generated solid; anything else stays on flat panels. Whichever arrives
    // second swaps in, which is why both paths rebuild below.
    Promise.all([loadMesh(item.id), loadSolid(item.id)])
      .then(([mesh, solid]) => {
        // The design moved on while this was in flight.
        if (!preview3d || meshItem !== item.id) return;
        meshLoaded = mesh || solid || null;
        preview3d.setMesh(meshLoaded);
        preview3d.build(room.design.item);
      })
      // A generated solid or a decoded mesh can throw, and an unhandled
      // rejection here means a panel that silently never draws anything at all -
      // the one failure the user cannot recover from by clicking again. Fall
      // back to the flat layout, which always builds, and say what happened.
      .catch((e) => {
        if (!preview3d || meshItem !== item.id) return;
        meshLoaded = null;
        preview3d.setMesh(null);
        try {
          preview3d.build(room.design.item);
        } catch (_) {
          /* even the fallback failed; the loop below reports it */
        }
        ui.toast(`3D fell back to the flat layout: ${e.message}`, 'warn', 5000);
      });
  }
  preview3d.setMesh(meshLoaded || null);
  preview3d.build(item);
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

/**
 * How much of the stage edge is already spoken for by a floating control.
 *
 * The zoom bar sits bottom-right over the board. Measured across six device
 * sizes it covered 1.4% of the board on a 1024x768 tablet and 5.5% on a phone -
 * cells that were visible but unreachable, because the bar eats the tap first.
 * Panels the user opens deliberately (trace, import, 3D) are not reserved:
 * they are temporary, and reserving them would shrink the board for no one's
 * benefit.
 */
function stageInset() {
  const ins = { l: 0, t: 0, r: 0, b: 0 };
  if (!view || !view.base) return ins;
  const box = view.base.getBoundingClientRect();
  for (const sel of ['.zoom', '.help']) {
    const el = document.querySelector(sel);
    if (!el || el.hidden) continue;
    const b = el.getBoundingClientRect();
    if (b.width < 1 || b.height < 1) continue;
    if (b.right <= box.left || b.left >= box.right) continue;
    if (b.bottom <= box.top || b.top >= box.bottom) continue;
    // One side only, the cheapest: pushing the board clear of an edge is
    // enough to miss an object sitting on that edge, and reserving two sides
    // for a corner control cost 9% of the board for nothing. A bar in the
    // bottom-right costs its 44px of height, not a 150px slice of width.
    const cands = [
      ['l', b.right - box.left],
      ['r', box.right - b.left],
      ['t', b.bottom - box.top],
      ['b', box.bottom - b.top],
    ];
    cands.sort((a, c) => a[1] - c[1]);
    ins[cands[0][0]] = Math.max(ins[cands[0][0]], cands[0][1]);
  }
  return ins;
}

function layout() {
  if (!view) return;
  view.measure();
  view.fit();
  ui.setZoom(view.zoomPercent);
  // The dock changes height with the board size and orientation; keep the
  // toasts clear of it instead of guessing in CSS.
  const dock = document.getElementById('dock');
  if (dock) document.documentElement.style.setProperty('--dock-h', `${Math.round(dock.getBoundingClientRect().height)}px`);
  // The 3D panel is only repainted when something changed, so a resize has to
  // say so or the garment keeps the size it had before the panel moved.
  if (preview3d) preview3d.markDirty();
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

/**
 * Copy the board into localStorage a beat after it stops changing. A stroke
 * lands in batches, so saving on every grid event would re-stringify the whole
 * board dozens of times a second to keep a single copy.
 */
const BACKUP_MS = 1200;

function scheduleBackup() {
  if (!room) return;
  if (backupTimer) clearTimeout(backupTimer);
  backupTimer = setTimeout(flushBackup, BACKUP_MS);
}

/** Save now. Called by the debounce and when the page is about to disappear. */
function flushBackup() {
  if (backupTimer) {
    clearTimeout(backupTimer);
    backupTimer = null;
  }
  if (!room) return;
  saveBoard(room.code, room.design.id, room.design.toSnapshot());
}

/**
 * Offer the picture this device painted last time it was here.
 *
 * Only on a board nothing has painted: the room is the truth, and a rescue that
 * overwrote a live picture would be worse than no rescue at all. It comes back
 * through the import path rather than being adopted wholesale, so it goes out on
 * the wire as ordinary paint under a fresh stamp, lands as one undo step, and
 * cannot drag the lamport clock backwards - which is also why a backup written
 * by an older build is merely paint, not a state packet.
 */
function offerBackup() {
  if (!room || !input) return;
  const design = room.design;
  const row = loadBoard(room.code, design.id);
  if (!row || !fitsDesign(row, design)) return;
  const wanted = savedCount(row);
  if (!wanted || !designIsEmpty(design)) return;
  const when = new Date(row.saved).toLocaleString();
  if (!confirm(`Bring back the board you left here - ${wanted} painted cell${wanted === 1 ? '' : 's'}, ${when}?`)) return;
  let cells = 0;
  for (let i = 0; i < row.snapshot.faces.length; i++) {
    const f = row.snapshot.faces[i];
    let buf;
    try {
      buf = b64ToBytes(f.cells || '');
    } catch (_) {
      continue; // one unreadable face must not lose the rest
    }
    cells += applyCellsToFace(room, input, buf, f.w, f.h, i).changed;
  }
  view.markDirty();
  if (preview3d) preview3d.refresh();
  ui.toast(cells ? `Restored ${cells} cell${cells === 1 ? '' : 's'} from your last visit` : 'Nothing could be restored', cells ? 'info' : 'warn');
}

function clearBoard() {
  if (!room || !room.canPaint) return;
  if (!confirm('Clear the whole design for everyone in this room?')) return;
  room.clear();
  undo.clear();
  ui.setUndoState(undo);
  // A deliberate clear is the one time the backup is wrong, not a rescue, so it
  // goes now. The clear itself re-triggers the autosave, and a saved-but-empty
  // board is never offered back, so the two cannot fight.
  clearBackup(room.code, room.design.id);
  ui.toast('Design cleared', 'info');
  refreshTrace();
}

/**
 * Point the ratio/level pickers at the design the room actually has.
 *
 * They are what the design dialog pre-selects, so a stale pair makes the dialog
 * open on the wrong size - and because "apply" is only enabled when the pick
 * differs from the room design, a stale pair also offers to resize the room
 * *back* to a size nobody asked for. Non-canvas designs leave them alone, so
 * switching to a garment and back remembers the canvas you were on.
 */
function syncBoardState(itemId) {
  const board = boardForItem(itemId);
  if (!board) return;
  state.ratio = board.ratio;
  state.level = board.level;
}

function setItem(id) {
  if (!room || !room.canPaint) return;
  // Ask the host question before the confirm, not after: a guest that says yes
  // to "this wipes the board" and then watches nothing happen reads as a bug.
  if (!room.isDesignHost) return ui.toast('Only the room host can change the design', 'warn');
  const item = findItem(id);
  if (!item) return;
  const warn = room.design.usedCells() > 0 ? `Switch to ${item.name}? This wipes the board for everyone.` : `Switch to ${item.name}?`;
  if (!confirm(warn)) return;
  if (!room.setItem(id)) return;
  state.item = id;
  state.designItem = id;
  state.designFamily = item.family;
  syncBoardState(id);
  undo.clear();
  ui.setUndoState(undo);
  view.setFace(room.grid, room.design.active);
  applyOutline();
  ui.toast(`${item.name} · ${item.faces.length} faces`, 'info');
}

function setBoard(ratio, level) {
  if (!room || !room.canPaint) return;
  if (!room.isDesignHost) return ui.toast('Only the room host can resize the board', 'warn');
  if (!confirm('Resize the board? Everything currently painted will be lost for everyone.')) return;
  // setBoard goes through setItem, which refuses when we are not the design
  // host - do not update local state for a resize the room never accepted.
  if (!room.setBoard(ratio, level)) return;
  state.ratio = ratio;
  state.level = level;
  state.item = itemIdForBoard(ratio, level);
  state.designItem = state.item;
  state.designFamily = 'canvas';
  syncBoardState(state.item);
  // The old board is gone, so its patches are too: an undo left over from it
  // would replay cells that no longer exist into the new grid.
  undo.clear();
  ui.setUndoState(undo);
  view.setFace(room.grid, room.design.active);
  applyOutline();
  // The legend and the "cells left" count are sized from the board, so they are
  // stale the moment it changes.
  refreshTrace();
  ui.toast(`Board resized to ${ratio} · ${LEVELS[level].tag}`, 'info');
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

  l: TOOLS.LINE,
  r: TOOLS.RECT,
  o: TOOLS.ELLIPSE,
  p: TOOLS.POLYGON,
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
  // ?item=canvas-16:9-2 has to open the dialog on 16:9 XL, not on the defaults.
  syncBoardState(state.item);
  ui._join.item = state.item;
  ui._join.family = state.designFamily;
  ui._buildItemPick();
  ui.showGroup(groupForIndex(state.colorIdx));
  ui.setColorIdx(state.colorIdx);
  ui.setTool(state.tool);
  ui.setBrush(state.brush);
  // Bring back the tip this player imported last time. Async, and silent if it
  // is gone: a missing brush is not worth stopping the app for.
  if (profile.tip) {
    stampFromDataUrl(profile.tip).then(
      ({ stamp }) => {
        state.stamp = stamp;
        ui.setTip(stampPreview(stamp));
      },
      () => {}
    );
  }
  watchLayout();
  bindKeys();
  // Touch the palette once so the perceptual tables are warm before a person
  // asks for an import; the first quantise is otherwise measurably slower.
  palette();

  // A phone getting backgrounded, or a tab being swiped away, is the exact
  // moment the debounce has not fired yet. Save what is on screen before it.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushBackup();
  });

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
