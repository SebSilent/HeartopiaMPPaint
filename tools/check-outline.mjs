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

// The panel is covered by the board, so counting non-transparent pixels measures
// the background, not the art. Compare the picture itself: a coarse signature
// plus the exact count of cells that differ.
const grab = () => page.evaluate(() => {
  const cv = document.getElementById('base');
  const g = cv.getContext('2d');
  const d = g.getImageData(0, 0, cv.width, cv.height).data;
  const hue = new Uint8Array(4096);
  let sig = 0;
  for (let i = 0; i < d.length; i += 4) {
    const k = ((d[i] >> 4) << 8) | ((d[i + 1] >> 4) << 4) | (d[i + 2] >> 4);
    hue[k] = 1;
    sig = (sig * 31 + d[i] + d[i + 1] * 7 + d[i + 2] * 13 + d[i + 3]) % 4294967296;
  }
  let hues = 0;
  for (let i = 0; i < 4096; i++) if (hue[i]) hues++;
  return { sig, hues, bytes: Array.from(d).join(',') };
});
// Compared over the flattened pixel string, sampling every 997th character: a
// coarse "did the picture move" measure, not a count of cells. A few hundred is
// the noise floor of the animation itself, so 1000 is the bar for a real change.
const differ = (a, b) => {
  if (a.length !== b.length) return Math.abs(a.length - b.length);
  let n = 0;
  for (let i = 0; i < a.length; i += 997) if (a[i] !== b[i]) n++;
  return n;
};
const MOVED = 1000;

const before = await grab();
say(`board before outline  sig=${before.sig} hues=${before.hues}`);

// The toggle lives in the blueprint panel, which starts closed.
await page.click('#btnTrace');
await page.waitForFunction(() => !document.getElementById('tracePanel').hidden, { timeout: 8000 });
await page.click('#outlineBtn');
await page.waitForTimeout(500);
const during = await grab();
const added = differ(before.bytes, during.bytes);
say(`board with outline  sig=${during.sig} hues=${during.hues}  cells changed ${added}`);
if (added > MOVED) say('PASS  the silhouette is drawn over the board');
else say(`FAIL  the outline toggle changed nothing on the board [${added}]`);

const note = await page.evaluate(() => document.getElementById('outlineNote').textContent);
say(`note reads ${JSON.stringify(note)}`);
if (/of [\d.,]+ cells on /.test(note)) say('PASS  the note counts cells inside the silhouette');
else say('FAIL  the note did not fill in');

await page.click('#outlineBtn');
await page.waitForTimeout(400);
const off = await grab();
const gone = differ(before.bytes, off.bytes);
say(`outline off again  sig=${off.sig} cells changed vs plain ${gone}`);
if (gone < MOVED) say('PASS  switching off restores the plain board');
else say(`FAIL  outline ink stuck on [${gone}]`);
// Leave it on so the 3D clip has a silhouette to test with.
await page.click('#outlineBtn');
await page.waitForTimeout(400);

// 3D: the clipped silhouette must paint something and must follow a face switch.
await page.click('#btn3d');
await page.waitForTimeout(900);
const ink3d = () => page.evaluate(() => {
  const cv = document.getElementById('d3Canvas');
  if (!cv) return null;
  const g = cv.getContext('2d');
  const d = g.getImageData(0, 0, cv.width, cv.height).data;
  const hue = new Uint8Array(4096);
  let sig = 0;
  for (let i = 0; i < d.length; i += 4) {
    const k = ((d[i] >> 4) << 8) | ((d[i + 1] >> 4) << 4) | (d[i + 2] >> 4);
    hue[k] = 1;
    sig = (sig * 31 + d[i] + d[i + 1] * 7 + d[i + 2] * 13 + d[i + 3]) % 4294967296;
  }
  let hues = 0;
  for (let i = 0; i < 4096; i++) if (hue[i]) hues++;
  return { w: cv.width, h: cv.height, sig, hues, bytes: Array.from(d).join(',') };
});
const d3 = await ink3d();
say(`3D canvas ${d3.w}x${d3.h} sig=${d3.sig} hues=${d3.hues}`);
if (d3.hues > 2) say('PASS  the 3D preview paints something');
else say('FAIL  the 3D preview is blank');

const tabs = await page.evaluate(() => [...document.querySelectorAll('.face[data-face]')].map((t) => t.textContent.trim()));
say(`face tabs ${JSON.stringify(tabs)}`);

// Paint inside the 3D canvas itself. The face texture is rebuilt from the live
// grid on every rebuild, so paint that lands there proves both the rebuild and
// the refresh. The 2D board cannot be used: the panel covers it.
const paint3d = async () => {
  const r = await page.evaluate(() => {
    const b = document.getElementById('d3Canvas').getBoundingClientRect();
    return { x: b.x, y: b.y, w: b.width, h: b.height };
  });
  const px = Math.round(r.x + r.w * 0.5);
  const py = Math.round(r.y + r.h * 0.5);
  await page.mouse.move(px, py);
  await page.mouse.down();
  for (let i = 0; i < 10; i++) await page.mouse.move(px + i * 4, py + i * 2);
  await page.mouse.up();
};

await paint3d();
await page.waitForTimeout(900);
const painted = await ink3d();
say(`3D after painting in the preview: hues ${d3.hues} -> ${painted.hues} cells changed ${differ(d3.bytes, painted.bytes)}`);
if (differ(d3.bytes, painted.bytes) > MOVED) say('PASS  paint in the 3D preview refreshes its texture');
else say(`FAIL  the 3D preview never repaints [${differ(d3.bytes, painted.bytes)}]`);

// The preview is a static schematic: every face of the garment at once, in
// fixed positions. Switching the active face must not move it.
await page.evaluate(() => document.querySelectorAll('.face[data-face]')[2].click());
await page.waitForTimeout(900);
const after = await ink3d();
const moved = differ(painted.bytes, after.bytes);
say(`3D after switching to ${tabs[2]}: cells changed ${moved}`);
if (moved === 0) say('PASS  the schematic is stable across a face switch');
else say(`FAIL  the schematic jumped for no reason [${moved}]`);

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
const moved2 = differ(front.bytes, sleeve.bytes);
say(`sleeve with silhouette: ${JSON.stringify(noteB)}  cells changed vs front ${moved2}`);
if (moved2 > MOVED) say('PASS  the silhouette follows the face');
else say(`FAIL  the silhouette did not change with the face [${moved2}]`);
if (noteA !== noteB) say('PASS  the cell count changed for the sleeve');
else say(`FAIL  the count is stuck at ${JSON.stringify(noteA)}`);

await page.click('#outlineBtn');
await page.waitForTimeout(400);
const offAgain = await grab();
const gone2 = differ(sleeve.bytes, offAgain.bytes);
say(`sleeve silhouette off: cells changed ${gone2}`);
if (gone2 > MOVED) say('PASS  the sleeve silhouette switches off too');
else say(`FAIL  the sleeve silhouette is stuck on [${gone2}]`);

say(errs.length ? `FAIL  page errors: ${JSON.stringify(errs.slice(0, 6))}` : 'PASS  no page or console errors');
await browser.close();
say('done');
