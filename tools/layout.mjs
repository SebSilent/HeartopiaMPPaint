// Does the drawn board ever hide behind a panel, at real device sizes?
// Measured from pixels, not from app internals: what a user actually sees.
import { chromium } from 'playwright';

const SIZES = [
  ['desktop 1280x720', 1280, 720, false],
  ['desktop 1024x768', 1024, 768, false],
  ['laptop 1440x900', 1440, 900, false],
  ['ipad land 1024x768', 1024, 768, true],
  ['ipad port 768x1024', 768, 1024, true],
  ['phone 390x844', 390, 844, true],
  ['phone land 844x390', 844, 390, true],
  ['narrow 900x700', 900, 700, false],
];

const BASE = process.argv[2] || 'http://localhost:8099';

// Port 8080 on this machine belongs to an unrelated app that answers on both
// localhost and 127.0.0.1, and will happily serve a page that is not ours.
const html = await (await fetch(`${BASE}/index.html`)).text();
if (!/id="app"/.test(html) || !/Heartopia/.test(html)) {
  throw new Error(`${BASE}/index.html is not this project - refusing to measure it`);
}

const browser = await chromium.launch();
for (const [name, w, h, touch] of SIZES) {
  const page = await browser.newPage({ viewport: { width: w, height: h }, hasTouch: touch, isMobile: touch });
  await page.goto(`${BASE}/?room=LAY${Math.round(w)}${h}&item=tshirt`, { waitUntil: 'load' });
  await page.fill('#nick', 'Layout');
  await page.click('#join');
  await page.waitForFunction(() => !document.getElementById('app').classList.contains('locked'), { timeout: 20000 });
  await page.waitForTimeout(1200);

  const r = await page.evaluate(() => {
    const rect = (sel) => {
      const el = document.querySelector(sel);
      if (!el || el.hidden) return null;
      const b = el.getBoundingClientRect();
      if (b.width < 1 || b.height < 1) return null;
      return { l: Math.round(b.left), t: Math.round(b.top), r: Math.round(b.right), b: Math.round(b.bottom) };
    };
    // The board is the only thing on #base that is not the stage backdrop, so
    // its on-screen box is the box of pixels that differ from a corner.
    const cv = document.getElementById('base');
    const cr = cv.getBoundingClientRect();
    const img = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height);
    const d = img.data;
    const at = (i) => [d[i], d[i + 1], d[i + 2], d[i + 3]];
    const bg = at(0);
    const far = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]) > 24;
    let l = img.width, t = img.height, rr = -1, bb = -1;
    for (let y = 0; y < img.height; y++) {
      for (let x = 0; x < img.width; x++) {
        if (!far(at((y * img.width + x) * 4), bg)) continue;
        if (x < l) l = x;
        if (x > rr) rr = x;
        if (y < t) t = y;
        if (y > bb) bb = y;
      }
    }
    const k = cr.width / img.width;
    const board = rr < 0 ? null : {
      l: Math.round(cr.left + l * k),
      t: Math.round(cr.top + t * k),
      r: Math.round(cr.left + (rr + 1) * k),
      b: Math.round(cr.top + (bb + 1) * k),
    };
    const panels = {
      dock: rect('#dock'),
      trace: rect('#tracePanel'),
      import: rect('#importPanel'),
      d3: rect('#d3Panel'),
      faces: rect('#faceBar') || rect('.faces'),
      bar: rect('#bar') || rect('.bar'),
      zoom: rect('.zoom') || rect('#zoomCtl'),
    };
    const inter = (a, b) => {
      if (!a || !b) return 0;
      const iw = Math.min(a.r, b.r) - Math.max(a.l, b.l);
      const ih = Math.min(a.b, b.b) - Math.max(a.t, b.t);
      return iw > 0 && ih > 0 ? iw * ih : 0;
    };
    let worst = 0, where = '';
    for (const [k2, p] of Object.entries(panels)) {
      const a = inter(board, p);
      if (a > worst) { worst = a; where = k2; }
    }
    const area = board ? (board.r - board.l) * (board.b - board.t) : 0;
    return { board, panels, worst, where, pct: area ? Math.round((worst / area) * 1000) / 10 : 0 };
  });

  console.log(
    name.padEnd(19),
    'board', r.board ? `${r.board.l},${r.board.t}-${r.board.r},${r.board.b}`.padEnd(21) : 'none'.padEnd(21),
    'dock', r.panels.dock ? `${r.panels.dock.l}-${r.panels.dock.r}`.padEnd(11) : 'none'.padEnd(11),
    'hidden', String(r.worst).padStart(7), 'px', String(r.pct).padStart(5) + '%', r.where
  );
  await page.screenshot({ path: `_shots/layout-${w}x${h}.png` });
  await page.close();
}
await browser.close();
