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
// The gate closes on its own under ?local=1; wait for the tool row, not the
// button, or this races the timer that hides it.
if (await page.locator('#join').isVisible().catch(() => false)) {
  await page.fill('#nick', 'Probe');
  await page.click('#join');
}
await page.waitForFunction(() => document.querySelectorAll('#tools [data-tool]').length >= 8, null, { timeout: 15000 });

const dock = await page.evaluate(() => {
  const tools = [...document.querySelectorAll('#tools [data-tool]')].map((b) => b.dataset.tool);
  const brushes = [...document.querySelectorAll('#brushes [data-brush]')].map((b) => Number(b.dataset.brush));
  return { tools, brushes };
});

const book = await page.evaluate(async (prefix) => {
  const { FACE_DATA } = await import(`${prefix}/assets/js/data/heartopia-faces.js`);
  const { maskFor, paintable } = await import(`${prefix}/assets/js/game/faces.js`);
  const m = maskFor('book', 'tall');
  const b = FACE_DATA.book || {};
  // The spine is the middle band of the cover. Counting what is paintable inside
  // it is the only way to check it is eighteen cells wide and centred without
  // eyeballing a picture: 18 x 84 = 1,512.
  let spine = 0;
  for (let y = 0; y < 84; y++) for (let x = 66; x < 84; x++) if (m && m[y * 150 + x]) spine++;
  return {
    faces: Object.keys(FACE_DATA).length,
    bookFaces: Object.keys(b),
    hasRings: !!(b.tall && b.tall.rings),
    ringPts: b.tall ? b.tall.rings.flat().length : 0,
    paintable: paintable('book', 'tall'),
    total: m ? m.length : 0,
    corner: m ? m[0] : -1,
    spine,
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
  // The book's outline is three panels tiling the board, not a mask that blocks
  // painting: the game's own disabledPixels list for the book is empty, so every
  // cell on it is paintable and the corners must be too. This check used to
  // demand the opposite (corner blocked, paintable < total), which is the bug.
  ['book has one board, the 16:9', book.bookFaces.join(',') === 'tall', JSON.stringify(book.bookFaces)],
  ['book whole board paints', book.hasRings && book.corner === 1 && book.paintable === book.total, JSON.stringify(book)],
  ['book spine is 18 wide and centred', book.spine === 18 * 84, `spine cells ${book.spine} of ${18 * 84}`],
  ['catalog faces include the book', book.faces >= 22, String(book.faces)],
  ['real garment mesh loads', !!mesh && mesh.tris > 400, JSON.stringify(mesh)],
  ['major grid follows the 5-cell guide', grid.step5, JSON.stringify(grid)],
  ['no page errors', errs.length === 0, errs.join(' | ')],
];
for (const [name, ok, detail] of checks) console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}  ${detail}`);
await page.screenshot({ path: '_shots/ui-final.png' });
await browser.close();
if (checks.some((c) => !c[1])) process.exitCode = 1;
