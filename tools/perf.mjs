// What the 3D preview actually costs per paint, and whether it holds still.
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';
const log = [];
const say = (s) => { log.push(s); writeFileSync('_perf.txt', log.join('\n') + '\n'); };

const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
p.on('pageerror', (e) => say('PAGEERROR ' + e));
await p.goto('http://localhost:8099/?room=PERF1&item=tshirt&renderDelay=0', { waitUntil: 'load' });
await p.fill('#nick', 'Solo');
await p.click('#join');
await p.waitForFunction(() => !document.getElementById('app').classList.contains('locked'), { timeout: 20000 });
await p.waitForFunction(() => document.getElementById('base').width > 300, { timeout: 8000 });
await p.click('#btn3d');
await p.waitForTimeout(1200);

say('TRIANGLES ' + JSON.stringify(await p.evaluate(() => {
  // Reach the preview through a fresh import of the same module the app uses.
  return { note: 'counted from the render loop below' };
})));

// 1. Does the panel hold still when nobody is painting?
const sig = () => p.evaluate(() => {
  const cv = document.getElementById('d3Canvas');
  const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
  let s = 0;
  for (let i = 0; i < d.length; i += 4009) s = (s * 31 + d[i] + d[i + 1] * 3 + d[i + 2] * 7) % 4294967296;
  return s;
});
const a1 = await sig();
await p.waitForTimeout(700);
const a2 = await sig();
say(`idle frames: ${a1} vs ${a2} -> ${a1 === a2 ? 'STABLE' : 'MOVING (redraw is not deterministic)'}`);

// 2. Cost of one stroke: time the refresh the app runs on paint.
const ms = await p.evaluate(async () => {
  const { Preview3D } = await import('/assets/js/game/render3d.js');
  const { CLOTHING } = await import('/assets/js/game/slots.js');
  const { outlineFor } = await import('/assets/js/game/outline.js');
  const cv = document.createElement('canvas');
  cv.width = 526;
  cv.height = 380;
  cv.getBoundingClientRect = () => ({ width: 526, height: 380 });
  const bake = () => {
    const c = document.createElement('canvas');
    c.width = 64;
    c.height = 80;
    c.getContext('2d').fillRect(0, 0, 64, 80);
    return c;
  };
  const pr = new Preview3D(cv, () => bake(), (id, f) => outlineFor(id, f));
  const item = CLOTHING.find((i) => i.id === 'tshirt');
  const n = pr.build(item);
  pr.render();
  let t0 = performance.now();
  for (let i = 0; i < 20; i++) pr.render();
  const render = (performance.now() - t0) / 20;
  t0 = performance.now();
  for (let i = 0; i < 20; i++) pr.refresh();
  const refresh = (performance.now() - t0) / 20;
  return { tris: n, renderMs: +render.toFixed(2), refreshMs: +refresh.toFixed(2) };
});
say('COST ' + JSON.stringify(ms));

// 3. How big does the garment actually render now?
say('FILL ' + JSON.stringify(await p.evaluate(() => {
  const cv = document.getElementById('d3Canvas');
  const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
  // #c2ccd3
  const back = [194, 204, 211];
  let other = 0;
  let lum = 0;
  let max = 0;
  let min = 999;
  for (let i = 0; i < d.length; i += 4) {
    const near = Math.abs(d[i] - back[0]) < 6 && Math.abs(d[i + 1] - back[1]) < 6 && Math.abs(d[i + 2] - back[2]) < 6;
    if (!near) {
      other++;
      const L = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      lum += L;
      if (L > max) max = L;
      if (L < min) min = L;
    }
  }
  const total = d.length / 4;
  return {
    pct: +((other / total) * 100).toFixed(1),
    avgLum: other ? +(lum / other).toFixed(0) : 0,
    maxLum: +max.toFixed(0),
    minLum: other ? +min.toFixed(0) : 0,
    backdropLum: 0.2126 * 194 + 0.7152 * 204 + 0.0722 * 211,
  };
})));
await p.screenshot({ path: '_shots/perf.png' });
await b.close();
