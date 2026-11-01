/**
 * Browser check for the reference sheet.
 *
 * The unit tests cover the arithmetic. They cannot cover the two things that
 * only go wrong on a real canvas: whether `drawSheet` puts ink where the layout
 * says it does, and whether pressing the button hands the player a file. A sheet
 * whose legend swatch is drawn at the wrong offset looks fine in a layout test
 * and prints a colour nobody can match.
 *
 * Run: node tools/probe_sheet.mjs   (server on 8099)
 */
import { chromium } from 'playwright';
import fs from 'node:fs';

const BASE = process.env.BASE || 'http://localhost:8099';

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
const ctx = await b.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push('console: ' + m.text());
});

async function open() {
  await page.goto(`${BASE}/?local=1&renderDelay=0`, { waitUntil: 'load' });
  await page.waitForFunction(() => !document.getElementById('app').classList.contains('locked'), { timeout: 20000 });
  await page.waitForFunction(() => document.getElementById('base').width > 300, { timeout: 10000 });
}
await open();

// ---- A. the button really hands over a file, and counts what it drew ----
const box = await page.locator('#base').boundingBox();
const idxs = await page.$$eval('#swatches .swatch', (n) => n.slice(0, 6).map((x) => Number(x.dataset.idx)));
const [A, B] = idxs;

await page.click('.tool[data-tool="brush"]');
await page.click(`#swatches .swatch[data-idx="${A}"]`);
await page.mouse.click(box.x + box.width * 0.25, box.y + box.height * 0.25);
await page.click(`#swatches .swatch[data-idx="${B}"]`);
await page.mouse.click(box.x + box.width * 0.35, box.y + box.height * 0.25);
await page.waitForTimeout(200);

const [download] = await Promise.all([page.waitForEvent('download', { timeout: 15000 }), page.click('#btnSheet')]);
const file = await download.path();
const bytes = fs.readFileSync(file);
check('S: the download has a name', /^heartopia-sheet-.*\.png$/.test(download.suggestedFilename()), download.suggestedFilename());
check('S: it is a PNG', bytes[0] === 0x89 && bytes.slice(1, 4).toString() === 'PNG', bytes.slice(0, 4).toString('hex'));
const w = bytes.readUInt32BE(16);
const h = bytes.readUInt32BE(20);
check('S: the sheet has real dimensions', w > 300 && h > 200, `${w}x${h}`);
check('S: and it is a file, not a blank', bytes.length > 4000, `${bytes.length} bytes`);

const toasts = (await page.locator('#toast .toast').allTextContents()).join(' | ');
const m = /Sheet: (\d+) shades, (\d+) cells/.exec(toasts);
check('S: the toast counts the shades in use', !!m && Number(m[1]) === 2, toasts);
check('S: and the cells painted', !!m && Number(m[2]) > 0, m ? m[2] : toasts);

// ---- B. the pixels land where the layout says ----
const drawn = await page.evaluate(async () => {
  const [{ buildSheet, drawSheet }, { Grid }] = await Promise.all([import('/assets/js/game/sheet.js'), import('/assets/js/game/grid.js')]);
  const g = new Grid(10, 10);
  g.paint([0, 1], 7, 1); // two cells of shade 7
  g.paint([2], 9, 2); // one of shade 9
  const sheet = buildSheet([{ w: 10, h: 10, grid: g }], [{ label: 'Test' }], { grid: true });
  const c = document.createElement('canvas');
  c.width = sheet.layout.width;
  c.height = sheet.layout.height;
  drawSheet(c.getContext('2d'), sheet);
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  const px = (x, y) => {
    const i = (Math.round(y) * c.width + Math.round(x)) * 4;
    return [d[i], d[i + 1], d[i + 2]];
  };
  const hex = (s) => [1, 3, 5].map((i) => parseInt(s.slice(i, i + 2), 16));
  const b = sheet.layout.boards[0];
  const cell = sheet.layout.cell;
  return {
    bg: px(2, 2),
    cell00: px(b.x + cell / 2, b.y + cell / 2),
    want7: hex(sheet.shades.find((s) => s.idx === 7).hex),
    cellEmpty: px(b.x + 6.5 * cell, b.y + 6.5 * cell),
    legendSwatch: px(sheet.layout.legend.x + 7, sheet.layout.legend.y + 26 + 7),
    rulerInk: (() => {
      let dark = 0;
      for (let x = b.x; x < b.x + b.w; x += 2) {
        const p = px(x, b.top + 10);
        if (p[0] + p[1] + p[2] < 480) dark++;
      }
      return dark;
    })(),
    shades: sheet.shades.map((s) => `${s.idx}:${s.count}`),
  };
});
const near = (p, want) => Math.abs(p[0] - want[0]) < 12 && Math.abs(p[1] - want[1]) < 12 && Math.abs(p[2] - want[2]) < 12;
check('S: the page is white paper', near(drawn.bg, [255, 255, 255]), drawn.bg.join(','));
check('S: a painted cell lands on the board where the layout puts it', near(drawn.cell00, drawn.want7), `${drawn.cell00} vs ${drawn.want7}`);
check('S: an unpainted cell stays unpainted', near(drawn.cellEmpty, [255, 255, 255]), drawn.cellEmpty.join(','));
check('S: the legend swatch is the shade it names', near(drawn.legendSwatch, drawn.want7), `${drawn.legendSwatch} vs ${drawn.want7}`);
check('S: the ruler has numbers on it', drawn.rulerInk > 3, `${drawn.rulerInk} dark samples along the axis`);
check(
  'S: the legend counts are the board, not the palette',
  JSON.stringify(drawn.shades) === JSON.stringify(['7:2', '9:1']),
  drawn.shades.join(' ')
);

// ---- C. an empty board admits it ----
await page.reload({ waitUntil: 'load' });
await open();
await page.click('#btnSheet');
await page.waitForTimeout(700);
const emptyToast = (await page.locator('#toast .toast').allTextContents()).join(' | ');
check('S: an empty design says nothing is painted', /nothing painted yet/.test(emptyToast), emptyToast);

check('S: no page errors', errors.length === 0, errors.slice(0, 2).join(' | '));

await b.close();
console.log(`\n${pass} passed, ${fail} failed`);
console.log(`sheet file: ${w}x${h}`);
process.exit(fail ? 1 : 0);
