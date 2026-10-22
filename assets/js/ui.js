/*
 * UI: the nickname gate, the Heartopia colour dock, the tool box, the face tabs
 * and the three panels (trace, import, 3D).
 *
 * All markup lives in index.html; this file builds the generated parts (125
 * palette swatches, 13 groups, the item catalogue, the face tabs) and wires
 * behaviour. It deliberately knows nothing about the network - it takes an
 * `actions` object and calls it, the same way the dock always has.
 */

import { HEARTOPIA_GROUPS, FLAT_COLORS } from './data/heartopia-palette.js';
import { RATIOS, LEVELS, BRUSH_SIZES } from './presets.js';
import { CATALOG, FAMILIES, FAMILY, findItem, cellTotal, itemIdForBoard, boardForItem } from './game/slots.js';
import { clamp, escapeHtml, initials, makeRoomCode, normalizeRoomCode, readableInk, detectDevice } from './util.js';
import { TOOLS } from './input.js';
import { MODES as TRACE_MODES, BLOCK_SIZES } from './ui/blueprint.js';
import { DITHER } from './ui/importer.js';

const ICONS = {
  brush:
    '<path d="M3 17c0 2 1.5 3.5 3.5 3.5 1 0 1.8-.4 2.3-1L16 12l-3-3L5.5 16c-.3.4-.5.8-.5 1z"/><path d="M14 7l3-3 4 4-3 3z"/>',
  eraser: '<path d="M8 20h10"/><path d="M6 16l6-6 6 6-4 4H8z"/>',
  pick: '<path d="M12 2l2 6-4 4-2-2z"/><path d="M8 12l-5 8 8-5"/>',
  fill: '<path d="M5 9l7-7 7 7-7 7z"/><path d="M19 13c1.5 2 2 3 2 4a2 2 0 01-4 0c0-1 .5-2 2-4z"/>',
  spray: '<path d="M9 8h6v12H9z"/><path d="M17 4h1M19 6h1M17 8h1M15 4h1"/><path d="M9 8l-3 3v9h3"/>',
  line: '<path d="M4 20L20 4"/>',
  rect: '<rect x="4" y="6" width="16" height="12"/>',
  ellipse: '<ellipse cx="12" cy="12" rx="8" ry="6"/>',
  triangle: '<path d="M12 4l8 16H4z"/>',
  star: '<path d="M12 3l2.6 6.2 6.4.5-4.9 4.2 1.5 6.3L12 17l-5.6 3.2 1.5-6.3L3 9.7l6.4-.5z"/>',
  heart: '<path d="M12 20s-7-4.5-7-9.5A3.9 3.9 0 0112 8a3.9 3.9 0 017 2.5c0 5-7 9.5-7 9.5z"/>',
  arrow: '<path d="M4 20L20 4"/><path d="M12 4h8v8"/>',
  polygon: '<path d="M12 3l8 6-3 10H7L4 9z"/>',
  guide: '<path d="M3 17c4-8 8 4 12-4 2-4 4-4 6-3"/>',
  grid: '<rect x="4" y="4" width="16" height="16"/><path d="M10 4v16M16 4v16M4 10h16M4 16h16"/>',
  mirror: '<path d="M12 3v18"/><path d="M9 7L4 12l5 5"/><path d="M15 7l5 5-5 5"/>',
  undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h9a5 5 0 010 10H8"/>',
  redo: '<path d="M15 14l5-5-5-5"/><path d="M20 9h-9a5 5 0 000 10h5"/>',
  desktop: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
  ipad: '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M11 18h2"/>',
  phone: '<rect x="8" y="2" width="8" height="20" rx="2"/><path d="M11 19h2"/>',
  link: '<path d="M10 14a4 4 0 006 .5l2.5-2.5a4 4 0 00-5.6-5.6L11.5 7"/><path d="M14 10a4 4 0 00-6-.5L5.5 12a4 4 0 005.6 5.6L12.5 15"/>',
};

const svg = (name, cls = '') =>
  `<svg class="ic ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`;

/** Flat shade index (1..125) -> which colour group holds it. */
export function groupForIndex(idx) {
  let start = 1;
  for (let i = 0; i < HEARTOPIA_GROUPS.length; i++) {
    const len = HEARTOPIA_GROUPS[i].colors.length;
    if (idx >= start && idx < start + len) return i;
    start += len;
  }
  return 0;
}

const DEVICE_ICON = { desktop: 'desktop', ipad: 'ipad', iphone: 'phone', android: 'phone', touch: 'ipad' };

const PANELS = ['tracePanel', 'importPanel', 'd3Panel'];
const BTN = { tracePanel: 'btnTrace', importPanel: 'btnImport', d3Panel: 'btn3d' };

