/*
 * UI: the nickname gate, the Heartopia colour dock, tools and the player list.
 *
 * All markup lives in index.html; this file only builds the generated parts
 * (125 palette swatches, 13 groups, board presets) and wires behaviour.
 */

import { HEARTOPIA_GROUPS, FLAT_COLORS } from './data/heartopia-palette.js';
import { RATIOS, LEVELS, GRID_DIMENSIONS, dimsFor, BRUSH_SIZES } from './presets.js';
import { clamp, escapeHtml, initials, makeRoomCode, normalizeRoomCode, readableInk, detectDevice } from './util.js';
import { TOOLS } from './input.js';

const ICONS = {
  brush:
    '<path d="M3 17c0 2 1.5 3.5 3.5 3.5 1 0 1.8-.4 2.3-1L16 12l-3-3L5.5 16c-.3.4-.5.8-.5 1z"/><path d="M14 7l3-3 4 4-3 3z"/>',
  eraser: '<path d="M8 20h10"/><path d="M6 16l6-6 6 6-4 4H8z"/>',
  pick: '<path d="M12 2l2 6-4 4-2-2z"/><path d="M8 12l-5 8 8-5"/>',
  grid: '<rect x="4" y="4" width="16" height="16"/><path d="M10 4v16M16 4v16M4 10h16M4 16h16"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5h10"/>',
  save: '<path d="M12 3v12"/><path d="M7 10l5 5 5-5"/><path d="M4 20h16"/>',
  trash: '<path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="M6 7l1 13h10l1-13"/>',
  desktop: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
  ipad: '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M11 18h2"/>',
  phone: '<rect x="8" y="2" width="8" height="20" rx="2"/><path d="M11 19h2"/>',
  link: '<path d="M10 14a4 4 0 006 .5l2.5-2.5a4 4 0 00-5.6-5.6L11.5 7"/><path d="M14 10a4 4 0 00-6-.5L5.5 12a4 4 0 005.6 5.6L12.5 15"/>',
};

const svg = (name, cls = '') =>
  `<svg class="ic ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;

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
      groups: document.getElementById('groups'),
      swatches: document.getElementById('swatches'),
      brushes: document.getElementById('brushes'),
      tools: document.getElementById('tools'),
      current: document.getElementById('currentColor'),
      zoomVal: document.getElementById('zoomVal'),
      toast: document.getElementById('toast'),
      me: document.getElementById('meChip'),
    };
    this._buildJoin();
    this._buildDock();
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
    });
  }

  showDims(ratio = this.state.ratio, level = this.state.level, locked = false) {
    const d = dimsFor(ratio, level);
    this.el.dims.textContent = `${d.w} × ${d.h}`;
    this.el.boardNote.textContent = locked
      ? 'Board size is set by whoever started this room.'
      : 'First player in the room sets the board. Everyone else matches it.';
    this.el.ratios.classList.toggle('locked', locked);
    this.el.levels.classList.toggle('locked', locked);
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
    e.tools.innerHTML = [
      ['brush', 'Brush', 'B'],
      ['eraser', 'Eraser', 'E'],
      ['pick', 'Eyedropper', 'I'],
    ]
      .map(
        ([id, label, key]) =>
          `<button class="tool" data-tool="${id}" title="${label} (${key})">${svg(id)}<span>${label}</span></button>`
      )
      .join('');
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
  }

  setBrush(size) {
    for (const b of this.el.brushes.children) b.classList.toggle('active', Number(b.dataset.brush) === size);
    this.state.brush = size;
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
    document.getElementById('btnBoard').addEventListener('click', () => this.openBoardDialog());
    document.getElementById('btnLeave').addEventListener('click', () => this.actions.leave());
    document.getElementById('zOut').addEventListener('click', () => this.actions.zoom(1 / 1.25));
    document.getElementById('zIn').addEventListener('click', () => this.actions.zoom(1.25));
    document.getElementById('zFit').addEventListener('click', () => this.actions.fit());
    document.getElementById('btnHelp').addEventListener('click', () => this.toggleHelp());
    e.nick.value = this.state.nick || '';
  }

  openBoardDialog() {
    const d = document.getElementById('boardDialog');
    d.hidden = false;
    const state = { ratio: this.state.ratio, level: this.state.level };
    const ratios = document.getElementById('dRatios');
    const levels = document.getElementById('dLevels');
    const dims = document.getElementById('dDims');
    const draw = () => {
      const p = dimsFor(state.ratio, state.level);
      dims.textContent = `${p.w} × ${p.h} cells`;
      for (const b of ratios.children) b.classList.toggle('active', b.dataset.ratio === state.ratio);
      for (const b of levels.children) b.classList.toggle('active', Number(b.dataset.level) === state.level);
    };
    ratios.innerHTML = RATIOS.map((r) => `<button data-ratio="${r}">${r}</button>`).join('');
    levels.innerHTML = LEVELS.map(
      (l) => `<button data-level="${l.id}" title="${l.name} - ${l.hint}">${l.tag}</button>`
    ).join('');
    ratios.onclick = (ev) => {
      const b = ev.target.closest('[data-ratio]');
      if (b) {
        state.ratio = b.dataset.ratio;
        draw();
      }
    };
    levels.onclick = (ev) => {
      const b = ev.target.closest('[data-level]');
      if (b) {
        state.level = Number(b.dataset.level);
        draw();
      }
    };
    const close = () => {
      d.hidden = true;
      ratios.onclick = null;
      levels.onclick = null;
    };
    document.getElementById('dCancel').onclick = close;
    document.getElementById('dApply').onclick = () => {
      close();
      this.actions.setBoard(state.ratio, state.level);
    };
    document.getElementById('dWarn').textContent =
      'This wipes the board for everyone in the room. There is no undo.';
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

export { svg, DEVICE_ICON };
