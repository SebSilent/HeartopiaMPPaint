// Is the garment smooth? Not an opinion about the picture: measure the steps.
//
// A faceted surface is a set of flat plateaus separated by hard edges, so the
// luminance difference between neighbouring pixels is small most of the time and
// occasionally large. A smoothly shaded one steps a little at a time everywhere.
// The ratio between those two is the faceting, and it can be compared across
// builds - which is the only way to know whether the relax pass did anything.
//
// Usage: node tools/smooth.mjs [base]
import { chromium } from 'playwright';

const BASE = (process.argv[2] || 'http://localhost:8099').replace(/\/$/, '');

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, hasTouch: true });
page.on('pageerror', (e) => console.log('PAGEERROR ' + e));
// The recipe tools/meshholes.mjs proved out. ?local=1 leaves the preview panel
// unsized - a 300x150 default canvas that measures as a flawless smooth surface
// of nothing - so this joins a room and waits for the board to have a box first.
await page.goto(`${BASE}/?room=SMOO&item=tshirt&renderDelay=0`, { waitUntil: 'load' });
if (await page.locator('#join').isVisible().catch(() => false)) {
  await page.fill('#nick', 'Smooth');
  await page.click('#join');
}
await page.waitForFunction(() => !document.getElementById('app').classList.contains('locked'), { timeout: 20000 });
await page.waitForFunction(() => document.getElementById('base').width > 300, { timeout: 10000 });
await page.click('#btn3d');
await page.waitForFunction(() => document.getElementById('d3Canvas').width > 200, { timeout: 10000 });
await page.waitForTimeout(1500);

const out = await page.evaluate(() => {
  const c = document.getElementById('d3Canvas');
  const d = c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, c.width, c.height).data;
  const W = c.width;
  const H = c.height;
  const bg = [194, 204, 211];
  const isBg = (i) => Math.abs(d[i] - bg[0]) <= 2 && Math.abs(d[i + 1] - bg[1]) <= 2 && Math.abs(d[i + 2] - bg[2]) <= 2;
  const lum = new Float32Array(W * H);
  const solid = new Uint8Array(W * H);
  for (let p = 0; p < W * H; p++) {
    const i = p * 4;
    if (isBg(i)) continue;
    solid[p] = 1;
    lum[p] = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
  }
  // Neighbour differences, only where both pixels are on the garment, so the
  // silhouette edge (a genuine hard step against the backdrop) is not counted.
  const steps = [];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W - 1; x++) {
      const p = y * W + x;
      if (solid[p] && solid[p + 1]) steps.push(Math.abs(lum[p + 1] - lum[p]));
    }
  }
  for (let y = 0; y < H - 1; y++) {
    for (let x = 0; x < W; x++) {
      const p = y * W + x;
      if (solid[p] && solid[p + W]) steps.push(Math.abs(lum[p + W] - lum[p]));
    }
  }
  steps.sort((a, b) => a - b);
  const at = (q) => steps[Math.min(steps.length - 1, Math.floor(steps.length * q))] || 0;
  const mean = steps.reduce((s, v) => s + v, 0) / (steps.length || 1);
  // The histogram of brightness values on the garment. Faceting shows as a few
  // wide plateaus; smooth shading spreads over almost every level.
  const hist = new Set();
  for (let p = 0; p < W * H; p++) if (solid[p]) hist.add(Math.round(lum[p] / 2));
  let borderOk = 0;
  let borderN = 0;
  for (let x = 0; x < W; x++) for (const y of [0, H - 1]) (borderN++, isBg((y * W + x) * 4) && borderOk++);
  return {
    garmentPx: steps.length ? solid.reduce((s, v) => s + v, 0) : 0,
    borderFrac: borderOk / borderN,
    pairs: steps.length,
    mean: +mean.toFixed(2),
    p50: +at(0.5).toFixed(2),
    p99: +at(0.99).toFixed(2),
    max: +at(1).toFixed(2),
    // Steps big enough to read as an edge between two flat faces.
    hard: steps.filter((s) => s > 8).length,
    hardPct: +((steps.filter((s) => s > 8).length / (steps.length || 1)) * 100).toFixed(3),
    levels: hist.size,
  };
});

if (out.borderFrac < 0.8 || out.garmentPx < 2000)
  throw new Error(`nothing rendered: border backdrop ${(out.borderFrac * 100).toFixed(0)}%, garment ${out.garmentPx}px`);
console.log(JSON.stringify(out));
console.log(
  `mean step ${out.mean}  median ${out.p50}  p99 ${out.p99}  max ${out.max}  hard steps ${out.hardPct}%  distinct levels ${out.levels}`
);
await browser.close();
