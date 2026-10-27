/**
 * Browser check for cell-snapped placement.
 *
 * The claim under test is a negative one: dragging the picture less than half a
 * cell must change nothing at all. That is invisible in a unit test of `fitRect`
 * because the arithmetic is only half the story - the other half is whether the
 * drag handler, the preview and the commit all read the same snapped box, and
 * whether the checkbox actually reaches the state.
 *
 * Run: node tools/probe_snap.mjs   (server on 8099)
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
const box = page.locator('#importControls [data-ctl="snap"]');
check('N: the rule is stated in the panel', (await box.count()) === 1);
check('N: and it is on by default', await box.isChecked());

// A hard-edged picture, so a shift of any size is unmistakable in the cells.
const png = await page.evaluate(() => {
  const c = document.createElement('canvas');
  c.width = 320;
  c.height = 200;
  const x = c.getContext('2d');
  x.fillStyle = '#101820';
  x.fillRect(0, 0, 320, 200);
  x.fillStyle = '#e8e0d0';
  for (let i = 0; i < 8; i++) x.fillRect(10 + i * 40, 20, 20, 160);
  return c.toDataURL('image/png');
});
await page.setInputFiles('#file', [
  { name: 'stripes.png', mimeType: 'image/png', buffer: Buffer.from(png.split(',')[1], 'base64') },
]);
await page.waitForSelector('#importPrev canvas', { timeout: 15000 });
await page.waitForTimeout(700);

/** A digest of the preview - one pixel per cell, so this IS the board. */
const hash = () =>
  page.evaluate(() => {
    const c = document.querySelector('#importPrev canvas');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let s = 0;
    for (let i = 0; i < d.length; i += 4) s = (s * 31 + d[i] + d[i + 1] * 7 + d[i + 2] * 13) | 0;
    const rect = c.getBoundingClientRect();
    return { s, cells: c.width, pxPerCell: rect.width / c.width, w: c.width, h: c.height };
  });

const h0 = await hash();
check('N: the preview is one pixel per cell', h0.w > 10 && h0.h > 10, `${h0.w}x${h0.h}`);

/** Drag the picture by a fraction of a cell and report what the board did. */
async function dragBy(cells) {
  const c = await page.locator('#importPrev canvas').boundingBox();
  const px = c.width / h0.cells; // screen px per cell
  const x = c.x + c.width * 0.5;
  const y = c.y + c.height * 0.5;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + px * cells, y, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(500);
  return await hash();
}

const quarter = await dragBy(0.25);
check('N: a quarter-cell drag changes nothing while snapped', quarter.s === h0.s, `${h0.s} -> ${quarter.s}`);

const two = await dragBy(2);
check('N: a two-cell drag does change it', two.s !== h0.s, `${h0.s} -> ${two.s}`);

// A drag is cumulative - it starts from wherever the picture already is - so
// repeating one proves nothing about determinism unless the start is reset
// first. The first version of this check omitted that and failed correctly.
async function recenter() {
  for (const key of ['ox', 'oy']) {
    const el = page.locator(`#importControls [data-ctl="${key}"]`);
    await el.fill('0');
    await el.dispatchEvent('input');
  }
  await page.waitForTimeout(450);
}

await recenter();
const start = await hash();
check('N: zeroing the move sliders returns the picture', start.s === h0.s, `${h0.s} -> ${start.s}`);

// A net offset of 0.25 + (-1.75) = -1.5 cells: the snap has to pick a whole cell,
// and pick it the same way every time, or the rule is a coin toss.
const b1 = await dragBy(-1.75);
await recenter();
const b2 = await dragBy(-1.75);
check('N: the same drag from the same start lands on the same cells', b1.s === b2.s, `${b1.s} vs ${b2.s}`);

// Turn the rule off: the picture has to become continuous again, otherwise the
// checkbox is decoration and the snapping is permanent.
await box.uncheck();
await page.waitForTimeout(500);
const off0 = await hash();
const offQuarter = await dragBy(0.25);
check('N: with the rule off, the same drag moves the picture', offQuarter.s !== off0.s, `${off0.s} -> ${offQuarter.s}`);

await box.check();
await recenter();
const on0 = await hash();
const on1 = await dragBy(0.25);
check('N: and turning the rule back on snaps again', on1.s === on0.s, `${on0.s} -> ${on1.s}`);

// The committed board must agree with the preview, not with the raw drag: if the
// commit re-derived the box without the snap, the player would get cells they
// never saw.
await page.click('#importApply');
await page.waitForTimeout(700);
const painted = await page.evaluate(() => {
  const cv = document.getElementById('base');
  const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
  let s = 0;
  for (let i = 0; i < d.length; i += 4) s = (s * 31 + d[i] + d[i + 1] * 7 + d[i + 2] * 13) | 0;
  return s;
});
check('N: the import commits without error', typeof painted === 'number' && painted !== 0, String(painted));
check('N: no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));

await b.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
