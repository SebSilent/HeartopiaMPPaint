// Does the face mask actually exist for a garment, or does it come back null and
// the bake silently fall back to a full rectangle? One of the two, and the
// difference is the whole fix.
import { chromium } from 'playwright';

const BASE = (process.argv[2] || 'http://localhost:8099').replace(/\/$/, '');
const PREFIX = new URL(BASE).pathname.replace(/\/$/, '');
const ITEM = process.argv[3] || 'tshirt';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (e) => console.log('PAGEERROR ' + e));
await page.goto(`${BASE}/?local=1&item=${ITEM}`, { waitUntil: 'load' });
await page.waitForFunction(() => document.querySelectorAll('#tools [data-tool]').length >= 8, null, { timeout: 20000 });

const out = await page.evaluate(async (args) => {
  const { maskFor, faceInfo, hasFaceOutline } = await import(`${args.prefix}/assets/js/game/faces.js`);
  const { findItem } = await import(`${args.prefix}/assets/js/game/slots.js`);
  const item = findItem(args.item);
  const rows = [];
  for (const f of item.faces) {
    const info = faceInfo(item.id, f.id);
    const m = maskFor(item.id, f.id);
    let inside = 0;
    if (m) for (let i = 0; i < m.length; i++) inside += m[i];
    rows.push({
      face: f.id,
      slots: `${f.w}x${f.h}`,
      faceInfo: info ? `${info.w}x${info.h}` : 'NONE',
      outline: hasFaceOutline(item.id, f.id),
      mask: m ? `${inside}/${m.length}` : 'NULL',
      // A mask whose size does not match the face cannot be used to clip it.
      matches: m ? m.length === f.w * f.h : false,
    });
  }
  return rows;
}, { prefix: PREFIX, item: ITEM });

for (const r of out) console.log(JSON.stringify(r));
await browser.close();
