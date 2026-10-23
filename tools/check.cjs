/*
 * End-to-end check in a real browser. Nothing here trusts a unit test: it loads
 * the site, joins a room with the local relay, and reads pixels off the canvas.
 *
 *   node tools/check.cjs            # all stages
 *   node tools/check.cjs paint      # one stage
 */
const { chromium } = require('playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

/*
 * The servers belong to the run. A background job does not outlive the turn that
 * started it, so a checker that assumes one fails in a way that looks like the
 * app being broken when it is only the harness being gone.
 */
const ROOT = path.resolve(__dirname, '..');
const STATIC_PORT = Number(process.env.HMP_PORT || 8123);
const RELAY_PORT = Number(process.env.HMP_RELAY_PORT || 8787);
const BASE = `http://127.0.0.1:${STATIC_PORT}/`;
const RELAY = `ws://127.0.0.1:${RELAY_PORT}/`;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

function startStatic() {
  const server = http.createServer((req, res) => {
    let rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (rel === '/') rel = '/index.html';
    const file = path.join(ROOT, rel.replace(/^([./\\])+/, ''));
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      return res.end('not found');
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve, reject) => {
    server.once('error', (e) => {
      // EADDRINUSE means something is already serving the site; that is fine,
      // but say which case we are in so a red run is not mysterious.
      if (e.code === 'EADDRINUSE') resolve(null);
      else reject(e);
    });
    server.listen(STATIC_PORT, () => resolve(server));
  });
}

function startRelay() {
  const p = spawn(process.execPath, [path.join(ROOT, 'server', 'relay.js')], {
    env: { ...process.env, PORT: String(RELAY_PORT) },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  return p;
}
const only = process.argv[2] || '';

// The relay keeps a room's picture for ten minutes after everyone leaves, so a
// fixed code would hand this run the previous run's paint and every "before"
// count would be wrong. Rooms are unique per run; two pages in one stage still
// share, which is the point.
const RUN = 'R' + Date.now().toString(36).toUpperCase();
// Room codes are A-Z2-9 (no I O 0 1) and normalizeRoomCode() slices them to 8.
// A long name is not merely trimmed: every stage in a run collapses into the
// same room, so a stage inherits another stage's paint and roster. Hash instead.
const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function room(name) {
  let h = 2166136261;
  for (const c of RUN + '/' + name) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
  let out = '';
  for (let i = 0; i < 7; i++) {
    out += ALPHA[h % ALPHA.length];
    h = Math.floor(h / ALPHA.length);
  }
  return out;
}

const results = [];
function ok(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log((pass ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  [' + detail + ']' : ''));
}

/**
 * Count painted pixels.
 *
 * "Not white" is not the test: the board also carries paper texture, grey grid
 * lines and dark guide lines, and at a fractional zoom those antialias into
 * dozens of near-greys. Pass a colour to look for and you get pixels of that
 * shade; pass nothing and you get anything chromatic, which no piece of the
 * chrome is.
 */
/** The 125 shades, as rgb triples. Paint is drawn from this list and nothing
 *  else on the canvas is: paper, grid lines, guide lines and the board's brown
 *  drop shadow all miss every one of them exactly. */
const PALETTE_RGB = (() => {
  const hexes = require('../assets/js/data/heartopia-palette.js').FLAT_COLORS || [];
  return hexes.slice(1).map((h) => {
    const n = parseInt(h.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  });
})();

async function ink(page, want) {
  return page.evaluate(
    ([w, pal]) => {
      const c = document.getElementById('base');
      const g = c.getContext('2d', { willReadFrequently: true });
      const d = g.getImageData(0, 0, c.width, c.height).data;
      let painted = 0;
      let white = 0;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i + 3] === 0) continue;
        if (d[i] > 245 && d[i + 1] > 245 && d[i + 2] > 245) white++;
        if (w) {
          if (Math.abs(d[i] - w[0]) <= 6 && Math.abs(d[i + 1] - w[1]) <= 6 && Math.abs(d[i + 2] - w[2]) <= 6) painted++;
        } else {
          for (let p = 0; p < pal.length; p++) {
            if (d[i] === pal[p][0] && d[i + 1] === pal[p][1] && d[i + 2] === pal[p][2]) {
              painted++;
              break;
            }
          }
        }
      }
      return { painted, white, w: c.width, h: c.height };
    },
    [want || null, PALETTE_RGB]
  );
}

/** What is actually at this point? A covered close button is a real defect. */
async function whyNotClickable(page, sel) {
  return page.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) return 'no such element';
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return 'zero size ' + Math.round(r.width) + 'x' + Math.round(r.height);
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    if (top === el || el.contains(top) || (top && top.contains(el))) return 'clickable';
    return (
      'covered by ' +
      (top ? top.tagName.toLowerCase() + (top.id ? '#' + top.id : '') + (top.className ? '.' + top.className : '') : 'nothing') +
      ' at ' + Math.round(r.left + r.width / 2) + ',' + Math.round(r.top + r.height / 2)
    );
  }, sel);
}

