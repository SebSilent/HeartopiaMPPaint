/**
 * Browser check for the recent-shades row and Alt-drag sampling.
 *
 * Both are dock behaviour the unit tests are blind to: the row is built by
 * `ui.setRecent` from a localStorage round trip, and Alt sampling is a pointer
 * gesture that has to survive a real browser's own Alt handling. The two claims
 * worth proving are that the row does not open with a shade nobody chose, and
 * that sampling paints nothing.
 *
 * Run: node tools/probe_recents.mjs   (server on 8099)
 */
import { chromium } from 'playwright';
import { FLAT_COLORS } from '../assets/js/data/heartopia-palette.js';

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
const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
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

const chips = () => page.$$eval('#recent .recent-sw', (n) => n.map((x) => Number(x.dataset.idx)));
const held = () => page.$eval('#currentColor', (n) => n.textContent.trim());

/** Cell interiors of one shade on the board. Interiors only: fractional cell
 *  scaling blends every edge into a colour that exists on no palette. */
const shadePx = (idx) =>
  page.evaluate(
    (hex) => {
      const cv = document.getElementById('base');
      const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
      const w = cv.width;
      const h = cv.height;
      const rgb = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
      const eq = (a) => d[a] === rgb[0] && d[a + 1] === rgb[1] && d[a + 2] === rgb[2] && d[a + 3] === 255;
      const run = (a, len, step) => {
        for (let k = 0; k < len; k++) if (!eq(a + k * step)) return false;
        return true;
      };
      let n = 0;
      for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
          const i = (y * w + x) * 4;
          if (!eq(i)) continue;
          if (!run(i - 4, 3, 4) || !run(i - w * 4, 3, w * 4)) continue;
          n++;
        }
      }
      return n;
    },
    FLAT_COLORS[idx].toLowerCase()
  );

// Two shades in whatever group is showing.
const idxs = await page.$$eval('#swatches .swatch', (n) => n.slice(0, 8).map((x) => Number(x.dataset.idx)));
const [A, B] = idxs;
check('R: two shades to work with', !!A && !!B && A !== B, `${A} ${B}`);

// 1. the row starts empty - a starting shade is not a choice
check('R: the row is empty before anything is chosen', (await chips()).length === 0, JSON.stringify(await chips()));

// 2. choosing a shade puts it in the row
await page.click(`#swatches .swatch[data-idx="${A}"]`);
check('R: a chosen shade appears', (await chips())[0] === A, JSON.stringify(await chips()));

// 3. newest first, and no duplicates
await page.click(`#swatches .swatch[data-idx="${B}"]`);
check('R: newest is first', JSON.stringify(await chips()) === JSON.stringify([B, A]), JSON.stringify(await chips()));
await page.click(`#swatches .swatch[data-idx="${A}"]`);
const after3 = await chips();
check('R: re-choosing moves it up instead of duplicating', after3.length === 2 && after3[0] === A, JSON.stringify(after3));

// 4. it survives a reload, and the row is not accidentally room state
await page.reload({ waitUntil: 'load' });
await open();
const reloaded = await chips();
check('R: the row comes back after a reload', reloaded.length === 2 && reloaded[0] === A, JSON.stringify(reloaded));

// 5. clicking a recent chip holds that shade
await page.click(`#swatches .swatch[data-idx="${B}"]`); // move away from A
await page.click(`#recent .recent-sw[data-idx="${A}"]`);
check(
  'R: a recent chip is a real control',
  (await held()).includes(FLAT_COLORS[A].toLowerCase()),
  `${await held()} vs ${FLAT_COLORS[A]}`
);

// 6. Alt samples without painting.
//
// Playwright's `modifiers: ['Alt']` option does NOT reach the event - measured:
// pointerdown.altKey stays false, while keyboard.down('Alt') gives true. So Alt
// has to actually be held. Getting this wrong makes every check below pass
// trivially, because an ordinary click that paints the same cells in the same
// colour looks exactly like "painted nothing".
async function altClick(x, y) {
  await page.keyboard.down('Alt');
  await page.mouse.click(x, y);
  await page.keyboard.up('Alt');
  await page.waitForTimeout(120);
}

await page.click('.tool[data-tool="brush"]');
await page.click(`#swatches .swatch[data-idx="${B}"]`);
const box = await page.locator('#base').boundingBox();
const spot = { x: box.x + box.width * 0.3, y: box.y + box.height * 0.3 };
await page.mouse.click(spot.x, spot.y); // leave a mark in B
await page.waitForTimeout(120);
const markB = await shadePx(B);
check('R: the brush still paints normally', markB > 0, `${markB} px of shade ${B}`);

// Hold a shade that is NOT the mark, then Alt the mark: the held shade must
// become the mark's, and neither shade may gain pixels.
await page.click(`#swatches .swatch[data-idx="${A}"]`);
const heldA = await held();
check('R: holding a different shade first', heldA.includes(FLAT_COLORS[A].toLowerCase()), heldA);
await altClick(spot.x, spot.y);
check(
  'R: Alt on the mark holds the mark\'s shade',
  (await held()).includes(FLAT_COLORS[B].toLowerCase()),
  `${await held()} should read ${FLAT_COLORS[B]}`
);
check('R: Alt painted none of the shade it sampled', (await shadePx(B)) === markB, `${markB} -> ${await shadePx(B)}`);
check('R: and painted none of the shade it left', (await shadePx(A)) === 0, `${await shadePx(A)} px of ${A}`);
const afterAlt = markB;

// 7. an Alt-drag across blank space keeps the last real shade
const heldBefore = await held();
await page.keyboard.down('Alt');
await page.mouse.move(spot.x, spot.y);
await page.mouse.down();
await page.mouse.move(box.x + box.width * 0.92, spot.y, { steps: 12 }); // off into the blank
await page.mouse.up();
await page.keyboard.up('Alt');
await page.waitForTimeout(120);
check('R: a drag over blank space does not drop the shade', (await held()) === heldBefore, `${heldBefore} -> ${await held()}`);
const blankPaint = await shadePx(B);
check('R: the whole Alt-drag painted nothing', blankPaint === afterAlt, `${afterAlt} -> ${blankPaint}`);

// 8. the eraser must not turn sampling into erasing
await page.click('.tool[data-tool="eraser"]');
await page.click(`#swatches .swatch[data-idx="${A}"]`); // hold a shade that is NOT the mark
const markBefore = await shadePx(B);
await altClick(spot.x, spot.y); // straight onto the B mark
check(
  'R: Alt samples through the eraser',
  (await held()).includes(FLAT_COLORS[B].toLowerCase()),
  `${await held()} should read ${FLAT_COLORS[B]}`
);
check(
  'R: and the eraser erased nothing while doing it',
  (await shadePx(B)) === markBefore,
  `${markBefore} -> ${await shadePx(B)}`
);

check('R: no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));

await b.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
