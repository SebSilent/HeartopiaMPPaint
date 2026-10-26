/**
 * Browser check for closing a polygon. The unit test hands Input a synthetic
 * pointer with detail 2; only a real browser says whether a double-click actually
 * reports that. It matters because the mouse path and the timed path are the two
 * ways a person means "finished", and one of them is a guess about the platform.
 *
 * Run: node tools/probe_polygon.mjs   (server on 8099)
 */
import { chromium } from 'playwright';
import { FLAT_COLORS } from '../assets/js/data/heartopia-palette.js';

const BASE = process.env.BASE || 'http://localhost:8099';
const HEX = FLAT_COLORS[16].toLowerCase();
const RGB = [1, 3, 5].map((i) => parseInt(HEX.slice(i, i + 2), 16));

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) {
    pass++;
    console.log(`PASS ${name}${detail ? ' - ' + detail : ''}`);
  } else {
    fail++;
    console.log(`FAIL ${name}${detail ? ' ' + detail : ''}`);
  }
}

const b = await chromium.launch();
const page = await b.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push('console: ' + m.text());
});

await page.goto(`${BASE}/?local=1&renderDelay=0`, { waitUntil: 'load' });
await page.waitForFunction(() => !document.getElementById('app').classList.contains('locked'), { timeout: 20000 });
await page.waitForFunction(() => document.getElementById('base').width > 300, { timeout: 10000 });

// Cell interiors only: fractional cell scaling blends every edge into a colour
// that exists on no palette.
const painted = () =>
  page.evaluate((rgb) => {
    const cv = document.getElementById('base');
    const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
    const w = cv.width;
    const h = cv.height;
    const eq = (a) => d[a] === rgb[0] && d[a + 1] === rgb[1] && d[a + 2] === rgb[2] && d[a + 3] === 255;
    const run = (a, len, step) => {
      for (let k = 0; k < len; k++) if (!eq(a + k * step)) return false;
      return true;
    };
    let n = 0;
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = (y * w + x) * 4;
        if (!eq(i)) continue;
        if (!run(i - 4, 3, 4) || !run(i - w * 4, 3, w * 4)) continue;
        n++;
      }
    }
    return n;
  }, RGB);

const box = await page.locator('#base').boundingBox();
const at = (fx, fy) => ({ x: box.x + box.width * fx, y: box.y + box.height * fy });

await page.click('.tool[data-tool="polygon"]');
await page.click('#toolOpts [data-fillmode="filled"]');

// What a real double-click reports, before asserting anything about behaviour.
let reported = null;
await page.evaluate(() => {
  window.__detail = null;
  document.getElementById('base').addEventListener(
    'pointerdown',
    (e) => {
      if (e.detail >= 2) window.__detail = e.detail;
    },
    true
  );
});

const p1 = at(0.25, 0.25);
const p2 = at(0.7, 0.25);
const p3 = at(0.5, 0.72);

await page.mouse.click(p1.x, p1.y);
await page.mouse.click(p2.x, p2.y);
check('G: two clicks and nothing is committed yet', (await painted()) === 0);
await page.mouse.click(p3.x, p3.y);
check('G: three clicks and still nothing', (await painted()) === 0);

await page.mouse.dblclick(p3.x, p3.y);
await page.waitForTimeout(150);
const filled = await painted();
reported = await page.evaluate(() => window.__detail);
// The app calls preventDefault() on pointerdown, which suppresses the
// compatibility mouse events that maintain the browser's click count - so
// pointerdown.detail never reaches 2 here, and the timed path is what actually
// closes a double-click. Asserting the outcome, not the mechanism, because a
// close that depended on `detail` would be broken by that suppression.
check('G: a double-click closes the shape', filled > 0, `${filled} px, detail seen: ${reported}`);

await page.click('#btnUndo');
await page.waitForTimeout(150);
check('G: one undo takes the whole polygon back', (await painted()) === 0);

// The other way: click back on the first vertex.
await page.mouse.click(p1.x, p1.y);
await page.mouse.click(p2.x, p2.y);
await page.mouse.click(p3.x, p3.y);
await page.mouse.click(p1.x, p1.y);
await page.waitForTimeout(150);
check('G: clicking the first vertex closes it too', (await painted()) > 0);
await page.click('#btnUndo');
await page.waitForTimeout(150);
check('G: and that one is one undo as well', (await painted()) === 0);

// Escape must still abandon an unfinished shape.
await page.mouse.click(p1.x, p1.y);
await page.mouse.click(p2.x, p2.y);
await page.keyboard.press('Escape');
await page.waitForTimeout(120);
await page.mouse.move(p3.x, p3.y);
await page.waitForTimeout(120);
const fxGhost = await page.evaluate((rgb) => {
  const cv = document.getElementById('fx');
  const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
  const near = (a) => Math.abs(d[a] - rgb[0]) <= 2 && Math.abs(d[a + 1] - rgb[1]) <= 2 && Math.abs(d[a + 2] - rgb[2]) <= 2;
  let n = 0;
  for (let i = 0; i < d.length; i += 4) if (near(i) && d[i + 3] > 0) n++;
  return n;
}, RGB);
check('G: Escape drops the rubber band, not the app', fxGhost === 0, `${fxGhost} preview px left`);

check('G: no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));

await b.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
