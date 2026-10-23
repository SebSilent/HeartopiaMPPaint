// Are there holes in the rendered garment? Not "does it look OK": count the
// background pixels that are TRAPPED inside the shape. A legitimately open neck
// or hem connects to the outside, so it does not count; a slit down a seam or a
// patch of missing surface is an island of background, and that is the defect.
//
// Usage: node tools/meshholes.mjs [base] [item]
import { chromium } from 'playwright';

const BASE = (process.argv[2] || 'http://localhost:8099').replace(/\/$/, '');
const ITEM = process.argv[3] || 'tshirt';
const PREFIX = new URL(BASE).pathname.replace(/\/$/, '');

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, hasTouch: true });
page.on('pageerror', (e) => console.log('PAGEERROR ' + e));
await page.goto(`${BASE}/?room=HOLES&item=${ITEM}&renderDelay=0`, { waitUntil: 'load' });
if (await page.locator('#join').isVisible().catch(() => false)) {
  await page.fill('#nick', 'Holes');
  await page.click('#join');
}
await page.waitForFunction(() => !document.getElementById('app').classList.contains('locked'), { timeout: 20000 });
// The board has to have a real box before the preview will size itself to it.
await page.waitForFunction(() => document.getElementById('base').width > 300, { timeout: 10000 });
await page.click('#btn3d');
await page.waitForFunction(() => document.getElementById('d3Canvas').width > 200, { timeout: 10000 });
await page.waitForTimeout(1500);

const BG = [194, 204, 211]; // #c2ccd3, the preview backdrop

/**
 * Flood fill the backdrop from the canvas border. Whatever backdrop is left
 * unreachable is enclosed by the garment, which can only mean a hole in it.
 */
const measure = async () =>
  page.evaluate(
    async ([r, g, b]) => {
      const c = document.getElementById('d3Canvas');
      const ctx = c.getContext('2d', { willReadFrequently: true });
      const img = ctx.getImageData(0, 0, c.width, c.height);
      const d = img.data;
      const W = c.width;
      const H = c.height;
      // Tolerance has to be near zero. The backdrop is a flat fill, so it is
      // exactly this triple, but a shaded crease on the garment measures about
      // 172-190 - inside a 12-wide window around 194,204,211. At 12 the metric
      // was counting the garment's own shadow bands as trapped background, which
      // is why three different real fixes moved the number by nothing.
      const near = (i) => Math.abs(d[i] - r) <= 2 && Math.abs(d[i + 1] - g) <= 2 && Math.abs(d[i + 2] - b) <= 2;
      const seen = new Uint8Array(W * H);
      const stack = [];
      for (let x = 0; x < W; x++) {
        stack.push(x, (H - 1) * W + x);
      }
      for (let y = 0; y < H; y++) {
        stack.push(y * W, y * W + W - 1);
      }
      for (const p of stack) if (near(p * 4)) seen[p] = 1;
      const live = stack.filter((p) => seen[p]);
      while (live.length) {
        const p = live.pop();
        const x = p % W;
        const y = (p / W) | 0;
        for (const q of [x > 0 ? p - 1 : -1, x < W - 1 ? p + 1 : -1, y > 0 ? p - W : -1, y < H - 1 ? p + W : -1]) {
          if (q < 0 || seen[q] || !near(q * 4)) continue;
          seen[q] = 1;
          live.push(q);
        }
      }
      let trapped = 0;
      let garment = 0;
      for (let p = 0; p < W * H; p++) {
        if (near(p * 4)) {
          if (!seen[p]) trapped++;
        } else garment++;
      }
      // Guard against measuring an empty canvas. The first run of this probe
      // reported "0 holes" on a 300x150 preview that had never been sized, which
      // is a pass for the wrong reason: an unsized canvas is transparent black,
      // matches no backdrop pixel, and so looks like a perfect garment.
      // Structure of the trapped pixels: many pinpoints is one diagnosis, a few
      // large islands is another. Without this the fix is guesswork.
      const trappedMask = new Uint8Array(W * H);
      for (let p = 0; p < W * H; p++) if (near(p * 4) && !seen[p]) trappedMask[p] = 1;
      const comps = [];
      const marks = new Uint8Array(W * H);
      for (let p = 0; p < W * H; p++) {
        if (!trappedMask[p] || marks[p]) continue;
        const stack = [p];
        marks[p] = 1;
        let n = 0;
        let sx = 0;
        let sy = 0;
        while (stack.length) {
          const c = stack.pop();
          n++;
          sx += c % W;
          sy += (c / W) | 0;
          const cx = c % W;
          for (const d2 of [
            cx > 0 ? c - 1 : -1,
            cx < W - 1 ? c + 1 : -1,
            c - W,
            c + W,
          ]) if (d2 >= 0 && d2 < W * H && trappedMask[d2] && !marks[d2]) (marks[d2] = 1), stack.push(d2);
        }
        comps.push({ n, x: Math.round(sx / n), y: Math.round(sy / n) });
      }
      comps.sort((a, b) => b.n - a.n);
      let border = 0;
      let borderOk = 0;
      for (let x = 0; x < W; x++) {
        for (const y of [0, H - 1]) {
          border++;
          if (near((y * W + x) * 4)) borderOk++;
        }
      }
      // "Trapped backdrop" alone is not a hole. The armpit, the gap between two
      // legs and the inside of a neck opening all legitimately enclose background
      // in a flat 2D projection of a 3D shape. A pinhole is a SMALL island; an
      // anatomy gap is a big one. Splitting them is the difference between
      // chasing a defect and chasing the garment's own shape.
      const small = comps.filter((c) => c.n <= 60);
      const big = comps.filter((c) => c.n > 60);
      // A picture of the classification, one character per 4x4 block: '.' open
      // backdrop, 'o' trapped, '#' not backdrop. Where the o's sit is the whole
      // diagnosis - inside the shape means the mesh is missing cloth, ringing it
      // means the panel's own shading is being miscounted as holes.
      const rows = [];
      for (let y = 0; y < H; y += 4) {
        let s = '';
        for (let x = 0; x < W; x += 4) {
          let g = 0;
          let o = 0;
          for (let dy = 0; dy < 4 && y + dy < H; dy++)
            for (let dx = 0; dx < 4 && x + dx < W; dx++) {
              const p = (y + dy) * W + (x + dx);
              if (!near(p * 4)) g++;
              else if (!seen[p]) o++;
            }
          s += g > 8 ? '#' : o > 0 ? 'o' : '.';
        }
        rows.push(s);
      }
      return {
        trapped,
        garment,
        w: W,
        h: H,
        map: rows.join('\n'),
        borderFrac: borderOk / border,
        islands: comps.length,
        pinhole: small.reduce((s, c) => s + c.n, 0),
        cavity: big.reduce((s, c) => s + c.n, 0),
        worst: comps.length ? comps[0].n : 0,
        at: comps.slice(0, 3).map((c) => `${c.x},${c.y}:${c.n}`),
      };
    },
    BG
  );

