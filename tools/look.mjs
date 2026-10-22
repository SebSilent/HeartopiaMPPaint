// What colours are actually in the 3D panel, and where.
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';
const log = [];
const say = (s) => { log.push(s); writeFileSync('_look.txt', log.join('\n') + '\n'); };

const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
p.on('pageerror', (e) => say('PAGEERROR ' + e));
await p.goto('http://localhost:8099/?room=LOOK7&item=tshirt&renderDelay=0', { waitUntil: 'load' });
await p.fill('#nick', 'Solo');
await p.click('#join');
await p.waitForFunction(() => !document.getElementById('app').classList.contains('locked'), { timeout: 20000 });
await p.waitForFunction(() => document.getElementById('base').width > 300, { timeout: 8000 });
await p.click('#btn3d');
await p.waitForTimeout(1400);

say(JSON.stringify(await p.evaluate(() => {
  const cv = document.getElementById('d3Canvas');
  const ctx = cv.getContext('2d');
  const d = ctx.getImageData(0, 0, cv.width, cv.height).data;
  const tally = new Map();
  for (let i = 0; i < d.length; i += 4) {
    const k = d[i] + ',' + d[i + 1] + ',' + d[i + 2];
    tally.set(k, (tally.get(k) || 0) + 1);
  }
  const top = [...tally.entries()].sort((a, b2) => b2[1] - a[1]).slice(0, 8).map(([k, v]) => k + ' x' + v);
  const cx = Math.floor(cv.width / 2);
  const cy = Math.floor(cv.height / 2);
  const at = (x, y) => {
    const q = ctx.getImageData(x, y, 1, 1).data;
    return q[0] + ',' + q[1] + ',' + q[2];
  };
  // A horizontal scan through the middle: where does the backdrop stop?
  const row = [];
  let run = null;
  let n = 0;
  for (let x = 0; x < cv.width; x++) {
    const k = at(x, cy);
    if (k === run) n++;
    else {
      if (run) row.push(run + ' x' + n);
      run = k;
      n = 1;
    }
  }
  row.push(run + ' x' + n);
  return { size: cv.width + 'x' + cv.height, top, centre: at(cx, cy), midRow: row.slice(0, 12) };
})));
await b.close();
