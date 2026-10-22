// Proves the outline layer reaches the screen in 2D and the silhouette clip
// reaches the mesh in 3D. Both are measured from pixels, not from flags.
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';

const BASE = 'http://localhost:8099/';
const LOG = '_outline-report.txt';
const out = [];
const say = (s) => { out.push(s); writeFileSync(LOG, out.join('\n') + '\n'); };

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errs = [];
page.on('pageerror', (e) => errs.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });

await page.goto(BASE + '?room=OUTLNX&item=tshirt&renderDelay=0', { waitUntil: 'load' });
await page.fill('#nick', 'Solo');
await page.click('#join');
await page.waitForFunction(() => !document.getElementById('app').classList.contains('locked'), { timeout: 20000 });
await page.waitForFunction(() => document.getElementById('base').width > 300, { timeout: 8000 });
// The room hands out a slot before the dock is armed. Reading the toggle any
// earlier measures the join form, not the board.
await page.waitForFunction(() => !document.getElementById('outlineBtn')?.disabled, { timeout: 20000 }).catch(() => {});

const which = await page.evaluate(() => {
  const t = document.querySelector('.face[data-face]');
  const note = document.getElementById('outlineNote')?.textContent || '';
  return {
    faces: document.querySelectorAll('.face[data-face]').length,
    first: t?.title,
    item: note.replace(/^.*cells on /, ''),
    disabled: document.getElementById('outlineBtn')?.disabled,
    note,
  };
});
say(`joined as T-shirt  ${JSON.stringify(which)}`);
if (which.disabled) say('FAIL  the outline toggle is still disabled on a clothing face');
else say('PASS  the outline toggle is offered on a clothing face at once');

// Ink the board first, so the silhouette has to be drawn over real paint.
const box = await page.evaluate(() => {
  const r = document.getElementById('base').getBoundingClientRect();
  return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
});
const sx = Math.round(box.x + box.width * 0.3);
const sy = Math.round(box.y + box.height * 0.4);
await page.mouse.move(sx, sy);
await page.mouse.down();
for (let i = 0; i < 12; i++) {
  await page.mouse.move(Math.round(sx + i * box.width * 0.02), Math.round(sy + i * box.height * 0.01));
}
await page.mouse.up();
await page.waitForTimeout(400);

/**
 * Read a canvas as a fixed-size sample of its pixels.
 *
 * The picture is compared against itself, not against a background count: the
 * panel sits under the board, so "how many pixels are opaque" measures the
 * wrong layer. Each sample is quantised to five bits per channel, which drops
 * the sub-pixel dither the animation always carries and keeps a real repaint
 * from hiding in it.
 */
const SAMPLE_CAP = 20000;
const readCanvas = (id) =>
  page.evaluate((arg) => {
    const { cid, cap } = arg;
    const cv = document.getElementById(cid);
    if (!cv) return null;
    const g = cv.getContext('2d');
    const d = g.getImageData(0, 0, cv.width, cv.height).data;
    const hue = new Uint8Array(4096);
    const n = d.length / 4;
    const stride = Math.max(1, Math.ceil(n / cap));
    const samp = [];
    for (let i = 0; i < n; i += stride) {
      const o = i * 4;
      const k = ((d[o] >> 4) << 8) | ((d[o + 1] >> 4) << 4) | (d[o + 2] >> 4);
      hue[k] = 1;
      samp.push(((d[o] >> 3) << 16) | ((d[o + 1] >> 3) << 8) | (d[o + 2] >> 3));
    }
    let hues = 0;
    for (let i = 0; i < 4096; i++) if (hue[i]) hues++;
    return { w: cv.width, h: cv.height, hues, pixels: n, samp };
  }, { cid: id, cap: SAMPLE_CAP });

const grab = () => readCanvas('base');
const ink3d = () => readCanvas('d3Canvas');

/** Percentage of sampled pixels that changed between two reads. */
const differ = (a, b) => {
  if (!a || !b || a.samp.length !== b.samp.length) return 100;
  let n = 0;
  for (let i = 0; i < a.samp.length; i++) if (a.samp[i] !== b.samp[i]) n++;
  return +((n / a.samp.length) * 100).toFixed(2);
};
// A silhouette covers a third of a board; a stroke covers a fraction of one
// face of a garment. Both are far above the dither floor, which measures 0.
const MOVED = 0.5;

const before = await grab();
say(`board before outline  ${before.w}x${before.h} hues=${before.hues}`);

// The toggle lives in the blueprint panel, which starts closed.
await page.click('#btnTrace');
await page.waitForFunction(() => !document.getElementById('tracePanel').hidden, { timeout: 8000 });
await page.click('#outlineBtn');
await page.waitForTimeout(500);
const during = await grab();
const added = differ(before, during);
say(`board with outline  hues=${during.hues}  pixels changed ${added}%`);
if (added > MOVED) say('PASS  the silhouette is drawn over the board');
else say(`FAIL  the outline toggle changed nothing on the board [${added}%]`);

const note = await page.evaluate(() => document.getElementById('outlineNote').textContent);
say(`note reads ${JSON.stringify(note)}`);
if (/of [\d.,]+ cells on /.test(note)) say('PASS  the note counts cells inside the silhouette');
else say('FAIL  the note did not fill in');

