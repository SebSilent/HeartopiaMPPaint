/*
 * The colour dock, driven against a stub DOM.
 *
 * Regression cover for the category selector: picking a group used to render it
 * and then immediately snap back to the group holding the current colour, so no
 * category click ever appeared to do anything.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { UI, groupForIndex } from '../assets/js/ui.js';
import { HEARTOPIA_GROUPS } from '../assets/js/data/heartopia-palette.js';

function makeEl(kind) {
  const node = {
    kind,
    dataset: {},
    _classes: new Set(),
    children: [],
    textContent: '',
    style: { color: '', setProperty() {} },
    classList: {
      toggle(name, on) {
        if (on) node._classes.add(name);
        else node._classes.delete(name);
      },
      contains(name) {
        return node._classes.has(name);
      },
    },
  };
  let html = '';
  Object.defineProperty(node, 'innerHTML', {
    get: () => html,
    set(v) {
      html = v;
      // Enough parsing to see what the dock actually renders.
      node.children = [...String(v).matchAll(/data-(group|idx)="(\d+)"/g)].map((m) => {
        const child = makeEl(m[1]);
        child.dataset[m[1]] = m[2];
        return child;
      });
    },
  });
  return node;
}

function makeDock() {
  const ui = Object.create(UI.prototype);
  ui.el = { groups: makeEl('group'), swatches: makeEl('idx'), current: makeEl('current') };
  ui.state = { colorIdx: 1, colorHex: '#051616', groupIndex: null };
  ui.el.groups.innerHTML = HEARTOPIA_GROUPS.map((_, i) => `<button data-group="${i}"></button>`).join('');
  return ui;
}

test('groupForIndex maps the flat shade range onto each group', () => {
  let start = 1;
  for (let i = 0; i < HEARTOPIA_GROUPS.length; i++) {
    const len = HEARTOPIA_GROUPS[i].colors.length;
    assert.equal(groupForIndex(start), i, 'first shade of group ' + i);
    assert.equal(groupForIndex(start + len - 1), i, 'last shade of group ' + i);
    start += len;
  }
  assert.equal(groupForIndex(1), 0);
  assert.equal(groupForIndex(125), HEARTOPIA_GROUPS.length - 1);
});

test('clicking a category shows that category and keeps showing it', () => {
  const ui = makeDock();
  ui.setColorIdx(1); // group 0, the grey ramp
  assert.equal(ui.state.groupIndex, 0);

  ui.showGroup(6); // greens
  assert.equal(ui.state.groupIndex, 6, 'the click must stick');
  assert.equal(ui.el.swatches.children.length, HEARTOPIA_GROUPS[6].colors.length);
  assert.equal(
    [...ui.el.groups.children].filter((b) => b.classList.contains('active')).length,
    1,
    'exactly one chip is lit'
  );
  assert.equal(ui.el.groups.children[6].classList.contains('active'), true);
});

test('a category click does not change the colour you are painting with', () => {
  const ui = makeDock();
  ui.setColorIdx(1);
  ui.showGroup(9);
  assert.equal(ui.state.colorIdx, 1, 'browsing is not painting');
  assert.equal(ui.state.colorHex, HEARTOPIA_GROUPS[0].colors[0]);
});

test('picking a shade moves the dock to that shade group', () => {
  const ui = makeDock();
  ui.showGroup(0);
  // First shade of group 4.
  let idx = 1;
  for (let i = 0; i < 4; i++) idx += HEARTOPIA_GROUPS[i].colors.length;
  ui.setColorIdx(idx);
  assert.equal(ui.state.groupIndex, 4);
  const lit = ui.el.swatches.children.filter((s) => s.classList.contains('active'));
  assert.equal(lit.length, 1, 'the chosen shade is highlighted');
  assert.equal(Number(lit[0].dataset.idx), idx);
});

test('the current-colour readout follows the shade, not the category', () => {
  const ui = makeDock();
  ui.setColorIdx(1);
  const hex = HEARTOPIA_GROUPS[0].colors[0];
  assert.equal(ui.el.current.textContent, hex);
  ui.showGroup(11);
  assert.equal(ui.el.current.textContent, hex, 'still the same colour while browsing');
});

test('every group renders all of its shades', () => {
  const ui = makeDock();
  for (let i = 0; i < HEARTOPIA_GROUPS.length; i++) {
    ui.showGroup(i);
    assert.equal(ui.el.swatches.children.length, HEARTOPIA_GROUPS[i].colors.length, 'group ' + i);
  }
});
