/*
 * UI: the nickname gate, the Heartopia colour dock, the tool box, the face tabs
 * and the three panels (trace, import, 3D).
 *
 * All markup lives in index.html; this file builds the generated parts (125
 * palette swatches, 13 groups, the item catalogue, the face tabs) and wires
 * behaviour. It deliberately knows nothing about the network - it takes an
 * `actions` object and calls it, the same way the dock always has.
 */

import { HEARTOPIA_GROUPS, FLAT_COLORS, COLOR_CODES, GROUP_BASE } from './data/heartopia-palette.js';
import { RATIOS, LEVELS, BRUSH_SIZES } from './presets.js';
import { CATALOG, FAMILIES, FAMILY, findItem, cellTotal, itemIdForBoard, boardForItem } from './game/slots.js';
import { clamp, escapeHtml, initials, makeRoomCode, normalizeRoomCode, readableInk, detectDevice } from './util.js';
import { TOOLS } from './input.js';
import { measure as measureText, prepare as prepareText } from './game/pixeltext.js';
import { MODES as TRACE_MODES, BLOCK_SIZES } from './ui/blueprint.js';
import { DITHER } from './ui/importer.js';

const ICONS = {
  brush:
    '<path d="M3 17c0 2 1.5 3.5 3.5 3.5 1 0 1.8-.4 2.3-1L16 12l-3-3L5.5 16c-.3.4-.5.8-.5 1z"/><path d="M14 7l3-3 4 4-3 3z"/>',
  eraser: '<path d="M8 20h10"/><path d="M6 16l6-6 6 6-4 4H8z"/>',
  pick: '<path d="M12 2l2 6-4 4-2-2z"/><path d="M8 12l-5 8 8-5"/>',
  fill: '<path d="M5 9l7-7 7 7-7 7z"/><path d="M19 13c1.5 2 2 3 2 4a2 2 0 01-4 0c0-1 .5-2 2-4z"/>',
  line: '<path d="M4 20L20 4"/>',
  rect: '<rect x="4" y="6" width="16" height="12"/>',
  ellipse: '<ellipse cx="12" cy="12" rx="8" ry="6"/>',
  polygon: '<path d="M12 3l8 6-3 10H7L4 9z"/>',
  text: '<path d="M6 20l6-15 6 15"/><path d="M9 14h6"/>',
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

/**
 * Tools that lay out a region, and so own the filled/hollow switch. The polygon
 * is in here although it does not drag: it commits through the same `shapeFilled`
 * flag, so leaving it out meant the only way to get a filled polygon was to
 * select the rectangle tool, set the switch, and come back.
 */
const SHAPE_TOOLS = ['line', 'rect', 'ellipse', 'polygon'];

/**
 * Import controls kept as fractions in state and shown as percentages.
 * Dragging the preview writes these directly, and the sliders have to agree
 * with it, so the conversion lives in one place on each side.
 */
const PLACEMENT = new Set(['zoom', 'ox', 'oy']);

const TOOL_DEFS = [
  ['brush', 'Brush', 'B'],
  ['eraser', 'Eraser', 'E'],
  ['pick', 'Eyedropper', 'I'],
  ['fill', 'Bucket', 'F'],
  ['line', 'Line', 'L'],
  ['rect', 'Rectangle', 'R'],
  ['ellipse', 'Ellipse', 'O'],
  ['polygon', 'Polygon', 'P'],
  ['text', 'Text', 'T'],
];

export class UI {
  constructor({ state, onJoin, actions }) {
    this.state = state;
    this.onJoin = onJoin;
    this.actions = actions;
    this._outline = { has: false, inside: 0, total: 0, itemName: '' };
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
      recent: document.getElementById('recent'),
      brushes: document.getElementById('brushes'),
    tipBtn: document.getElementById('tipBtn'),
    tipFile: document.getElementById('tipFile'),
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
      outlineBtn: document.getElementById('outlineBtn'),
      outlineNote: document.getElementById('outlineNote'),
      legend: document.getElementById('legend'),
      copyRow: document.getElementById('copyRow'),
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
      (f) => `<button class="pick-fam" data-fam="${f}">${FAMILY[f].name}</button>`
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
      (l) => `<button class="pick-level" data-level="${l.id}" title="${l.name}">${l.tag}</button>`
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
          `<button class="item-chip" data-item="${i.id}">${escapeHtml(i.name)}<b>${i.faces.length}</b></button>`
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
      // Singular matters now: the book is one board, and "1 faces" was only ever
      // hidden because every non-canvas item used to have two or more.
      e.dims.textContent = `${item.faces.length} ${item.faces.length === 1 ? 'face' : 'faces'} · ${cellTotal(item).toLocaleString()} cells`;
    }
    e.boardNote.textContent = this.state.roomLocked ? 'Set by the room.' : '';
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
        `<button class="group" data-group="${i}" style="--c:${g.main}" title="${
          GROUP_BASE[i] ? GROUP_BASE[i].code + ' ' + GROUP_BASE[i].hex : 'Group ' + g.group
        } · ${g.colors.length} shades" aria-label="Colour group ${g.group} of ${HEARTOPIA_GROUPS.length}, ${
          g.colors.length
        } shades"></button>`
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

    e.tipBtn.addEventListener('click', () => e.tipFile.click());
    e.tipFile.addEventListener('change', () => {
      const f = e.tipFile.files && e.tipFile.files[0];
      // Clear the input first: picking the same file twice has to re-import it,
      // and a file input that still holds the old value fires no change event.
      e.tipFile.value = '';
      if (f) this.actions.setStampFromFile(f);
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
    // The recent row is rebuilt on every shade change, so the listener has to sit
    // on the container - the same reason the swatch row's does.
    if (e.recent)
      e.recent.addEventListener('click', (ev) => {
        const b = ev.target.closest('.recent-sw');
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
    if (st.tool === TOOLS.BRUSH || st.tool === TOOLS.ERASER) {
      html += row(
        'Shape',
        chips('shape', [
          ['square', 'Square', 'Hard-edged, like the game'],
          ['round', 'Round', 'Round brush footprint'],
          ['spray', 'Spray', 'Scattered dabs inside the round brush'],
          ['air', 'Airbrush', 'Scattered dots that fade outward'],
        ], st.brushShape),
        'shape'
      );
      if (st.brushShape === 'spray' || st.brushShape === 'air') {
        html += row(
          'Density',
          chips('density', [
            ['0.125', 'Sparse', 'An eighth of the disc per dab'],
            ['0.25', 'Normal', 'A quarter of the disc per dab'],
            ['0.5', 'Heavy', 'Half the disc per dab'],
          ], String(st.sprayDensity)),
          'density'
        );
      }
    }
    if (SHAPE_TOOLS.includes(st.tool)) {
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
      // How wide a "same colour" is allowed to be. Steps are ΔE(2000) and named
      // the way a person judges it: 6 is the same colour under a different
      // light, 12 starts picking up neighbours that only rhyme.
      html += row(
        'Matches',
        chips('fillmatch', [
          ['0', 'Exact', 'Only this shade'],
          ['6', 'Close', 'Shades that look the same'],
          ['12', 'Broad', 'Shades that nearly match'],
        ], String(st.fillTolerance | 0)),
        'fillmatch'
      );
    }
    if (st.tool === TOOLS.TEXT) {
      // The string lives in state, not in the field, because the field is torn
      // down and rebuilt every time the tool row changes - a brush size click
      // would otherwise wipe what you had typed.
      html +=
        `<span class="dock-label">Text</span>` +
        `<input id="textIn" class="text-in" type="text" maxlength="60" spellcheck="false"
          autocomplete="off" placeholder="Type, then tap the board" aria-label="Text to paint">`;
      html += row(
        'Size',
        chips('textsize', [
          ['1', 'S', 'One board cell per pixel'],
          ['2', 'M', 'Two cells per pixel'],
          ['3', 'L', 'Three cells per pixel'],
          ['4', 'XL', 'Four cells per pixel'],
        ], String(st.textSize)),
        'textsize'
      );
      // The block size is what you cannot see until it is too wide for the face,
      // so it is stated before the first tap rather than refused after it.
      html += `<span class="text-dim" id="textDim"></span>`;
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
    for (const b of e.toolOpts.querySelectorAll('[data-density]'))
      b.classList.toggle('active', Number(b.dataset.density) === st.sprayDensity);
    for (const b of e.toolOpts.querySelectorAll('[data-fillmode]'))
      b.classList.toggle('active', (b.dataset.fillmode === 'filled') === !!st.shapeFilled);
    for (const b of e.toolOpts.querySelectorAll('[data-fillscope]'))
      b.classList.toggle('active', (b.dataset.fillscope === 'all') === !!st.fillGlobal);
    for (const b of e.toolOpts.querySelectorAll('[data-fillmatch]'))
      b.classList.toggle('active', Number(b.dataset.fillmatch) === (st.fillTolerance | 0));
    for (const b of e.toolOpts.querySelectorAll('[data-mirror]'))
      b.classList.toggle('active', b.dataset.mirror === ['off', 'x', 'y', 'xy'][st.mirror || 0]);
    for (const b of e.toolOpts.querySelectorAll('[data-textsize]'))
      b.classList.toggle('active', Number(b.dataset.textsize) === (st.textSize | 0));
    this._syncText();
  }

  /**
   * Echo what the Text box currently means: how many cells it will cover, and
   * which characters the pixel font cannot draw. Called on every keystroke, so
   * a player finds out before the tap, not after a partly-painted word.
   */
  _syncText() {
    const box = document.getElementById('textIn');
    const dim = document.getElementById('textDim');
    if (!box || !dim) return;
    const st = this.state;
    if (document.activeElement !== box) box.value = st.text || '';
    const { text, skipped } = prepareText(st.text);
    const m = measureText(text, st.textSize);
    if (!m.w) {
      dim.textContent = '';
      dim.classList.remove('bad');
      return;
    }
    const size = `${m.w}×${m.h} cells`;
    if (skipped.length) {
      dim.textContent = `${size} - no letter for ${skipped.join(' ')}`;
      dim.classList.add('bad');
    } else {
      dim.textContent = size;
      dim.classList.remove('bad');
    }
  }

  _wireToolOptions() {
    const e = this.el;
    e.toolOpts.addEventListener('click', (ev) => {
      const b = ev.target.closest(
        'button[data-shape],button[data-density],button[data-fillmode],button[data-fillscope],button[data-fillmatch],button[data-mirror],button[data-textsize]'
      );
      if (!b) return;
      if (b.dataset.shape) this.actions.setBrushShape(b.dataset.shape);
      if (b.dataset.density) this.actions.setSprayDensity(Number(b.dataset.density));
      if (b.dataset.fillmode) this.actions.setShapeFilled(b.dataset.fillmode === 'filled');
      // Presence, not truthiness: '0' is a real choice (Exact), and a truthy
      // test would make clicking Exact do nothing.
      if (b.dataset.fillmatch !== undefined) this.actions.setFillTolerance(Number(b.dataset.fillmatch));
      if (b.dataset.fillscope) this.actions.setFillGlobal(b.dataset.fillscope === 'all');
      if (b.dataset.mirror) this.actions.setMirror(['off', 'x', 'y', 'xy'].indexOf(b.dataset.mirror));
      if (b.dataset.textsize) this.actions.setTextSize(Number(b.dataset.textsize));
    });
    // Delegation again: the row is rebuilt whenever the tool changes, so the
    // field this listener needs is not the field that existed when it was bound.
    e.toolOpts.addEventListener('input', (ev) => {
      if (ev.target && ev.target.id === 'textIn') this.actions.setText(ev.target.value);
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
        return `<button class="swatch" data-idx="${idx}" style="--c:${hex}" title="${COLOR_CODES[idx] || ''} ${hex}" aria-label="Colour ${COLOR_CODES[idx] || idx}"></button>`;
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
    const code = COLOR_CODES[this.state.colorIdx];
    e.current.style.setProperty('--c', hex);
    e.current.textContent = code ? `${code} ${hex}` : hex;
    e.current.style.color = readableInk(hex);
  }

  /**
   * @param {boolean} remember  put this shade in the recent row. False for the
   *   starting shade, which the player never chose - a row that opens with a
   *   default is a row that lies about what they have been using.
   */
  setColorIdx(idx, remember = true) {
    this.state.colorIdx = idx;
    this.state.colorHex = FLAT_COLORS[idx] || '#ffffff';
    // Follow the shade only when the shade is what changed (a pick, an
    // eyedropper read). A category click must not be second-guessed.
    const g = groupForIndex(idx);
    if (this.state.groupIndex === null || g !== this.state.groupIndex) this.showGroup(g);
    else if (this.el.swatches.children.length) this._syncSwatch();
    // One hook, because every way a shade changes - a swatch click, an
    // eyedropper, an Alt-drag, a restore - comes through here. Recording it in
    // the click handler instead would mean the picks never become recent, which
    // is backwards: a pick is the clearest sign of a shade you keep coming back
    // to. Empty (0) is dropped by the store, not here.
    // Optional all the way down: a UI built without actions is a supported shape
    // here (test/palette-ui.test.js does exactly that), so neither the object nor
    // the method may be assumed.
    if (remember) this.actions?.rememberShade?.(idx);
  }

  /**
   * The recent row: the last few shades this player reached for, newest first.
   * Drawn from scratch because it is at most eight nodes, and a diff that has to
   * work out which swatch moved is more code than the row is worth.
   */
  setRecent(list) {
    const e = this.el;
    if (!e.recent) return;
    const arr = Array.isArray(list) ? list : [];
    if (!arr.length) {
      e.recent.innerHTML = '';
      return;
    }
    const chips = arr
      .map((idx) => {
        const hex = FLAT_COLORS[idx] || '#ffffff';
        const code = COLOR_CODES[idx] || '';
        // The same control as a palette swatch, not a lookalike: it is the same
        // affordance, and a person should not have to learn a second target.
        const on = idx === this.state.colorIdx ? ' active' : '';
        return (
          `<button class="swatch recent-sw${on}" data-idx="${idx}" style="--c:${hex}" ` +
          `title="${code} ${hex}" aria-label="Recent colour ${code || idx}"></button>`
        );
      })
      .join('');
    e.recent.innerHTML = `<span class="recent-label">Recent</span><div class="recent-row">${chips}</div>`;
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

  /** Show the loaded tip, or go back to the plain "Tip" label when it is null. */
  setTip(previewUrl) {
    const b = this.el.tipBtn;
    if (!b) return;
    // The thumbnail exists only while a tip is loaded. A permanent <img> with
    // no src reads as a broken image to tooling, so until there is something
    // real to show the button carries just the "Tip" label.
    let img = b.querySelector('img');
    if (!previewUrl) {
      b.classList.remove('set', 'active');
      if (img) img.remove();
      b.title =
        "Import a brush tip: a picture of a shape, used as the stamp. It paints whole cells, so it stays inside the game's grid.";
      return;
    }
    if (!img) {
      img = document.createElement('img');
      img.id = 'tipImg';
      img.alt = '';
      b.prepend(img);
    }
    img.src = previewUrl;
    b.classList.add('set', 'active');
    b.title = 'Imported tip is in use. Click to choose another; pick Square or Round to go back to the built-in blocks.';
  }

  /* ---------------- face tabs ---------------- */

  setFaces(faces, active, elsewhere = []) {
    this._paintOutline();
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
        return `<button class="face ${i === active ? 'active' : ''}" data-face="${i}" title="${f.w} × ${f.h}">
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
    e.outlineBtn.addEventListener('click', () => this.actions.setOutline(!this.state.showOutline));
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

  /**
   * Grey the 3D button out when the current item has nothing to show in 3D.
   *
   * A dead button that opens an empty panel teaches people the button is a lie,
   * so it says why it is off instead, and an open panel is closed rather than
   * left showing the previous item's solid.
   */
  set3DAvailable(ok, why) {
    const btn = document.getElementById('btn3d');
    if (!btn) return;
    btn.disabled = !ok;
    btn.title = ok ? 'Preview this item in 3D' : why || 'This item has no 3D model';
    if (!ok && this.el.d3Panel && !this.el.d3Panel.hidden) this.hidePanel('d3Panel');
  }

  /**
   * Name the kind of preview, so a flat layout is never mistaken for a model.
   * @param {'mesh'|'solid'|'panels'|null} source
   */
  set3DKind(source) {
    const el = document.getElementById('d3Kind');
    if (!el) return;
    const KIND = {
      mesh: ['real 3D model', ''],
      solid: ['3D model', ''],
      panels: ['flat layout - this item has no 3D model', 'is-flat'],
    };
    const [text, cls] = KIND[source] || ['nothing to show', 'is-flat'];
    el.textContent = text;
    el.className = `kind${cls ? ' ' + cls : ''}`;
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
    // Three buttons, one listener, and the format lives in the markup next to the
    // label that names it - rather than in three handlers that can each drift.
    if (e.copyRow)
      e.copyRow.addEventListener('click', (ev) => {
        const b = ev.target.closest('[data-copy]');
        if (b) this.actions?.copyGrid?.(b.dataset.copy);
      });
  }

  setOutlineInfo(has, inside, total, itemName) {
    this._outline = { has, inside, total, itemName };
    this._paintOutline();
  }

  // The dock re-renders on every face change, so the outline row redraws there
  // too; without this the toggle would vanish the moment you switched face.
  _paintOutline() {
    const e = this.el;
    if (!e.outlineBtn) return;
    const { has, inside, total, itemName } = this._outline;
    e.outlineBtn.classList.toggle('active', this.state.showOutline && has);
    e.outlineBtn.disabled = !has;
    e.outlineBtn.setAttribute('aria-pressed', String(!!(this.state.showOutline && has)));
    e.outlineNote.textContent = has ? `${inside.toLocaleString()} of ${total.toLocaleString()} cells on ${itemName}` : '';
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
          };--ink:${readableInk(l.hex)}" title="${l.code} · ${l.hex} · group ${l.group + 1}">
            <i>${n + 1}</i><u>${l.code}</u><span>${l.n.toLocaleString()}</span></button>`
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
      // Placement first: it is what you drag on the preview, and the sliders are
      // the touch-friendly way to set the same three numbers precisely.
      rows.push(['zoom', 'Scale', 'range', [20, 400, 5, 100]]);
      rows.push(['ox', 'Move X', 'range', [-100, 100, 1, 0]]);
      rows.push(['oy', 'Move Y', 'range', [-100, 100, 1, 0]]);
      // Turn lives with placement, not with colour: it moves the same picture
      // around the same face, and a sideways phone photo is the commonest reason
      // the auto-fit is wrong.
      rows.push(['rot', 'Turn', 'select', [['0', 'no turn'], ['90', '90° right'], ['180', 'upside down'], ['270', '90° left']]]);
      rows.push(['dither', 'Dither', 'select', DITHER.filter((d) => d !== 'bayer2')]);
      rows.push(['maxColors', 'Max colours', 'range', [4, 125]]);
      rows.push(['brightness', 'Brightness', 'range', [-60, 60]]);
      rows.push(['contrast', 'Contrast', 'range', [-60, 60]]);
      rows.push(['saturation', 'Saturation', 'range', [-80, 80]]);
      // One-way on purpose. Shrinking a photo to board size is a box filter, so
      // the softness is always in the same direction and there is nothing for a
      // negative end of the slider to undo; and 0 is the honest default, because
      // sharpening a picture that was already crisp just adds speckle.
      rows.push(['sharpness', 'Sharpen', 'range', [0, 100]]);
    } else {
      rows.push(['pitch', 'Cell size', 'auto']);
      rows.push(['trim', 'Ignore cell edges', 'range', [4, 34]]);
    }
    e.importControls.innerHTML = rows
      .map(([key, label, kind, range]) => {
        if (kind === 'select') {
          const cur = String(this.state.import[key] ?? range[0]);
          return `<label class="ctl"><span>${label}</span><select data-ctl="${key}">${range
            .map((v) => {
              // A row may be a bare value or a [value, plain-language label]
              // pair - "90° right" tells you what happens, "90" does not.
              const val = Array.isArray(v) ? v[0] : v;
              const text = Array.isArray(v) ? v[1] : v;
              // Mark the live value. This panel is rebuilt every time it opens,
              // and a select that falls back to its first option while the state
              // still holds the old one shows a setting the rasteriser is not
              // using - which is worse than no control at all.
              return `<option value="${val}"${cur === String(val) ? ' selected' : ''}>${text}</option>`;
            })
            .join('')}</select></label>`;
        }
        if (kind === 'range') {
          const [lo, hi, step, dflt] = [range[0], range[1], range[2] || 1, range[3] ?? 0];
          // Placement is stored as fractions (zoom 1, ox 0) and shown as
          // percentages, because a slider that reads 0..100 is legible and one
          // that reads 0.2..6 is not.
          const raw = this.state.import[key] ?? dflt;
          const shown = PLACEMENT.has(key) ? Math.round(raw * 100) : raw;
          return `<label class="ctl"><span>${label}</span><input class="slider" type="range" data-ctl="${key}" min="${lo}" max="${hi}" step="${step}" value="${shown}"></label>`;
        }
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
      this.state.import[t.dataset.ctl] = PLACEMENT.has(t.dataset.ctl) ? v / 100 : v;
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
    // Only swap when it is a different canvas. replaceChildren() removes and
    // re-adds, and re-parenting the preview canvas mid-drag ends the drag, so
    // every slider tick would drop the finger that is still down.
    if (e.importPrev.firstChild !== canvas) e.importPrev.replaceChildren(canvas);
    e.importPrev.hidden = false;
  }

  /**
   * Move the placement sliders to wherever the drag left the picture.
   *
   * Only the values change: rebuilding the controls row would destroy the slider
   * under a finger that is still dragging it.
   */
  syncImportPlacement() {
    const imp = this.state.import;
    for (const b of this.el.importControls.querySelectorAll('[data-ctl]')) {
      if (!PLACEMENT.has(b.dataset.ctl)) continue;
      b.value = Math.round(imp[b.dataset.ctl] * 100);
    }
  }

  setUndoState({ canUndo, canRedo }) {
    this.el.undo.disabled = !canUndo;
    this.el.redo.disabled = !canRedo;
  }

  /* ---------------- design dialog ---------------- */

  openDesignDialog() {
    const d = document.getElementById('designDialog');
    d.hidden = false;
    const state = {
      family: this.state.designFamily || 'canvas',
      item: this.state.designItem,
      ratio: this.state.ratio,
      level: this.state.level,
    };
    const fams = document.getElementById('fFams');
    const items = document.getElementById('fItems');
    const boardRow = document.getElementById('fBoardRow');
    const ratios = document.getElementById('fRatios');
    const levels = document.getElementById('fLevels');
    const info = document.getElementById('fInfo');
    const apply = document.getElementById('fApply');

    // A canvas card is a family of boards, not one item: ratio and precision
    // together pick the size. The canvas tab therefore gets the same two
    // pickers as the join gate - a list of level-0 cards could never express
    // "XL 16:9", which is why switching size used to do nothing at all.
    const isCanvas = () => state.family === 'canvas';
    const chosen = () => (isCanvas() ? itemIdForBoard(state.ratio, state.level) : state.item);

    const draw = () => {
      const item = findItem(chosen());
      for (const b of fams.children) b.classList.toggle('active', b.dataset.fam === state.family);
      items.hidden = isCanvas();
      boardRow.hidden = !isCanvas();
      items.innerHTML = CATALOG[state.family]
        .map(
          (i) =>
            `<button class="item-card" data-item="${i.id}"><b>${escapeHtml(i.name)}</b></button>`
        )
        .join('');
      for (const b of items.children) b.classList.toggle('active', b.dataset.item === state.item);
      this._syncPick(ratios, ratios.querySelector(`[data-ratio="${state.ratio}"]`));
      this._syncPick(levels, levels.querySelector(`[data-level="${state.level}"]`));
      if (item) {
        info.textContent = isCanvas()
          ? `${item.faces[0].w} × ${item.faces[0].h}`
          : `${item.faces.length} ${item.faces.length === 1 ? 'face' : 'faces'}`;
      }
      const same = chosen() === this.state.designItem;
      // A guest may browse the picker, but the button would only ever toast at
      // them, so say who can press it instead of letting them find out.
      const allowed = this.state.canDesign;
      apply.disabled = same || !allowed;
      apply.textContent = !allowed
        ? 'Host only'
        : same
          ? 'Already the room design'
          : 'Switch for everyone';
    };

    fams.innerHTML = FAMILIES.map((f) => `<button data-fam="${f}">${FAMILY[f].name}</button>`).join('');
    ratios.innerHTML = RATIOS.map(
      (r) => `<button class="pick-ratio" data-ratio="${r}" title="${r}">${r}</button>`
    ).join('');
    levels.innerHTML = LEVELS.map(
      (l) => `<button class="pick-level" data-level="${l.id}" title="${l.name}">${l.tag}</button>`
    ).join('');

    fams.onclick = (ev) => {
      const b = ev.target.closest('[data-fam]');
      if (!b) return;
      state.family = b.dataset.fam;
      if (isCanvas()) {
        state.ratio = this.state.ratio;
        state.level = this.state.level;
      } else {
        state.item = CATALOG[state.family][0].id;
      }
      draw();
    };
    items.onclick = (ev) => {
      const b = ev.target.closest('[data-item]');
      if (b) {
        state.item = b.dataset.item;
        draw();
      }
    };
    ratios.onclick = (ev) => {
      const b = ev.target.closest('[data-ratio]');
      if (!b) return;
      state.ratio = b.dataset.ratio;
      draw();
    };
    levels.onclick = (ev) => {
      const b = ev.target.closest('[data-level]');
      if (!b) return;
      state.level = Number(b.dataset.level);
      draw();
    };
    const close = () => {
      d.hidden = true;
      fams.onclick = null;
      items.onclick = null;
      ratios.onclick = null;
      levels.onclick = null;
    };
    document.getElementById('fCancel').onclick = close;
    document.getElementById('fApply').onclick = () => {
      const id = chosen();
      const canvas = isCanvas();
      close();
      if (id === this.state.designItem) return;
      // A resize has to go through setBoard so the room's ratio and level move
      // with it; setItem alone would leave the pickers describing the old size.
      if (canvas) this.actions.setBoard(state.ratio, state.level);
      else this.actions.setItem(id);
    };
    document.getElementById('fWarn').textContent = this.state.canDesign
      ? 'This replaces the design for everyone in the room and wipes what is on it. There is no undo for a switch.'
      : 'Only the room host can change the design. You can look, but the switch will not go through.';
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
      .map((p) => {
        // The shade they are holding, as a chip on their avatar. `shade` is a
        // palette index or null - null means a player from an older room that
        // never announced one, which renders as a plain avatar, not a wrong one.
        const has = Number.isInteger(p.shade) && FLAT_COLORS[p.shade];
        const hex = has ? FLAT_COLORS[p.shade] : '';
        const code = has ? COLOR_CODES[p.shade] || '' : '';
        const chip = has ? `<i class="shade" style="--s:${escapeHtml(hex)}"></i>` : '';
        const title = has ? `${p.nick} - painting ${code} ${hex}`.trim() : p.nick;
        return `<span class="avatar ${p.id === meId ? 'me' : ''}" style="--c:${escapeHtml(p.color)}" title="${escapeHtml(
          title
        )}">${escapeHtml(initials(p.nick))}${chip}${svg(DEVICE_ICON[p.device] || 'desktop', 'dev')}</span>`;
      })
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
    const b = document.getElementById('lockNote');
    // report() ticks every second; skip the DOM writes when nothing changed so
    // the steady state stays quiet (no per-tick attribute/text mutations).
    if (this.el.app.classList.contains('locked') !== locked || b.hidden !== !locked) {
      this.el.app.classList.toggle('locked', locked);
      b.hidden = !locked;
    }
    if (why && b.textContent !== why) b.textContent = why;
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