const TOOL_DEFS = [
  ['brush', 'Brush', 'B'],
  ['eraser', 'Eraser', 'E'],
  ['pick', 'Eyedropper', 'I'],
  ['fill', 'Bucket', 'F'],
  ['spray', 'Spray', 'J'],
  ['line', 'Line', 'L'],
  ['rect', 'Rectangle', 'R'],
  ['ellipse', 'Ellipse', 'O'],
  ['triangle', 'Triangle', 'T'],
  ['star', 'Star', 'S'],
  ['heart', 'Heart', 'H'],
  ['arrow', 'Arrow', 'A'],
  ['polygon', 'Polygon', 'P'],
  ['guide', 'Guide line', 'D'],
];

export class UI {
  constructor({ state, onJoin, actions }) {
    this.state = state;
    this.onJoin = onJoin;
    this.actions = actions;
    this.el = {
      veil: document.getElementById('veil'),
      card: document.getElementById('joinCard'),
      nick: document.getElementById('nick'),
      nickErr: document.getElementById('nickErr'),
      myColors: document.getElementById('myColors'),
      famRow: document.getElementById('famRow'),
      itemPick: document.getElementById('itemPick'),
      canvasSizeField: document.getElementById('canvasSizeField'),
      ratios: document.getElementById('ratios'),
      levels: document.getElementById('levels'),
      dims: document.getElementById('dims'),
      boardNote: document.getElementById('boardNote'),
      room: document.getElementById('room'),
      newRoom: document.getElementById('newRoom'),
      join: document.getElementById('join'),
      app: document.getElementById('app'),
      roomChip: document.getElementById('roomChip'),
      roomCode: document.getElementById('roomCode'),
      net: document.getElementById('net'),
      netText: document.getElementById('netText'),
      players: document.getElementById('players'),
      faces: document.getElementById('faces'),
      groups: document.getElementById('groups'),
      swatches: document.getElementById('swatches'),
      brushes: document.getElementById('brushes'),
      tools: document.getElementById('tools'),
      toolOpts: document.getElementById('toolOpts'),
      current: document.getElementById('currentColor'),
      zoomVal: document.getElementById('zoomVal'),
      toast: document.getElementById('toast'),
      me: document.getElementById('meChip'),
      undo: document.getElementById('btnUndo'),
      redo: document.getElementById('btnRedo'),
      tracePanel: document.getElementById('tracePanel'),
      traceModes: document.getElementById('traceModes'),
      blockSizes: document.getElementById('blockSizes'),
      traceNote: document.getElementById('traceNote'),
      legend: document.getElementById('legend'),
      importPanel: document.getElementById('importPanel'),
      importModes: document.getElementById('importModes'),
      drop: document.getElementById('drop'),
      file: document.getElementById('file'),
      dropText: document.getElementById('dropText'),
      importPrev: document.getElementById('importPrev'),
      importInfo: document.getElementById('importInfo'),
      importControls: document.getElementById('importControls'),
      importApply: document.getElementById('importApply'),
      importCancel: document.getElementById('importCancel'),
      d3Panel: document.getElementById('d3Panel'),
      d3Canvas: document.getElementById('d3Canvas'),
    };
    this._join = { family: 'canvas', item: itemIdForBoard(state.ratio, state.level) };
    this._buildJoin();
    this._buildDock();
    this._buildTrace();
    this._buildImport();
    this._wireChrome();
  }

  /* ---------------- join gate ---------------- */

