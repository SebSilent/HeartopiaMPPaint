/*
 * Import, end to end, with images built here rather than downloaded: a photo and
 * a fake in-game screenshot. The claim being tested is that a picture becomes
 * cells on the board and that the board then actually shows them.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const STATIC = 8123;
const RELAY = 8787;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.cjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json' };

const server = http.createServer((req, res) => {
  let rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (rel === '/') rel = '/index.html';
  const file = path.join(ROOT, rel.replace(/^([./\\])+/, ''));
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return res.writeHead(404).end('no');
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
  fs.createReadStream(file).pipe(res);
});
const relay = require('child_process').spawn(process.execPath, [path.join(ROOT, 'server', 'relay.js')], {
  env: { ...process.env, PORT: String(RELAY) },
  stdio: ['ignore', 'ignore', 'inherit'],
});

// The 125 shades as the strings getImageData will give back.
const PAL_KEYS = (() => {
  const { FLAT_COLORS } = require('./../assets/js/data/heartopia-palette.js');
  return new Set(
    FLAT_COLORS.slice(1).map((h) => {
      const n = parseInt(h.slice(1), 16);
      return `${(n >> 16) & 255},${(n >> 8) & 255},${n & 255}`;
    })
  );
})();

/* ---------- a real PNG, written by hand ---------- */

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
/** rgb(x,y) -> PNG buffer. */
function png(w, h, rgb) {
  const raw = Buffer.alloc(h * (1 + w * 3));
  for (let y = 0; y < h; y++) {
    raw[y * (1 + w * 3)] = 0; // filter: none
    for (let x = 0; x < w; x++) {
      const [r, g, b] = rgb(x, y);
      const o = y * (1 + w * 3) + 1 + x * 3;
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const results = [];
function ok(name, pass, detail) {
  results.push(pass);
  console.log((pass ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  [' + detail + ']' : ''));
}

async function join(page, nick) {
  await page.fill('#nick', nick);
  await page.click('#join');
  await page.waitForFunction(() => !document.getElementById('app').classList.contains('locked'), { timeout: 15000 });
  await page.waitForFunction(() => document.getElementById('base').width > 300, { timeout: 8000 });
}

/**
 * Count cells that hold a palette shade.
 *
 * NOT "chromatic pixels": the board's brown drop shadow is chromatic and dark,
 * so that test reported 31,897 pixels on a board nobody had painted and every
 * before/after comparison was meaningless.
 */
const paintCells = ([palList]) => {
  // Sets do not survive the trip into the page - they serialise to {} - so the
  // list arrives as an array and is rebuilt here.
  const pal = new Set(palList);
  const c = document.getElementById('base');
  const d = c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, c.width, c.height).data;
  const seen = new Set();
  let pixels = 0;
  for (let i = 0; i < d.length; i += 4) {
    const k = d[i] + ',' + d[i + 1] + ',' + d[i + 2];
    if (pal.has(k)) {
      seen.add(k);
      pixels++;
    }
  }
  return { shades: seen.size, pixels };
};

(async () => {
  await new Promise((r) => server.listen(STATIC, r));
  await new Promise((r) => setTimeout(r, 900));
  const browser = await chromium.launch();
  const errors = [];

  /* ---------------- photo ---------------- */

  {
    const ctx = await browser.newContext({ viewport: { width: 1024, height: 768 } });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push('photo: ' + e.message));
    page.on('dialog', (d) => d.accept().catch(() => {}));
    const code = 'PHOTO' + Math.floor(Math.random() * 900 + 100);
    await page.goto(`http://127.0.0.1:${STATIC}/?relay=ws://127.0.0.1:${RELAY}/&room=${code}&renderDelay=0`, { waitUntil: 'load' });
    await join(page, 'Photo');

    // Three hard-edged bands: a picture the palette can absorb cleanly.
    const img = png(160, 120, (x, y) => (y < 40 ? [220, 40, 40] : y < 80 ? [40, 200, 60] : [40, 60, 220]));
    await page.click('#btnImport');
    await page.setInputFiles('#file', { name: 'bands.png', mimeType: 'image/png', buffer: img });
    await page.waitForFunction(() => !document.getElementById('importApply').disabled, { timeout: 8000 });
    const info = await page.textContent('#importInfo');
    ok('a photo is read and previewed', /×/.test(info) && /shades/.test(info), JSON.stringify(info));
    // Three hard bands must not arrive as one flat shade. This is the assertion
    // that catches a broken pixel path, which otherwise "succeeds" in colour.
    const shadesFound = Number((info.match(/(\d+)\s+shades/) || [])[1] || 0);
    ok('and keeps the bands apart instead of flattening them', shadesFound >= 3, JSON.stringify(info));

    const prev = await page.evaluate(() => {
      const box = document.getElementById('importPrev');
      const c = box.querySelector('canvas');
      return { boxH: Math.round(box.getBoundingClientRect().height), hasCanvas: !!c, attr: c ? [c.width, c.height] : null };
    });
    ok('the preview is shown, not nested in a canvas', prev.hasCanvas && prev.boxH > 40, JSON.stringify(prev));

    const before = await page.evaluate(paintCells, [[...PAL_KEYS]]);
    await page.click('#importApply');
    await page.waitForTimeout(600);
    const after = await page.evaluate(paintCells, [[...PAL_KEYS]]);
    ok('a new board holds no palette colour at all', before.shades === 0, JSON.stringify(before));
    ok('applying a photo puts palette shades on the board', after.shades > 0 && after.pixels > 500, JSON.stringify(after));
    ok('the panel closes after applying', !(await page.isVisible('#importPanel')));
    await page.screenshot({ path: path.join(ROOT, '_shots', 'import-photo.png') });
    await ctx.close();
  }

  /* ---------------- screenshot ---------------- */

  {
    const ctx = await browser.newContext({ viewport: { width: 1024, height: 768 } });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push('shot: ' + e.message));
    page.on('dialog', (d) => d.accept().catch(() => {}));
    const code = 'SHOT' + Math.floor(Math.random() * 900 + 100);
    await page.goto(`http://127.0.0.1:${STATIC}/?relay=ws://127.0.0.1:${RELAY}/&room=${code}&renderDelay=0`, { waitUntil: 'load' });
    await join(page, 'Shooter');

    // The screenshot has to be the board the room is actually on: Medium 1:1,
    // 50 x 50 (presets.js). The tool asks for the current face first and only
    // falls back to a blind hunt, so this exercises the expected path.
    const C = 50;
    const R = 50;
    const P = 8;
    const PAD = 40;
    const W = PAD * 2 + C * P;
    const H = PAD * 2 + R * P;
    // Every cell is a real palette shade, so the lifted board can be checked
    // against the exact source instead of against "some colours came out".
    const { FLAT_COLORS } = require('./../assets/js/data/heartopia-palette.js');
    const shades = FLAT_COLORS.slice(1).map((h) => {
      const n = parseInt(h.slice(1), 16);
      return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    });
    const cells = [];
    for (let cy = 0; cy < R; cy++) for (let cx = 0; cx < C; cx++) cells.push(shades[(cy * C + cx * 7) % shades.length]);
    const img = png(W, H, (x, y) => {
      if (x < PAD || y < PAD || x >= PAD + C * P || y >= PAD + R * P) return [110 + ((x * 3 + y * 5) % 40), 118, 124];
      const cx = Math.floor((x - PAD) / P);
      const cy = Math.floor((y - PAD) / P);
      if ((x - PAD) % P === 0 || (y - PAD) % P === 0) return [20, 20, 20];
      if ((x - PAD) === Math.floor((C * P) / 2) || (y - PAD) === Math.floor((R * P) / 2)) return [250, 250, 250];
      // The cell's own colour, so a correct lift is checkable afterwards.
      return cells[cy * C + cx];
    });

    await page.click('#btnImport');
    await page.evaluate(() => {
      const b = [...document.querySelectorAll('#importModes button')].find((x) => /screenshot/i.test(x.textContent));
      b.click();
    });
    await page.waitForTimeout(200);
    await page.setInputFiles('#file', { name: 'board.png', mimeType: 'image/png', buffer: img });
    await page.waitForFunction(() => /cells · grid/.test(document.getElementById('importInfo').textContent), { timeout: 10000 }).catch(() => {});
    const info = await page.textContent('#importInfo');
    ok('a game screenshot is measured, not guessed', /50 × 50/.test(info), JSON.stringify(info));
    ok('and it names the slot it thinks it is', /looks like|unknown slot/.test(info), JSON.stringify(info));

    // A board that is not this face's must be announced, not quietly applied.
    // The app opens on Medium 1:1 (50x50), so a 64x80 shot is the wrong face.
    const other = png(PAD * 2 + 64 * P, PAD * 2 + 80 * P, (x, y) => {
      if (x < PAD || y < PAD || x >= PAD + 64 * P || y >= PAD + 80 * P) return [110 + ((x * 3 + y * 5) % 40), 118, 124];
      const cx = Math.floor((x - PAD) / P), cy = Math.floor((y - PAD) / P);
      if ((x - PAD) % P === 0 || (y - PAD) % P === 0) return [20, 20, 20];
      return shades[(cy * 64 + cx * 7) % shades.length];
    });
    await page.setInputFiles('#file', { name: 'other-face.png', mimeType: 'image/png', buffer: other });
    await page.waitForFunction(() => /not this face/.test(document.getElementById('importInfo').textContent), { timeout: 10000 }).catch(() => {});
    const mismatch = await page.textContent('#importInfo');
    ok('a board from another face is announced, not silently applied', /not this face/.test(mismatch), JSON.stringify(mismatch));
    // A blind lift reports what it measured, which for a board cropped at the
    // far border is a row and a column short of the truth. The message has to
    // stay honest about that rather than claim the size it guessed.
    ok('and it says how big that board is', /63 × 79/.test(mismatch), JSON.stringify(mismatch));
    ok('and it recognises the face it belongs to', /T-shirt Front/.test(mismatch), JSON.stringify(mismatch));

    // Back to the board this face expects, which is the path that paints.
    await page.setInputFiles('#file', { name: 'board.png', mimeType: 'image/png', buffer: img });
    await page.waitForFunction(() => /cells · grid/.test(document.getElementById('importInfo').textContent), { timeout: 10000 }).catch(() => {});

    const before = await page.evaluate(paintCells, [[...PAL_KEYS]]);
    // What the board itself is made of - paper, grid, guides, frame - measured
    // while it is still empty. Hardcoding this list was guesswork and it was
    // wrong; the board's own renderer is the only honest source of it.
    const paperColors = await page.evaluate(() => {
      const c = document.getElementById('base');
      const d = c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, c.width, c.height).data;
      const seen = new Set();
      for (let i = 0; i < d.length; i += 4) {
        if (d[i + 3] < 250) continue;
        seen.add(d[i] + ',' + d[i + 1] + ',' + d[i + 2]);
      }
      return [...seen];
    });
    await page.click('#importApply');
    await page.waitForTimeout(700);
    const after = await page.evaluate(paintCells, [[...PAL_KEYS]]);
    ok('applying a screenshot paints the face', after.pixels > 500, `${JSON.stringify(before)} -> ${JSON.stringify(after)}`);

    // The detector's claim is that the board which arrives is the board that was
    // on screen. Every source cell was a real palette shade, so a pixel of a
    // colour the screenshot never contained is one we invented.
    const source = new Set([...cells.map((c) => c.join(',')), ...paperColors]);
    const stray = await page.evaluate(
      ([srcList, palList, paperList]) => {
        const src = new Set(srcList.concat(paperList));
        const pal = new Set(palList);
        const c = document.getElementById('base');
        const d = c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, c.width, c.height).data;
        const seen = new Set();
        const seenOpaque = new Set();
        let paint = 0;
        let other = 0;
        for (let i = 0; i < d.length; i += 4) {
          if (d[i + 3] < 250) continue;
          const k = d[i] + ',' + d[i + 1] + ',' + d[i + 2];
          // A colour written with full opacity cannot come from compositing a
          // translucent line over paint, so it is tracked on its own.
          if (!pal.has(k) && d[i + 3] === 255) seenOpaque.add(k);
          // Only an exact palette colour can be paint. The board's grid lines and
          // the game's guide lines are drawn translucent OVER the paint, so they
          // sit between two shades; counting those as invented paint made this
          // test fail on correct output. They are checked separately, below.
          if (!pal.has(k)) { other++; continue; }
          paint++;
          if (!src.has(k)) seen.add(k);
        }
        return { stray: [...seen].slice(0, 6), opaque: [...seenOpaque].slice(0, 6), paint, other, total: paint + other };
      },
      [[...source], [...PAL_KEYS], paperColors] // arrays, not Sets: see paintCells
    );
    ok('no paint colour appears that was not in the screenshot', stray.stray.length === 0, 'unexpected: ' + JSON.stringify(stray.stray));
    /*
     * The round trip. Judging the rendered board by its raw pixel set is the
     * wrong test: grid lines, guide lines and paper grain are drawn over the
     * paint, so a correct board legitimately contains colours the fixture never
     * had, and no hand-written blend model of the renderer is trustworthy.
     * So lift the app's own board with the same detector and compare cell to
     * cell. If what comes back is what went in, the loop is honest - and this
     * needs no hardcoded geometry.
     */
    const wantIdx = cells.map((c) => shades.indexOf(c) + 1);
    const roundTrip = await page.evaluate(
      async ([flat, w, h]) => {
        const { liftBoard } = await import('/assets/js/cv/boarddetect.js');
        const c = document.getElementById('base');
        const d = c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, c.width, c.height);
        const lifted = liftBoard({ data: d.data, width: c.width, height: c.height }, { expectCols: w, expectRows: h });
        if (!lifted) return { found: false };
        let same = 0;
        let wrong = 0;
        let blank = 0;
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            const want = flat[y * w + x];
            const got = lifted.cells[y * w + x];
            if (!got) blank++;
            else if (got === want) same++;
            else wrong++;
          }
        }
        return { found: true, same, wrong, blank, total: w * h };
      },
      [wantIdx, C, R]
    );
    ok('the app renders a board that lifts back through the detector', roundTrip.found, JSON.stringify(roundTrip));
    if (roundTrip.found) {
      const rate = roundTrip.same / roundTrip.total;
      ok(
        'and the cells agree, not merely the colours',
        rate > 0.95,
        `${(rate * 100).toFixed(1)}% identical · ${roundTrip.wrong} wrong · ${roundTrip.blank} blank of ${roundTrip.total}`
      );
    }
    // The composited lines must stay what they are: a thin overlay, not the
    // board's content. If they ever become the majority, the board is mush.
    ok(
      'the overlay lines stay a thin minority of the board',
      stray.other / stray.total < 0.2,
      `${stray.other} of ${stray.total} pixels are not exact palette colours (${((100 * stray.other) / stray.total).toFixed(1)}%)`
    );
    // The import must land where it was drawn, not merely in the same colours.
    // A stretched sample grid used to pass every colour test above.
    const fidelity = await page.evaluate(
      async ([flat, w, h]) => {
        const { liftBoard } = await import('/assets/js/cv/boarddetect.js');
        const c = document.getElementById('base');
        const d = c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, c.width, c.height);
        const l = liftBoard({ data: d.data, width: c.width, height: c.height }, { expectCols: w, expectRows: h });
        if (!l) return null;
        let same = 0;
        for (let i = 0; i < flat.length; i++) if (l.cells[i] === flat[i]) same++;
        return { same, total: flat.length };
      },
      [Array.from(cells.map((c) => shades.indexOf(c) + 1)), C, R]
    );
    ok(
      'the board lands cell for cell where it was drawn',
      fidelity && fidelity.same === fidelity.total,
      fidelity ? `${fidelity.same}/${fidelity.total} cells exact` : 'the rendered board did not lift'
    );
    await page.screenshot({ path: path.join(ROOT, '_shots', 'import-shot.png') });
    await ctx.close();
  }

  ok('no page errors during import', errors.length === 0, errors.slice(0, 3).join(' | '));
  await browser.close();
  server.close();
  relay.kill();
  const bad = results.filter((r) => !r).length;
  console.log(`\n${results.length - bad}/${results.length} import checks passed`);
  process.exit(bad ? 1 : 0);
})().catch((e) => {
  console.log('THREW', e.message);
  server.close();
  relay.kill();
  process.exit(1);
});
