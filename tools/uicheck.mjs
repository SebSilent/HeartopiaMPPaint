// What the shipped page must prove about itself, in a real browser.
// Usage: node tools/uicheck.mjs [base]   (default http://localhost:8099)
import { chromium } from 'playwright';

const BASE = (process.argv[2] || 'http://localhost:8099').replace(/\/$/, '');

// Never measure something we did not start ourselves: port 8080 on this machine
// belongs to an unrelated app that answers on localhost and 127.0.0.1 alike.
const html = await (await fetch(`${BASE}/index.html`)).text();
if (!/id="app"/.test(html) || !/Heartopia/.test(html)) {
  throw new Error(`${BASE}/index.html is not this project`);
}
// GitHub Pages serves under /HeartopiaMPPaint/, so the asset root comes from the
// base URL rather than being assumed to be "/".
const PREFIX = new URL(BASE).pathname.replace(/\/$/, '');

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, hasTouch: true });
const errs = [];
page.on('pageerror', (e) => errs.push('PAGEERROR ' + e));
page.on('console', (m) => m.type() === 'error' && errs.push('CONSOLE ' + m.text()));
await page.goto(`${BASE}/?local=1`, { waitUntil: 'load' });
await page.fill('#nick', 'Probe');
await page.click('#join');
await page.waitForTimeout(1500);

const dock = await page.evaluate(() => {
  const tools = [...document.querySelectorAll('#tools [data-tool]')].map((b) => b.dataset.tool);
  const brushes = [...document.querySelectorAll('#brushes [data-brush]')].map((b) => Number(b.dataset.brush));
  return { tools, brushes };
});

const book = await page.evaluate(async (prefix) => {
  const { FACE_DATA } = await import(`${prefix}/assets/js/data/heartopia-faces.js`);
  const { maskFor, paintable } = await import(`${prefix}/assets/js/game/faces.js`);
  const m = maskFor('book', 'wide');
  return {
    faces: Object.keys(FACE_DATA).length,
    hasRings: !!(FACE_DATA.book && FACE_DATA.book.wide && FACE_DATA.book.wide.rings),
    ringPts: FACE_DATA.book ? FACE_DATA.book.wide.rings.flat().length : 0,
    paintable: paintable('book', 'wide'),
    total: m ? m.length : 0,
    corner: m ? m[0] : -1,
  };
}, PREFIX);

const mesh = await page.evaluate(async (prefix) => {
  const { loadMesh } = await import(`${prefix}/assets/js/game/meshdata.js`);
  const m = await loadMesh('tshirt');
  return m ? { tris: m.tris, faces: m.faces.join('|') } : null;
}, PREFIX);

// The game's guide squares are 5 cells, so the board's major grid must land on
// multiples of 5 - a 10-cell major line is ours, not Heartopia's.
const grid = await page.evaluate(async (prefix) => {
  const src = await (await fetch(`${prefix}/assets/js/view.js`)).text();
  return { step5: /for \(let i = 0; i <= g\.w; i \+= 5\)/.test(src) };
}, PREFIX);

const want = 'brush,eraser,pick,fill,line,rect,ellipse,polygon';
const checks = [
  ['tool row is the eight we ship', dock.tools.join(',') === want, dock.tools.join(',')],
  ['brush ladder is the game blocks', dock.brushes.join(',') === '1,2,5,10,20', dock.brushes.join(',')],
  ['book outline gates painting', book.hasRings && book.corner === 0 && book.paintable < book.total, JSON.stringify(book)],
  ['catalog faces include the book', book.faces >= 22, String(book.faces)],
  ['real garment mesh loads', !!mesh && mesh.tris > 400, JSON.stringify(mesh)],
  ['major grid follows the 5-cell guide', grid.step5, JSON.stringify(grid)],
  ['no page errors', errs.length === 0, errs.join(' | ')],
];
for (const [name, ok, detail] of checks) console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}  ${detail}`);
await page.screenshot({ path: '_shots/ui-final.png' });
await browser.close();
if (checks.some((c) => !c[1])) process.exitCode = 1;