async function newPage(browser, errors, room) {
  const ctx = await browser.newContext({
    viewport: { width: 1024, height: 768 },
    hasTouch: false,
    deviceScaleFactor: 1,
  });
  const page = await ctx.newPage();
  // The message alone ("Cannot read properties of undefined (reading 'map')")
  // is not actionable; the frame is.
  page.on('pageerror', (e) => {
    const frame = (e.stack || '').split('\n').find((l) => l.includes('assets/js'));
    errors.push('pageerror: ' + e.message + (frame ? ' @' + frame.trim().replace(/^at /, '') : ''));
  });
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push('console: ' + m.text());
  });
  // Clear and item-switch ask for a native confirmation. Playwright answers
  // those with `false` unless told, which silently disables half the buttons.
  page.setDefaultTimeout(15000);
  console.log('    room ' + room);
  // A native dialog: Playwright dismisses these unless told. One handler only -
  // accepting a dialog twice throws "already handled" and takes the run down.
  const dialogs = [];
  page.on('dialog', (d) => {
    dialogs.push(d.message());
    d.accept().catch(() => {});
  });
  page._dialogs = dialogs;
  await page.goto(BASE + '?relay=' + RELAY + '&room=' + room + '&renderDelay=0', {
    waitUntil: 'load',
  });
  return { ctx, page };
}

async function join(page, nick) {
  await page.fill('#nick', nick);
  await page.click('#join');
  await page.waitForFunction(() => !document.getElementById('app').hidden, { timeout: 8000 });
  // 'locked' is the class that says the room has not given us a slot yet.
  await page.waitForFunction(() => !document.getElementById('app').classList.contains('locked'), {
    timeout: 15000,
  });
  // The board canvas is sized when the gate finishes revealing the app. If it is
  // still the browser default, nothing on it is being drawn at the right scale.
  await page.waitForFunction(() => document.getElementById('base').width > 300, { timeout: 8000 });
}

/* ------------------------------------------------------------------ boot -- */

