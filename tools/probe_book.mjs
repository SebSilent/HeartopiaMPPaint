// Does the 3D preview actually draw the book's rounded solid, and does the
// toolbar correctly disable itself when an item has no 3D? Measured in a browser
// because the answer is pixels on a canvas plus a real click on a real button.
import { chromium } from 'playwright';

const BASE = (process.argv[2] || 'http://localhost:8099').replace(/\/$/, '');
const browser = await chromium.launch();
const fail = [];
const note = (s) => console.log(s);

async function open(item) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e)));
  await page.goto(`${BASE}/?local=1&item=${item}&renderDelay=0`, { waitUntil: 'load' });
  await page.waitForFunction(() => !document.getElementById('app').classList.contains('locked'), { timeout: 20000 });
  await page.waitForFunction(() => document.getElementById('base').width > 300, { timeout: 10000 });
  return { page, errs };
}

// The panel paints an opaque backdrop first, so alpha says nothing. Measure what
// differs from the corner colour, which is the only way to see the silhouette.
const STATS = () => {
  const c = document.getElementById('d3Canvas');
  if (!c || !c.width) return null;
  const x = c.getContext('2d');
  const d = x.getImageData(0, 0, c.width, c.height).data;
  const bg = [d[0], d[1], d[2]];
  const near = (i) =>
    Math.abs(d[i] - bg[0]) + Math.abs(d[i + 1] - bg[1]) + Math.abs(d[i + 2] - bg[2]) < 24;
  let n = 0, minX = 1e9, maxX = -1, minY = 1e9, maxY = -1;
  const rows = [];
  for (let py = 0; py < c.height; py++) {
    let inRow = 0;
    for (let px = 0; px < c.width; px++) {
      const i = (py * c.width + px) * 4;
      if (d[i + 3] > 8 && !near(i)) {
        n++; inRow++;
        if (px < minX) minX = px;
        if (px > maxX) maxX = px;
        if (py < minY) minY = py;
        if (py > maxY) maxY = py;
      }
    }
    rows.push(inRow);
  }
  return { n, box: [minX, minY, maxX, maxY], rows, w: c.width, h: c.height, bg };
};

// Paint a bold band across the board so the drawn solid is not the same colour
// as the empty canvas, and so the shape we measure is real texture.
async function paintBand(page) {
  const box = await page.locator('#base').boundingBox();
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.5);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) {
    await page.mouse.move(box.x + box.width * (0.3 + 0.05 * i), box.y + box.height * 0.5);
  }
  await page.mouse.up();
  await page.waitForTimeout(250);
}

/* ---- 1. the book renders a solid ---- */
{
  const { page, errs } = await open('book');
  const off = await page.evaluate(() => document.getElementById('btn3d').disabled);
  if (off) fail.push('book: the 3D button is disabled but the book has a solid');
  await paintBand(page);
  await page.click('#btn3d');
  await page.waitForFunction(() => {
    const c = document.getElementById('d3Canvas');
    return c && c.width > 100;
  }, { timeout: 10000 });
  await page.waitForTimeout(900);
  const s = await page.evaluate(STATS);
  if (!s) fail.push('book: no 3D canvas was drawn');
  else {
    const bw = s.box[2] - s.box[0] + 1;
    const bh = s.box[3] - s.box[1] + 1;
    const bk = await page.evaluate(() => document.getElementById('d3Kind').textContent);
  note(`book: front view pixels=${s.n} box=${bw}x${bh} canvas=${s.w}x${s.h} kind="${bk}"`);
  if (!/3D model/.test(bk)) fail.push(`the book is not labelled as a model: "${bk}"`);
    if (s.n < 4000) fail.push(`book: only ${s.n} pixels drawn - the solid is not appearing`);
    // Folded, the book is 66 cells across the cover by 84 down the spine, so it
    // stands portrait. A landscape silhouette would mean the cover was laid
    // flat instead of wrapped.
    if (bh <= bw) fail.push(`book: silhouette ${bw}x${bh} is not portrait - the cover is not folded`);
  }

  // The test that separates a solid from a diagram: look down the book's height
  // axis. A flat panel turns into a line and vanishes; a real book shows its
  // cover-to-spine profile, 26 cells deep, with the spine bowing out of it.
  const box = await page.locator('#d3Canvas').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  // pitch += -dy*0.45, so dragging up 170px tips from 14 deg to about 90.
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 - 170, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(500);
  const top = await page.evaluate(STATS);
  if (!top) fail.push('book: nothing drawn after orbiting to the top view');
  else {
    const tw = top.box[2] - top.box[0] + 1;
    const th = top.box[3] - top.box[1] + 1;
    note(`book: top view pixels=${top.n} box=${tw}x${th}`);
    // Edge-on, a panel is a few pixels of seam bleed. A solid keeps its depth.
    if (top.n < 3000) {
      fail.push(`book: only ${top.n} pixels from the top - it has no depth, so it is a flat panel`);
    }
    // The spine bulge means the profile is not a rectangle: its widest row sits
    // where the spine is, and the row widths change smoothly across it.
    const rows = top.rows.filter((r) => r > 0);
    if (rows.length) {
      const widest = Math.max(...rows);
      const nWidest = rows.filter((r) => r === widest).length;
      const distinct = new Set(rows).size;
      note(`book: profile ${rows.length} rows, widest ${widest} x${nWidest}, ${distinct} distinct widths`);
      if (distinct < 4) {
        fail.push(`book: the profile has only ${distinct} distinct widths - the spine is a mitred corner, not round`);
      }
    }
  }
  if (errs.length) fail.push(`book: page errors ${errs.join(' | ')}`);
  await page.close();
}

