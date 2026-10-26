/**
 * Browser check for the text tool. The unit tests drive Input with synthetic
 * pointers and a stubbed view; they cannot see the dock at all. This proves the
 * wiring a player uses: the button, the field, the live readout, the ghost under
 * the cursor, the tap that paints, and the one undo that takes the whole word
 * back.
 *
 * Run: node tools/probe_text.mjs   (server on 8099)
 */
import { chromium } from 'playwright';
import { measure, textCells } from '../assets/js/game/pixeltext.js';
import { FLAT_COLORS } from '../assets/js/data/heartopia-palette.js';

const BASE = process.env.BASE || 'http://localhost:8099';
const AIM = 16; // #e95e2b
const HEX = FLAT_COLORS[AIM].toLowerCase();

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
check('P: the page is ours', (await page.content()).includes('id="app"'));

/**
 * Pixels of one exact shade on one canvas. Counted as whole-cell interiors only:
 * a board scaled to a non-integer cell size blends every cell edge into a colour
 * that is on no palette, and those blends would swamp a real count.
 */
const shadePixels = (id, hex, opaqueOnly = true) =>
  page.evaluate(
    ({ id, hex, opaqueOnly }) => {
      const cv = document.getElementById(id);
      if (!cv || !cv.width) return -1;
      const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
      const w = cv.width;
      const h = cv.height;
      const rgb = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
      // The aim ghost is drawn at half alpha on a transparent layer. That is not
      // simply "the same colour, any coverage": a canvas stores premultiplied
      // alpha, so 0x2b at 0.5 comes back as 0x2c. A translucent preview is only
      // findable within a channel or two of the colour it was drawn from.
      const near = (a) =>
        Math.abs(d[a] - rgb[0]) <= 2 && Math.abs(d[a + 1] - rgb[1]) <= 2 && Math.abs(d[a + 2] - rgb[2]) <= 2;
      const eq = (a) => near(a) && (opaqueOnly ? d[a + 3] === 255 : d[a + 3] > 0);
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
    { id, hex }
  );

/**
 * The colours the board is currently made of, as a set. Cell *interiors* only:
 * a board scaled to a non-integer cell size blends every cell edge into a colour
 * that exists on no palette, and those blends would read as the tool inventing
 * tones it never used.
 */
const colourSet = () =>
  page.evaluate(() => {
    const cv = document.getElementById('base');
    const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
    const w = cv.width;
    const h = cv.height;
    const eq = (a, b) => d[a] === d[b] && d[a + 1] === d[b + 1] && d[a + 2] === d[b + 2] && d[a + 3] === d[b + 3];
    const out = new Set();
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = (y * w + x) * 4;
        if (d[i + 3] < 250) continue;
        if (!eq(i, i + 4) || !eq(i, i - 4) || !eq(i, i + w * 4) || !eq(i, i - w * 4)) continue;
        out.add('#' + [d[i], d[i + 1], d[i + 2]].map((v) => v.toString(16).padStart(2, '0')).join(''));
      }
    }
    return [...out];
  });

const board = await page.locator('#base').boundingBox();
const mid = { x: board.x + board.width / 2, y: board.y + board.height / 2 };

// 1. the tool exists and is reachable by keyboard as well as by click
await page.click('.tool[data-tool="text"]');
check('T: the Text button is in the dock', (await page.locator('.tool[data-tool="text"].active').count()) === 1);
await page.keyboard.press('b');
await page.keyboard.press('t');
check(
  'T: the T key selects it',
  (await page.locator('.tool[data-tool="text"].active').count()) === 1,
  'after B then T'
);

// 2. the field and the size row are there
const field = page.locator('#textIn');
check('T: typing field present', (await field.count()) === 1);
check('T: four sizes offered', (await page.locator('#toolOpts [data-textsize]').count()) === 4);

