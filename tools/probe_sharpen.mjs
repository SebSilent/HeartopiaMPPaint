/**
 * Browser check for the import's Sharpen slider.
 *
 * The filter itself is unit-tested on arrays. What only a page can answer is
 * whether the slider is wired to the thing it claims to control: a control that
 * updates state but not the raster, or the preview but not the commit, is
 * indistinguishable from a working one until someone imports a photo.
 *
 * The image is built in the page as a deliberately soft two-tone block, pulled
 * out as a PNG, and fed through the real file input - so it travels the same
 * decode, fit, rasterise and quantise path as somebody's holiday photo.
 *
 * Run: node tools/probe_sharpen.mjs   (server on 8099)
 */
import { chromium } from 'playwright';

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
const page = await b.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push('console: ' + m.text());
});

await page.goto(`${BASE}/?local=1&renderDelay=0`, { waitUntil: 'load' });
await page.waitForFunction(() => !document.getElementById('app').classList.contains('locked'), { timeout: 20000 });
await page.waitForFunction(() => document.getElementById('base').width > 300, { timeout: 10000 });

await page.click('#btnImport');
const slider = page.locator('#importControls [data-ctl="sharpness"]');
check('S: the slider is in the panel', (await slider.count()) === 1);
const label = await page.evaluate(() => {
  const el = document.querySelector('#importControls [data-ctl="sharpness"]');
  return el?.closest('label')?.textContent.replace(/\s+/g, ' ').trim();
});
check('S: and it is labelled in plain words', /Sharpen/i.test(label || ''), label);

// A soft edge, made by blurring a hard one. The first version of this used a
// linear gradient and the slider appeared dead - because an unsharp mask is a
// second-derivative operator and a linear ramp has no second derivative, so
// "sharpen this" is provably a no-op on it. Whatever else this probe checks, it
// has to feed the filter something it can act on.
const png = await page.evaluate(() => {
  const src = document.createElement('canvas');
  src.width = 240;
  src.height = 160;
  const s = src.getContext('2d');
  s.fillStyle = '#101820';
  s.fillRect(0, 0, 120, 160);
  s.fillStyle = '#e8e0d0';
  s.fillRect(120, 0, 120, 160);
  const c = document.createElement('canvas');
  c.width = 240;
  c.height = 160;
  const x = c.getContext('2d');
  x.filter = 'blur(4px)';
  x.drawImage(src, 0, 0);
  return c.toDataURL('image/png');
});
// A bare Buffer is not a file to Playwright - it needs the name and type too,
// because the app branches on the mime type the way it does for a real drop.
await page.setInputFiles('#file', [
  { name: 'soft.png', mimeType: 'image/png', buffer: Buffer.from(png.split(',')[1], 'base64') },
]);
await page.waitForSelector('#importPrev canvas', { timeout: 15000 });
await page.waitForTimeout(700);

/**
 * Read the preview as what it is: one pixel per cell, so this is the board.
 *
 * The measurement is the width of the transition, in cells, between the dark
 * plateau and the light one - how many columns sit between 10% and 90% of the
 * range. That is what "soft" means on a board, and it is the thing a sharpen
 * slider is supposed to move. Counting colours or hard steps was tried first and
 * both were too blunt to see a few cells change hands.
 */
const read = (fixed = null) =>
  page.evaluate(
    (fixed) => {
      const c = document.querySelector('#importPrev canvas');
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      const lum = (x, y) => {
        const i = (y * c.width + x) * 4;
        return (d[i] + d[i + 1] + d[i + 2]) / 3;
      };
      let lo = 255;
      let hi = 0;
      let sum = 0;
      for (let i = 0; i < d.length; i += 4) {
        const v = (d[i] + d[i + 1] + d[i + 2]) / 3;
        sum += v;
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      // The band comes from the FIRST frame and is then reused for every later
      // one. Measuring each frame against its own range is self-defeating here:
      // sharpening pushes pixels past both ends, which widens the range, which
      // widens the 10-90% band, which makes a sharpened edge measure as a
      // *blurred* one. That is exactly what this probe reported before the band
      // was pinned.
      const ref = fixed || { lo, hi };
      const a = ref.lo + (ref.hi - ref.lo) * 0.1;
      const b = ref.lo + (ref.hi - ref.lo) * 0.9;
      let width = 0;
      let rows = 0;
      for (let y = 0; y < c.height; y++) {
        let first = -1;
        let last = -1;
        for (let x = 0; x < c.width; x++) {
          const v = lum(x, y);
          if (v >= a && v <= b) {
            if (first < 0) first = x;
            last = x;
          }
        }
        if (first >= 0) {
          width += last - first + 1;
          rows++;
        }
      }
      const kinds = new Set();
      for (let i = 0; i < d.length; i += 4) kinds.add(`${d[i]},${d[i + 1]},${d[i + 2]}`);
      return {
        mean: sum / (c.width * c.height),
        colours: kinds.size,
        edge: rows ? width / rows : 0,
        range: { lo, hi },
        w: c.width,
        h: c.height,
      };
    },
    fixed
  );

const soft = await read();
check('S: the preview rendered', soft.w > 0 && soft.h > 0, `${soft.w}x${soft.h}, ${soft.colours} colours`);
check('S: and it really is soft to begin with', soft.edge >= 2, `${soft.edge.toFixed(2)} cells of transition`);

// A control: another slider, known to work, measured the same way. Without this
// a flat "nothing changed" could mean the probe is blind rather than the feature
// dead - which is exactly the mistake the first version of this file made.
const bright = page.locator('#importControls [data-ctl="brightness"]');
await bright.fill('60');
await bright.dispatchEvent('input');
await page.waitForTimeout(800);
const lifted = await read(soft.range);
check('S: the probe can see a slider take effect', Math.abs(lifted.mean - soft.mean) > 1, `${soft.mean.toFixed(1)} -> ${lifted.mean.toFixed(1)}`);
await bright.fill('0');
await bright.dispatchEvent('input');
await page.waitForTimeout(800);
check('S: and put it back', Math.abs((await read()).mean - soft.mean) < 0.5);

await slider.fill('100');
await slider.dispatchEvent('input');
await page.waitForTimeout(800);
const crisp = await read(soft.range);

check('S: the slider holds its value', (await slider.inputValue()) === '100', await slider.inputValue());
check(
  'S: and it reaches the board - the transition narrowed',
  crisp.edge < soft.edge - 0.4,
  `${soft.edge.toFixed(2)} -> ${crisp.edge.toFixed(2)} cells`
);
check(
  'S: overshoot did not invent colours by accident (mean held)',
  Math.abs(crisp.mean - soft.mean) < 6,
  `${soft.mean.toFixed(1)} -> ${crisp.mean.toFixed(1)}`
);

// Back to 0 has to undo it: a slider that only ever sharpens is a broken slider.
await slider.fill('0');
await slider.dispatchEvent('input');
await page.waitForTimeout(800);
const back = await read(soft.range);
check('S: turning it off gives the soft import back', Math.abs(back.edge - soft.edge) < 0.01, `${soft.edge.toFixed(2)} vs ${back.edge.toFixed(2)}`);
check('S: and the mean brightness did not drift', Math.abs(back.mean - soft.mean) < 0.5, `${soft.mean.toFixed(2)} -> ${back.mean.toFixed(2)}`);

check('S: no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));

await b.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