/* ---- 2. a garment still renders (the mesh path was not broken) ---- */
{
  const { page, errs } = await open('tshirt');
  await paintBand(page);
  await page.click('#btn3d');
  await page.waitForFunction(() => {
    const c = document.getElementById('d3Canvas');
    return c && c.width > 100;
  }, { timeout: 10000 });
  await page.waitForTimeout(900);
  const s = await page.evaluate(STATS);
  note(`tshirt: pixels=${s && s.n}`);
  if (!s || s.n < 4000) fail.push(`tshirt: ${s ? s.n : 'nothing'} pixels - the mesh path regressed`);
  if (errs.length) fail.push(`tshirt: page errors ${errs.join(' | ')}`);
  await page.close();
}

/* ---- 3. a garment opens the panel normally ---- */
{
  const { page, errs } = await open('tshirt');
  const res = await page.evaluate(async () => {
    const btn = document.getElementById('btn3d');
    const disabled = btn.disabled;
    btn.click();
    await new Promise((r) => setTimeout(r, 400));
    return { disabled, opened: !document.getElementById('d3Panel').hidden };
  });
  note(`garment button: disabled=${res.disabled} panel opened=${res.opened}`);
  if (res.disabled) fail.push('a garment with a mesh has its 3D button disabled');
  if (!res.opened) fail.push('clicking 3D on a garment did not open the panel');
  if (errs.length) fail.push(`garment: page errors ${errs.join(' | ')}`);
  await page.close();
}

/* ---- 4. the panel admits what a flat layout is ---- */
{
  const { page, errs } = await open('sofa1');
  await page.click('#btn3d');
  await page.waitForTimeout(600);
  const r = await page.evaluate(() => ({
    kind: document.getElementById('d3Kind').textContent,
    cls: document.getElementById('d3Kind').className,
    disabled: document.getElementById('btn3d').disabled,
  }));
  note(`sofa1: "${r.kind}" [${r.cls}] disabled=${r.disabled}`);
  if (!/flat/.test(r.kind)) fail.push(`furniture is not labelled as a flat layout: "${r.kind}"`);
  if (!/is-flat/.test(r.cls)) fail.push('the flat-layout warning style is not applied');
  if (r.disabled) fail.push('furniture should still open its layout, but the button is disabled');
  if (errs.length) fail.push(`sofa1: page errors ${errs.join(' | ')}`);
  await page.close();
}

/* ---- 5. the availability table itself, in the browser's module graph ---- */
{
  const { page } = await open('tshirt');
  const r = await page.evaluate(async () => {
    const m = await import('/assets/js/game/solid.js');
    return {
      book: m.sourceFor('book'),
      tshirt: m.sourceFor('tshirt'),
      canvas: m.sourceFor('canvas-square-1'),
      junk: m.sourceFor('nope'),
      undef: m.sourceFor(undefined),
      empty: m.sourceFor(''),
    };
  });
  note('sourceFor: ' + JSON.stringify(r));
  if (r.book !== 'solid') fail.push(`book claims '${r.book}'`);
  if (r.tshirt !== 'mesh') fail.push(`tshirt claims '${r.tshirt}'`);
  if (r.junk !== null) fail.push(`an unknown item claims '${r.junk}'`);
  if (r.undef !== null || r.empty !== null) fail.push('a missing id must claim nothing, not throw');
  await page.close();
}

await browser.close();
for (const f of fail) console.log('FAIL ' + f);
console.log(fail.length ? `\n${fail.length} PROBLEM(S)` : '\nPASS: the book renders as a rounded solid, garments still render, and unknown items are refused.');
process.exit(fail.length ? 1 : 0);
