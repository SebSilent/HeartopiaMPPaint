/**
 * Two-client check for the per-player colour legend.
 *
 * The transport tests prove the field survives the wire. They cannot prove the
 * thing a player actually notices: that a second browser, in the same room,
 * shows the shade the first one is holding - that the chip is the right colour,
 * that black is not mistaken for "nothing", and that someone who joins late is
 * told what everyone is already wearing.
 *
 * Run: node tools/probe_legend.mjs   (dev server on 8099, relay on 8787)
 */
import { chromium } from 'playwright';
import { FLAT_COLORS } from '../assets/js/data/heartopia-palette.js';

const BASE = process.env.BASE || 'http://localhost:8099';
const RELAY = process.env.RELAY || 'ws://localhost:8787';
const ROOM = 'LEG' + String(Date.now()).slice(-4);
const NICK_A = 'Adelaide';
const NICK_B = 'Boris';
const NICK_C = 'Cara';

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' - ' + detail : ''}`);
}

/** `#e95e2b` -> `rgb(233, 94, 43)` the way a computed style reports it. */
function rgb(hex) {
  const h = hex.replace('#', '');
  return `rgb(${parseInt(h.slice(0, 2), 16)}, ${parseInt(h.slice(2, 4), 16)}, ${parseInt(h.slice(4, 6), 16)})`;
}

const browser = await chromium.launch();
const errors = [];

/**
 * One player, in their own context: two pages in one context share the stored
 * profile, so the second would join with the first one's clientId and the room
 * would see one player, not two.
 */
async function makePlayer(nick) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${nick} PAGEERROR ${e}`));
  page.on('console', (m) => m.type() === 'error' && errors.push(`${nick} CONSOLE ${m.text()}`));
  page.on('dialog', (d) => d.accept().catch(() => {}));

  const url = `${BASE}/?transport=ws&relay=${encodeURIComponent(RELAY)}&room=${ROOM}&item=tshirt&renderDelay=0`;
  await page.goto(url, { waitUntil: 'load' });
  // PLAN.md:156 - another app answers on some ports on this machine and will
  // happily serve a page that is not ours. Nothing below means anything until
  // this is our app.
  if (!(await page.locator('#app').count())) throw new Error(`${BASE} is not serving this app`);
  await page.fill('#nick', nick);
  await page.click('#join');
  await page.waitForFunction(() => !document.getElementById('app').classList.contains('locked'), null, { timeout: 20000 });
  await page.waitForFunction(() => document.getElementById('base').width > 300, null, { timeout: 20000 });

  return {
    nick,
    page,
    // `#swatches` holds only the open group, so a shade in another group is not
    // in the DOM at all. Walk the groups until it is, the same way a player does.
    pick: async (idx) => {
      const sel = `#swatches button[data-idx="${idx}"]`;
      if (!(await page.locator(sel).count())) {
        const groups = page.locator('#groups button[data-group]');
        const n = await groups.count();
        for (let g = 0; g < n; g++) {
          await groups.nth(g).click();
          await page.waitForTimeout(120);
          if (await page.locator(sel).count()) break;
        }
      }
      await page.click(sel);
      await page.waitForTimeout(350);
    },
    /** The chip on the avatar this browser draws for `who`. */
    chipFor: (who) =>
      page.evaluate((w) => {
        const av = [...document.querySelectorAll('#players .avatar')].find((a) => (a.title || '').startsWith(w));
        if (!av) return { found: false };
        const chip = av.querySelector('.shade');
        return {
          found: true,
          hasChip: !!chip,
          bg: chip ? getComputedStyle(chip).backgroundColor : null,
          title: av.title,
        };
      }, who),
    roster: () => page.evaluate(() => [...document.querySelectorAll('#players .avatar')].map((a) => a.title)),
  };
}

const A = await makePlayer(NICK_A);
const B = await makePlayer(NICK_B);

// --- both see each other ------------------------------------------------------
await B.page.waitForFunction(
  () => document.querySelectorAll('#players .avatar').length >= 2,
  null,
  { timeout: 15000 }
);
const seen = await B.roster();
check('L1: two players in one room are both listed', seen.length === 2, `${seen.length} avatars - ${JSON.stringify(seen)}`);

// --- a picked shade reaches the other browser ---------------------------------
const IDX = 42;
await A.pick(IDX);
let chip = null;
for (let t = 0; t < 20; t++) {
  chip = await B.chipFor(NICK_A);
  if (chip.hasChip) break;
  await B.page.waitForTimeout(250);
}
check('L2: Boris sees the shade Adelaide picked', !!chip.hasChip, JSON.stringify(chip));
check(
  `L3: that chip is ${FLAT_COLORS[IDX]} and not a guess`,
  chip.bg === rgb(FLAT_COLORS[IDX]),
  `chip ${chip.bg} vs expected ${rgb(FLAT_COLORS[IDX])}`
);
check('L4: the avatar says the shade in its own words', /painting/i.test(chip.title || ''), chip.title);

// --- your own avatar shows your own shade -------------------------------------
const self = await A.chipFor(NICK_A);
check('L5: Adelaide sees her own shade too', self.hasChip && self.bg === rgb(FLAT_COLORS[IDX]), JSON.stringify(self));

// --- the other player keeps theirs --------------------------------------------
const bSelf = await B.chipFor(NICK_B);
check('L6: Boris is not coloured by Adelaide pick', !bSelf.hasChip || bSelf.bg !== rgb(FLAT_COLORS[IDX]), JSON.stringify(bSelf));

// --- the lowest real shade ------------------------------------------------------
// Note: `showGroup` numbers swatches from 1 (`let flat = 1`), so palette index 0
// is not clickable anywhere in this UI. The 0-is-not-"none" case is therefore
// covered in the transport tests, where `setProfile({ shade: 0 })` is reachable;
// here the honest check is the first shade the palette actually offers.
await A.pick(1);
let black = null;
for (let t = 0; t < 20; t++) {
  black = await B.chipFor(NICK_A);
  if (black.hasChip && black.bg === rgb(FLAT_COLORS[1])) break;
  await B.page.waitForTimeout(250);
}
check('L7: the first real shade travels too', black.hasChip && black.bg === rgb(FLAT_COLORS[1]), JSON.stringify(black));

// --- a change travels as well as a first pick -----------------------------------
await A.pick(7);
let moved = null;
for (let t = 0; t < 20; t++) {
  moved = await B.chipFor(NICK_A);
  if (moved.bg === rgb(FLAT_COLORS[7])) break;
  await B.page.waitForTimeout(250);
}
check('L8: switching shade follows', moved.bg === rgb(FLAT_COLORS[7]), JSON.stringify(moved));

// --- a late joiner is told what is already in use --------------------------------
const C = await makePlayer(NICK_C);
let late = null;
for (let t = 0; t < 24; t++) {
  late = await C.chipFor(NICK_A);
  if (late.hasChip && late.bg === rgb(FLAT_COLORS[7])) break;
  await C.page.waitForTimeout(250);
}
check('L9: a player who joins late sees the shade already held', late.hasChip && late.bg === rgb(FLAT_COLORS[7]), JSON.stringify(late));
const cSeen = await C.roster();
check('L10: the late joiner sees all three', cSeen.length === 3, JSON.stringify(cSeen));

check('Z: no page errors anywhere', errors.length === 0, errors.slice(0, 3).join(' | '));
console.log(`\n${pass} PASS / ${fail} FAIL`);
await browser.close();
process.exit(fail ? 1 : 0);
