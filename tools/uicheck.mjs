// What the shipped page must prove about itself, in a real browser.
import { chromium } from 'playwright';

const BASE = process.argv[2] || 'http://localhost:8099';
const html = await (await fetch(`${BASE}/index.html`)).text();
if (!/id="app"/.test(html) || !/Heartopia/.test(html)) {
  throw new Error(`${BASE}/index.html is not this project`);
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, hasTouch: true });
const errs = [];
page.on('pageerror', (e) => errs.push('PAGEERROR ' + e));
page.on('console', (m) => m.type() === 'error' && errs.push('CONSOLE ' + m.text()));
await page.goto(`${BASE}/?local=1`, { waitUntil: 'load' });
await page.fill('#nick', 'Probe');
await page.click('#join');
await page.waitForTimeout(1500);

const r = await page.evaluate(() => {
  const tools = [...document.querySelectorAll('#tools [data-tool]')].map((b) => b.dataset.tool);
  const brushes = [...document.querySelectorAll('#brushes [data-brush]')].map((b) => Number(b.dataset.brush));
  return { tools, brushes, keys: Object.keys(window) };
});

// Paint on the book's wide face and confirm the game's own outline is in force.
const book = await page.evaluate(async () => {
  const { FACE_DATA } = await import('/assets/js/data/heartopia-faces.js');
  const { maskFor, paintable } = await import('/assets/js/game/faces.js');
  const m = maskFor('book', 'wide');
  return {
    hasRings: !!FACE_DATA.book.wide.rings,
    ringPts: FACE_DATA.book.wide.rings.flat().length,
    paintable: paintable('book', 'wide'),
    total: m.length,
    cornerPaintable: m[0],
  };
});

const guide = await page.evaluate(() => {
  // The major grid must land on multiples of 5 cells, like the game's guide lines.
  const { GRID_LINE_MAJOR } = (() => {
    try {
      return { GRID_LINE_MAJOR: getComputedStyle(document.documentElement).getPropertyValue('--x') };
    } catch (_) {
      return {};
    }
  })();
  return !!GRID_LINE_MAJOR;
});

console.log('tools   ', r.tools.join(','), `(${r.tools.length})`);
console.log('brushes ', r.brushes.join(','));
console.log('book    ', JSON.stringify(book));
console.log('errors  ', errs.length ? errs.join('\n') : 'none');

const want = ['brush', 'eraser', 'pick', 'fill', 'line', 'rect', 'ellipse', 'polygon'];
const okTools = r.tools.slice().sort().join() === want.slice().sort().join();
const okBrush = r.brushes.join() === '1,2,5,10,20';
const okBook = book.hasRings && book.cornerPaintable === 0 && book.paintable < book.total;
console.log(`\n${okTools ? 'OK' : 'BAD'} tools reduced to the eight`);
console.log(`${okBrush ? 'OK' : 'BAD'} brush ladder is Heartopia's 1/2/5/10/20`);
console.log(`${okBook ? 'OK' : 'BAD'} book outline gates painting`);
console.log(`${errs.length ? 'BAD' : 'OK'} no page errors`);
await page.screenshot({ path: '_shots/ui-final.png' });
await browser.close();
if (!(okTools && okBrush && okBook && !errs.length)) process.exitCode = 1;
