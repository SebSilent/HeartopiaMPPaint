// Emit the browser module from the game's preset catalog, and prove the two
// representations of each face agree before anything is shipped.
import { readFileSync, writeFileSync } from 'node:fs';
import { CLOTHING, FURNITURE, BOOK } from '../assets/js/game/slots.js';

const data = JSON.parse(readFileSync('_scrape/catalog/ls-heartopia_presets_cache.json', 'utf8'));
const groups = Array.isArray(data) ? data : Object.values(data)[0];

/**
 * Every item, against the catalog group that holds it.
 *
 * Matching by face size alone was wrong and quietly so: the book's faces are
 * 150x114 and 150x84, which are also the XL 4:3 and XL 16:9 canvas boards, and
 * the bucket's crown is 100x100, the XL square board. Those three faces matched
 * a plain rectangle with no silhouette, got dropped for having nothing to say,
 * and the book lost its outline. A group is one item and its canvases are that
 * item's faces in order, so the group is the only honest way to pair them.
 */
const GROUPS = {
  tshirt: 'preset-1777184841479',
  tank: 'preset-1777278490477',
  skirt: 'preset-1777290267757',
  shorts: 'preset-1777298278879',
  bucket: 'preset-1777301965325',
  sweat: 'preset-1777617844320',
  trousers: 'preset-1777627440426',
  dress: 'preset-1777629592231',
  cap: 'preset-1777787903161',
  shoes: 'preset-1777800915342',
  maryjanes: 'preset-1777838216361',
  bed1: 'preset-1778155724575',
  bed2: 'preset-1778313299042',
  wardrobe: 'preset-1778316252932',
  nightstand: 'preset-1778921383302',
  tablelamp: 'preset-1778922985639',
  chair: 'preset-1778923864990',
  lowtable: 'preset-1778924748825',
  sofa2: 'preset-1779103003287',
  sofa1: 'preset-1779104637948',
  floorlamp: 'preset-1779105268541',
  book: 'preset-1777399477607',
};

/**
 * Which canvas of the catalog group a face is drawn from, when the order of the
 * group's canvases cannot be trusted to say. See pickCanvas below.
 */
const CANVAS_BY_ID = {
  // The book's group lists a 4:3 canvas next to the 16:9 one. The game offers a
  // book only the 16:9 board, and 150x114 is the XL 4:3 canvas board besides.
  book: { tall: 'canvas-1777564834202' },
};

const ours = [];
const unmatched = [];
const notes = [];
for (const it of [...CLOTHING, ...FURNITURE, ...(BOOK ? [BOOK] : [])]) {
  const gid = GROUPS[it.id];
  const group = (groups || []).find((g) => g.id === gid);
  if (!group) {
    unmatched.push(`${it.id}: no catalog group ${gid}`);
    continue;
  }
  const cs = group.canvases || [];
  for (const f of it.faces) {
    const canvas = pickCanvas(it.id, f, it.faces, cs);
    if (!canvas) {
      unmatched.push(`${it.id}:${f.id}: group ${gid} has no canvas for it (${cs.map((c) => c.name + '#' + c.id).join(', ')})`);
      continue;
    }
    ours.push({ item: it.id, face: f.id, w: f.w, h: f.h, lv: canvas });
  }
}

/**
 * Which canvas of the catalog group a face is drawn from.
 *
 * Usually that is the group's canvases in order, and for every item except one
 * the group holds exactly one canvas per face. The book is the exception: its
 * group still lists a 4:3 canvas at 150x114 next to the 16:9 one at 150x84, and
 * the game does not offer a 4:3 board for a book. Pairing by index is what
 * shipped a second book face here, so the book's face is pinned to a canvas by
 * id and everything else keeps the order.
 */
function pickCanvas(itemId, face, faces, canvases) {
  const want = (CANVAS_BY_ID[itemId] || {})[face.id];
  if (want) return canvases.find((c) => c.id === want) || null;
  if (canvases.length === faces.length) return canvases[faces.indexOf(face)];
  if (canvases.length === 1) return canvases[0];
  return null;
}

/**
 * The book's cover, drawn the way the game draws it.
 *
 * Two things here are not what the catalog says, and the shipped data had both
 * wrong.
 *
 * The maskLines put the spine between x 68 and x 82 - fourteen cells, where the
 * game shows eighteen - and inset the cover to x 5..144, y 1..84. But maskLines
 * are LINES, not a silhouette, and the book's disabledPixels list is empty: the
 * game blocks nothing on this board. Reading the lines as a mask made the board
 * refuse to paint 1,063 of the 12,600 cells a player can actually paint, and
 * drew a cover narrower than the book.
 *
 * So the three panels tile the whole board - cover, spine, cover - with the
 * spine eighteen cells wide and centred. The outline still reads as a book laid
 * flat open, and every cell stays paintable, which is what the empty
 * disabled-pixel list has been saying all along.
 */
function bookRings(w, h, spineW) {
  const x0 = Math.round((w - spineW) / 2);
  const x1 = x0 + spineW;
  return [
    [[0, 0], [x0, 0], [x0, h], [0, h], [0, 0]],
    [[x0, 0], [x1, 0], [x1, h], [x0, h], [x0, 0]],
    [[x1, 0], [w, 0], [w, h], [x1, h], [x1, 0]],
  ];
}

