/**
 * Browser check for the copy-grid buttons.
 *
 * The pure module is tested; what cannot be tested in Node is that the dock
 * reaches the clipboard at all. Chromium only lets a page write to it with a
 * secure context and a real user gesture, and the fallback path (a hidden
 * textarea and execCommand) is the one a phone without clipboard-write actually
 * takes. So this checks the text the app hands the clipboard API, and then asks
 * the clipboard what it really holds, and requires the two to agree.
 *
 * Run: node tools/probe_gridtext.mjs   (server on 8099)
 */
import { chromium } from 'playwright';
import { FLAT_COLORS, COLOR_CODES } from '../assets/js/data/heartopia-palette.js';

const BASE = process.env.BASE || 'http://localhost:8099';

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) {
    pass++;
    console.log(`PASS ${name}${detail ? ' - ' + detail : ''}`);
  } else {
    fail++;
    console.log(`FAIL ${name}${detail ? ' ' + detail : ''}`);
  }
}

const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(BASE).origin });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push('console: ' + m.text());
});

await page.goto(`${BASE}/?local=1&item=tshirt&renderDelay=0`, { waitUntil: 'load' });
await page.waitForFunction(() => !document.getElementById('app').classList.contains('locked'), { timeout: 20000 });
await page.waitForFunction(() => document.getElementById('base').width > 300, { timeout: 10000 });

// Record what the app hands the clipboard, without swallowing it - the real
// write still happens, so the toast path is the production path.
await page.evaluate(() => {
  window.__copied = null;
  const orig = navigator.clipboard.writeText.bind(navigator.clipboard);
  navigator.clipboard.writeText = (t) => {
    window.__copied = t;
    return orig(t);
  };
});

await page.click('#btnTrace');
const labels = await page.$$eval('#copyRow [data-copy]', (n) => n.map((x) => x.textContent.trim()));
check('C: the panel offers all three formats', labels.length === 3, labels.join('/'));

// One size-1 square click paints exactly one cell, whatever the garment's
// outline looks like - and the toast tells us which cell the app thinks it was.
await page.click('.tool[data-tool="brush"]');
const size1 = page.locator('#toolOpts [data-brush="1"]');
if (await size1.count()) await size1.click();
const box = await page.locator('#base').boundingBox();
await page.mouse.click(box.x + box.width / 2 + 7, box.y + box.height / 2 + 11);
await page.waitForTimeout(200);
const heldCode = (await page.$eval('#currentColor', (n) => n.textContent.trim())).split(' ')[0];
check('C: a shade is held', /^\d\d-\d$/.test(heldCode), heldCode);

const idx = COLOR_CODES.indexOf(heldCode);
check('C: the held code is a real palette entry', idx > 0, `index ${idx}`);

/** Click a copy button and report what the app produced. */
async function copy(fmt) {
  await page.evaluate(() => (window.__copied = null));
  await page.click(`#copyRow [data-copy="${fmt}"]`);
  await page.waitForTimeout(250);
  const given = await page.evaluate(() => window.__copied);
  const toast = (await page.$$eval('#toast .toast', (n) => n.map((x) => x.textContent))).pop() || '';
  let real = null;
  try {
    real = await page.evaluate(() => navigator.clipboard.readText());
  } catch (e) {
    real = `READ FAILED: ${String(e).split('\n')[0]}`;
  }
  return { given, real, toast };
}

const codes = await copy('code');
check('C: the app handed text to the clipboard', typeof codes.given === 'string' && codes.given.length > 0);
// The clipboard rewrites \n as \r\n on the way through, so the comparison has to
// be on the payload rather than the bytes. Nothing here normalises the other way:
// if the clipboard ever dropped or truncated a row, this still fails.
check(
  'C: the clipboard really holds the same text',
  String(codes.real).replace(/\r\n/g, '\n') === codes.given,
  // \r sits at the END of a line in CRLF, so testing for it at a line start is how
  // this label once reported "LF" for a clipboard holding 79 more characters than
  // the app had written - the exact number of newlines it had just converted.
  `line endings ${codes.given.includes('\r') ? 'app sent CRLF' : 'app sent LF'} / ` +
    `clip ${(codes.real || '').includes('\r\n') ? 'CRLF' : 'LF'}, ${(codes.real || '').length} vs ${codes.given.length} chars`
);

// The toast's own numbers have to agree with the text's shape, or the copy is a
// picture of a board rather than the board.
const m = /(\d+) of (\d+) cells/.exec(codes.toast);
check('C: the toast counts the cells', !!m, codes.toast);
if (m) {
  const painted = Number(m[1]);
  const total = Number(m[2]);
  const rows = codes.given.split('\n');
  const cols = rows[0].split('\t').length;
  check('C: rows x cols is the face the toast named', rows.length * cols === total, `${rows.length}x${cols} vs ${total}`);
  check('C: every row is the same width', rows.every((r) => r.split('\t').length === cols), `${cols} columns`);
  // Split on both separators. Splitting on the tab alone leaves the newline stuck
  // to the last token of every row, which is not ".", and the dot count comes out
  // one short per row - a bug in the arithmetic, not in the board.
  const dots = codes.given.split(/[\t\n]/).filter((t) => t === '.').length;
  check('C: the painted count matches the non-dot tokens', painted + dots === rows.length * cols, `${painted} painted`);
  check('C: one click copied exactly one cell', painted === 1, `${painted}`);
  const toks = codes.given.split(/[\t\n]/).filter((t) => t !== '.');
  check('C: and it is the shade that was held', toks.length === 1 && toks[0] === heldCode, toks.join(','));
}

const indices = await copy('index');
const iTok = indices.given.split(/[\t\n]/).filter((t) => t !== '.');
check('C: the index copy is the palette index', iTok.length === 1 && iTok[0] === String(idx), iTok.join(','));

const hexes = await copy('hex');
const hTok = hexes.given.split(/[\t\n]/).filter((t) => t !== '.');
check(
  'C: the hex copy is the palette colour, lowercase',
  hTok.length === 1 && hTok[0] === FLAT_COLORS[idx].toLowerCase(),
  hTok.join(',')
);
check('C: all three copies are the same shape', indices.given.split('\n').length === hexes.given.split('\n').length);

// An untouched face: the copy must say so instead of claiming a board.
const faceBtns = await page.$$('#faces [data-face]');
if (faceBtns.length > 1) {
  await faceBtns[1].click();
  await page.waitForTimeout(250);
  const blank = await copy('code');
  check('C: an empty face says every cell is blank', /every cell is blank/.test(blank.toast), blank.toast);
  check('C: and copies dots, not nothing', blank.given.length > 0 && !blank.given.replace(/[.\t\n]/g, ''), 'all dots');
} else {
  check('C: an empty face says so', false, 'this item has only one face, so the case was not exercised');
}

check('C: no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));

await b.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