  _buildJoin() {
    const e = this.el;
    // Identity colours: the 13 Heartopia group primaries.
    e.myColors.innerHTML = HEARTOPIA_GROUPS.map(
      (g, i) =>
        `<button class="pick-color" data-color="${g.main}" style="--c:${g.main}" title="Group ${g.group}" aria-label="Group ${g.group}"></button>`
    ).join('');
    e.myColors.addEventListener('click', (ev) => {
      const b = ev.target.closest('.pick-color');
      if (!b) return;
      this.state.color = b.dataset.color;
      this._syncPick(e.myColors, b);
    });
    this._syncPick(e.myColors, e.myColors.querySelector(`[data-color="${this.state.color}"]`));

    e.famRow.innerHTML = FAMILIES.map(
      (f) => `<button class="pick-fam" data-fam="${f}" title="${FAMILY[f].blurb}">${FAMILY[f].name}</button>`
    ).join('');
    e.famRow.addEventListener('click', (ev) => {
      const b = ev.target.closest('[data-fam]');
      if (!b) return;
      this._join.family = b.dataset.fam;
      const first = CATALOG[this._join.family][0];
      this._join.item = this._join.family === 'canvas' ? itemIdForBoard(this.state.ratio, this.state.level) : first.id;
      this._syncPick(e.famRow, b);
      this._buildItemPick();
    });
    this._syncPick(e.famRow, e.famRow.querySelector(`[data-fam="canvas"]`));

    e.ratios.innerHTML = RATIOS.map(
      (r) => `<button class="pick-ratio" data-ratio="${r}" title="${r}">${r}</button>`
    ).join('');
    e.levels.innerHTML = LEVELS.map(
      (l) => `<button class="pick-level" data-level="${l.id}" title="${l.name} (${l.hint})">${l.tag}</button>`
    ).join('');

    const pickBoard = (btn) => {
      if (btn.dataset.ratio) {
        this.state.ratio = btn.dataset.ratio;
        this._syncPick(e.ratios, btn);
      } else {
        this.state.level = Number(btn.dataset.level);
        this._syncPick(e.levels, btn);
      }
      this._join.item = itemIdForBoard(this.state.ratio, this.state.level);
      this.showDims();
    };
    e.ratios.addEventListener('click', (ev) => {
      const b = ev.target.closest('[data-ratio]');
      if (b) pickBoard(b);
    });
    e.levels.addEventListener('click', (ev) => {
      const b = ev.target.closest('[data-level]');
      if (b) pickBoard(b);
    });
    this._syncPick(e.ratios, e.ratios.querySelector(`[data-ratio="${this.state.ratio}"]`));
    this._syncPick(e.levels, e.levels.querySelector(`[data-level="${this.state.level}"]`));
    this._buildItemPick();
    this.showDims();

    e.newRoom.addEventListener('click', () => {
      e.room.value = makeRoomCode();
    });
    e.room.addEventListener('input', () => {
      e.room.value = normalizeRoomCode(e.room.value);
    });

    e.nick.addEventListener('input', () => {
      e.nickErr.textContent = '';
    });
    e.nick.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') e.join.click();
    });
    e.join.addEventListener('click', () => this._submitJoin());
  }

  _buildItemPick() {
    const e = this.el;
    const fam = this._join.family;
    e.canvasSizeField.hidden = fam !== 'canvas';
    if (fam === 'canvas') {
      e.itemPick.innerHTML = '';
      this.showDims();
      return;
    }
    e.itemPick.innerHTML = CATALOG[fam]
      .map(
        (i) =>
          `<button class="item-chip" data-item="${i.id}" title="${i.native ? escapeHtml(i.native) + ' · ' : ''}${
            i.faces.length
          } faces · ${cellTotal(i).toLocaleString()} cells">${escapeHtml(
            i.name
          )}<b>${i.faces.length}</b></button>`
      )
      .join('');
    e.itemPick.onclick = (ev) => {
      const b = ev.target.closest('[data-item]');
      if (!b) return;
      this._join.item = b.dataset.item;
      this._syncPick(e.itemPick, b);
      this.showDims();
    };
    const sel = e.itemPick.querySelector(`[data-item="${this._join.item}"]`) || e.itemPick.firstChild;
    this._syncPick(e.itemPick, sel);
    this.showDims();
  }

  _submitJoin() {
    const e = this.el;
    const nick = cleanNick(e.nick.value);
    const err = validateNick(nick);
    if (err) {
      e.nickErr.textContent = err;
      e.nick.focus();
      e.card.classList.add('shake');
      setTimeout(() => e.card.classList.remove('shake'), 450);
      return;
    }
    e.nick.value = nick;
    this.onJoin({
      nick,
      color: this.state.color,
      device: detectDevice(),
      room: normalizeRoomCode(e.room.value) || makeRoomCode(),
      ratio: this.state.ratio,
      level: this.state.level,
      item: this._join.item,
    });
  }

  showDims() {
    const e = this.el;
    const item = findItem(this._join.item);
    if (!item) return;
    if (item.family === 'canvas') {
      const d = item.faces[0];
      e.dims.textContent = `${d.w} × ${d.h}`;
    } else {
      e.dims.textContent = `${item.faces.length} faces · ${cellTotal(item).toLocaleString()} cells`;
    }
    e.boardNote.textContent =
      this.state.roomLocked
        ? 'The room already decided what it is making.'
        : 'First player in the room sets it. Everyone else matches.';
    e.ratios.classList.toggle('locked', !!this.state.roomLocked);
    e.levels.classList.toggle('locked', !!this.state.roomLocked);
  }

  openGate() {
    this.el.veil.hidden = false;
    this.el.app.hidden = true;
    setTimeout(() => this.el.nick.focus(), 60);
  }

  closeGate() {
    this.el.veil.classList.add('leaving');
    setTimeout(() => {
      this.el.veil.hidden = true;
      this.el.veil.classList.remove('leaving');
      this.el.app.hidden = false;
      this.actions.onLayout();
    }, 220);
  }

  /* ---------------- colour dock ---------------- */

  _buildDock() {
    const e = this.el;
    e.groups.innerHTML = HEARTOPIA_GROUPS.map(
      (g, i) =>
        `<button class="group" data-group="${i}" style="--c:${g.main}" title="Group ${g.group}: ${g.colors.length} shades" aria-label="Colour group ${g.group} of ${HEARTOPIA_GROUPS.length}, ${g.colors.length} shades"></button>`
    ).join('');
    e.groups.addEventListener('click', (ev) => {
      const b = ev.target.closest('.group');
      if (!b) return;
      this.showGroup(Number(b.dataset.group));
    });

    e.brushes.innerHTML = BRUSH_SIZES.map(
      (s) =>
        `<button class="brush" data-brush="${s}" title="${s}×${s} cells"><span style="width:${Math.min(18, s * 4)}px;height:${Math.min(18, s * 4)}px"></span></button>`
    ).join('');
    e.brushes.addEventListener('click', (ev) => {
      const b = ev.target.closest('.brush');
      if (b) this.actions.setBrush(Number(b.dataset.brush));
    });

    // No hand tool: pinch and space-drag do that job, like every other canvas.
    e.tools.innerHTML = TOOL_DEFS.map(
      ([id, label, key]) =>
        `<button class="tool" data-tool="${id}" title="${label} (${key})">${svg(id)}<span>${label}</span></button>`
    ).join('');
    e.tools.addEventListener('click', (ev) => {
      const b = ev.target.closest('.tool');
      if (b) this.actions.setTool(b.dataset.tool);
    });

    // Delegation: showGroup() replaces the swatch nodes on every group change,
    // so the listener has to live on the container.
    e.swatches.addEventListener('click', (ev) => {
      const b = ev.target.closest('.swatch');
      if (!b) return;
      this.actions.setColor(Number(b.dataset.idx));
    });
  }

  /** The row under the tools: only the options that apply to the live tool. */
  _buildToolOptions() {
    const e = this.el;
    const st = this.state;
    const row = (label, seg, name) => `<span class="dock-label">${label}</span><div class="seg tiny" data-opt="${name}">${seg}</div>`;
    const chips = (name, opts, active) =>
      opts.map((o) => `<button class="opt" data-${name}="${o[0]}" title="${o[2]}">${o[1]}</button>`).join('') + '';
    let html = '';
    if (st.tool === TOOLS.BRUSH || st.tool === TOOLS.ERASER || st.tool === TOOLS.SPRAY) {
      html += row(
        'Shape',
        chips('shape', [
          ['square', 'Square', 'Hard-edged, like the game'],
          ['round', 'Round', 'Round brush footprint'],
        ], st.brushShape),
        'shape'
      );
    }
    if (st.tool === TOOLS.SPRAY) {
      html += `<span class="dock-label">Density</span><input class="slider" type="range" min="10" max="90" value="${Math.round(
        st.sprayDensity * 100
      )}" data-opt="density">`;
    }
    if (['line', 'rect', 'ellipse', 'triangle', 'star', 'heart'].includes(st.tool)) {
      html += row(
        'Style',
        chips('fillmode', [
          ['outline', 'Outline', 'Just the edge'],
          ['filled', 'Filled', 'Fill the inside'],
        ], st.shapeFilled ? 'filled' : 'outline'),
        'fillmode'
      );
    }
    if (st.tool === TOOLS.FILL) {
      html += row(
        'Bucket',
        chips('fillscope', [
          ['area', 'Area', 'Contiguous'],
          ['all', 'Everywhere', 'This shade, all over the face'],
        ], st.fillGlobal ? 'all' : 'area'),
        'fillscope'
      );
    }
    html += row(
      'Mirror',
      chips('mirror', [
        ['off', 'Off', 'No mirroring'],
        ['x', '↔', 'Across the middle'],
        ['y', '↕', 'Down the middle'],
        ['xy', '✛', 'Both'],
      ], ['off', 'x', 'y', 'xy'][st.mirror || 0]),
      'mirror'
    );
    e.toolOpts.innerHTML = html;
    for (const b of e.toolOpts.querySelectorAll('[data-shape]'))
      b.classList.toggle('active', b.dataset.shape === st.brushShape);
    for (const b of e.toolOpts.querySelectorAll('[data-fillmode]'))
      b.classList.toggle('active', (b.dataset.fillmode === 'filled') === !!st.shapeFilled);
    for (const b of e.toolOpts.querySelectorAll('[data-fillscope]'))
      b.classList.toggle('active', (b.dataset.fillscope === 'all') === !!st.fillGlobal);
    for (const b of e.toolOpts.querySelectorAll('[data-mirror]'))
      b.classList.toggle('active', b.dataset.mirror === ['off', 'x', 'y', 'xy'][st.mirror || 0]);
  }

  _wireToolOptions() {
    const e = this.el;
    e.toolOpts.addEventListener('click', (ev) => {
      const b = ev.target.closest('button[data-shape],button[data-fillmode],button[data-fillscope],button[data-mirror]');
      if (!b) return;
      if (b.dataset.shape) this.actions.setBrushShape(b.dataset.shape);
      if (b.dataset.fillmode) this.actions.setShapeFilled(b.dataset.fillmode === 'filled');
      if (b.dataset.fillscope) this.actions.setFillGlobal(b.dataset.fillscope === 'all');
      if (b.dataset.mirror) this.actions.setMirror(['off', 'x', 'y', 'xy'].indexOf(b.dataset.mirror));
    });
    e.toolOpts.addEventListener('input', (ev) => {
      if (ev.target.dataset.opt === 'density') this.actions.setSprayDensity(Number(ev.target.value) / 100);
    });
  }

  showGroup(i) {
    const e = this.el;
    i = clamp(i, 0, HEARTOPIA_GROUPS.length - 1);
    const g = HEARTOPIA_GROUPS[i];
    this.state.groupIndex = i;
    for (const btn of e.groups.children) btn.classList.toggle('active', Number(btn.dataset.group) === i);
    let flat = 1;
    for (let k = 0; k < i; k++) flat += HEARTOPIA_GROUPS[k].colors.length;
    e.swatches.innerHTML = g.colors
      .map((hex, n) => {
        const idx = flat + n;
        return `<button class="swatch" data-idx="${idx}" style="--c:${hex}" title="${hex}" aria-label="Colour ${idx}"></button>`;
      })
      .join('');
    // Only highlights what is showing. Which group is showing is the caller's
    // decision - if this snapped back to the current shade's group, a category
    // click could never stick.
    this._syncSwatch();
  }

  _syncSwatch() {
    const e = this.el;
    for (const s of e.swatches.children) s.classList.toggle('active', Number(s.dataset.idx) === this.state.colorIdx);
    const hex = FLAT_COLORS[this.state.colorIdx] || '#ffffff';
    e.current.style.setProperty('--c', hex);
    e.current.textContent = hex;
    e.current.style.color = readableInk(hex);
  }

  setColorIdx(idx) {
    this.state.colorIdx = idx;
    this.state.colorHex = FLAT_COLORS[idx] || '#ffffff';
    // Follow the shade only when the shade is what changed (a pick, an
    // eyedropper read). A category click must not be second-guessed.
    const g = groupForIndex(idx);
    if (this.state.groupIndex === null || g !== this.state.groupIndex) this.showGroup(g);
    else if (this.el.swatches.children.length) this._syncSwatch();
  }

  setTool(tool) {
    for (const b of this.el.tools.children) b.classList.toggle('active', b.dataset.tool === tool);
    this.state.tool = tool;
    this._buildToolOptions();
  }

  setBrush(size) {
    for (const b of this.el.brushes.children) b.classList.toggle('active', Number(b.dataset.brush) === size);
    this.state.brush = size;
  }

  /* ---------------- face tabs ---------------- */

  setFaces(faces, active, elsewhere = []) {
    const e = this.el;
    if (faces.length < 2) {
      e.faces.innerHTML = '';
      e.faces.hidden = true;
      return;
    }
    e.faces.hidden = false;
    const byFace = new Map();
    for (const p of elsewhere) byFace.set(p.face, (byFace.get(p.face) || []).concat(p));
    e.faces.innerHTML = faces
      .map((f, i) => {
        const who = byFace.get(i) || [];
        const dots = who
          .slice(0, 4)
          .map((p) => `<i class="who" style="--c:${escapeHtml(p.color)}" title="${escapeHtml(p.nick)}"></i>`)
          .join('');
        const more = who.length > 4 ? `<i class="who more">+${who.length - 4}</i>` : '';
        return `<button class="face ${i === active ? 'active' : ''}" data-face="${i}" title="${f.native ? escapeHtml(f.native) + ' · ' : ''}${
          f.w
        } × ${f.h} cells">
          ${escapeHtml(f.label)}<b>${f.w}×${f.h}</b>${dots ? `<span class="who-row">${dots}${more}</span>` : ''}</button>`;
      })
      .join('');
  }

  /* ---------------- chrome ---------------- */

  _wireChrome() {
    const e = this.el;
    e.roomChip.addEventListener('click', () => this.actions.copyInvite());
    document.getElementById('btnGrid').addEventListener('click', (ev) => {
      this.state.showGrid = !this.state.showGrid;
      ev.currentTarget.classList.toggle('active', this.state.showGrid);
      this.actions.setGridVisible(this.state.showGrid);
    });
    document.getElementById('btnSave').addEventListener('click', () => this.actions.exportPNG());
    document.getElementById('btnClear').addEventListener('click', () => this.actions.clearBoard());
    document.getElementById('btnDesign').addEventListener('click', () => this.openDesignDialog());
    document.getElementById('btnImport').addEventListener('click', () => this.togglePanel('importPanel'));
    document.getElementById('btn3d').addEventListener('click', () => this.togglePanel('d3Panel'));
    document.getElementById('btnTrace').addEventListener('click', () => this.togglePanel('tracePanel'));
    document.getElementById('btnLeave').addEventListener('click', () => this.actions.leave());
    document.getElementById('zOut').addEventListener('click', () => this.actions.zoom(1 / 1.25));
    document.getElementById('zIn').addEventListener('click', () => this.actions.zoom(1.25));
    document.getElementById('zFit').addEventListener('click', () => this.actions.fit());
    document.getElementById('btnHelp').addEventListener('click', () => this.toggleHelp());
    e.undo.innerHTML = svg('undo');
    e.redo.innerHTML = svg('redo');
    e.undo.addEventListener('click', () => this.actions.undo());
    e.redo.addEventListener('click', () => this.actions.redo());
    e.faces.addEventListener('click', (ev) => {
      const b = ev.target.closest('[data-face]');
      if (b) this.actions.switchFace(Number(b.dataset.face));
    });
    for (const x of document.querySelectorAll('.panel-x'))
      x.addEventListener('click', () => this.hidePanel(x.dataset.close));
    document.getElementById('d3Reset').addEventListener('click', () => this.actions.reset3d());
    document.getElementById('tickBlock').addEventListener('click', () => this.actions.tickBlock());
    e.importCancel.addEventListener('click', () => this.hidePanel('importPanel'));
    e.importApply.addEventListener('click', () => this.actions.applyImport());
    e.file.addEventListener('change', () => {
      if (e.file.files && e.file.files[0]) this.actions.loadImport(e.file.files[0]);
    });
    this._wireToolOptions();
    e.nick.value = this.state.nick || '';
  }

  /** Only one panel at a time: they all want the same corner of the screen. */
  togglePanel(id) {
    const p = document.getElementById(id);
    const show = p.hidden;
    for (const other of PANELS) if (other !== id) this.hidePanel(other);
    p.hidden = !show;
    document.getElementById(BTN[id]).classList.toggle('active', show);
    if (show) {
      if (id === 'importPanel') this._buildImportControls();
      if (id === 'd3Panel') this.actions.open3d();
      if (id === 'tracePanel') this.actions.refreshTrace();
    }
  }

  hidePanel(id) {
    const p = document.getElementById(id);
    if (p) p.hidden = true;
    const btn = document.getElementById(BTN[id]);
    if (btn) btn.classList.remove('active');
    if (id === 'd3Panel') this.actions.close3d();
  }

  /* ---------------- trace panel ---------------- */

  _buildTrace() {
    const e = this.el;
    e.traceModes.innerHTML = TRACE_MODES.map(
      (m) => `<button data-mode="${m}" title="${m === 'off' ? 'Just paint' : m === 'block' ? 'Work block by block' : 'Work shade by shade'}">${m}</button>`
    ).join('');
    e.traceModes.addEventListener('click', (ev) => {
      const b = ev.target.closest('[data-mode]');
      if (b) this.actions.setTraceMode(b.dataset.mode);
    });
    e.blockSizes.innerHTML = BLOCK_SIZES.map((n) => `<button data-block="${n}" title="${n}×${n} cells">${n}</button>`).join('');
    e.blockSizes.addEventListener('click', (ev) => {
      const b = ev.target.closest('[data-block]');
      if (b) this.actions.setBlockSize(Number(b.dataset.block));
    });
    // Delegation again: refreshLegend() rebuilds every row on each change.
    e.legend.addEventListener('click', (ev) => {
      const b = ev.target.closest('[data-legend]');
      if (b) this.actions.setColor(Number(b.dataset.legend));
    });
  }

  syncTrace(mode, block) {
    for (const b of this.el.traceModes.children) b.classList.toggle('active', b.dataset.mode === mode);
    for (const b of this.el.blockSizes.children) b.classList.toggle('active', Number(b.dataset.block) === block);
    this.el.blockSizes.classList.toggle('dim', mode !== 'block');
  }

  /** Called with no arguments by the Trace button; the room pushes the data. */
  refreshLegend(legend = this._legend || [], remaining = this._remaining ?? 0, doneOf = this._done ?? null) {
    const e = this.el;
    if (!legend) return;
    this._legend = legend;
    this._remaining = remaining;
    this._done = doneOf;
    e.traceNote.textContent = legend.length
      ? `${legend.length} ${legend.length === 1 ? 'shade' : 'shades'} in use · ${remaining.toLocaleString()} cells to key in${
          doneOf != null ? ` · ${doneOf} blocks ticked` : ''
        }`
      : 'Nothing painted on this face yet.';
    e.legend.innerHTML = legend
      .map(
        (l, n) =>
          `<button class="leg${this.state.colorIdx === l.idx ? ' active' : ''}" data-legend="${l.idx}" style="--c:${
            l.hex
          };--ink:${readableInk(l.hex)}" title="${l.hex} · group ${l.group + 1}">
            <i>${n + 1}</i><span>${l.n.toLocaleString()}</span></button>`
      )
      .join('');
  }

  /* ---------------- import panel ---------------- */

  _buildImport() {
    const e = this.el;
    e.importModes.innerHTML = [
      ['photo', 'Photo'],
      ['screenshot', 'Game screenshot'],
    ]
      .map(([id, label]) => `<button data-import="${id}" title="${id === 'photo' ? 'Any picture, quantised to the palette' : 'Detect the board in a Heartopia screenshot'}">${label}</button>`)
      .join('');
    e.importModes.addEventListener('click', (ev) => {
      const b = ev.target.closest('[data-import]');
      if (!b) return;
      this.state.importMode = b.dataset.import;
      for (const c of e.importModes.children) c.classList.toggle('active', c === b);
      e.dropText.textContent =
        b.dataset.import === 'screenshot'
          ? 'Drop a screenshot of an in-game board'
          : 'Choose a photo, or drop one on the board';
      this._buildImportControls();
    });
    this._syncPick(e.importModes, e.importModes.firstChild);

    const stop = (ev) => {
      ev.preventDefault();
      e.drop.classList.remove('hot');
      if (ev.dataTransfer && ev.dataTransfer.files && ev.dataTransfer.files[0]) this.actions.loadImport(ev.dataTransfer.files[0]);
    };
    e.drop.addEventListener('dragover', (ev) => {
      ev.preventDefault();
      e.drop.classList.add('hot');
    });
    e.drop.addEventListener('drop', stop);
    e.drop.addEventListener('dragleave', () => e.drop.classList.remove('hot'));
    // Dropping straight onto the stage is the way people actually do it.
    const stage = document.getElementById('stage');
    stage.addEventListener('dragover', (ev) => ev.preventDefault());
    this._wireImportControls();
    stage.addEventListener('drop', (ev) => {
      ev.preventDefault();
      this.showPanel('importPanel');
      if (ev.dataTransfer && ev.dataTransfer.files && ev.dataTransfer.files[0]) this.actions.loadImport(ev.dataTransfer.files[0]);
    });
  }

  showPanel(id) {
    for (const other of PANELS) if (other !== id) this.hidePanel(other);
    document.getElementById(id).hidden = false;
    document.getElementById(BTN[id]).classList.add('active');
    if (id === 'importPanel') this._buildImportControls();
  }

  _buildImportControls() {
    const e = this.el;
    const photo = this.state.importMode !== 'screenshot';
    const rows = [];
    if (photo) {
      rows.push(['fit', 'Fit', 'select', ['cover', 'contain', 'stretch']]);
      rows.push(['dither', 'Dither', 'select', DITHER.filter((d) => d !== 'bayer2')]);
      rows.push(['maxColors', 'Max colours', 'range', [4, 125]]);
      rows.push(['brightness', 'Brightness', 'range', [-60, 60]]);
      rows.push(['contrast', 'Contrast', 'range', [-60, 60]]);
      rows.push(['saturation', 'Saturation', 'range', [-80, 80]]);
    } else {
      rows.push(['pitch', 'Cell size', 'auto']);
      rows.push(['trim', 'Ignore cell edges', 'range', [4, 34]]);
    }
    e.importControls.innerHTML = rows
      .map(([key, label, kind, range]) => {
        if (kind === 'select')
          return `<label class="ctl"><span>${label}</span><select data-ctl="${key}">${range
            .map((v) => `<option value="${v}">${v}</option>`)
            .join('')}</select></label>`;
        if (kind === 'range')
          return `<label class="ctl"><span>${label}</span><input class="slider" type="range" data-ctl="${key}" min="${range[0]}" max="${range[1]}" value="${
            this.state.import[key] ?? (key === 'maxColors' ? 24 : key === 'trim' ? 16 : 0)
          }"></label>`;
        return `<label class="ctl"><span>${label}</span><output data-ctl="${key}">auto</output></label>`;
      })
      .join('');
  }

  /**
   * Wired once, not from _buildImportControls: that runs every time the panel is
   * opened, the container element is reused, and a listener added per open means
   * the tenth slider drag re-renders the preview ten times.
   */
  _wireImportControls() {
    const e = this.el;
    const onInput = (ev) => {
      const t = ev.target;
      if (!t.dataset || !t.dataset.ctl) return;
      const v = t.type === 'number' || t.type === 'range' ? Number(t.value) : t.value;
      this.state.import[t.dataset.ctl] = v;
      this.actions.previewImport();
    };
    e.importControls.addEventListener('input', onInput);
    e.importControls.addEventListener('change', onInput);
  }

  setImportInfo(text, ok) {
    this.el.importInfo.textContent = text;
    this.el.importApply.disabled = !ok;
  }

  setImportPreview(canvas) {
    const e = this.el;
    e.importPrev.replaceChildren(canvas);
    e.importPrev.hidden = false;
  }

  setUndoState({ canUndo, canRedo }) {
    this.el.undo.disabled = !canUndo;
    this.el.redo.disabled = !canRedo;
  }

  /* ---------------- design dialog ---------------- */

  openDesignDialog() {
    const d = document.getElementById('designDialog');
    d.hidden = false;
    const state = { family: this.state.designFamily || 'canvas', item: this.state.designItem };
    const fams = document.getElementById('fFams');
    const items = document.getElementById('fItems');
    const info = document.getElementById('fInfo');
    const draw = () => {
      const item = findItem(state.item);
      for (const b of fams.children) b.classList.toggle('active', b.dataset.fam === state.family);
      items.innerHTML = CATALOG[state.family]
        .map(
          (i) =>
            `<button class="item-card" data-item="${i.id}"><b>${escapeHtml(i.name)}</b><span>${
              i.native ? escapeHtml(i.native) + ' · ' : ''
            }${i.faces
              .map((f) => `${f.w}×${f.h}`)
              .join(' · ')}</span></button>`
        )
        .join('');
      for (const b of items.children) b.classList.toggle('active', b.dataset.item === state.item);
      if (item) {
        info.textContent = `${item.name} · ${item.faces.length} ${item.faces.length === 1 ? 'face' : 'faces'} · ${cellTotal(
          item
        ).toLocaleString()} cells to fill`;
      }
    };
    fams.innerHTML = FAMILIES.map((f) => `<button data-fam="${f}">${FAMILY[f].name}</button>`).join('');
    fams.onclick = (ev) => {
      const b = ev.target.closest('[data-fam]');
      if (!b) return;
      state.family = b.dataset.fam;
      state.item = state.family === 'canvas' ? this.state.designItem : CATALOG[state.family][0].id;
      draw();
    };
    items.onclick = (ev) => {
      const b = ev.target.closest('[data-item]');
      if (b) {
        state.item = b.dataset.item;
        draw();
      }
    };
    const close = () => {
      d.hidden = true;
      fams.onclick = null;
      items.onclick = null;
    };
    document.getElementById('fCancel').onclick = close;
    document.getElementById('fApply').onclick = () => {
      close();
      this.actions.setItem(state.item);
    };
    document.getElementById('fWarn').textContent =
      'This replaces the design for everyone in the room and wipes what is on it. There is no undo for a switch.';
    draw();
  }

  toggleHelp() {
    const h = document.getElementById('help');
    h.hidden = !h.hidden;
  }

  /* ---------------- live bits ---------------- */

  setRoom(code) {
    this.el.roomCode.textContent = code;
    this.el.room.value = code;
  }

  setNet({ status, detail, role, transport, latency }) {
    const e = this.el;
    e.net.dataset.state = status;
    const label =
      status === 'online'
        ? `${role === 'host' ? 'Hosting' : 'Joined'} · ${transport === 'ws' ? 'relay' : 'peer-to-peer'}${
            latency != null ? ` · ${latency}ms` : ''
          }`
        : status === 'reconnecting' || status === 'connecting'
          ? 'Connecting…'
          : status === 'error'
            ? 'Connection problem'
            : 'Offline';
    e.netText.textContent = label;
    e.net.title = detail || label;
  }

  setPlayers(roster, meId) {
    const e = this.el;
    e.players.innerHTML = roster
      .slice(0, 8)
      .map(
        (p) =>
          `<span class="avatar ${p.id === meId ? 'me' : ''}" style="--c:${escapeHtml(p.color)}" title="${escapeHtml(
            p.nick
          )}">${escapeHtml(initials(p.nick))}${svg(DEVICE_ICON[p.device] || 'desktop', 'dev')}</span>`
      )
      .join('') + (roster.length > 8 ? `<span class="more">+${roster.length - 8}</span>` : '');
    e.me.style.setProperty('--c', this.state.color);
    e.me.textContent = this.state.nick;
  }

  setZoom(percent) {
    this.el.zoomVal.textContent = `${percent}%`;
  }

  toast(text, kind = 'info', ms = 2600) {
    const e = this.el.toast;
    const row = document.createElement('div');
    row.className = `toast ${kind}`;
    row.textContent = text;
    e.appendChild(row);
    requestAnimationFrame(() => row.classList.add('show'));
    setTimeout(() => {
      row.classList.remove('show');
      setTimeout(() => row.remove(), 300);
    }, ms);
  }

  setLocked(locked, why) {
    this.el.app.classList.toggle('locked', locked);
    const b = document.getElementById('lockNote');
    b.hidden = !locked;
    if (why) b.textContent = why;
  }

  _syncPick(container, btn) {
    for (const c of container.children) c.classList.toggle('active', c === btn);
    if (btn) btn.classList.add('active');
  }
}

export function cleanNick(v) {
  return String(v || '')
    .replace(/[\u0000-\u001f\u200b-\u200f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 16);
}

export function validateNick(nick) {
  if (!nick) return 'Pick a nickname first - it is how other players see you.';
  if (nick.length < 2) return 'At least 2 characters.';
  if (!/[\p{L}\p{N}]/u.test(nick)) return 'Use at least one letter or number.';
  return null;
}

export { svg, DEVICE_ICON, boardForItem };
