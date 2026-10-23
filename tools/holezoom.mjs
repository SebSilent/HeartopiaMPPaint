// What is a "hole", pixel by pixel, in the live panel? Print a window around the
// biggest trapped island and classify every pixel by colour, so the answer is
// visible instead of inferred:
//   .  backdrop  #c2ccd3
//   o  backdrop, trapped by the flood fill
//   g  garment (light)   G  garment (shaded)
//   s  something else entirely - a shadow, an outline, a tint
// If the o's sit inside a ring of s, the "hole" is a shadow on the background and
// the mesh was never the problem.
import { chromium } from 'playwright';

const BASE = (process.argv[2] || 'http://localhost:8099').replace(/\/$/, '');
const DRAG = Number(process.argv[3] ?? 3);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, hasTouch: true });
page.on('pageerror', (e) => console.log('PAGEERROR ' + e));
await page.goto(`${BASE}/?local=1&item=tshirt`, { waitUntil: 'load' });
await page.waitForFunction(() => document.querySelectorAll('#tools [data-tool]').length >= 8, null, { timeout: 20000 });
await page.waitForFunction(() => document.getElementById('base').width > 300, { timeout: 10000 });
await page.click('#btn3d');
await page.waitForFunction(() => document.getElementById('d3Canvas').width > 200, { timeout: 10000 });
await page.waitForTimeout(1500);

const box = await page.locator('#d3Canvas').boundingBox();
const cx = box.x + box.width / 2;
const cy = box.y + box.height / 2;
for (let i = 0; i < DRAG; i++) {
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 26 + i * 8, cy + 6);
  await page.mouse.up();
  await page.waitForTimeout(700);
}

const out = await page.evaluate(() => {
  const c = document.getElementById('d3Canvas');
  const d = c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, c.width, c.height).data;
  const W = c.width;
  const H = c.height;
  const bg = [194, 204, 211];
  const near = (i) => Math.abs(d[i] - bg[0]) < 12 && Math.abs(d[i + 1] - bg[1]) < 12 && Math.abs(d[i + 2] - bg[2]) < 12;
  const seen = new Uint8Array(W * H);
  const live = [];
  for (let x = 0; x < W; x++) for (const y of [0, H - 1]) if (near((y * W + x) * 4) && !seen[y * W + x]) (seen[y * W + x] = 1), live.push(y * W + x);
  // The index into the pixel data, not into the pixel: passing y*W+x here made
  // near() read the wrong byte, seed from arbitrary pixels, and report that no
  // backdrop was trapped at all.
  for (let y = 0; y < H; y++) for (const x of [0, W - 1]) if (near((y * W + x) * 4) && !seen[y * W + x]) (seen[y * W + x] = 1), live.push(y * W + x);
  while (live.length) {
    const p = live.pop();
    const x = p % W;
    for (const q of [x > 0 ? p - 1 : -1, x < W - 1 ? p + 1 : -1, p - W, p + W])
      if (q >= 0 && q < W * H && !seen[q] && near(q * 4)) (seen[q] = 1), live.push(q);
  }
  // Biggest trapped island, and its neighbourhood.
  const marks = new Uint8Array(W * H);
  let best = null;
  for (let p = 0; p < W * H; p++) {
    if (!near(p * 4) || seen[p] || marks[p]) continue;
    const stack = [p];
    marks[p] = 1;
    const cells = [];
    while (stack.length) {
      const q = stack.pop();
      cells.push(q);
      const x = q % W;
      for (const r of [x > 0 ? q - 1 : -1, x < W - 1 ? q + 1 : -1, q - W, q + W])
        if (r >= 0 && r < W * H && near(r * 4) && !seen[r] && !marks[r]) (marks[r] = 1), stack.push(r);
    }
    if (!best || cells.length > best.cells.length) best = { cells };
  }
  // Report what was actually on the canvas. A blank or transparent canvas has no
  // backdrop pixels at all, so "no trapped pixels" from one is a false pass, not
  // a result - which is how the first version of this probe was wrong.
  let bgPx = 0;
  let otherPx = 0;
  let borderOk = 0;
  let borderN = 0;
  for (let x = 0; x < W; x++) for (const y of [0, H - 1]) (borderN++, near((y * W + x) * 4) && borderOk++);
  for (let p = 0; p < W * H; p++) near(p * 4) ? bgPx++ : otherPx++;
  if (!best) return { none: true, bgPx, otherPx, borderFrac: borderOk / borderN, canvas: [W, H] };
  const xs = best.cells.map((p) => p % W);
  const ys = best.cells.map((p) => (p / W) | 0);
  const mx = Math.round((Math.min(...xs) + Math.max(...xs)) / 2);
  const my = Math.round((Math.min(...ys) + Math.max(...ys)) / 2);
  const rows = [];
  for (let y = my - 12; y <= my + 12; y++) {
    let s = '';
    for (let x = mx - 22; x <= mx + 22; x++) {
      if (x < 0 || y < 0 || x >= W || y >= H) {
        s += ' ';
        continue;
      }
      const i = (y * W + x) * 4;
      const lum = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) | 0;
      s += near(i) ? (seen[y * W + x] ? '.' : 'o') : lum > 200 ? 'g' : lum > 120 ? 'G' : 's';
    }
    rows.push(s);
  }
  // The colours ringing the island, which is the part that decides the diagnosis.
  const ring = [];
  for (const p of best.cells.slice(0, 6)) {
    for (const [dx, dy] of [[0, -13], [0, 13], [-23, 0], [23, 0]]) {
      const q = ((p / W) | 0) + dy;
      const x2 = (p % W) + dx;
      if (q < 0 || q >= H || x2 < 0 || x2 >= W) continue;
      const i = (q * W + x2) * 4;
      ring.push([d[i], d[i + 1], d[i + 2]]);
    }
  }
  return { size: best.cells.length, at: [mx, my], rows, ring, canvas: [W, H] };
});

if (out.none)
  console.log(
    `no trapped pixels; canvas ${out.canvas}, backdrop ${out.bgPx}px, other ${out.otherPx}px, border backdrop ${(out.borderFrac * 100).toFixed(0)}%${out.borderFrac < 0.5 ? '  <-- nothing rendered, this is not a pass' : ''}`
  );
else {
  console.log(`island of ${out.size} px at ${out.at}, canvas ${out.canvas}`);
  console.log(out.rows.join('\n'));
  console.log(`colours just outside it: ${JSON.stringify(out.ring.slice(0, 8))}`);
}
await browser.close();
