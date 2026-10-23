// Which of the two suspects is making the speckle: missing geometry, or the
// paint texture being transparent where the mesh samples it?
//
// Same mesh, same camera, two textures - one solid and opaque, one the real baked
// face. If the trapped backdrop only appears with the real texture, the surface
// is fine and the paint is the problem. If it appears with both, triangles are
// missing. Guessing between those two costs a wrong fix, so measure it.
//
// Usage: node tools/holesolid.mjs [base]
import { chromium } from 'playwright';

const BASE = (process.argv[2] || 'http://localhost:8099').replace(/\/$/, '');
const PREFIX = new URL(BASE).pathname.replace(/\/$/, '');

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, hasTouch: true });
page.on('pageerror', (e) => console.log('PAGEERROR ' + e));
await page.goto(`${BASE}/?local=1&item=tshirt`, { waitUntil: 'load' });
if (await page.locator('#join').isVisible().catch(() => false)) {
  await page.fill('#nick', 'Sol');
  await page.click('#join');
}
await page.waitForFunction(() => document.querySelectorAll('#tools [data-tool]').length >= 8, null, { timeout: 20000 });
await page.waitForFunction(() => document.getElementById('base').width > 300, { timeout: 10000 });

const rows = await page.evaluate(async (prefix) => {
  const { Preview3D } = await import(`${prefix}/assets/js/game/render3d.js`);
  const { loadMesh } = await import(`${prefix}/assets/js/game/meshdata.js`);
  const { findItem } = await import(`${prefix}/assets/js/game/slots.js`);
  const { outlineFor } = await import(`${prefix}/assets/js/game/outline.js`);
  const mesh = await loadMesh('tshirt');
  const item = findItem('tshirt');

  const bakeSolid = (face) => {
    const c = document.createElement('canvas');
    c.width = face.w;
    c.height = face.h;
    const x = c.getContext('2d');
    x.fillStyle = '#d8d8d8';
    x.fillRect(0, 0, c.width, c.height);
    return c;
  };
  // What the app really bakes: paper plus paint, transparent outside the face's
  // own silhouette. Built from the same mask the board gates painting with, so
  // the transparency pattern is the real one rather than my guess at it.
  const { maskFor } = await import(`${prefix}/assets/js/game/outline.js`);
  const bakeReal = (face) => {
    const c = document.createElement('canvas');
    c.width = face.w;
    c.height = face.h;
    const x = c.getContext('2d', { willReadFrequently: true });
    const mask = maskFor(item.id, face.id);
    if (!mask) {
      x.fillStyle = '#8a5a3b';
      x.fillRect(0, 0, c.width, c.height);
      return c;
    }
    const img = x.createImageData(face.w, face.h);
    for (let i = 0; i < mask.length; i++) {
      if (!mask[i]) continue;
      const k = i * 4;
      img.data[k] = 138;
      img.data[k + 1] = 90;
      img.data[k + 2] = 59;
      img.data[k + 3] = 255;
    }
    x.putImageData(img, 0, 0);
    return c;
  };

  const measure = (pr, yaw, pitch) => {
    const cv = pr.canvas;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    pr.yaw = yaw;
    pr.pitch = pitch;
    pr.render(true);
    const d = ctx.getImageData(0, 0, cv.width, cv.height).data;
    const W = cv.width;
    const H = cv.height;
    const near = (i) => Math.abs(d[i] - 194) < 14 && Math.abs(d[i + 1] - 204) < 14 && Math.abs(d[i + 2] - 211) < 14;
    const seen = new Uint8Array(W * H);
    const live = [];
    for (let x = 0; x < W; x++) for (const y of [0, H - 1]) if (near((y * W + x) * 4)) (seen[y * W + x] = 1), live.push(y * W + x);
    for (let y = 0; y < H; y++) for (const x of [0, W - 1]) if (near(y * W + x) && !seen[y * W + x]) (seen[y * W + x] = 1), live.push(y * W + x);
    while (live.length) {
      const p = live.pop();
      const x = p % W;
      for (const q of [x > 0 ? p - 1 : -1, x < W - 1 ? p + 1 : -1, p - W, p + W]) {
        if (q >= 0 && q < W * H && !seen[q] && near(q * 4)) (seen[q] = 1), live.push(q);
      }
    }
    let trapped = 0;
    let garment = 0;
    for (let p = 0; p < W * H; p++) {
      if (near(p * 4)) {
        if (!seen[p]) trapped++;
      } else garment++;
    }
    return { trapped, garment };
  };

  const mk = (bake) => {
    const cv = document.createElement('canvas');
    cv.width = 526;
    cv.height = 331;
    cv.getBoundingClientRect = () => ({ width: 526, height: 331 });
    const pr = new Preview3D(cv, (id) => {
      const face = item.faces.find((f) => f.id === id);
      return bake(face);
    }, (id, f) => outlineFor(id, f));
    pr.setMesh(mesh);
    pr.build(item);
    return pr;
  };

  const out = [];
  const angles = [
    [0, 0],
    [0.6, 0.2],
    [1.2, 0.4],
    [2.2, 0.5],
    [3.0, 0.7],
    [4.2, 0.9],
  ];
  const solid = mk(bakeSolid);
  const real = mk(bakeReal);
  for (const [yaw, pitch] of angles) {
    const s = measure(solid, yaw, pitch);
    const r = measure(real, yaw, pitch);
    out.push({ yaw: yaw.toFixed(1), solid: s.trapped, real: r.trapped, px: s.garment });
  }
  return out;
}, PREFIX);

console.log('angle   trapped-with-solid-texture   trapped-with-real-texture');
for (const r of rows) console.log(`${r.yaw.padEnd(7)} ${String(r.solid).padStart(12)} ${String(r.real).padStart(22)}   (garment ${r.px}px)`);
await browser.close();