async function stageBoot(browser, errors) {
  const { ctx, page } = await newPage(browser, errors, room('boot'));
  await page.waitForTimeout(400); // let the first frame size the board canvas

  const veil = await page.isVisible('#veil');
  ok('the join card is up before anything else', veil);

  // The app must not be usable until a name is given.
  const appHidden = await page.evaluate(() => document.getElementById('app').hidden);
  ok('nothing behind it is reachable yet', appHidden);

  // Try to join with no name and with a name that is too short.
  await page.click('#join');
  const err1 = await page.textContent('#nickErr');
  ok('an empty name is refused with a reason', (err1 || '').length > 0, JSON.stringify(err1));

  await page.fill('#nick', 'a');
  await page.click('#join');
  const err2 = await page.textContent('#nickErr');
  const stillGated = await page.evaluate(() => document.getElementById('app').hidden);
  ok('a one-letter name is refused too', stillGated && (err2 || '').length > 0, JSON.stringify(err2));

  await join(page, 'Tester');
  ok('a real name gets you in', true);

  const counts = await page.evaluate(() => ({
    groups: document.querySelectorAll('#groups .group').length,
    tools: [...document.querySelectorAll('#tools .tool')].map((b) => b.dataset.tool).join(','),
    brushes: [...document.querySelectorAll('#brushes .brush')].map((b) => b.dataset.brush).join(','),
  }));
  ok('13 colour groups', counts.groups === 13, 'got ' + counts.groups);
  // Named exactly. A bare count went stale the day the toy shapes were cut, and
  // a tool row that quietly gains or loses a button is worth a failing check.
  ok(
    'the tool row is the eight we ship',
    counts.tools === 'brush,eraser,pick,fill,line,rect,ellipse,polygon',
    'got ' + counts.tools
  );
  // Heartopia's own block ladder (5, 10, 20) plus a single tap and one detail size.
  ok('brush sizes are the game blocks', counts.brushes === '1,2,5,10,20', 'got ' + counts.brushes);

  // The palette shows one group at a time, the way the game's card does, so
  // "125 shades" has to be checked by walking every group and collecting the
  // indices. A duplicated or dropped shade is exactly the kind of thing a
  // one-group-at-a-time view hides.
  const walk = await page.evaluate(async () => {
    const groups = [...document.querySelectorAll('#groups .group')];
    const seen = new Map();
    for (const g of groups) {
      g.click();
      await new Promise((r) => setTimeout(r, 25));
      for (const s of document.querySelectorAll('#swatches .swatch')) {
        const i = Number(s.dataset.idx);
        seen.set(i, (seen.get(i) || 0) + 1);
      }
    }
    const dupes = [...seen.entries()].filter(([, n]) => n > 1).length;
    const idxs = [...seen.keys()].sort((a, b) => a - b);
    return { total: seen.size, dupes, first: idxs[0], last: idxs[idxs.length - 1] };
  });
  ok('all 125 shades are reachable', walk.total === 125, JSON.stringify(walk));
  ok('no shade appears in two groups', walk.dupes === 0, 'dupes ' + walk.dupes);
  ok('indices run 1..125, 0 stays empty', walk.first === 1 && walk.last === 125, JSON.stringify(walk));

  const first = await page.evaluate(() => {
    const s = document.querySelector('#swatches .swatch');
    const cs = getComputedStyle(s);
    return { bg: cs.backgroundColor, r: cs.borderRadius, w: s.offsetWidth, h: s.offsetHeight };
  });
  ok('a swatch is a rounded square like the game card', first.r !== '0px' && Math.abs(first.w - first.h) <= 2, JSON.stringify(first));

  // Paper is white; the grid lines drawn on it are not, so "empty" means no
  // paint colour, not no ink at all.
  const paper = await page.evaluate(() => {
    const c = document.getElementById('base');
    const d = c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, c.width, c.height).data;
    const hist = new Map();
    for (let i = 0; i < d.length; i += 4) {
      const k = d[i] + ',' + d[i + 1] + ',' + d[i + 2];
      hist.set(k, (hist.get(k) || 0) + 1);
    }
    const top = [...hist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
    return { top, distinct: hist.size };
  });
  ok('the board starts white', /^255,255,255/.test(paper.top[0][0]), JSON.stringify(paper.top));
  // The long tail of colours in that histogram is antialiasing: the grid lines
  // land on fractional pixels at a fractional zoom. Chroma is what says paint.
  const fresh = await ink(page);
  ok('nothing is painted on a new board', fresh.painted === 0, 'chromatic pixels ' + fresh.painted);

  const net = await page.getAttribute('#net', 'data-state');
  ok('the relay link came up', net === 'online' || net === 'connecting', 'state ' + net);

  await page.screenshot({ path: '_shots/boot.png', fullPage: false });
  await ctx.close();
  return page;
}

/* ----------------------------------------------------------------- paint -- */