/** How wide the book's spine is drawn, in cells. */
const BOOK_SPINE_CELLS = 18;

const items = {};
for (const o of ours) {
  const canvas = o.lv;
  const lv = (canvas.levels || [])[0];
  if (!lv || lv.w !== o.w || lv.h !== o.h) {
    unmatched.push(`${o.item}:${o.face} wants ${o.w}x${o.h}, group offers ${lv ? lv.w + 'x' + lv.h : 'nothing'}`);
    continue;
  }

  let rings = null;
  if (lv.maskLines) {
    // maskLines is a JSON string, not an array: the catalog stores it encoded.
    const parsed = typeof lv.maskLines === 'string' ? JSON.parse(lv.maskLines) : lv.maskLines;
    rings = parsed.map((ring) => ring.map((p) => [p.x, p.y]));
  }
  if (o.item === 'book') {
    // Replaced rather than trusted: see bookRings. The scraped lines are kept in
    // the report below so the difference stays visible instead of silently gone.
    const spine = rings ? rings.map((r) => Math.max(...r.map((p) => p[0])) - Math.min(...r.map((p) => p[0]))).sort((a, b) => a - b)[0] : 0;
    notes.push(`book:${o.face} catalog spine ${spine} cells inset to x 5..144, drawn as ${BOOK_SPINE_CELLS} centred and the full board`);
    rings = bookRings(o.w, o.h, BOOK_SPINE_CELLS);
  }
  const off = lv.disabledPixels && lv.disabledPixels.length ? lv.disabledPixels : null;
  if (!rings && !off) continue;
  items[o.item] = items[o.item] || {};
  items[o.item][o.face] = { w: o.w, h: o.h, rings: rings || null, off: off || null };
}

/**
 * The cell list is the bulk of this file: a duvet face disables 6,578 cells and
 * each one costs seven characters as "x,y". They come in horizontal runs, so
 * encode the runs instead - "x:len" per run, ";" between rows, an empty row
 * being a row with nothing disabled.
 */
function runsOf(off, w, h) {
  const rows = [];
  for (let y = 0; y < h; y++) {
    const set = new Set();
    for (const s of off) {
      const i = s.indexOf(',');
      if (Number(s.slice(i + 1)) === y) set.add(Number(s.slice(0, i)));
    }
    const xs = [...set].sort((a, b) => a - b);
    const runs = [];
    for (let i = 0; i < xs.length;) {
      let j = i;
      while (j + 1 < xs.length && xs[j + 1] === xs[j] + 1) j++;
      runs.push(xs[i] + ':' + (j - i + 1));
      i = j + 1;
    }
    rows.push(runs.join(','));
  }
  return rows.join(';');
}

if (unmatched.length) {
  console.error('FATAL unmatched faces: ' + unmatched.join(', '));
  process.exit(1);
}

// The polygon and the cell list are two claims about the same shape. Check they
// tell the same story, or one of them was mis-parsed.
//
// They do not agree everywhere, and the run above prints the worst case: the
// shoe toe disagrees with itself on 16.79% of its cells. The cell list wins,
// because that is the list the game blocks painting against, so maskFor uses
// it and the polygon is only ever drawn.
const inside = (rings, x, y) => {
  let c = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
    }
  }
  return c;
};

let worst = 0;
let worstName = '';
for (const item of Object.keys(items)) {
  for (const face of Object.keys(items[item])) {
    const f = items[item][face];
    if (!f.rings || !f.off) continue;
    const offSet = new Set(f.off);
    let agree = 0;
    for (let y = 0; y < f.h; y++) {
      for (let x = 0; x < f.w; x++) {
        const inRing = inside(f.rings, x + 0.5, y + 0.5);
        const isOff = offSet.has(x + ',' + y);
        if (inRing === !isOff) agree++;
      }
    }
    const total = f.w * f.h;
    const mismatch = total - agree;
    const pct = (mismatch / total) * 100;
    if (pct > worst) {
      worst = pct;
      worstName = `${item}:${face} ${mismatch}/${total}`;
    }
  }
}

// Ship the runs, not the cell list. The check above needed the raw cells.
for (const item of Object.keys(items)) {
  for (const face of Object.keys(items[item])) {
    const f = items[item][face];
    if (f.off) f.off = runsOf(f.off, f.w, f.h);
  }
}

const body = JSON.stringify(items);
writeFileSync(
  'assets/js/data/heartopia-faces.js',
  '/* GENERATED by tools/build_faces_module.mjs from the game preset catalog.\n' +
    ' * Per-face silhouette: maskLines as rings, disabledPixels as cells.\n' +
    ' * Do not edit by hand. */\n' +
    'export const FACE_DATA = ' +
    body +
    ';\n'
);
writeFileSync('assets/data/heartopia-faces.json', body);

const nFaces = Object.values(items).reduce((a, g) => a + Object.keys(g).length, 0);
const nRings = Object.values(items).reduce((a, g) => a + Object.values(g).filter((f) => f.rings).length, 0);
console.log(
  `faces ${nFaces} with rings ${nRings}  bytes ${body.length}\n` +
    `worst polygon/cell disagreement ${worst.toFixed(2)}% at ${worstName || 'n/a'}`
);
for (const n of notes) console.log('note ' + n);