await page.click('#outlineBtn');
await page.waitForTimeout(400);
const off = await grab();
const gone = differ(before, off);
say(`outline off again  pixels changed vs plain ${gone}%`);
if (gone < MOVED) say('PASS  switching off restores the plain board');
else say(`FAIL  outline ink stuck on [${gone}%]`);
// Leave it on so the 3D clip has a silhouette to test with.
await page.click('#outlineBtn');
await page.waitForTimeout(400);

// 3D: the clipped silhouette must paint something and must follow a face switch.
await page.click('#btn3d');
await page.waitForTimeout(900);
const d3 = await ink3d();
say(`3D canvas ${d3.w}x${d3.h} hues=${d3.hues}`);
if (d3.hues > 2) say('PASS  the 3D preview paints something');
else say('FAIL  the 3D preview is blank');

const tabs = await page.evaluate(() => [...document.querySelectorAll('.face[data-face]')].map((t) => t.textContent.trim()));
say(`face tabs ${JSON.stringify(tabs)}`);

/**
 * Paint on the real board, then look at the 3D panel.
 *
 * Dragging inside the 3D canvas cannot work: that canvas is bound to orbit, so
 * a drag turns the garment and the pixels that move are the rotation, not the
 * paint. The board is under the panel while it is shown, so the panel is hidden
 * for the stroke and brought back to read the texture the stroke left behind.
 */
const paint3d = async () => {
  // The default colour is the paper itself, and white on white leaves nothing
  // to measure, so pick a colour that is not.
  await page.evaluate(() => document.querySelectorAll('#swatches .swatch')[3].click());
  await page.click('#btn3d');
  await page.waitForTimeout(300);
  const s = await page.evaluate(() => {
    const b = document.getElementById('stage').getBoundingClientRect();
    return { x: b.x, y: b.y, w: b.width, h: b.height };
  });
  // A patch of colour, not a flick. On a 64x80 face a 40px drag is three cells
  // and lands on a handful of samples in the 3D panel, which is not enough to
  // tell a repaint from the dither. Twelve sweeps is a square a player would
  // actually shade.
  const px = Math.round(s.x + s.w * 0.34);
  const py = Math.round(s.y + s.h * 0.34);
  await page.mouse.move(px, py);
  await page.mouse.down();
  for (let r = 0; r < 12; r++) {
    const y = py + r * 9;
    for (let i = 0; i <= 24; i++) await page.mouse.move(px + i * 8, y + (r % 2 ? 24 - i : i) * 0);
  }
  await page.mouse.up();
  await page.waitForTimeout(300);
  await page.click('#btn3d');
};

await paint3d();
await page.waitForTimeout(900);
const painted = await ink3d();
const landed = differ(d3, painted);
say(`3D after painting on the board: hues ${d3.hues} -> ${painted.hues} pixels changed ${landed}%`);
if (landed > MOVED) say('PASS  paint on the board refreshes the 3D texture');
else say(`FAIL  the 3D preview never repaints [${landed}%]`);

// The preview is a static schematic: every face of the garment at once, in
// fixed positions. Switching the active face must not move it.
await page.evaluate(() => document.querySelectorAll('.face[data-face]')[2].click());
await page.waitForTimeout(900);
const after = await ink3d();
const moved = differ(painted, after);
say(`3D after switching to ${tabs[2]}: pixels changed ${moved}%`);
if (moved < MOVED) say('PASS  the schematic is stable across a face switch');
else say(`FAIL  the schematic jumped for no reason [${moved}%]`);

// The outline belongs to the face on screen and must follow it. Baseline is the
// front face *with* its silhouette on, not the plain board.
await page.click('#btn3d');
await page.waitForTimeout(500);
await page.click('#btnTrace');
await page.waitForFunction(() => !document.getElementById('tracePanel').hidden, { timeout: 8000 });
// The 3D step left the sleeve active. Go back to the front, or this compares a
// face against itself.
await page.evaluate(() => document.querySelectorAll('.face[data-face]')[0].click());
await page.waitForTimeout(700);
const front = await grab();
const noteA = await page.evaluate(() => document.getElementById('outlineNote').textContent);
say(`front with silhouette: ${JSON.stringify(noteA)}`);

await page.evaluate(() => document.querySelectorAll('.face[data-face]')[2].click());
await page.waitForTimeout(700);
const sleeve = await grab();
const noteB = await page.evaluate(() => document.getElementById('outlineNote').textContent);
const moved2 = differ(front, sleeve);
say(`sleeve with silhouette: ${JSON.stringify(noteB)}  pixels vs front ${moved2}%`);
if (moved2 > MOVED) say('PASS  the silhouette follows the face');
else say(`FAIL  the silhouette did not change with the face [${moved2}%]`);
if (noteA !== noteB) say('PASS  the cell count changed for the sleeve');
else say(`FAIL  the count is stuck at ${JSON.stringify(noteA)}`);

await page.click('#outlineBtn');
await page.waitForTimeout(400);
const offAgain = await grab();
const gone2 = differ(sleeve, offAgain);
say(`sleeve silhouette off: pixels changed ${gone2}%`);
if (gone2 > MOVED) say('PASS  the sleeve silhouette switches off too');
else say(`FAIL  the sleeve silhouette is stuck on [${gone2}%]`);

say(errs.length ? `FAIL  page errors: ${JSON.stringify(errs.slice(0, 6))}` : 'PASS  no page or console errors');
await browser.close();
say('done');
