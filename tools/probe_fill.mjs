/**
 * Browser check for "fill similar" (bucket tolerance). Proves three things the
 * unit tests cannot: the Matches chips actually render and press, the Exact
 * chip survives the `'0'`-is-falsy trap, and a real click on a real canvas
 * groups shades by colour rather than by palette position.
 *
 * Run: node tools/probe_fill.mjs   (server on 8099)
 */
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://localhost:8099';
let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`PASS ${name}${detail ? ' - ' + detail : ''}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? ' - ' + detail : ''}`); }
}

// Real shipped shades. 12 and 13 are next to each other in the list and 56
// apart in colour; 13 and 123 are 110 apart in the list and 2.4 apart in
// colour. Target is an orange none of them resemble.
const DARK_RED = 12, PALE_PINK = 13, PALE_LILAC = 123, TARGET = 16;
const HEX = { [DARK_RED]: '#682f39', [PALE_PINK]: '#e7d5d5', [PALE_LILAC]: '#e4d5da', [TARGET]: '#e95e2b' };

const b = await chromium.launch();
const page = await b.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

await page.goto(`${BASE}/?local=1&renderDelay=0`, { waitUntil: 'load' });
await page.waitForFunction(() => !document.getElementById('app').classList.contains('locked'), { timeout: 20000 });
await page.waitForFunction(() => document.getElementById('base').width > 300, { timeout: 10000 });

// The chips only exist while the bucket is the live tool.
await page.click('button[data-tool="fill"]');
await page.waitForTimeout(150);

const chips = await page.evaluate(() =>
  [...document.querySelectorAll('#toolOpts [data-fillmatch]')].map((el) => ({
    v: el.dataset.fillmatch,
    label: el.textContent.trim(),
    active: el.classList.contains('active'),
    title: el.title,
  }))
);
check('F1: three Match chips render', chips.length === 3, JSON.stringify(chips.map((c) => c.label + '=' + c.v)));
check('F2: chips carry 0/6/12', chips.map((c) => c.v).join(',') === '0,6,12', chips.map((c) => c.v).join(','));
check('F3: exactly one chip pressed', chips.filter((c) => c.active).length === 1,
  chips.filter((c) => c.active).map((c) => c.v).join(','));
check('F4: every chip explains itself', chips.every((c) => c.title.length > 5), chips.map((c) => c.title).join(' / '));

// The `'0'` trap: clicking Exact must stick, not read as "no choice made".
await page.click('#toolOpts [data-fillmatch="12"]');
await page.waitForTimeout(120);
let after = await page.evaluate(() =>
  [...document.querySelectorAll('#toolOpts [data-fillmatch]')].filter((e) => e.classList.contains('active')).map((e) => e.dataset.fillmatch)
);
check('F5: clicking Broad presses it', after.join(',') === '12', after.join(','));
await page.click('#toolOpts [data-fillmatch="0"]');
await page.waitForTimeout(120);
after = await page.evaluate(() =>
  [...document.querySelectorAll('#toolOpts [data-fillmatch]')].filter((e) => e.classList.contains('active')).map((e) => e.dataset.fillmatch)
);
check('F6: clicking Exact presses it (0 is a real choice, not falsy-nothing)', after.join(',') === '0', after.join(','));

// "Everywhere" so contiguity cannot mask the result.
await page.click('#toolOpts [data-fillscope="all"]');
await page.waitForTimeout(120);

/** Click the swatch for a palette index, walking groups until it is showing. */
async function pickShade(idx) {
  for (let g = 0; g < 13; g++) {
    await page.click(`#groups [data-group="${g}"]`);
    await page.waitForTimeout(40);
    const found = await page.$(`#swatches [data-idx="${idx}"]`);
    if (found) {
      await found.click();
      await page.waitForTimeout(60);
      const sel = await page.evaluate(() =>
        [...document.querySelectorAll('#swatches .swatch.active')].map((e) => e.dataset.idx).join(',')
      );
      return sel === String(idx);
    }
  }
  return false;
}

