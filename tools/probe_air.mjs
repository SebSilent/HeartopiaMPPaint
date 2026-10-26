/**
 * Browser check for the airbrush. The unit tests pin the ramp cell by cell;
 * this proves the thing a player would actually notice - that a real drag on a
 * real canvas comes out as several tones of the chosen colour and nothing else,
 * that the spray next door still comes out as one, and that one undo takes the
 * whole stroke away.
 *
 * Run: node tools/probe_air.mjs   (server on 8099)
 */
import { chromium } from 'playwright';
import { fadeShade, FADE_STEPS } from '../assets/js/color/science.js';
import { FLAT_COLORS } from '../assets/js/data/heartopia-palette.js';

const BASE = process.env.BASE || 'http://localhost:8099';
const AIM = 16; // #e95e2b, a saturated orange with somewhere to fade to
const ROW = [];
for (let k = 0; k <= FADE_STEPS; k++) ROW.push(FLAT_COLORS[fadeShade(AIM, k)]);

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`PASS ${name}${detail ? ' - ' + detail : ''}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? ' ' + detail : ''}`); }
}

const b = await chromium.launch();
const page = await b.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

await page.goto(`${BASE}/?local=1&renderDelay=0`, { waitUntil: 'load' });
await page.waitForFunction(() => !document.getElementById('app').classList.contains('locked'), { timeout: 20000 });
await page.waitForFunction(() => document.getElementById('base').width > 300, { timeout: 10000 });

/**
 * Histogram of the colours the board is *made of*. A canvas scaled to a
 * non-integer cell size blends every cell edge into a colour that exists on no
 * palette, and those blends swamped the real tones - so only pixels whose four
 * neighbours match them are counted. A blend is by definition between two
 * things, so it never survives this; a cell interior always does.
 */
const hist = () =>
  page.evaluate(() => {
    const cv = document.getElementById('base');
    const ctx = cv.getContext('2d');
    const { width: w, height: h } = cv;
    const d = ctx.getImageData(0, 0, w, h).data;
    const eq = (a, b) => d[a] === d[b] && d[a + 1] === d[b + 1] && d[a + 2] === d[b + 2] && d[a + 3] === d[b + 3];
    const out = {};
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = (y * w + x) * 4;
        if (d[i + 3] < 200) continue;
        if (!eq(i, i + 4) || !eq(i, i - 4) || !eq(i, i + w * 4) || !eq(i, i - w * 4)) continue;
        const hex = '#' + [d[i], d[i + 1], d[i + 2]].map((v) => v.toString(16).padStart(2, '0')).join('');
        out[hex] = (out[hex] || 0) + 1;
      }
    }
    return out;
  });

/** Click a swatch, walking palette groups until it is showing. */
async function pickShade(idx) {
  for (let g = 0; g < 13; g++) {
    await page.click(`#groups [data-group="${g}"]`);
    await page.waitForTimeout(40);
    const el = await page.$(`#swatches [data-idx="${idx}"]`);
    if (el) {
      await el.click();
      await page.waitForTimeout(60);
      return await page.evaluate((i) =>
        [...document.querySelectorAll('#swatches .swatch.active')].map((e) => e.dataset.idx).join(',') === String(i), idx);
    }
  }
  return false;
}

const shapeChips = () =>
  page.evaluate(() =>
    [...document.querySelectorAll('#toolOpts [data-shape]')].map((el) => ({
      v: el.dataset.shape,
      label: el.textContent.trim(),
      active: el.classList.contains('active'),
      title: el.title,
    }))
  );

// --- The control exists and behaves. ---
await page.click('button[data-tool="brush"]');
await page.waitForTimeout(150);
const chips = await shapeChips();
check('A1: the Shape row offers four shapes', chips.length === 4, chips.map((c) => c.v).join(','));
check('A2: Airbrush is one of them', chips.some((c) => c.v === 'air' && /air/i.test(c.label)),
  JSON.stringify(chips.find((c) => c.v === 'air') || null));

