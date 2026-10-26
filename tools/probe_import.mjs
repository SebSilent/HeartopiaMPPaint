// Does dragging the import preview actually move the picture, and does the
// moved picture land on the board? Measured in a browser because the whole
// feature is a pointer gesture on a canvas.
import { chromium } from 'playwright';

const BASE = (process.argv[2] || 'http://localhost:8099').replace(/\/$/, '');

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, hasTouch: true });
page.on('pageerror', (e) => console.log('PAGEERROR ' + e));
await page.goto(`${BASE}/?local=1&item=tshirt&renderDelay=0`, { waitUntil: 'load' });
await page.waitForFunction(() => !document.getElementById('app').classList.contains('locked'), { timeout: 20000 });
await page.waitForFunction(() => document.getElementById('base').width > 300, { timeout: 10000 });

// A source image that is unmistakably asymmetric: black left, white right, with
// a red band, so a shift in placement is visible in which cells land where.
await page.evaluate(() => {
  const c = document.createElement('canvas');
  c.width = 120;
  c.height = 60;
  const x = c.getContext('2d');
  x.fillStyle = '#000000';
  x.fillRect(0, 0, 60, 60);
  x.fillStyle = '#ffffff';
  x.fillRect(60, 0, 60, 60);
  x.fillStyle = '#ff0000';
  x.fillRect(0, 0, 20, 60);
  window.__src = c.toDataURL('image/png');
});
const b64 = await page.evaluate(() => window.__src.split(',')[1]);

await page.click('#btnImport');
await page.evaluate(async (data) => {
  const blob = await (await fetch(data)).blob();
  const file = new File([blob], 'probe.png', { type: 'image/png' });
  const dt = new DataTransfer();
  dt.items.add(file);
  const input = document.getElementById('file');
  input.files = dt.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
}, `data:image/png;base64,${b64}`);
await page.waitForFunction(() => !document.getElementById('importPrev').hidden, { timeout: 15000 });
await page.waitForTimeout(400);

const prev = page.locator('#importPrev canvas');
const box = await prev.boundingBox();
if (!box) throw new Error('no import preview canvas to drag');

// Count dark cells down the middle of the preview: the seam between the black
// and white halves sits at u=0.5 at rest, so a pan moves it.
const seam = async () =>
  page.evaluate(() => {
    const c = document.querySelector('#importPrev canvas');
    const ctx = c.getContext('2d');
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    const row = Math.floor(c.height / 2);
    let firstDark = -1;
    for (let x = 0; x < c.width; x++) {
      const i = (row * c.width + x) * 4;
      if (d[i] + d[i + 1] + d[i + 2] < 200) {
        firstDark = x;
        break;
      }
    }
    const dark = [];
    for (let x = 0; x < c.width; x++) {
      const i = (row * c.width + x) * 4;
      if (d[i] + d[i + 1] + d[i + 2] < 200) dark.push(x);
    }
    return { firstDark, n: dark.length, w: c.width };
  });

const atRest = await seam();
console.log('at rest:', JSON.stringify(atRest));

// Drag the picture to the right by a third of the preview.
const cy = box.y + box.height / 2;
await page.mouse.move(box.x + box.width / 2, cy);
await page.mouse.down();
await page.mouse.move(box.x + box.width / 2 + box.width / 3, cy, { steps: 12 });
await page.mouse.up();
await page.waitForTimeout(500);

const moved = await seam();
console.log('after drag:', JSON.stringify(moved));
const sliders = await page.evaluate(() => {
  const g = (k) => {
    const el = document.querySelector(`[data-ctl="${k}"]`);
    return el ? Number(el.value) : null;
  };
  return { ox: g('ox'), oy: g('oy'), zoom: g('zoom') };
});
console.log('sliders after drag:', JSON.stringify(sliders));

// Wheel-zoom the preview.
await page.mouse.move(box.x + box.width / 2, cy);
await page.mouse.wheel(0, -400);
await page.waitForTimeout(400);
const zoomed = await page.evaluate(() => Number(document.querySelector('[data-ctl="zoom"]').value));
console.log('zoom after wheel:', zoomed);

await page.click('#importApply');
await page.waitForTimeout(600);
const painted = await page.evaluate(() => {
  const c = document.getElementById('base');
  const ctx = c.getContext('2d');
  const d = ctx.getImageData(0, 0, c.width, c.height).data;
  let dark = 0;
  for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] < 200) dark++;
  return dark;
});
console.log('dark pixels on the board after apply:', painted);

await page.screenshot({ path: '_shots/import-place.png' });
// The evidence is the shape of the row, not its first dark pixel: panning the
// black half rightwards covers more of the face, so the dark count grows, and
// the slider must read the same pan the drag wrote.
const ok =
  moved.n !== atRest.n &&
  sliders.ox !== null &&
  Math.abs(sliders.ox) > 5 &&
  zoomed > 100 &&
  painted > 0;
console.log(ok ? 'PASS: drag moved the picture, the sliders followed, and it landed' : 'FAIL: see the numbers above');
await browser.close();
process.exit(ok ? 0 : 1);
