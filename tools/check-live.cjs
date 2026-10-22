/*
 * The live site, as published. No local server, no relay of ours, no overrides:
 * whatever a stranger gets from https://sebsilent.github.io/HeartopiaMPPaint/
 * is what this tests, which means the default serverless WebRTC transport and
 * the public broker are the thing under test.
 */
const { chromium } = require('playwright');

const BASE = 'https://sebsilent.github.io/HeartopiaMPPaint/';
const results = [];
const errors = [];
function ok(name, pass, detail) {
  results.push(pass);
  console.log((pass ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  [' + detail + ']' : ''));
}

// A room code nobody has used before. Broker rooms outlive the tabs that made them.
const ROOM = 'LIVE' + Math.random().toString(36).slice(2, 7).toUpperCase();

async function join(browser, nick) {
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 800 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${nick}: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const t = m.text();
    // Claiming the room and finding it taken is how a guest joins. PeerJS logs
    // it as an error on the way, and it is not a fault in what we built.
    if (/PeerJS/.test(t)) return;
    errors.push(`${nick} console: ${t}`);
  });
  await page.goto(`${BASE}?room=${ROOM}`, { waitUntil: 'load', timeout: 60000 });
  await page.waitForSelector('#nick', { timeout: 30000 });
  await page.fill('#nick', nick);
  await page.click('#join');
  const inRoom = await page
    .waitForFunction(() => !document.getElementById('app').classList.contains('locked'), { timeout: 45000 })
    .then(() => true)
    .catch(() => false);
  return { ctx, page, inRoom };
}

/** Pick a shade from the palette and return the colour it should draw. */
async function pickShade(page, n) {
  return page.evaluate(
    ([i]) => {
      const sw = [...document.querySelectorAll('#swatches .swatch, .swatch')];
      const el = sw[i % sw.length] || sw[0];
      if (!el) return null;
      el.click();
      const m = getComputedStyle(el).backgroundColor.match(/(\d+), (\d+), (\d+)/);
      if (!m) return null;
      return { hex: '#' + m.slice(1, 4).map((v) => Number(v).toString(16).padStart(2, '0')).join(''), title: el.title };
    },
    [n]
  );
}

/**
 * Drag across a region of the board, given as fractions so two players can be
 * made to paint in places that cannot overlap. Overlapping strokes are the
 * mistake this file used to make: the ink was syncing and the pixel count just
 * could not show it.
 */
async function paintRegion(page, box, from, to) {
  const [fx, fy] = from;
  const [tx, ty] = to;
  await page.mouse.move(box.x + box.width * fx, box.y + box.height * fy);
  await page.mouse.down();
  const steps = 10;
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(
      box.x + box.width * (fx + ((tx - fx) * i) / steps),
      box.y + box.height * (fy + ((ty - fy) * i) / steps)
    );
  }
  await page.mouse.up();
}

const countShade = ([hex]) => {
  const c = document.getElementById('base');
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  const d = c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, c.width, c.height).data;
  let count = 0;
  for (let i = 0; i < d.length; i += 4) if (d[i] === r && d[i + 1] === g && d[i + 2] === b) count++;
  return count;
};

/** A cheap fingerprint of the whole board, so "in sync" is a fact and not a vibe. */
const boardHash = () => {
  const c = document.getElementById('base');
  const d = c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, c.width, c.height).data;
  let h = 2166136261;
  for (let i = 0; i < d.length; i += 4) {
    h ^= (d[i] << 16) | (d[i + 1] << 8) | d[i + 2];
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h;
};