// 3. the readout states what the string means in cells
await field.fill('HI');
const dim = (await page.locator('#textDim').textContent()) || '';
const want = measure('HI', 1);
check(
  'T: readout gives the block in cells',
  dim.includes(`${want.w}×${want.h}`),
  `"${dim}" vs ${want.w}×${want.h}`
);

// 4. a glyph the font has no letter for is named before you tap, not after
await field.fill('AÏ');
const dimBad = (await page.locator('#textDim').textContent()) || '';
check('T: an untypeable character is named', /no letter for ï/i.test(dimBad), `"${dimBad}"`);
check(
  'T: and the rest of the string still measures',
  dimBad.startsWith(`${measure('A', 1).w}×`),
  dimBad
);

// 5. a bigger size is the same word, bigger
await field.fill('HI');
await page.click('#toolOpts [data-textsize="4"]');
const dim4 = (await page.locator('#textDim').textContent()) || '';
const m4 = measure('HI', 4);
check('T: size 4 multiplies the block', dim4.includes(`${m4.w}×${m4.h}`), `"${dim4}"`);
await page.click('#toolOpts [data-textsize="1"]');

// 6. an empty box refuses, and says so out loud
await field.fill('');
const before0 = await shadePixels('base', HEX);
await page.mouse.click(mid.x, mid.y);
const toasts = await page.locator('#toast .toast').allTextContents();
check(
  'T: an empty box is refused with a reason',
  toasts.some((t) => /type something/i.test(t)),
  toasts.join(' | ') || 'no toast'
);
check('T: and nothing is painted', (await shadePixels('base', HEX)) === before0);

// 7. the ghost follows the cursor before anything is committed
await field.fill('HI');
await page.mouse.move(mid.x, mid.y);
await page.waitForTimeout(120);
const ghost = await shadePixels('fx', HEX, false);
check('T: the aim ghost previews the word', ghost > 0, `${ghost} preview px`);
const prePaint = await shadePixels('base', HEX);
check('T: and previewing paints nothing on the board', prePaint === before0);

// 8. one tap commits the word, in the held shade, as one action
const setBefore = await colourSet();
await page.mouse.click(mid.x, mid.y);
await page.waitForTimeout(120);
const painted = await shadePixels('base', HEX);
check('T: the tap paints', painted > before0, `${before0} -> ${painted} px`);
const cells = textCells('HI', 1).length;
const perCell = (painted - before0) / cells;
check('T: about one cell per glyph cell', perCell > 4, `${perCell.toFixed(1)} px/cell for ${cells} cells`);
// A word is one colour. Anything else turning up means the tool invented a tone
// of its own, which a Heartopia board cannot hold.
const added = (await colourSet()).filter((c) => !setBefore.includes(c));
check('T: the held shade is the only new colour', added.length === 1 && added[0] === HEX, added.join(' ') || 'none');

// 9. one undo takes the whole word back
await page.click('#btnUndo');
await page.waitForTimeout(150);
const afterUndo = await shadePixels('base', HEX);
check('T: one undo removes the whole word', afterUndo === before0, `${afterUndo} vs ${before0}`);

// 10. a word aimed at the corner is not eaten by the border
await page.mouse.move(board.x + 6, board.y + 6);
await page.waitForTimeout(120);
const ghostCorner = await shadePixels('fx', HEX, false);
// Not an exact count: the cell size is fractional, so the same 32 cells cover a
// few pixels more or less depending on where they land. What must not happen is
// the block being clipped to a fraction of itself at the border.
check(
  'T: the block slides inside at the corner',
  ghostCorner > ghost * 0.9,
  `${ghost} mid vs ${ghostCorner} corner`
);

// 11. mirror puts it on both sides
await page.click('#toolOpts [data-mirror="x"]');
await page.mouse.move(mid.x, mid.y);
await page.waitForTimeout(120);
const ghostMirror = await shadePixels('fx', HEX, false);
check('T: mirroring doubles the preview', ghostMirror > ghost * 1.5, `${ghost} -> ${ghostMirror}`);
await page.click('#toolOpts [data-mirror="off"]');

check('T: no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));

await b.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
