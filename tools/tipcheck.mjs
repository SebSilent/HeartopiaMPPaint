// Does an imported picture really become the brush? Drives the shipped page:
// makes a tip image, feeds it through the file input, paints, and reads cells.
import { chromium } from 'playwright';
import { writeFileSync, unlinkSync } from 'node:fs';

const BASE = process.argv[2] || 'http://localhost:8099';
const TMP = '_tip.png';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, hasTouch: true });
const errs = [];
page.on('pageerror', (e) => errs.push('PAGEERROR ' + e));
await page.goto(`${BASE}/?local=1`, { waitUntil: 'load' });
// ?local=1 closes the gate by itself, so #join is only clickable if it is still
// up. Waiting on the tool row instead of the button removes the race.
if (await page.locator('#join').isVisible().catch(() => false)) {
  await page.fill('#nick', 'Tip');
  await page.click('#join');
}
await page.waitForFunction(() => document.querySelectorAll('#tools [data-tool]').length >= 8, null, { timeout: 15000 });

// A flat bar with a nub: if the mask is right, only those cells get painted.
const dataUrl = await page.evaluate(() => {
  const c = document.createElement('canvas');
  c.width = 60;
  c.height = 60;
  const x = c.getContext('2d');
  x.fillStyle = '#fff';
  x.fillRect(0, 0, 60, 60);
  x.fillStyle = '#000';
  x.fillRect(4, 26, 52, 8); // the bar
  x.fillRect(24, 12, 8, 14); // the nub above it
  return c.toDataURL('image/png');
});
writeFileSync(TMP, Buffer.from(dataUrl.split(',')[1], 'base64'));

await page.setInputFiles('#tipFile', TMP);
await page.waitForTimeout(600);
const loaded = await page.evaluate(() => ({
  set: document.getElementById('tipBtn').classList.contains('set'),
  thumb: (document.getElementById('tipImg').src || '').slice(0, 22),
}));

// What the mask actually resolves to, read from the same module the app uses.
const painted = await page.evaluate(async () => {
  const { stampFromFile, stampOffsets } = await import('./assets/js/game/stamps.js');
  const f = await fetch('./_tip.png').then((r) => r.blob());
  const { stamp } = await stampFromFile(f);
  return { box: stamp.box, offs: stampOffsets(stamp, 5), on: stamp.on };
});

// Drive it as a pointer would: single tap with the tip loaded at size 5.
await page.click('#brushes [data-brush="5"]');
const box = await page.locator('#stage').boundingBox();
const cx = Math.round(box.x + box.width / 2);
const cy = Math.round(box.y + box.height / 2);

// Read the paper before and after and count what CHANGED. Comparing against
// "white" instead would score every guide line and grid line on the board as
// paint, which is how the first version of this probe reported a dab as 15,420
// inked pixels.
const shot = () =>
  page.evaluate(() => {
    const c = document.querySelector('#base');
    const ctx = c.getContext('2d', { willReadFrequently: true });
    return Array.from(ctx.getImageData(0, 0, c.width, c.height).data);
  });

const before = await shot();
await page.mouse.move(cx, cy);
await page.mouse.down();
await page.mouse.up();
await page.waitForTimeout(400);
const after = await shot();

const dims = await page.evaluate(() => {
  const c = document.querySelector('#base');
  return { w: c.width, h: c.height };
});
let changed = 0;
let minX = dims.w;
let minY = dims.h;
let maxX = -1;
let maxY = -1;
for (let y = 0; y < dims.h; y += 2) {
  for (let x = 0; x < dims.w; x += 2) {
    const k = (y * dims.w + x) * 4;
    if (
      Math.abs(before[k] - after[k]) > 24 ||
      Math.abs(before[k + 1] - after[k + 1]) > 24 ||
      Math.abs(before[k + 2] - after[k + 2]) > 24
    ) {
      changed++;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
}
const grid = { changed, w: maxX - minX + 1, h: maxY - minY + 1 };

await page.screenshot({ path: '_shots/tip.png' });
unlinkSync(TMP);
const checks = [
  ['tip button shows the thumbnail', loaded.set && loaded.thumb.startsWith('data:image/png'), JSON.stringify(loaded)],
  ['tip trimmed to its own art', painted.box.x > 0 && painted.box.w < 60 && painted.box.h < 40, JSON.stringify(painted.box)],
  ['mask is wide and short', painted.offs.length > 0 && new Set(painted.offs.map((o) => o[1])).size <= 3, `${painted.offs.length} cells`],
  ['a dab paints a band, not a dot', grid.changed > 20 && grid.w > grid.h * 2, JSON.stringify(grid)],
  ['no page errors', errs.length === 0, errs.join(' | ')],
];
for (const [n, ok, d] of checks) console.log(`${ok ? 'OK  ' : 'FAIL'} ${n}  ${d}`);
await browser.close();
if (checks.some((c) => !c[1])) process.exitCode = 1;
