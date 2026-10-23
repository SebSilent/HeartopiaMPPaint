// The book as a player sees it: one board, the outline drawn, and the 3D panel
// showing a single cover instead of two boards standing apart.
import { chromium } from 'playwright';

const BASE = (process.argv[2] || 'http://localhost:8099').replace(/\/$/, '');
const PREFIX = new URL(BASE).pathname.replace(/\/$/, '');
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, hasTouch: true });
const errs = [];
page.on('pageerror', (e) => errs.push('PAGEERROR ' + e));
page.on('console', (m) => m.type() === 'error' && errs.push('CONSOLE ' + m.text()));

await page.goto(`${BASE}/?room=BOOK1&item=book&renderDelay=0`, { waitUntil: 'load' });
if (await page.locator('#join').isVisible().catch(() => false)) {
  await page.fill('#nick', 'Book');
  await page.click('#join');
}
await page.waitForFunction(() => !document.getElementById('app').classList.contains('locked'), { timeout: 20000 });
await page.waitForFunction(() => document.getElementById('base').width > 300, { timeout: 10000 });

const tabs = await page.$$eval('#faces > *', (els) => els.map((e) => e.textContent.trim().replace(/\s+/g, ' ')));
const facesHtml = await page.evaluate(() => ({
  count: document.getElementById('faces').children.length,
  first: (document.getElementById('faces').children[0] || {}).textContent || '',
}));
const board = await page.evaluate(() => {
  const c = document.getElementById('base');
  return { w: c.width, h: c.height };
});

// Paint across the whole width, including the corners the old outline blocked.
const painted = await page.evaluate(async (prefix) => {
  const { maskFor } = await import(`${prefix}/assets/js/game/faces.js`);
  const m = maskFor('book', 'tall');
  const probes = [
    [0, 0],
    [149, 83],
    [74, 42],
    [65, 0],
    [84, 83],
  ];
  return probes.map(([x, y]) => `${x},${y}=${m[y * 150 + x] ? 'open' : 'BLOCKED'}`);
}, PREFIX);

await page.click('#btn3d');
await page.waitForTimeout(1800);
const d3 = await page.evaluate(() => {
  const c = document.getElementById('d3Canvas');
  const d = c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, c.width, c.height).data;
  let other = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (Math.abs(d[i] - 194) > 2 || Math.abs(d[i + 1] - 204) > 2 || Math.abs(d[i + 2] - 211) > 2) other++;
  }
  return { w: c.width, h: c.height, drawnPx: other };
});
await page.screenshot({ path: '_shots/book.png' });

console.log('board', JSON.stringify(board), 'tabs', JSON.stringify(tabs), 'faces', JSON.stringify(facesHtml));
console.log('corners and centre', painted.join(' '));
console.log('3D', JSON.stringify(d3));
console.log('errors', errs.length ? errs.slice(0, 3) : 'none');
await browser.close();
