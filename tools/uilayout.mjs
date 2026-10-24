// What is actually overlapping in the right-hand dock? Not a guess from reading
// CSS: walk every control, take its box, and report pairs that intersect.
//
// Usage: node tools/uilayout.mjs [base]
import { chromium } from 'playwright';

const BASE = (process.argv[2] || 'http://localhost:8099').replace(/\/$/, '');

const browser = await chromium.launch();
const SIZES = [
  ['desktop', 1280, 720],
  ['ipad-landscape', 1024, 768],
  ['ipad-portrait', 768, 1024],
  ['phone', 390, 844],
];

for (const [name, w, h] of SIZES) {
  const page = await browser.newPage({ viewport: { width: w, height: h }, hasTouch: true });
  page.on('pageerror', (e) => console.log('  PAGEERROR ' + e));
  await page.goto(`${BASE}/?local=1&item=book`, { waitUntil: 'load' });
  await page.waitForFunction(() => document.querySelectorAll('#tools [data-tool]').length >= 8, null, { timeout: 20000 });
  // Load a brush tip too, since that is the newest control in the row and the
  // one most likely to change the row's width.
  await page.evaluate(() => {
    const b = document.getElementById('tipBtn');
    if (!b) return;
    b.classList.add('set');
    // The app builds the thumbnail only when a tip is set (setTip in ui.js),
    // so mirror that here to measure the row with the thumb in place.
    let i = b.querySelector('img');
    if (!i) {
      i = document.createElement('img');
      i.id = 'tipImg';
      i.alt = '';
      b.prepend(i);
    }
    if (!i.src.includes('data:')) i.src =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAF0lEQVR4nGP8z8DwnwEGMDAmAG0JFw0YBgsA5gAAAAZlAQKQcAAAAASUVORK5CYII=';
  });
  await page.waitForTimeout(400);

  const report = await page.evaluate(() => {
    const roots = [document.getElementById('dock'), document.getElementById('faces'), document.querySelector('.bar-right')].filter(Boolean);
    const sel = 'button, img, .swatch, .brush, .tool, .chip, .faces > *, .groups > *';
    const els = [];
    for (const root of roots) {
      for (const el of root.querySelectorAll(sel)) {
        const r = el.getBoundingClientRect();
        if (r.width < 1 || r.height < 1) continue;
        if (getComputedStyle(el).visibility === 'hidden') continue;
        els.push({
          el,
          tag: el.tagName.toLowerCase(),
          id: el.id || '',
          cls: (el.className || '').toString().slice(0, 30),
          box: { x: r.x, y: r.y, w: r.width, h: r.height },
        });
      }
    }
    const label = (e) => `${e.tag}${e.id ? '#' + e.id : ''}${e.cls ? '.' + e.cls.split(' ')[0] : ''}`;
    const hits = [];
    for (let i = 0; i < els.length; i++) {
      for (let j = i + 1; j < els.length; j++) {
        const a = els[i];
        const b = els[j];
        // Nested elements overlap by design; only siblings/foreign elements are a bug.
        if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
        const ox = Math.min(a.box.x + a.box.w, b.box.x + b.box.w) - Math.max(a.box.x, b.box.x);
        const oy = Math.min(a.box.y + a.box.h, b.box.y + b.box.h) - Math.max(a.box.y, b.box.y);
        if (ox > 3 && oy > 3) hits.push({ a: label(a), b: label(b), ox: +ox.toFixed(1), oy: +oy.toFixed(1), at: [Math.round(a.box.x), Math.round(a.box.y)] });
      }
    }
    // Anything hanging outside its own container is the other half of "overlapping".
    const spill = [];
    for (const e of els) {
      const p = e.el.parentElement;
      if (!p) continue;
      const pr = p.getBoundingClientRect();
      const over = e.box.x + e.box.w - (pr.x + pr.width);
      if (over > 3) spill.push({ a: label(e), over: +over.toFixed(1), parent: p.className ? String(p.className).split(' ')[0] : p.tagName });
    }
    const dock = document.getElementById('dock');
    const dr = dock ? dock.getBoundingClientRect() : null;
    return {
      hits: hits.slice(0, 24),
      hitCount: hits.length,
      spill: spill.slice(0, 12),
      spillCount: spill.length,
      dock: dr ? { x: Math.round(dr.x), y: Math.round(dr.y), w: Math.round(dr.width), h: Math.round(dr.height) } : null,
      count: els.length,
    };
  });
  console.log(`\n== ${name} ${w}x${h} ==`);
  console.log(`  dock ${JSON.stringify(report.dock)}  controls measured ${report.count}`);
  console.log(`  overlaps ${report.hitCount}`);
  for (const x of report.hits) console.log(`    ${x.a}  <->  ${x.b}   ${x.ox}x${x.oy}px at ${x.at}`);
  if (report.spillCount) {
    console.log(`  sticking out of their container ${report.spillCount}`);
    for (const x of report.spill) console.log(`    ${x.a} out of .${x.parent} by ${x.over}px`);
  }
  await page.screenshot({ path: `_shots/uilayout-${name}.png` });
  await page.close();
}
await browser.close();
