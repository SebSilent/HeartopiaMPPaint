// Stop guessing: print the render as text. '#' garment, '.' backdrop that
// reaches the border, 'o' backdrop trapped inside the shape. The position of the
// o's tells you which fix is right - along a seam, at a rim, or in the middle of
// a panel - and no aggregate count can do that.
// Usage: node tools/lookmap.mjs [base] [yaw] [pitch]
import { chromium } from 'playwright';

const BASE = (process.argv[2] || 'http://localhost:8099').replace(/\/$/, '');
const PREFIX = new URL(BASE).pathname.replace(/\/$/, '');
const YAW = Number(process.argv[3] ?? 0);
const PITCH = Number(process.argv[4] ?? 0);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (e) => console.log('PAGEERROR ' + e));
await page.goto(`${BASE}/?local=1&item=tshirt`, { waitUntil: 'load' });
await page.waitForFunction(() => document.querySelectorAll('#tools [data-tool]').length >= 8, null, { timeout: 20000 });
await page.waitForFunction(() => document.getElementById('base').width > 300, { timeout: 10000 });
await page.click('#btn3d');
await page.waitForTimeout(1600);

const map = await page.evaluate(async (args) => {
  const { Preview3D } = await import(`${args.prefix}/assets/js/game/render3d.js`);
  const { loadMesh } = await import(`${args.prefix}/assets/js/game/meshdata.js`);
  const { findItem } = await import(`${args.prefix}/assets/js/game/slots.js`);
  const { maskFor } = await import(`${args.prefix}/assets/js/game/faces.js`);

  const mesh = await loadMesh('tshirt');
  const item = findItem('tshirt');
  const cv = document.createElement('canvas');
  // Match the panel's real size. At 132x66 a two-pixel island simply rounds
  // away, and the map reported a clean garment while the live panel speckled.
  cv.width = 526;
  cv.height = 331;
  cv.getBoundingClientRect = () => ({ width: 526, height: 331 });
  // The same bake the app does, so this map is the app and not a sketch of it.
  const bake = (faceId) => {
    const face = item.faces.find((f) => f.id === faceId);
    const c = document.createElement('canvas');
    c.width = face.w;
    c.height = face.h;
    const x = c.getContext('2d');
    const img = x.createImageData(face.w, face.h);
    const words = new Uint32Array(img.data.buffer);
    const m = maskFor(item.id, faceId);
    for (let i = 0; i < words.length; i++) words[i] = m && !m[i] ? 0 : 0xff0000ff;
    x.putImageData(img, 0, 0);
    return c;
  };
  // The app passes its outline lookup as the third argument. Whether it does is
  // the only remaining difference between this map and the live panel, so it is
  // switchable: without it the mesh alone traps 4 px, and the live panel 244.
  const { outlineFor } = await import(`${args.prefix}/assets/js/game/outline.js`);
  const pr = new Preview3D(cv, bake, args.outline ? (id, f) => outlineFor(id, f) : null);
  pr.setMesh(mesh);
  pr.build(item);
  pr.yaw = args.yaw;
  pr.pitch = args.pitch;
  pr.render(true);

  const d = cv.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, cv.width, cv.height).data;
  const W = cv.width;
  const H = cv.height;
  const near = (i) => Math.abs(d[i] - 194) < 16 && Math.abs(d[i + 1] - 204) < 16 && Math.abs(d[i + 2] - 211) < 16;
  const seen = new Uint8Array(W * H);
  const live = [];
  for (let x = 0; x < W; x++) for (const y of [0, H - 1]) if (near((y * W + x) * 4) && !seen[y * W + x]) (seen[y * W + x] = 1), live.push(y * W + x);
  for (let y = 0; y < H; y++) for (const x of [0, W - 1]) if (near(y * W + x) && !seen[y * W + x]) (seen[y * W + x] = 1), live.push(y * W + x);
  while (live.length) {
    const p = live.pop();
    const x = p % W;
    for (const q of [x > 0 ? p - 1 : -1, x < W - 1 ? p + 1 : -1, p - W, p + W]) {
      if (q >= 0 && q < W * H && !seen[q] && near(q * 4)) (seen[q] = 1), live.push(q);
    }
  }
  // Print every 4th pixel so the map fits in a terminal, but count over all of
  // them - the islands are two pixels wide and would never survive sampling.
  const rows = [];
  for (let y = 0; y < H; y += 4) {
    let s = '';
    for (let x = 0; x < W; x += 4) {
      let o = 0;
      let g = 0;
      for (let dy = 0; dy < 4 && y + dy < H; dy++) {
        for (let dx = 0; dx < 4 && x + dx < W; dx++) {
          const p = (y + dy) * W + (x + dx);
          if (!near(p * 4)) g++;
          else if (!seen[p]) o++;
        }
      }
      s += g > 8 ? '#' : o > 0 ? 'o' : '.';
    }
    rows.push(s);
  }
  let trapped = 0;
  for (let p = 0; p < W * H; p++) if (near(p * 4) && !seen[p]) trapped++;
  return { rows, trapped };
}, { prefix: PREFIX, yaw: YAW, pitch: PITCH, outline: process.argv[5] === 'outline' });

console.log(map.rows.join('\n'));
console.log(`trapped: ${map.trapped} px of 526x331 (o marks a 4x4 block containing at least one)`);
await browser.close();