// Seed three separate blobs with the three shades, far apart on the board.
const box = await page.locator('#base').boundingBox();
const pts = [
  [box.x + box.width * 0.22, box.y + box.height * 0.25],
  [box.x + box.width * 0.72, box.y + box.height * 0.25],
  [box.x + box.width * 0.22, box.y + box.height * 0.72],
];

await page.click('button[data-tool="brush"]');
await page.waitForTimeout(100);
for (const [idx, pt] of [[PALE_PINK, pts[0]], [PALE_LILAC, pts[1]], [DARK_RED, pts[2]]]) {
  const ok = await pickShade(idx);
  check(`F7: shade ${idx} (${HEX[idx]}) selectable`, ok, `swatch ${idx} pressed`);
  await page.mouse.click(pt[0], pt[1]);
  await page.waitForTimeout(120);
}

/** Count pixels of an exact colour on the board canvas. */
const countHex = (hex) =>
  page.evaluate((h) => {
    const cv = document.getElementById('base');
    const ctx = cv.getContext('2d');
    const d = ctx.getImageData(0, 0, cv.width, cv.height).data;
    const n = [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
    let c = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] > 200 && Math.abs(d[i] - n[0]) < 3 && Math.abs(d[i + 1] - n[1]) < 3 && Math.abs(d[i + 2] - n[2]) < 3) c++;
    }
    return c;
  }, hex);

const seeded = {
  pink: await countHex(HEX[PALE_PINK]),
  lilac: await countHex(HEX[PALE_LILAC]),
  red: await countHex(HEX[DARK_RED]),
};
check('F8: the board really has all three shades on it',
  seeded.pink > 0 && seeded.lilac > 0 && seeded.red > 0, JSON.stringify(seeded));

// --- Exact: only the shade under the pointer converts. ---
await page.click('button[data-tool="fill"]');
await page.click('#toolOpts [data-fillmatch="0"]');
await page.waitForTimeout(120);
await pickShade(TARGET);
await page.mouse.click(pts[0][0], pts[0][1]);
await page.waitForTimeout(250);
let now = { pink: await countHex(HEX[PALE_PINK]), lilac: await countHex(HEX[PALE_LILAC]), red: await countHex(HEX[DARK_RED]) };
check('F9: Exact converts the shade clicked', now.pink === 0, JSON.stringify(now));
check('F10: Exact leaves the look-alike alone', now.lilac === seeded.lilac, `${now.lilac} vs ${seeded.lilac}`);
check('F11: Exact leaves the unrelated shade alone', now.red === seeded.red, `${now.red} vs ${seeded.red}`);

// --- Undo, then Broad: the look-alike joins, the list-neighbour does not. ---
await page.click('#btnUndo');
await page.waitForTimeout(250);
now = { pink: await countHex(HEX[PALE_PINK]), lilac: await countHex(HEX[PALE_LILAC]), red: await countHex(HEX[DARK_RED]) };
check('F12: undo restores the seed', now.pink === seeded.pink && now.lilac === seeded.lilac && now.red === seeded.red, JSON.stringify(now));

await page.click('#toolOpts [data-fillmatch="12"]');
await page.waitForTimeout(120);
await pickShade(TARGET);
await page.mouse.click(pts[0][0], pts[0][1]);
await page.waitForTimeout(250);
now = { pink: await countHex(HEX[PALE_PINK]), lilac: await countHex(HEX[PALE_LILAC]), red: await countHex(HEX[DARK_RED]) };
check('F13: Broad takes the shade clicked', now.pink === 0, JSON.stringify(now));
check('F14: Broad takes the shade 110 list-places away that looks the same', now.lilac === 0, `${now.lilac} left`);
check('F15: Broad refuses the shade 1 list-place away that looks nothing alike', now.red === seeded.red, `${now.red} vs ${seeded.red}`);

check('F16: no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));

await page.screenshot({ path: 'tools/fill.png', fullPage: false });
console.log(`\n${pass} PASS / ${fail} FAIL  (screenshot tools/fill.png)`);
await b.close();
process.exit(fail ? 1 : 0);