const angles = [];
for (let i = 0; i < 6; i++) {
  const m = await measure();
  if (m.borderFrac < 0.8) throw new Error(`preview is not showing the backdrop (${(m.borderFrac * 100).toFixed(0)}% of the border): the canvas is empty or unsized, so any hole count here would be meaningless`);
  if (m.garment < 2000) throw new Error(`only ${m.garment} non-backdrop pixels: nothing was rendered`);
  angles.push(m);
  // Orbit by dragging on the preview, so the angles are the ones a player sees.
  const box = await page.locator('#d3Canvas').boundingBox();
  if (!box) break;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 26 + i * 8, cy + 6);
  await page.mouse.up();
  await page.waitForTimeout(700);
}

const sum = (k) => angles.reduce((s, a) => s + a[k], 0);
const max = (k) => angles.reduce((s, a) => Math.max(s, a[k]), 0);
console.log(`item ${ITEM}  canvas ${angles[0]?.w}x${angles[0]?.h}  garment px ~${angles[0]?.garment}`);
console.log(`pinhole px per angle (islands of 60px or less): ${angles.map((a) => a.pinhole).join(' ')}   total ${sum('pinhole')}`);
console.log(`cavity px  (large enclosed gaps, expected shape):  ${angles.map((a) => a.cavity).join(' ')}   total ${sum('cavity')}`);
console.log(`island counts: ${angles.map((a) => a.islands).join(' ')}   worst single island ${max('worst')}px`);
console.log(`first angles' islands: ${JSON.stringify(angles[0]?.at)} / ${JSON.stringify(angles[3]?.at)}`);
// The angle with the most trapped pixels, drawn.
const worstAngle = angles.reduce((a, b) => (b.trapped > a.trapped ? b : a), angles[0]);
console.log(`\nmap at the worst angle (${worstAngle.trapped} trapped px):\n${worstAngle.map}`);
await page.screenshot({ path: `_shots/holes-${ITEM}.png` });
await browser.close();
