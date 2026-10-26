/**
 * Browser check for the local board backup.
 *
 * The unit tests prove the storage layer. What they cannot prove is the part
 * that matters to a player: that a picture really does come back after the tab
 * is closed, that it comes back as paint on the board and not just as bytes in
 * storage, and - the dangerous half - that a rescue never overwrites a board
 * that still has a picture on it.
 *
 * Run: node tools/probe_backup.mjs   (dev server on 8099, relay on 8787)
 */
import { chromium } from 'playwright';

// 8099, not 8080 - PLAN.md:156. An unrelated app answers on 8080 on this
// machine and serves a page that is not ours.
const BASE = process.env.BASE || 'http://localhost:8099';
const RELAY = process.env.RELAY || 'ws://localhost:8787';
const PREFIX = 'hmpaint.board.v1.';
const SHADE = 16; // #e95e2b
const SHADE_HEX = '#e95e2b';
const DAY = 1000 * 60 * 60 * 24;

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' - ' + detail : ''}`);
}

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push('PAGEERROR ' + e));
page.on('console', (m) => m.type() === 'error' && errors.push('CONSOLE ' + m.text()));

// --- dialog control -----------------------------------------------------------
// The app asks "bring back the board you left here?" with confirm(). Every
// reload needs an answer, and the answer is half of what is being tested.
let answer = true;
let offers = [];
page.on('dialog', async (d) => {
  const text = d.message();
  console.log(`  [dialog ${d.type()}] ${text.slice(0, 70)}`);
  if (/Bring back/.test(text)) offers.push(text);
  // accept() takes prompt *text*; for a confirm it takes nothing.
  if (answer) await d.accept();
  else await d.dismiss();
});

/**
 * Wait for the app to be up. `waitForFunction(fn, arg, options)` - the options
 * are the THIRD parameter, and passing them second silently leaves them treated
 * as the argument, so every timeout here was really the 30s default.
 */
async function settled(label) {
  try {
    await page.waitForFunction(() => !document.getElementById('app').classList.contains('locked'), null, { timeout: 15000 });
    await page.waitForFunction(() => document.getElementById('base').width > 300, null, { timeout: 15000 });
  } catch (err) {
    const state = await page
      .evaluate(() => ({
        cls: document.getElementById('app').className,
        base: document.getElementById('base').width,
        join: !!document.getElementById('join') && getComputedStyle(document.getElementById('join')).display,
        keys: Object.keys(localStorage),
      }))
      .catch((e) => ({ evaluateFailed: String(e).slice(0, 120) }));
    console.log(`  [stalled ${label}] ${JSON.stringify(state)}`);
    throw err;
  }
}

async function open(url, { accept = true } = {}) {
  answer = accept;
  offers = [];
  await page.goto(url, { waitUntil: 'load' });
  // PLAN.md:156 - assert this is our page before measuring anything on it.
  if (!(await page.locator('#app').count())) throw new Error(`${BASE} is not serving this app`);
  // ?local=1 never shows the gate, and clicking #join when it is not really
  // there would swap the offline sandbox for a random room - which silently
  // changes the backup key and makes every "no offer" below a lie.
  if (!/local=1/.test(url) && (await page.locator('#join').isVisible().catch(() => false))) {
    await page.fill('#nick', 'Backup');
    await page.click('#join');
    console.log('  [gate] joined');
  }
  await settled('open');
}

/**
 * Reload without re-entering the URL: a goto to the address the page already
 * has does not reliably re-run the app's boot, which is the whole test.
 */
async function reload({ accept = true } = {}) {
  answer = accept;
  offers = [];
  await page.reload({ waitUntil: 'load' });
  // The load event lands while boot is still mid-flight (the canvas is 1px wide
  // for a moment), so give it a beat before judging whether it came up.
  await page.waitForTimeout(500);
  await settled('reload');
}

// --- storage readers ----------------------------------------------------------
async function rows() {
  const raw = await page.evaluate((p) => {
    const out = {};
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(p)) out[k] = localStorage.getItem(k);
    }
    return out;
  }, PREFIX);
  return Object.entries(raw).map(([key, text]) => {
    let parsed = null;
    let note = '';
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      note = 'unparseable';
    }
    const faces = parsed?.snapshot?.faces || [];
    let painted = 0;
    for (const f of faces) {
      const bytes = Buffer.from(f.cells || '', 'base64');
      for (const b of bytes) if (b) painted++;
    }
    return { key: key.slice(PREFIX.length), saved: parsed?.saved ?? 0, item: parsed?.snapshot?.item, faces: faces.map((f) => `${f.w}x${f.h}`).join(','), painted, note, text };
  });
}

async function plant(key, mutate) {
  await page.evaluate(({ p, k, m }) => {
    const row = JSON.parse(localStorage.getItem(p + k));
    if (!row) return;
    // eslint-disable-next-line no-new-func
    new Function('row', m)(row);
    localStorage.setItem(p + k, JSON.stringify(row));
  }, { p: PREFIX, k: key, m: mutate });
}

/** Colours the board is genuinely made of, ignoring cell-edge blends. */
const hist = () =>
  page.evaluate(() => {
    const cv = document.getElementById('base');
    const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
    const w = cv.width;
    const h = cv.height;
    const eq = (a, b) => d[a] === d[b] && d[a + 1] === d[b + 1] && d[a + 2] === d[b + 2] && d[a + 3] === d[b + 3];
    const out = {};
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = (y * w + x) * 4;
        if (d[i + 3] < 200) continue;
        if (!eq(i, i + 4) || !eq(i, i - 4) || !eq(i, i + w * 4) || !eq(i, i - w * 4)) continue;
        const hex = '#' + [d[i], d[i + 1], d[i + 2]].map((v) => v.toString(16).padStart(2, '0')).join('');
        out[hex] = (out[hex] || 0) + 1;
      }
    }
    return out;
  });

async function paintStroke(fraction = 0.5) {
  await page.click('button[data-tool="brush"]');
  const solid = await page.$('#toolOpts [data-shape="solid"]');
  if (solid) await solid.click();
  await page.waitForTimeout(120);
  for (let g = 0; g < 13; g++) {
    await page.click(`#groups [data-group="${g}"]`);
    await page.waitForTimeout(40);
    const el = await page.$(`#swatches [data-idx="${SHADE}"]`);
    if (el) {
      await el.click();
      break;
    }
  }
  await page.waitForTimeout(80);
  const box = await page.locator('#base').boundingBox();
  const y = box.y + box.height * fraction;
  await page.mouse.move(box.x + box.width * 0.42, y);
  await page.mouse.down();
  for (let k = 0; k <= 10; k++) {
    await page.mouse.move(box.x + box.width * (0.42 + k * 0.008), y);
  }
  await page.mouse.up();
  await page.waitForTimeout(1600); // the autosave debounce is 1.2s
}

