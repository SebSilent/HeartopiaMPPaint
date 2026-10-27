/**
 * Does the gap pass only ever paint backdrop?
 *
 * The hole counter in meshholes.mjs cannot answer this. It defines a hole as
 * "backdrop you cannot reach from the border", so a bug that put a dark pixel on
 * cloth would make its numbers look *better*, not worse. The only way to know is
 * to render the same frame twice - once with the pass off, once on - and look at
 * every pixel that changed.
 *
 * `?gapFill=0` is what makes that possible without arguing about it.
 *
 * Run: node tools/probe_gapfill.mjs [base] [item]   (server on 8099)
 */
import { chromium } from 'playwright';

const BASE = (process.argv[2] || 'http://localhost:8099').replace(/\/$/, '');
const ITEM = process.argv[3] || 'tshirt';
const BG = [194, 204, 211]; // #c2ccd3, the studio backdrop

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
const page = await b.newPage({ viewport: { width: 1280, height: 720 }, hasTouch: true });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));

async function shot(gapFill) {
  const url = `${BASE}/?room=GAPFILL&item=${ITEM}&renderDelay=0${gapFill ? '' : '&gapFill=0'}`;
  await page.goto(url, { waitUntil: 'load' });
  if (await page.locator('#join').isVisible().catch(() => false)) {
    await page.fill('#nick', 'Gap');
    await page.click('#join');
  }
  await page.waitForFunction(() => !document.getElementById('app').classList.contains('locked'), { timeout: 20000 });
  await page.waitForFunction(() => document.getElementById('base').width > 300, { timeout: 10000 });
  await page.click('#btn3d');
  await page.waitForFunction(() => document.getElementById('d3Canvas').width > 200, { timeout: 10000 });
  await page.waitForTimeout(900);
  // Orbit to a fixed non-default angle. The dress at rest has nothing to fill -
  // meshholes.mjs counts its trapped pixels per angle, and the default one is not
  // the worst - so a single static frame would either prove nothing or fail on a
  // garment that is genuinely clean at that pose. Both loads run the same drag,
  // and the orbit is deterministic from the same start, so the two frames differ
  // only by the pass.
  const c = await page.locator('#d3Canvas').boundingBox();
  await page.mouse.move(c.x + c.width / 2, c.y + c.height / 2);
  await page.mouse.down();
  await page.mouse.move(c.x + c.width / 2 + 78, c.y + c.height / 2 - 26, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(1000);
  const died = await page.evaluate(() => document.getElementById('d3Panel').hidden);
  check(`G${gapFill ? 'on' : 'off'}: the preview survived the frame`, !died);
  return await page.evaluate(() => {
    const cv = document.getElementById('d3Canvas');
    const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
    let s = '';
    const CH = 8192;
    for (let i = 0; i < d.length; i += CH) s += String.fromCharCode.apply(null, d.subarray(i, i + CH));
    return { w: cv.width, h: cv.height, b64: btoa(s) };
  });
}

const off = await shot(false);
const on = await shot(true);
check('G: both frames are the same size', off.w === on.w && off.h === on.h, `${off.w}x${off.h}`);

const A = Buffer.from(off.b64, 'base64');
const B = Buffer.from(on.b64, 'base64');
const isBg = (buf, i) => Math.abs(buf[i] - BG[0]) <= 4 && Math.abs(buf[i + 1] - BG[1]) <= 4 && Math.abs(buf[i + 2] - BG[2]) <= 4;

let changed = 0;
let onBackdrop = 0;
let onCloth = 0;
let darkest = 255;
const worst = [];
for (let i = 0; i < A.length; i += 4) {
  if (A[i] === B[i] && A[i + 1] === B[i + 1] && A[i + 2] === B[i + 2]) continue;
  changed++;
  if (isBg(A, i)) {
    onBackdrop++;
    darkest = Math.min(darkest, (B[i] + B[i + 1] + B[i + 2]) / 3);
  } else {
    onCloth++;
    if (worst.length < 4) worst.push(`(${(i / 4) % off.w},${Math.floor(i / 4 / off.w)}) was #${[A[i], A[i + 1], A[i + 2]].map((v) => v.toString(16).padStart(2, '0')).join('')} now #${[B[i], B[i + 1], B[i + 2]].map((v) => v.toString(16).padStart(2, '0')).join('')}`);
  }
}

console.log(`\nitem ${ITEM}  ${off.w}x${off.h}  changed ${changed} px  of which backdrop ${onBackdrop}, cloth ${onCloth}`);
check('G: the pass changes something', changed > 0, `${changed} px`);
check('G: it never paints over cloth', onCloth === 0, worst.join(' | '));
check('G: every changed pixel was backdrop first', onBackdrop === changed, `${onBackdrop}/${changed}`);
check('G: the fill reads as shadow, not as a black mark', darkest > 40, `darkest fill luma ${darkest.toFixed(0)}`);
check('G: no page errors', errors.length === 0, errors.slice(0, 2).join(' | '));

await b.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
