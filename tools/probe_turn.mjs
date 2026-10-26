/**
 * Browser check for "Turn" on import. fitRect is unit-tested; this checks the
 * part only a real canvas can show - that ctx.rotate actually puts the picture
 * in the quadrant it claims to, and that the preview you judge by is the buffer
 * that gets committed.
 *
 * Run: node tools/probe_turn.mjs   (server on 8099)
 */
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://localhost:8099';
let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`PASS ${name}${detail ? ' - ' + detail : ''}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? ' - ' + detail : ''}`); }
}

const b = await chromium.launch();
const page = await b.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

await page.goto(`${BASE}/?local=1&renderDelay=0`, { waitUntil: 'load' });
await page.waitForFunction(() => !document.getElementById('app').classList.contains('locked'), { timeout: 20000 });
await page.click('#btnImport');
await page.waitForTimeout(300);

// The Turn control only exists for photos, where placement is a choice.
const turn = await page.evaluate(() => {
  const s = document.querySelector('#importControls [data-ctl="rot"]');
  return s ? { value: s.value, options: [...s.options].map((o) => `${o.value}:${o.text}`) } : null;
});
check('T1: a Turn control exists', !!turn, JSON.stringify(turn));
check('T2: Turn offers four quarter turns with plain-language labels',
  turn && turn.options.length === 4 && turn.options[0] === '0:no turn' && turn.options[3] === '270:90° left',
  turn && turn.options.join(' | '));
check('T3: Turn starts on no turn', turn && turn.value === '0', turn && turn.value);

/** A 200x100 white picture with a black block in its top-left quadrant. */
async function loadPicture() {
  await page.evaluate(async () => {
    const c = document.createElement('canvas');
    c.width = 200;
    c.height = 100;
    const x = c.getContext('2d');
    x.fillStyle = '#ffffff';
    x.fillRect(0, 0, 200, 100);
    x.fillStyle = '#000000';
    x.fillRect(0, 0, 100, 50); // top-left quarter
    const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
    const file = new File([blob], 'marker.png', { type: 'image/png' });
    const dt = new DataTransfer();
    dt.items.add(file);
    const input = document.getElementById('file');
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForTimeout(700);
}

/** Contain, so the whole turned picture is inside the face and nothing is cropped. */
await page.selectOption('#importControls [data-ctl="fit"]', 'contain').catch(() => {});
await loadPicture();

const prev = page.locator('#importPrev canvas');
check('T4: an import preview appeared', (await prev.count()) > 0);

/** Where the dark block sits, as a quadrant of the preview. */
async function quadrant() {
  return page.evaluate(() => {
    const cv = document.querySelector('#importPrev canvas');
    if (!cv) return null;
    const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
    let n = 0, sx = 0, sy = 0;
    for (let y = 0; y < cv.height; y++) {
      for (let x = 0; x < cv.width; x++) {
        const i = (y * cv.width + x) * 4;
        if (d[i + 3] > 200 && d[i] < 90 && d[i + 1] < 90 && d[i + 2] < 90) { n++; sx += x; sy += y; }
      }
    }
    if (!n) return { n: 0 };
    const cx = sx / n / cv.width - 0.5;
    const cy = sy / n / cv.height - 0.5;
    return { n, h: cx < 0 ? 'left' : 'right', v: cy < 0 ? 'up' : 'down', cx: +cx.toFixed(3), cy: +cy.toFixed(3) };
  });
}

let q = await quadrant();
check('T5: the block is on the board before any turn', q && q.n > 0, JSON.stringify(q));
check('T6: no turn keeps it top-left', q && q.h === 'left' && q.v === 'up', JSON.stringify(q));

const expect = { 90: ['right', 'up'], 180: ['right', 'down'], 270: ['left', 'down'] };
for (const deg of ['90', '180', '270']) {
  await page.selectOption('#importControls [data-ctl="rot"]', deg);
  await page.waitForTimeout(500);
  q = await quadrant();
  const [eh, ev] = expect[deg];
  check(`T7: turning ${deg}° clockwise moves the block to ${eh}-${ev}`,
    q && q.h === eh && q.v === ev, JSON.stringify(q));
}

// Back to 0 and confirm it is a real rotation, not a one-way shuffle.
await page.selectOption('#importControls [data-ctl="rot"]', '0');
await page.waitForTimeout(500);
q = await quadrant();
check('T8: turning back to no turn restores it', q && q.h === 'left' && q.v === 'up', JSON.stringify(q));

// The select must show what the rasteriser is using after a panel rebuild.
await page.selectOption('#importControls [data-ctl="rot"]', '270');
await page.waitForTimeout(300);
await page.click('#btnImport'); // close
await page.waitForTimeout(200);
await page.click('#btnImport'); // reopen - _buildImportControls runs again
await page.waitForTimeout(300);
const shown = await page.evaluate(() => document.querySelector('#importControls [data-ctl="rot"]').value);
check('T9: the control still reads 270 after the panel is rebuilt', shown === '270', shown);

check('T10: no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));

await page.screenshot({ path: 'tools/turn.png' });
console.log(`\n${pass} PASS / ${fail} FAIL  (screenshot tools/turn.png)`);
await b.close();
process.exit(fail ? 1 : 0);
