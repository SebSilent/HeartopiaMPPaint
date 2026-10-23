// Does the real mesh arrive, and does the paint land where it belongs on it?
//
// The position test is the one that matters: the mesh's UV is v = 1 - y/h, so a
// bar painted across the TOP of the board has to come back as a bar across the
// top of the garment. Get that sign wrong and every design is upside down.
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';
const log = [];
const say = (s) => { log.push(s); writeFileSync('_mesh.txt', log.join('\n') + '\n'); };

const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
p.on('pageerror', (e) => say('PAGEERROR ' + e));
p.on('console', (m) => {
  if (m.type() === 'error') say('CONSOLE ' + m.text());
});
await p.goto('http://localhost:8099/?room=MESH1&item=tshirt&renderDelay=0', { waitUntil: 'load' });
await p.fill('#nick', 'Solo');
await p.click('#join');
await p.waitForFunction(() => !document.getElementById('app').classList.contains('locked'), { timeout: 20000 });
await p.waitForFunction(() => document.getElementById('base').width > 300, { timeout: 8000 });

// A colour that is not the paper, so it can be found in pixels.
await p.evaluate(() => document.querySelectorAll('#swatches .swatch')[3].click());

// Paint a bar across the top of the board, well inside the silhouette.
const s = await p.evaluate(() => {
  const r = document.getElementById('stage').getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height };
});
const barY = Math.round(s.y + s.h * 0.16);
await p.mouse.move(s.x + s.w * 0.3, barY);
await p.mouse.down();
for (let i = 0; i <= 20; i++) await p.mouse.move(s.x + s.w * 0.3 + i * 8, barY);
await p.mouse.up();
await p.waitForTimeout(300);

await p.click('#btn3d');
await p.waitForTimeout(1800);

const stats = await p.evaluate(() => {
  const cv = document.getElementById('d3Canvas');
  const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
  const back = [194, 204, 211];
  let cloth = 0;
  let clothY = 0;
  let ink = 0;
  let inkY = 0;
  let inkX = 0;
  let inkTop = 1e9;
  let inkBot = -1;
  let clothTop = 1e9;
  let clothBot = -1;
  for (let y = 0; y < cv.height; y++) {
    for (let x = 0; x < cv.width; x++) {
      const o = (y * cv.width + x) * 4;
      const r = d[o];
      const g = d[o + 1];
      const bl = d[o + 2];
      const isBack = Math.abs(r - back[0]) < 7 && Math.abs(g - back[1]) < 7 && Math.abs(bl - back[2]) < 7;
      if (isBack) continue;
      cloth++;
      clothY += y;
      clothTop = Math.min(clothTop, y);
      clothBot = Math.max(clothBot, y);
      // The chosen swatch is a saturated colour: red far above blue.
      if (r > bl + 45 && r > 90) {
        ink++;
        inkY += y;
        inkX += x;
        inkTop = Math.min(inkTop, y);
        inkBot = Math.max(inkBot, y);
      }
    }
  }
  return {
    clothPct: +((cloth / (cv.width * cv.height)) * 100).toFixed(1),
    clothSpan: [clothTop, clothBot],
    ink: { n: ink, midY: ink ? Math.round(inkY / ink) : -1, top: inkTop === 1e9 ? -1 : inkTop, bot: inkBot },
    canvas: cv.width + 'x' + cv.height,
  };
});
say('LIVE ' + JSON.stringify(stats));
say(
  stats.ink.n > 40
    ? `PASS  paint shows on the mesh (${stats.ink.n} px, band ${stats.ink.top}..${stats.ink.bot} of garment ${stats.clothSpan[0]}..${stats.clothSpan[1]})`
    : `FAIL  no paint found on the 3D garment [${stats.ink.n}]`
);
const span = stats.clothSpan[1] - stats.clothSpan[0];
const rel = span ? (stats.ink.midY - stats.clothSpan[0]) / span : -1;
say(`paint sits at ${(rel * 100).toFixed(0)}% down the garment (painted at the top, so it must be under 40%)`);
say(rel >= 0 && rel < 0.4 ? 'PASS  the mesh UV is right way up' : 'FAIL  the paint is upside down or misplaced');

// And the geometry itself, measured from the module the app loads.
const geo = await p.evaluate(async () => {
  const { loadMesh } = await import('/assets/js/game/meshdata.js');
  const out = {};
  for (const id of ['tshirt', 'dress', 'shoes', 'trousers', 'bucket']) {
    const m = await loadMesh(id);
    if (!m) {
      out[id] = 'NO MESH';
      continue;
    }
    let y0 = Infinity;
    let y1 = -Infinity;
    let u0 = Infinity;
    let u1 = -Infinity;
    for (let i = 0; i < m.pos.length; i += 3) {
      y0 = Math.min(y0, m.pos[i + 1]);
      y1 = Math.max(y1, m.pos[i + 1]);
    }
    for (let i = 0; i < m.uv.length; i += 2) {
      u0 = Math.min(u0, m.uv[i]);
      u1 = Math.max(u1, m.uv[i]);
    }
    out[id] = { tris: m.tris, verts: m.pos.length / 3, y: [+y0.toFixed(3), +y1.toFixed(3)], uvU: [+u0.toFixed(3), +u1.toFixed(3)], faces: m.faces.join('|') };
  }
  return out;
});
say('GEOMETRY ' + JSON.stringify(geo, null, 1));
await p.screenshot({ path: '_shots/mesh3d.png' });
await b.close();
