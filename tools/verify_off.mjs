// Is the shipped run-length cell list a faithful copy of the game's
// disabledPixels, for every face of every item?
//
// The generator checks the polygon against the cell list *before* it encodes the
// list into runs, so a bug in the encoder or its decoder would sail straight
// through that check and ship a board that blocks the wrong cells. This compares
// the shipped, encoded data back against the catalog it came from.
import { readFileSync } from 'node:fs';
import { FACE_DATA } from '../assets/js/data/heartopia-faces.js';

const raw = JSON.parse(readFileSync('_scrape/catalog/ls-heartopia_presets_cache.json', 'utf8'));
const groups = Array.isArray(raw) ? raw : Object.values(raw)[0];

// Every level in the catalog, indexed by the board size it describes. Two items
// share sizes with the plain canvas boards, so the size is only a key, not a
// claim about which item it belongs to; the face tells us which one to read.
const bySize = new Map();
for (const g of groups) {
  for (const c of g.canvases || []) {
    for (const lv of c.levels || []) {
      const key = `${lv.w}x${lv.h}`;
      const off = new Set(lv.disabledPixels || []);
      const list = bySize.get(key) || [];
      list.push({ group: g.id, canvas: c.id, off, raw: off.size });
      bySize.set(key, list);
    }
  }
}

/** "x:len" runs, "," within a row, ";" between rows, an empty row meaning none. */
function decode(str, w, h) {
  const set = new Set();
  const rows = str.split(';');
  for (let y = 0; y < h && y < rows.length; y++) {
    const r = rows[y];
    if (!r) continue;
    for (const run of r.split(',')) {
      const i = run.indexOf(':');
      const x = Number(i < 0 ? run : run.slice(0, i));
      const len = i < 0 ? 1 : Number(run.slice(i + 1));
      for (let k = 0; k < len; k++) set.add(`${x + k},${y}`);
    }
  }
  return set;
}

const rows = [];
for (const [item, faces] of Object.entries(FACE_DATA)) {
  for (const [face, d] of Object.entries(faces)) {
    if (!d.off) {
      rows.push({ item, face, note: 'no cell list', shipped: 0, candidates: (bySize.get(`${d.w}x${d.h}`) || []).length });
      continue;
    }
    const shipped = decode(d.off, d.w, d.h);
    // Match against the catalog levels of the same board size and take the best
    // agreement: if the encoder is faithful, one candidate matches exactly.
    const cands = bySize.get(`${d.w}x${d.h}`) || [];
    let best = null;
    for (const c of cands) {
      let missing = 0;
      let extra = 0;
      for (const s of c.off) if (!shipped.has(s)) missing++;
      for (const s of shipped) if (!c.off.has(s)) extra++;
      const diff = missing + extra;
      if (!best || diff < best.diff) best = { ...c, missing, extra, diff };
    }
    rows.push({
      item,
      face,
      board: `${d.w}x${d.h}`,
      gameCells: best ? best.raw : 0,
      shippedCells: shipped.size,
      missing: best ? best.missing : -1,
      extra: best ? best.extra : -1,
      candidates: cands.length,
    });
  }
}

const bad = rows.filter((r) => r.missing !== 0 || r.extra !== 0);
console.log(`faces checked ${rows.length}, faithful ${rows.length - bad.length}, wrong ${bad.length}`);
for (const r of bad) console.log(JSON.stringify(r));
const odd = rows.filter((r) => r.note);
console.log(`faces with no cell list at all: ${odd.map((r) => `${r.item}:${r.face}`).join(', ') || 'none'}`);