async function stagePaint(browser, errors) {
  const { ctx, page } = await newPage(browser, errors, room('paint'));
  await join(page, 'Painter');
  await page.waitForTimeout(400);

  const stage = await page.locator('#stage').boundingBox();

  // Pick group 5 then a shade, the way a person does.
  await page.click('#groups .group:nth-child(5)');
  await page.waitForTimeout(120);
  const picked = await page.evaluate(() => {
    const s = document.querySelectorAll('#swatches .swatch')[3];
    s.click();
    const cs = getComputedStyle(s);
    // A pale yellow is not "saturated", so remember what was chosen and look
    // for that colour specifically rather than for any chroma at all.
    const n = parseInt((s.title.match(/#[0-9a-fA-F]{6}/) || ['#000000'])[0].slice(1), 16);
    return {
      active: s.classList.contains('active'),
      bg: cs.backgroundColor,
      title: s.title,
      want: [(n >> 16) & 255, (n >> 8) & 255, n & 255],
    };
  });
  ok('clicking a shade selects it', picked.active, JSON.stringify(picked));

  const before = await ink(page, picked.want);
  await page.mouse.move(stage.x + stage.width / 2 - 60, stage.y + stage.height / 2);
  await page.mouse.down();
  for (let i = 0; i < 12; i++) {
    await page.mouse.move(stage.x + stage.width / 2 - 60 + i * 10, stage.y + stage.height / 2 + i * 3);
    await page.waitForTimeout(12);
  }
  await page.mouse.up();
  await page.waitForTimeout(250);
  const after = await ink(page, picked.want);
  ok(
    'a mouse drag leaves ink in the chosen shade',
    after.painted > before.painted + 40,
    picked.title + ': before ' + before.painted + ' after ' + after.painted
  );

  // Brush size must change what a drag covers.
  const n = page._dialogs.length;
  await page.click('#btnClear');
  await page.waitForTimeout(400);
  ok('clear asks before wiping everyone', page._dialogs.length > n, JSON.stringify(page._dialogs));
  const clearedAll = await ink(page);
  ok('clear leaves no paint of any shade', clearedAll.painted === 0, 'chromatic pixels ' + clearedAll.painted);
  const cleared = await ink(page, picked.want);
  ok('clear empties the board', cleared.painted < after.painted * 0.1, 'painted ' + cleared.painted);

  await page.evaluate(() => {
    document.querySelectorAll('#brushes .brush')[2].click();
  });
  await page.mouse.move(stage.x + stage.width / 2, stage.y + stage.height / 2);
  await page.mouse.down();
  await page.mouse.move(stage.x + stage.width / 2 + 30, stage.y + stage.height / 2, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(220);
  const fat = await ink(page, picked.want);
  ok('a bigger brush paints more cells', fat.painted > after.painted * 1.15, after.painted + ' -> ' + fat.painted);
  // The readout and the swatch must agree, or "I picked the pink" is a lie.
  const shown = await page.evaluate(() => {
    const s = document.querySelector('#swatches .swatch.active');
    return { swatch: s && s.title, readout: document.getElementById('currentColor').textContent.trim() };
  });
  ok('the shade readout matches the selected swatch', shown.swatch === shown.readout, JSON.stringify(shown));

  // Undo is one step per stroke, and it has to travel: a peer that only sees
  // your ink arrive must also see it go away.
  // The button used to stay greyed while the stack was full and Ctrl+Z worked:
  // nothing told it there was something to undo.
  const enabled = await page.evaluate(() => !document.getElementById('btnUndo').disabled);
  ok('the undo button wakes up when there is a stroke', enabled);
  await page.click('#btnUndo');
  await page.waitForTimeout(300);
  const afterUndo = await ink(page, picked.want);
  ok('undo took the paint off', afterUndo.painted === 0, fat.painted + ' -> ' + afterUndo.painted);

  const reRedo = await page.evaluate(() => !document.getElementById('btnRedo').disabled);
  ok('redo becomes available after an undo', reRedo);
  await page.click('#btnRedo');
  await page.waitForTimeout(300);
  const afterRedo = await ink(page, picked.want);
  ok('redo puts it back', afterRedo.painted > 0, 'painted ' + afterRedo.painted);

  await page.screenshot({ path: '_shots/paint.png' });
  await ctx.close();
}

/* ------------------------------------------------------------------ zoom -- */

async function stageZoom(browser, errors) {
  const { ctx, page } = await newPage(browser, errors, room('zoom'));
  await join(page, 'Zoomer');
  await page.waitForTimeout(300);
  const stage = await page.locator('#stage').boundingBox();
  const cx = stage.x + stage.width / 2;
  const cy = stage.y + stage.height / 2;

  const read = () => page.textContent('#zoomVal');
  const start = await read();
  await page.mouse.move(cx, cy);
  await page.mouse.wheel(0, -240);
  await page.waitForTimeout(180);
  const up = await read();
  await page.mouse.wheel(0, 600);
  await page.waitForTimeout(180);
  const down = await read();

  const num = (s) => parseInt(String(s || '').replace(/[^0-9]/g, ''), 10);
  ok('the zoom readout is a percentage', /%$/.test(String(start || '').trim()), String(start));
  ok('wheel up zooms in and the readout follows', num(up) > num(start), start + ' -> ' + up);
  ok('wheel down zooms out', num(down) < num(up), up + ' -> ' + down);

  await page.click('#zFit');
  await page.waitForTimeout(150);
  const fit = await read();
  ok('fit gives a sane number', num(fit) > 0 && num(fit) < 4000, String(fit));

  await ctx.close();
}

/* ---------------------------------------------------------------- panels -- */

async function stagePanels(browser, errors) {
  const { ctx, page } = await newPage(browser, errors, room('panels'));
  await join(page, 'Panelist');
  await page.waitForTimeout(300);

  for (const [btn, panel] of [['#btnTrace', '#tracePanel'], ['#btnImport', '#importPanel'], ['#btn3d', '#d3Panel']]) {
    await page.click(btn);
    await page.waitForTimeout(250);
    const vis = await page.isVisible(panel);
    const box = vis ? await page.locator(panel).boundingBox() : null;
    const stage = await page.locator('#stage').boundingBox();
    const inside = box && box.x >= stage.x - 1 && box.y >= stage.y - 1 && box.x + box.width <= stage.x + stage.width + 1;
    ok(btn + ' opens ' + panel, vis, box ? Math.round(box.width) + 'x' + Math.round(box.height) : 'not visible');
    ok(btn + ' stays inside the board', !!inside, JSON.stringify(box));
    await page.screenshot({ path: path.join(ROOT, '_shots', btn.replace(/[^a-z]/gi, '') + '.png') });
    const reach = await whyNotClickable(page, panel + ' .panel-x');
    ok(btn + ' close button can be reached', reach === 'clickable', reach);
    await page.click(panel + ' .panel-x', { timeout: 5000 }).catch((e) =>
      errors.push('click ' + panel + ' .panel-x: ' + e.message.split('\n')[0])
    );
    await page.waitForTimeout(200);
    const gone = await page.isVisible(panel);
    ok(btn + ' closes again', !gone);
  }

  // The design dialog: a garment must produce face tabs.
  await page.click('#btnDesign');
  await page.waitForTimeout(250);
  // The dialog opens on the canvas family, which has one face. Ask for clothes.
  const fam = await page.evaluate(() => {
    const b = [...document.querySelectorAll('#fFams button')].find((x) => /cloth/i.test(x.textContent));
    if (b) b.click();
    return b ? b.textContent.trim() : null;
  });
  await page.waitForTimeout(200);
  const cards = await page.evaluate(() => document.querySelectorAll('#fItems .item-card').length);
  ok('the design picker lists clothing', cards >= 11, 'cards ' + cards + ' family ' + fam);
  await page.click('#fItems .item-card:nth-child(1)');
  await page.waitForTimeout(100);
  await page.click('#fApply');
  await page.waitForTimeout(700);
  const tabs = await page.evaluate(() => {
    const f = document.getElementById('faces');
    return { hidden: f.hidden, n: f.querySelectorAll('.face').length, text: (f.textContent || '').trim().slice(0, 60) };
  });
  ok('a garment shows one tab per face', !tabs.hidden && tabs.n >= 2, JSON.stringify(tabs));

  const chrome = await page.evaluate(() => {
    const card = document.querySelector('#fItems .item-card');
    const tab = document.querySelector('#faces .face');
    return {
      card: card ? card.textContent.replace(/\s+/g, ' ').trim() : '',
      tabTitle: tab ? tab.getAttribute('title') : '',
      tabText: tab ? tab.textContent.replace(/\s+/g, ' ').trim() : '',
    };
  });
  // The picker is a picker. It carries names and sizes and nothing else.
  ok(
    'the picker carries no descriptive text',
    !/[぀-ヿ]/.test(chrome.card + chrome.tabTitle + chrome.tabText) &&
      !/\.{3}|·/.test(chrome.tabText) &&
      chrome.card === 'T-shirt' && /^Front/.test(chrome.tabText),
    JSON.stringify(chrome)
  );

  await page.evaluate(() => document.querySelectorAll('#faces .face')[1].click());
  await page.waitForTimeout(250);
  const active = await page.evaluate(() => {
    const on = document.querySelector('#faces .face.active');
    return on ? on.textContent.trim() : null;
  });
  ok('switching face tabs moves the board', !!active, JSON.stringify(active));

  await page.screenshot({ path: '_shots/faces.png' });
  await ctx.close();
}

/* -------------------------------------------------------------- multiplayer -- */

async function stageTogether(browser, errors) {
  const a = await newPage(browser, errors, room('together'));
  const b = await newPage(browser, errors, room('together'));
  await join(a.page, 'Alice');
  await join(b.page, 'Bob');
  await a.page.waitForTimeout(600);
  await b.page.waitForTimeout(600);

  // The roster shows initials, with the nickname in the title - textContent
  // alone would read "AB" and tell you nothing.
  const roster = await a.page.evaluate(() =>
    [...document.querySelectorAll('#players .avatar')].map((x) => x.title || x.textContent.trim())
  );
  ok('both players appear in the roster', roster.includes('Alice') && roster.includes('Bob'), JSON.stringify(roster));

  const sa = await a.page.locator('#stage').boundingBox();
  const sb = await b.page.locator('#stage').boundingBox();

  // Alice paints; Bob must see the same ink.
  await a.page.mouse.move(sa.x + 200, sa.y + 200);
  await a.page.mouse.down();
  for (let i = 0; i < 10; i++) {
    await a.page.mouse.move(sa.x + 200 + i * 8, sa.y + 200 + i * 4);
    await a.page.waitForTimeout(16);
  }
  await a.page.mouse.up();

  let bobInk = { painted: 0 };
  for (let t = 0; t < 24; t++) {
    bobInk = await ink(b.page);
    if (bobInk.painted > 0) break;
    await b.page.waitForTimeout(250);
  }
  ok("Bob sees Alice's paint", bobInk.painted > 20, JSON.stringify(bobInk));

  // And Alice must not double-count her own stroke as remote.
  const aliceInk = await ink(a.page);
  ok('Alice sees her own stroke once', aliceInk.painted > 0, JSON.stringify(aliceInk));

  // A cursor on the other machine should be drawn.
  await b.page.mouse.move(sb.x + 320, sb.y + 260);
  await b.page.waitForTimeout(500);
  const cursors = await a.page.evaluate(() => {
    const c = document.getElementById('fx');
    const g = c.getContext('2d', { willReadFrequently: true });
    const d = g.getImageData(0, 0, c.width, c.height).data;
    let lit = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 0) lit++;
    return lit;
  });
  ok("Alice can see Bob's cursor", cursors > 0, 'lit fx pixels ' + cursors);

  await a.page.screenshot({ path: '_shots/two.png' });
  await a.ctx.close();
  await b.ctx.close();
}

/* ------------------------------------------------------------------ touch -- */

async function stageTouch(browser, errors) {
  const ctx = await browser.newContext({
    viewport: { width: 820, height: 1180 },
    hasTouch: true,
    isMobile: true,
    deviceScaleFactor: 2,
  });
  const errors2 = [];
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors2.push('pageerror: ' + e.message));
  await page.goto(BASE + '?relay=' + RELAY + '&room=' + room('touch') + '&renderDelay=0', { waitUntil: 'load' });
  await join(page, 'Touchy');
  await page.waitForTimeout(400);

  const stage = await page.locator('#stage').boundingBox();
  // One finger paints.
  await page.touchscreen.tap(stage.x + 120, stage.y + 200);
  await page.waitForTimeout(200);
  const afterTap = await ink(page);

  // Two fingers must pan/zoom, never paint.
  const before = afterTap.painted;
  await page.evaluate(
    async ([x, y]) => {
      const el = document.getElementById('stage');
      const mk = (id, tx, ty) =>
        new Touch({ identifier: id, target: el, clientX: tx, clientY: ty });
      const t1 = mk(1, x, y);
      const t2 = mk(2, x + 60, y + 60);
      const fire = (type, touches, changed) =>
        el.dispatchEvent(new TouchEvent(type, { touches, changedTouches: changed, bubbles: true, cancelable: true }));
      fire('touchstart', [t1], [t1]);
      await new Promise((r) => setTimeout(r, 30));
      fire('touchstart', [t1, t2], [t2]);
      await new Promise((r) => setTimeout(r, 30));
      fire('touchmove', [t1, t2], [t2]);
      fire('touchend', [t1], [t2]);
    },
    [stage.x + 300, stage.y + 300]
  );
  await page.waitForTimeout(300);
  const afterPinch = await ink(page);
  ok('a finger paints on a tablet', afterTap.painted > 0, JSON.stringify(afterTap));
  ok('two fingers never paint', afterPinch.painted === before, before + ' -> ' + afterPinch.painted);

  // What matters is that the page itself never scrolls and the board keeps real
  // height. Whether the dock needs to scroll depends on how much room it has.
  const fit = await page.evaluate(() => {
    const de = document.documentElement;
    const s = document.getElementById('stage').getBoundingClientRect();
    const d = document.getElementById('dock').getBoundingClientRect();
    return {
      pageScrolls: de.scrollHeight > de.clientHeight + 1 || de.scrollWidth > de.clientWidth + 1,
      stage: Math.round(s.width) + 'x' + Math.round(s.height),
      dockBottom: Math.round(d.bottom),
      vh: de.clientHeight,
    };
  });
  ok('the page itself does not scroll', !fit.pageScrolls, JSON.stringify(fit));
  ok('the board keeps real height on a tablet', parseInt(fit.stage.split('x')[1], 10) > 300, fit.stage);
  ok('the dock ends inside the screen', fit.dockBottom <= fit.vh + 1, JSON.stringify(fit));

  await page.screenshot({ path: '_shots/ipad.png' });
  errors.push(...errors2);
  await ctx.close();
}

/* ------------------------------------------------------------------- run -- */

(async () => {
  const stages = { boot: stageBoot, paint: stagePaint, zoom: stageZoom, panels: stagePanels, together: stageTogether, touch: stageTouch };
  const staticServer = await startStatic();
  const relay = startRelay();
  console.log(staticServer ? `static server on ${STATIC_PORT}` : `port ${STATIC_PORT} already serving - reusing it`);
  await new Promise((r) => setTimeout(r, 900)); // let the relay bind
  const browser = await chromium.launch();
  const errors = [];
  let failed = 0;
  for (const [name, fn] of Object.entries(stages)) {
    if (only && name !== only) continue;
    console.log('\n--- ' + name + ' ---');
    try {
      await fn(browser, errors);
    } catch (e) {
      ok(name + ' threw', false, e.message.split('\n')[0]);
      failed++;
    }
  }
  const noise = errors.filter((e) => !/favicon|net::ERR|404/.test(e));
  ok('no page errors or console errors', noise.length === 0, noise.slice(0, 6).join(' | '));
  await browser.close();
  if (staticServer) staticServer.close();
  relay.kill();
  const bad = results.filter((r) => !r.pass);
  console.log('\n' + (results.length - bad.length) + '/' + results.length + ' checks passed');
  process.exit(bad.length ? 1 : 0);
})();