(async () => {
  const browser = await chromium.launch();
  console.log(`live site, room ${ROOM}`);

  const a = await join(browser, 'AliceLive');
  ok('a stranger can open the published page and join', a.inRoom);
  if (!a.inRoom) {
    ok('and nothing else can be tested without a first player', false, 'stuck at the gate');
    console.log(`\n${results.filter(Boolean).length}/${results.length} live checks passed`);
    process.exit(1);
  }

  const shade = await pickShade(a.page, 10);
  ok('the palette is usable on the live page', !!shade, JSON.stringify(shade));

  const box = await a.page.locator('#base').boundingBox();
  ok('the board has a real box to paint on', box && box.width > 200, box && `${Math.round(box.width)}x${Math.round(box.height)}`);

  // Top-left quarter for Alice.
  await paintRegion(a.page, box, [0.12, 0.12], [0.3, 0.3]);
  await a.page.waitForTimeout(1500);
  const mine = await a.page.evaluate(countShade, [shade.hex]);
  ok('painting works on the published site', mine > 200, `${mine} px of ${shade.hex}`);

  const b = await join(browser, 'BobLive');
  ok('a second player can join the same room', b.inRoom);
  if (!b.inRoom) {
    console.log(`\n${results.filter(Boolean).length}/${results.length} live checks passed`);
    process.exit(1);
  }

  // The roster is #players, holding one .avatar per person with the name in title.
  const names = (page) => page.evaluate(() => [...document.querySelectorAll('#players .avatar')].map((n) => n.getAttribute('title')));
  await a.page.waitForFunction(() => document.querySelectorAll('#players .avatar').length >= 2, { timeout: 25000 }).catch(() => {});
  const rosterA = await names(a.page);
  const rosterB = await names(b.page);
  ok('both players appear in each other\'s roster', rosterA.length === 2 && rosterB.length === 2, `${JSON.stringify(rosterA)} / ${JSON.stringify(rosterB)}`);

  // Bottom-right quarter for Bob: cells Alice cannot have touched.
  const boxB = await b.page.locator('#base').boundingBox();
  const bShade = await pickShade(b.page, 40);
  await paintRegion(b.page, boxB, [0.7, 0.7], [0.88, 0.88]);
  await b.page.waitForTimeout(1500);
  const bMine = await b.page.evaluate(countShade, [bShade.hex]);
  ok('the second player can paint too', bMine > 200, `${bMine} px of ${bShade.hex}`);

  await a.page.waitForTimeout(4000);
  const bOnA = await a.page.evaluate(countShade, [bShade.hex]);
  ok('one player sees the other\'s paint arrive', bOnA > 200, `alice sees ${bOnA} px of bob's ${bShade.hex}`);

  const ha = await a.page.evaluate(boardHash);
  const hb = await b.page.evaluate(boardHash);
  ok('and the two boards are identical, not merely similar', ha === hb, `hash ${ha} vs ${hb}`);

  const transport = await a.page.evaluate(async () => {
    const m = await import('/HeartopiaMPPaint/assets/js/config.js');
    return m.CONFIG.transport;
  });
  ok('it is running the serverless transport, with no relay of ours', transport === 'peer', String(transport));

  // A third player, because a host that only ever holds one guest is a common
  // and embarrassing failure.
  const c = await join(browser, 'CaraLive');
  if (c.inRoom) {
    await a.page.waitForFunction(() => document.querySelectorAll('#players .avatar').length >= 3, { timeout: 30000 }).catch(() => {});
    const three = await names(a.page);
    ok('a third player joins the same room', three.length === 3, JSON.stringify(three));
    await c.page.waitForTimeout(2500);
    const hc = await c.page.evaluate(boardHash);
    ok('and sees the picture that was already there', hc === ha, `hash ${hc} vs ${ha}`);
  } else {
    ok('a third player joins the same room', false, 'could not join');
  }

  ok('no page or console errors on the live site', errors.length === 0, errors.slice(0, 3).join(' | ').slice(0, 300));
  await browser.close();
  const bad = results.filter((r) => !r).length;
  console.log(`\n${results.length - bad}/${results.length} live checks passed`);
  process.exit(bad ? 1 : 0);
})().catch((e) => {
  console.log('THREW', e.message);
  process.exit(1);
});
