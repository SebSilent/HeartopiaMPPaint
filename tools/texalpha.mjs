// Is the "hole" the geometry, or the paint? A triangle can be drawn perfectly
// and still show the backdrop if the pixel of the face texture it samples is
// transparent - drawImage of nothing leaves whatever was underneath.
// Usage: node tools/texalpha.mjs [base] [item]
import { chromium } from 'playwright';

const BASE = (process.argv[2] || 'http://localhost:8099').replace(/\/$/, '');
const ITEM = process.argv[3] || 'tshirt';
const PREFIX = new URL(BASE).pathname.replace(/\/$/, '');

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, hasTouch: true });
page.on('pageerror', (e) => console.log('PAGEERROR ' + e));
await page.goto(`${BASE}/?room=TEXA&item=${ITEM}&renderDelay=0`, { waitUntil: 'load' });
if (await page.locator('#join').isVisible().catch(() => false)) {
  await page.fill('#nick', 'Tex');
  await page.click('#join');
}
await page.waitForFunction(() => !document.getElementById('app').classList.contains('locked'), { timeout: 20000 });
await page.waitForFunction(() => document.getElementById('base').width > 300, { timeout: 10000 });

const out = await page.evaluate(async (prefix) => {
  const { loadMesh } = await import(`${prefix}/assets/js/game/meshdata.js`);
  const { ITEMS, findItem } = await import(`${prefix}/assets/js/game/design.js`);
  const mesh = await loadMesh('tshirt');
  const item = findItem('tshirt');
  const rows = [];
  // Every face the mesh references, and how much of the area it actually uses is
  // transparent in the texture that gets drawn.
  const used = new Map();
  for (let t = 0; t < mesh.tris; t++) {
    const fid = mesh.faces[mesh.idx[t * 4 + 3]];
    used.set(fid, (used.get(fid) || 0) + 1);
  }
  for (const [fid, tris] of used) {
    const face = item.faces.find((f) => f.id === fid);
    if (!face) {
      rows.push({ fid, tris, note: 'NO FACE IN ITEM' });
      continue;
    }
    // Reproduce what the preview bakes: the face's own texture canvas.
    const c = document.createElement('canvas');
    c.width = face.w;
    c.height = face.h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    const d = ctx.getImageData(0, 0, face.w, face.h).data;
    let opaque = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 0) opaque++;
    // Where the mesh's UVs land, in cells.
    let u0 = 1;
    let u1 = 0;
    let v0 = 1;
    let v1 = 0;
    for (let t = 0; t < mesh.tris; t++) {
      if (mesh.faces[mesh.idx[t * 4 + 3]] !== fid) continue;
      for (const k of [0, 1, 2]) {
        const vi = mesh.idx[t * 4 + k];
        const u = mesh.uv[vi * 2];
        const v = mesh.uv[vi * 2 + 1];
        u0 = Math.min(u0, u);
        u1 = Math.max(u1, u);
        v0 = Math.min(v0, v);
        v1 = Math.max(v1, v);
      }
    }
    rows.push({
      fid,
      tris,
      face: `${face.w}x${face.h}`,
      uvBox: `${u0.toFixed(2)}..${u1.toFixed(2)} x ${v0.toFixed(2)}..${v1.toFixed(2)}`,
      // A face whose texture is entirely transparent paints nothing at all.
      opaqueOfFresh: opaque,
    });
  }
  return rows;
}, PREFIX);

console.log(`item ${ITEM}, mesh faces:`);
for (const r of out) console.log(JSON.stringify(r));
await browser.close();
