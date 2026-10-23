// Where the 3D frame time actually goes, measured rather than assumed.
//
//   node tools/renderbreakdown.mjs
//
// Drawing both sides of the cloth shell roughly doubled the frame, so before
// guessing at a fix this disables one canvas operation at a time and reports
// what each one costs. A saving that does not show up here is not real.
import { chromium } from 'playwright';

const BASE = process.argv[2] || 'http://localhost:8099';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('pageerror', (e) => console.log('PAGEERROR ' + e));
await page.goto(`${BASE}/?room=BRK1&item=tshirt&renderDelay=0`, { waitUntil: 'load' });
await page.waitForFunction(() => !!document.getElementById('d3Canvas'), null, { timeout: 60000 });

const out = await page.evaluate(async () => {
  const { Preview3D } = await import('./assets/js/game/render3d.js');
  const { bakeCells } = await import('./assets/js/game/cells.js');
  const { CLOTHING } = await import('./assets/js/data/catalog.js');
  const { loadMesh } = await import('./assets/js/game/meshdata.js');
  const cv = document.getElementById('d3Canvas');
  const item = CLOTHING.find((c) => c.id === 'tshirt');
  const mesh = await loadMesh('tshirt');
  const bake = (f, w, h) =>
    bakeCells({ cells: f.cells, width: w, height: h, palette: CLOTHING });
  const pm = new Preview3D(cv, bake, null);
  pm.setMesh(mesh);
  pm.build(item);
  pm.render(true);

  const time = () => {
    const t0 = performance.now();
    for (let i = 0; i < 20; i++) pm.render();
    return (performance.now() - t0) / 20;
  };
  const base = time();

  const ctx = cv.getContext('2d');
  const real = {
    clip: ctx.clip.bind(ctx),
    drawImage: ctx.drawImage.bind(ctx),
    fill: ctx.fill.bind(ctx),
    save: ctx.save.bind(ctx),
    restore: ctx.restore.bind(ctx),
    beginPath: ctx.beginPath.bind(ctx),
  };
  const counts = {};
  const bump = (k) => {
    counts[k] = (counts[k] || 0) + 1;
  };
  for (const k of Object.keys(real)) ctx[k] = (...a) => (bump(k), real[k](...a));
  time();
  const perFrame = {};
  for (const k of Object.keys(counts)) perFrame[k] = Math.round(counts[k] / 20);

  const measure = (mutate) => {
    for (const k of Object.keys(real)) ctx[k] = real[k];
    mutate();
    const ms = time();
    for (const k of Object.keys(real)) ctx[k] = real[k];
    return +ms.toFixed(2);
  };
  return {
    tris: pm._tris.length,
    baseMs: +base.toFixed(2),
    perFrame,
    noClip: measure(() => {
      ctx.clip = () => {};
    }),
    noDrawImage: measure(() => {
      ctx.drawImage = () => {};
    }),
    noFill: measure(() => {
      ctx.fill = () => {};
    }),
    noSaveRestore: measure(() => {
      ctx.save = () => {};
      ctx.restore = () => {};
    }),
  };
});
console.log(JSON.stringify(out, null, 1));
await browser.close();