const localUrl = `${BASE}/?local=1&item=tshirt&renderDelay=0`;

/* ================= A: save, then bring it back ================= */
await open(localUrl);
await page.evaluate(() => localStorage.clear());
check('A0: a clean device offers nothing', offers.length === 0);
await paintStroke();

let r = await rows();
check('A1: painting wrote exactly one backup', r.length === 1, r.map((x) => x.key).join(','));
const saved = r[0] || {};
check('A2: it is keyed to this offline garment', saved.key === 'LOCAL:tshirt', String(saved.key));
check('A3: the saved picture has paint on it', saved.painted > 0, `${saved.painted} cells over ${saved.faces}`);
const before = await hist();
const beforeN = before[SHADE_HEX] || 0;
check('A4: the board shows that colour', beforeN > 50, `${beforeN}px`);

await reload();
console.log('  [guards]', JSON.stringify(await page.evaluate(async () => {
  const bk = await import('/assets/js/game/backup.js');
  const { Design } = await import('/assets/js/game/design.js');
  const d = new Design('tshirt');
  const row = bk.loadBoard('LOCAL', d.id);
  return {
    keys: Object.keys(localStorage),
    row: !!row,
    fits: row ? bk.fitsDesign(row, d) : null,
    count: bk.savedCount(row),
    empty: bk.designIsEmpty(d),
    locked: document.getElementById('app').className,
  };
})));
check('A5: coming back asks whether to restore', offers.length === 1, JSON.stringify(offers));
const quoted = Number((offers[0] || '').match(/(\d+) painted cell/)?.[1] || -1);
check('A6: the offer quotes the real number', quoted === saved.painted, `offer says ${quoted}, storage has ${saved.painted}`);
await page.waitForTimeout(700);
const after = await hist();
const afterN = after[SHADE_HEX] || 0;
check('A7: accepting puts the colour back on the board', afterN > 50, `${afterN}px vs ${beforeN}px before`);
r = await rows();
check('A8: the restored board is a board again', r.length === 1 && r[0].painted > 0, r.map((x) => `${x.key}:${x.painted}`).join(','));

/* ================= B: refusing is safe and remembers ================= */
await reload({ accept: false });
check('B1: refusing still asks', offers.length === 1);
await page.waitForTimeout(500);
const declined = await hist();
check('B2: refusing leaves the board empty', (declined[SHADE_HEX] || 0) === 0, `${declined[SHADE_HEX] || 0}px`);
r = await rows();
check('B3: refusing does not destroy the backup', r.length === 1 && r[0].painted > 0, r.map((x) => `${x.key}:${x.painted}`).join(','));

