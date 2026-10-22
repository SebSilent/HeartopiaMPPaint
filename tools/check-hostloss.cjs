/*
 * What happens when the host walks away. Three players on the published site,
 * then the host tab is closed and the other two have to sort themselves out
 * without losing the picture. The README cannot say anything about this that
 * this file has not seen.
 */
const { chromium } = require('playwright');

const BASE = 'https://sebsilent.github.io/HeartopiaMPPaint/';
const ROOM = 'DROP' + Math.random().toString(36).slice(2, 7).toUpperCase();
const results = [];
function ok(name, pass, detail) {
  results.push(pass);
  console.log((pass ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  [' + detail + ']' : ''));
}

async function join(browser, nick) {
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 800 } });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(`${BASE}?room=${ROOM}`, { waitUntil: 'load', timeout: 60000 });
  await page.waitForSelector('#nick', { timeout: 30000 });
  await page.fill('#nick', nick);
  await page.click('#join');
  await page.waitForFunction(() => !document.getElementById('app').classList.contains('locked'), { timeout: 45000 }).catch(() => {});
  return { ctx, page, errs };
}

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

async function paintCorner(page, from, to) {
  const box = await page.locator('#base').boundingBox();
  await page.mouse.move(box.x + box.width * from[0], box.y + box.height * from[1]);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) {
    await page.mouse.move(
      box.x + box.width * (from[0] + ((to[0] - from[0]) * i) / 8),
      box.y + box.height * (from[1] + ((to[1] - from[1]) * i) / 8)
    );
  }
  await page.mouse.up();
}

(async () => {
  const browser = await chromium.launch();
  console.log('room', ROOM);

  const host = await join(browser, 'Host');
  await paintCorner(host.page, [0.1, 0.1], [0.3, 0.3]);
  await host.page.waitForTimeout(1000);

  const g1 = await join(browser, 'Grace');
  const g2 = await join(browser, 'Henry');
  await host.page.waitForFunction(() => document.querySelectorAll('#players .avatar').length >= 3, { timeout: 40000 }).catch(() => {});
  const three = await host.page.evaluate(() => [...document.querySelectorAll('#players .avatar')].map((n) => n.getAttribute('title')));
  ok('three players are in the room', three.length === 3, JSON.stringify(three));

  const beforeHash = await host.page.evaluate(boardHash);
  const h1 = await g1.page.evaluate(boardHash);
  const h2 = await g2.page.evaluate(boardHash);
  ok('all three agree on the picture before anyone leaves', h1 === beforeHash && h2 === beforeHash, `${beforeHash} / ${h1} / ${h2}`);

  console.log('closing the host tab');
  await host.ctx.close();

  /*
   * The survivors need a host before they can talk to each other again, and that
   * takes a while: the watchdog only calls a host dead after hostTimeoutMs of
   * silence, then they race for the room id with a randomised backoff. Painting
   * during that window is dropped, which is the honest cost of having no server.
   * So wait for the takeover to finish, and only then ask if drawing works.
   */
  const gone = await g1.page
    .waitForFunction(() => !document.querySelector('#players .avatar[title="Host"]'), { timeout: 60000 })
    .then(() => true)
    .catch(() => false);
  ok('the dead host is dropped from the roster', gone, JSON.stringify(await g1.page.evaluate(() => [...document.querySelectorAll('#players .avatar')].map((n) => n.getAttribute('title')))));

  // Give the new host a moment to settle before anyone tries to draw.
  await g1.page.waitForTimeout(6000);
  await paintCorner(g1.page, [0.6, 0.2], [0.8, 0.4]);
  await g1.page.waitForTimeout(4000);

  const afterA = await g1.page.evaluate(boardHash);
  const afterB = await g2.page.evaluate(boardHash);
  ok('a survivor can still paint after the takeover', afterA !== beforeHash, `hash ${beforeHash} -> ${afterA}`);
  ok('and the other survivor receives it', afterA === afterB, `${afterA} vs ${afterB}`);

  const rosters = await Promise.all([
    g1.page.evaluate(() => [...document.querySelectorAll('#players .avatar')].map((n) => n.getAttribute('title'))),
    g2.page.evaluate(() => [...document.querySelectorAll('#players .avatar')].map((n) => n.getAttribute('title'))),
  ]);
  ok(
    'and the departed player is gone from both rosters',
    rosters.every((r) => !r.includes('Host') && r.length === 2),
    JSON.stringify(rosters)
  );

  ok('no page errors in the survivors', g1.errs.length === 0 && g2.errs.length === 0, [...g1.errs, ...g2.errs].slice(0, 2).join(' | '));
  await browser.close();
  const bad = results.filter((r) => !r).length;
  console.log(`\n${results.length - bad}/${results.length} host-loss checks passed`);
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.log('THREW', e.message); process.exit(1); });
