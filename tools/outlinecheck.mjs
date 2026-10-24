// Does the outline the player sees match the cells they can paint?
//
// The board draws outline.js boardOutline(); painting is gated by faces.js
// maskFor(), which is the game's disabledPixels list wherever that list exists.
// Two different pieces of data, so they can disagree - and when they do, the board
// shows a line that is not the edge of the area you can actually paint. That is the
// same category of mistake that made the book's spine lines block paint.
//
// This imports the app's own functions rather than re-deriving them, and separates
// two very different kinds of disagreement:
//   missing region  - a whole part of the garment has no line around it
//   edge band       - the line is one or two cells off the true edge everywhere
import { boardOutline, outlineFor } from '../assets/js/game/outline.js';
import { faceInfo, maskFor } from '../assets/js/game/faces.js';
import { CATALOG } from '../assets/js/game/slots.js';

function drawnInside(o, x, y) {
  // Guides are not a limit: a face that ships only guides promises the whole board.
  const rings = o.rings || (o.ring ? [o.ring] : []);
  if (!rings.length) return true;
  let c = false;
  for (const r of rings) {
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const xi = r[i][0], yi = r[i][1], xj = r[j][0], yj = r[j][1];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
    }
  }
  return c;
}

/** Distance from every cell to the nearest cell where line and paint agree. */
function bandWidth(disagree, w, h) {
  const d = new Int32Array(w * h).fill(-1);
  const q = [];
  for (let i = 0; i < w * h; i++) if (!disagree[i]) { d[i] = 0; q.push(i); }
  if (!q.length) return { max: -1, p95: -1 };
  for (let head = 0; head < q.length; head++) {
    const i = q[head];
    const x = i % w;
    const y = (i / w) | 0;
    for (const [nx, ny] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]) {
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const j = ny * w + nx;
      if (d[j] !== -1) continue;
      d[j] = d[i] + 1;
      q.push(j);
    }
  }
  const vals = [...disagree.keys()].filter((i) => disagree[i]).map((i) => d[i]).sort((a, b) => a - b);
  if (!vals.length) return { max: 0, p95: 0 };
  return { max: vals[vals.length - 1], p95: vals[Math.floor(vals.length * 0.95)] };
}

const rows = [];
for (const [family, items] of Object.entries(CATALOG)) {
  if (family === 'canvas') continue; // plain rectangles, no silhouette shipped or drawn
  for (const item of items) {
    for (const f of item.faces) {
      const info = faceInfo(item.id, f.id);
      const paint = maskFor(item.id, f.id);
      const o = boardOutline(item.id, f.id);
      if (!paint || !o) {
        rows.push({ face: `${item.name} ${f.id}`, skip: o ? 'no paint mask' : 'no drawn outline' });
        continue;
      }
      const w = info.w;
      const h = info.h;
      let blocked = 0; // inside the line, but the game refuses the cell
      let hidden = 0; // paintable, but the line does not go around it
      const dis = new Uint8Array(w * h);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const inLine = drawnInside(o, x + 0.5, y + 0.5);
          const can = paint[y * w + x] === 1;
          if (inLine !== can) {
            dis[y * w + x] = 1;
            if (inLine) blocked++;
            else hidden++;
          }
        }
      }
      const band = bandWidth(dis, w, h);
      const total = w * h;
      rows.push({
        face: `${item.name} ${f.id}`,
        pct: +(((blocked + hidden) / total) * 100).toFixed(2),
        blocked,
        hidden,
        total,
        band95: band.p95,
        bandMax: band.max,
        // Would the old source have been worse? Reported so the change is measurable.
        meshPct: (() => {
          const m = outlineFor(item.id, f.id);
          if (!m) return null;
          let n = 0;
          for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
              if (drawnInside(m, x + 0.5, y + 0.5) !== (paint[y * w + x] === 1)) n++;
            }
          }
          return +((n / total) * 100).toFixed(2);
        })(),
      });
    }
  }
}

const scored = rows.filter((r) => !r.skip).sort((a, b) => b.pct - a.pct);
console.log(`faces drawn and painted: ${scored.length}   (skipped: ${rows.filter((r) => r.skip).map((r) => r.face + ' ' + r.skip).join(', ') || 'none'})`);
console.log('worst 10 faces, drawn outline vs paintable cells:');
for (const r of scored.slice(0, 10)) {
  console.log(`  ${r.face.padEnd(24)} ${String(r.pct).padStart(6)}%  blocked-in-line ${String(r.blocked).padStart(5)}, line-missing ${String(r.hidden).padStart(5)} of ${r.total} | band p95 ${r.band95} cells, max ${r.bandMax}`);
}
console.log(`clean (0%): ${scored.filter((r) => r.pct === 0).length} | median ${scored[Math.floor(scored.length / 2)].pct}% | mean ${(scored.reduce((s, r) => s + r.pct, 0) / scored.length).toFixed(2)}%`);
const wide = scored.filter((r) => r.band95 > 2);
console.log(`faces whose disagreement is thicker than 2 cells at p95 (i.e. a missing region, not an edge band): ${wide.length}${wide.length ? ' -> ' + wide.map((r) => `${r.face} p95 ${r.band95}`).join(', ') : ''}`);
const cmp = scored.filter((r) => r.meshPct !== null);
const worse = cmp.filter((r) => r.meshPct < r.pct);
console.log(`mesh-ring source would have been worse on ${cmp.filter((r) => r.meshPct > r.pct).length} of ${cmp.length} clothing faces; it is better on ${worse.length}: ${worse.map((r) => `${r.face} ${r.pct}<${r.meshPct}`).join(', ') || 'none'}`);