/* ================= C: junk must not become a hazard ================= */
await plant('LOCAL:tshirt', 'row.saved = Date.now() - 15 * 86400000;');
await reload();
check('C1: a two-week-old picture is not offered', offers.length === 0, JSON.stringify(offers));

await plant('LOCAL:tshirt', 'row.saved = Date.now(); row.snapshot.faces = [];');
await reload();
check('C2: a board with no faces is not offered', offers.length === 0);

await plant('LOCAL:tshirt', 'row.saved = Date.now(); row.snapshot.item = "book";');
await reload();
check('C3: another garment\'s board is not offered', offers.length === 0);

await plant('LOCAL:tshirt', 'row.saved = Date.now(); row.snapshot.faces[0].w += 8;');
await reload();
check('C4: a face of the wrong shape is not offered', offers.length === 0);

await page.evaluate((p) => {
  for (const k of Object.keys(localStorage)) if (k.startsWith(p)) localStorage.setItem(k, '{truncat');
}, PREFIX);
await reload();
check('C5: half-written storage is not offered', offers.length === 0);
await page.evaluate((p) => {
  for (const k of Object.keys(localStorage)) if (k.startsWith(p)) localStorage.removeItem(k);
}, PREFIX);

/* ================= D: a deliberate clear is not a rescue ================= */
await reload(); // storage clean; paints fresh
await paintStroke(0.62);
r = await rows();
const clearedFrom = (r[0] || {}).painted || 0;
check('D1: painted a fresh board to clear', clearedFrom > 0, `${clearedFrom} cells`);
answer = true; // "Clear the whole design for everyone?"
await page.click('#btnClear');
await page.waitForTimeout(1800);
r = await rows();
const afterClear = (r[0] || {}).painted ?? 0;
check('D2: clearing leaves nothing to rescue', afterClear === 0, r.map((x) => `${x.key}:${x.painted}`).join(','));
await reload();
check('D3: and the next visit is quiet', offers.length === 0, JSON.stringify(offers));

/* ================= E: the room is the truth ================= */
const roomUrl = `${BASE}/?transport=ws&relay=${encodeURIComponent(RELAY)}&room=BKROOM1&item=tshirt&renderDelay=0`;
await open(roomUrl);
await paintStroke();
r = await rows();
const roomSaved = (r.find((x) => x.key === 'BKROOM1') || {}).painted || 0;
check('E1: a room board is backed up too', roomSaved > 0, `${roomSaved} cells under ${r.map((x) => x.key).join(',')}`);

// Throw the backup away and rejoin: if the picture comes back now, it came
// from the relay, which is the point - the backup is a rescue, not the record.
await page.evaluate((p) => {
  for (const k of Object.keys(localStorage)) if (k.startsWith(p)) localStorage.removeItem(k);
}, PREFIX);
await open(roomUrl);
await page.waitForTimeout(2600);
const fromRoom = await hist();
check('E2: the room still had the picture', (fromRoom[SHADE_HEX] || 0) > 50, `${fromRoom[SHADE_HEX] || 0}px with no backup at all`);
check('E3: and nothing was offered over it', offers.length === 0, JSON.stringify(offers));

// A brand new room is empty, so here the rescue is the only source of the
// picture. Plant a backup for it and join.
const snap = await page.evaluate((p) => {
  const k = Object.keys(localStorage).find((x) => x.startsWith(p));
  return k ? localStorage.getItem(k) : null;
}, PREFIX);
await page.evaluate(({ p, code, text }) => {
  // Re-key a real snapshot onto a room nobody has ever opened.
  const row = JSON.parse(text || '{"saved":0,"snapshot":{"item":"tshirt","faces":[]}}');
  row.saved = Date.now();
  localStorage.setItem(p + code, JSON.stringify(row));
}, { p: PREFIX, code: 'BKRES1', text: snap });
const rescueUrl = `${BASE}/?transport=ws&relay=${encodeURIComponent(RELAY)}&room=BKRES1&item=tshirt&renderDelay=0`;
await open(rescueUrl);
await page.waitForTimeout(3000);
check('E4: an empty room does offer the rescue', offers.length === 1, JSON.stringify(offers));
await page.waitForTimeout(800);
const rescued = await hist();
check('E5: and the rescue lands as paint', (rescued[SHADE_HEX] || 0) > 50, `${rescued[SHADE_HEX] || 0}px`);
r = await rows();
const rescRow = r.find((x) => x.key === 'BKRES1') || {};
check('E6: the rescued board is a live board', (rescRow.painted || 0) > 0, `${rescRow.painted} cells`);

check('Z: no page errors anywhere', errors.length === 0, errors.slice(0, 3).join(' | '));

console.log(`\n${pass} PASS / ${fail} FAIL`);
await browser.close();
process.exit(fail ? 1 : 0);