await page.click('#toolOpts [data-shape="air"]');
await page.waitForTimeout(150);
let live = (await shapeChips()).filter((c) => c.active).map((c) => c.v);
check('A3: clicking Airbrush presses it', live.join(',') === 'air', live.join(','));

const dens = await page.evaluate(() =>
  [...document.querySelectorAll('#toolOpts [data-density]')].map((e) => e.dataset.density));
check('A4: Airbrush shows the Density row (it shares the scatter)', dens.length === 3, dens.join(','));

// A second shape must not leave the airbrush pressed.
await page.click('#toolOpts [data-shape="spray"]');
await page.waitForTimeout(120);
live = (await shapeChips()).filter((c) => c.active).map((c) => c.v);
check('A5: the shapes stay mutually exclusive', live.join(',') === 'spray', live.join(','));

// --- Paint with the airbrush. ---
await page.click('#toolOpts [data-shape="air"]');
await page.click('button[data-brush="5"]');
await page.click('#toolOpts [data-density="0.5"]');
await page.waitForTimeout(150);
check('A6: shade 16 selectable', await pickShade(AIM), FLAT_COLORS[AIM]);

const box = await page.locator('#base').boundingBox();
/** Drag a stroke and report which colours appeared, plus the board before it. */
const drag = async () => {
  const before = await hist();
  await page.mouse.move(box.x + box.width * 0.34, box.y + box.height * 0.5);
  await page.mouse.down();
  for (let k = 1; k <= 14; k++) {
    await page.mouse.move(box.x + box.width * (0.34 + k * 0.012), box.y + box.height * 0.5);
    await page.waitForTimeout(22);
  }
  await page.mouse.up();
  await page.waitForTimeout(260);
  const after = await hist();
  const fresh = {};
  for (const [hex, n] of Object.entries(after)) if (n > (before[hex] || 0)) fresh[hex] = n - (before[hex] || 0);
  return { fresh, before };
};

const { fresh: air, before: airBase } = await drag();
const airHexes = Object.keys(air).sort();
check('A7: an airbrush drag lays more than one tone', airHexes.length >= 3, airHexes.join(' '));
const strays = airHexes.filter((h) => !ROW.includes(h));
check('A8: every tone it lays is a fade of the aimed shade', strays.length === 0,
  strays.length ? 'strays: ' + strays.join(' ') : airHexes.join(' '));
check('A9: it reaches the palest step of the ramp', air[ROW[FADE_STEPS]] > 0,
  `${ROW[FADE_STEPS]} x${air[ROW[FADE_STEPS]] || 0}`);
check('A10: it keeps the aimed shade at the dab centre', air[ROW[0]] > 0,
  `${ROW[0]} x${air[ROW[0]] || 0}`);

await page.click('#btnUndo');
await page.waitForTimeout(260);
// Back to the board as it was: every tone the stroke laid must have gone, and
// nothing else may have moved. One undo for a whole multi-tone stroke.
const restored = await hist();
const left = Object.entries(air).filter(([hex]) => (restored[hex] || 0) > (airBase[hex] || 0));
check('A11: one undo takes the whole stroke away', left.length === 0,
  left.map(([h, n]) => `${h}+${n - (airBase[h] || 0)}`).join(' '));

// --- The spray, same settings, must still be a single tone. ---
await page.click('#toolOpts [data-shape="spray"]');
await page.waitForTimeout(120);
const { fresh: spray } = await drag();
check('A12: the spray next door lays exactly one tone', Object.keys(spray).length === 1,
  Object.keys(spray).join(' '));
check('A13: and it is the shade aimed', Object.keys(spray)[0] === ROW[0], Object.keys(spray).join(' '));
await page.click('#btnUndo');
await page.waitForTimeout(200);

check('A14: no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));

await page.screenshot({ path: 'tools/air.png' });
console.log(`\n${pass} PASS / ${fail} FAIL  (fade row ${ROW.join(' ')}, screenshot tools/air.png)`);
await b.close();
process.exit(fail ? 1 : 0);
