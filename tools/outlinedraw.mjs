// Does the traced outline actually get drawn in a browser, and drawn where the
// paintable cells are?
//
// The node-side check proves the data agrees. This proves the page loads trace.js,
// strokes it, and puts the ink on the cell edges. To find the ink without knowing
// the board's pixel mapping, the outline is toggled off and on and the two frames
// are diffed: whatever changed *is* the outline. Its shape is then compared against
// the extent of the paintable cells, which is the thing the old outline got wrong.
import { chromium } from 'playwright';

const BASE = process.argv[2] || 'http://localhost:8080';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push('console ' + m.text());
});

async function openRoom(item) {
  await page.goto(`${BASE}/?room=OT${item.slice(0, 3).toUpperCase()}&item=${item}&renderDelay=0`, { waitUntil: 'load' });
  // The board only lays out once the room is joined; before that the canvas is an
  // unsized 300x150 and every pixel read is a false negative.
  if (await page.locator('#join').isVisible().catch(() => false)) {
    await page.fill('#nick', 'Outline');
    await page.click('#join');
  }
  await page.waitForFunction(() => !document.getElementById('app').classList.contains('locked'), { timeout: 20000 });
  await page.waitForFunction(() => document.getElementById('base').width > 300, { timeout: 20000 });
  await page.waitForTimeout(1000);
}

async function grabBase() {
  return page.evaluate(() => {
    const c = document.getElementById('base');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height);
    return { w: c.width, h: c.height, data: Array.from(d.data) };
  });
}

for (const item of ['trousers', 'shoes', 'tshirt', 'chair', 'book']) {
  await openRoom(item);
  const withOutline = await grabBase();
  // The dock button can sit outside the viewport at this size, and Playwright
  // refuses to click an invisible element, so the toggle is fired directly.
  const toggle = () => page.evaluate(() => document.getElementById('outlineBtn').click());
  await toggle();
  await page.waitForTimeout(500);
  const without = await grabBase();
  await toggle();
  await page.waitForTimeout(300);

  // Diff the two frames: the changed pixels are the outline.
  let n = 0;
  let minX = 1e9;
  let maxX = -1e9;
  let minY = 1e9;
  let maxY = -1e9;
  for (let i = 0; i < withOutline.data.length; i += 4) {
    const same =
      withOutline.data[i] === without.data[i] &&
      withOutline.data[i + 1] === without.data[i + 1] &&
      withOutline.data[i + 2] === without.data[i + 2] &&
      withOutline.data[i + 3] === without.data[i + 3];
    if (same) continue;
    n++;
    const p = i / 4;
    const x = p % withOutline.w;
    const y = (p / withOutline.w) | 0;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }

  const facts = await page.evaluate(async (item) => {
    const { boardOutline } = await import('/assets/js/game/outline.js');
    const { faceInfo, maskFor } = await import('/assets/js/game/faces.js');
    const { CATALOG } = await import('/assets/js/game/slots.js');
    const entry = Object.values(CATALOG).flat().find((i) => i.id === item);
    const faceId = entry.faces[0].id;
    const o = boardOutline(item, faceId);
    const info = faceInfo(item, faceId);
    const mask = maskFor(item, faceId);
    let a = 1e9;
    let b = -1e9;
    let c = 1e9;
    let e = -1e9;
    for (let y = 0; y < info.h; y++) {
      for (let x = 0; x < info.w; x++) {
        if (mask[y * info.w + x] !== 1) continue;
        if (x < a) a = x;
        if (x > b) b = x;
        if (y < c) c = y;
        if (y > e) e = y;
      }
    }
    return {
      face: faceId,
      rings: o && o.rings ? o.rings.length : 0,
      pts: o && o.rings ? o.rings.reduce((s, r) => s + r.length, 0) : 0,
      // The traced boundary sits on cell corners, so it spans one cell wider than
      // the cells themselves in each direction.
      cellAspect: (b - a + 2) / (e - c + 2),
      board: [info.w, info.h],
    };
  }, item);

  const inkAspect = n ? (maxX - minX + 1) / (maxY - minY + 1) : 0;
  const drift = n ? Math.abs(inkAspect - facts.cellAspect) / facts.cellAspect : 0;
  console.log(
    item.padEnd(10),
    `${facts.face.padEnd(6)} rings ${facts.rings} pts ${String(facts.pts).padStart(3)} | ink px ${String(n).padStart(6)}`,
    `| box ${n ? `${minX},${minY}..${maxX},${maxY}` : 'none'}`,
    `| aspect ink ${inkAspect.toFixed(3)} vs cells ${facts.cellAspect.toFixed(3)} drift ${(drift * 100).toFixed(1)}%`,
    drift < 0.06 && n > 200 ? 'OK' : 'CHECK'
  );
  await page.screenshot({ path: `_research/outline-${item}.png` });
}
console.log('page errors:', errors.length ? errors.join(' | ') : 'none');
await browser.close();
