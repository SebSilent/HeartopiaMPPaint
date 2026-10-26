// Failure modes, exercised in a browser.
//
// Every guard below was added by reading code, which is exactly how a guard
// ends up wrong: it looks reasonable and never runs. Each case here drives the
// real DOM (a real File through the real input, a real throw inside the real
// frame loop) and asserts the app said something the user can act on rather
// than crashed or went quiet.
//
//   node tools/probe_failguards.mjs http://localhost:8099
import { chromium } from 'playwright';

const BASE = (process.argv[2] || 'http://localhost:8099').replace(/\/$/, '');
const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`);
};

const browser = await chromium.launch();

/**
 * Fresh page, unlocked app, optional extra query params.
 *
 * `routes` must be installed before goto: a module the page has already fetched
 * cannot be broken after the fact, and a route added after load is a route that
 * matches nothing.
 */
async function open(query = '', routes = []) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push('console: ' + m.text());
  });
  for (const r of routes) await page.route(r.pattern, r.handler);
  await page.goto(`${BASE}/?local=1&renderDelay=0${query}`, { waitUntil: 'load' });
  await page.waitForFunction(() => !document.getElementById('app').classList.contains('locked'), {
    timeout: 20000,
  });
  await page.waitForFunction(() => document.getElementById('base').width > 300, { timeout: 10000 });
  return { page, errors };
}

/** Feed a File through the real file input, the way a drop does. */
async function drop(page, name, type, bytes) {
  await page.evaluate(
    async ({ name, type, len }) => {
      const body = new Uint8Array(len);
      // Only the first bytes matter for the guards; a real PNG header would get
      // past the cheap checks and into the decoder, which is what we want.
      const head = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
      body.set(head, 0);
      const file = new File([name.endsWith('.txt') ? 'just some text' : body], name, { type });
      const dt = new DataTransfer();
      dt.items.add(file);
      const input = document.getElementById('file');
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    },
    { name, type, len: bytes }
  );
  await page.waitForTimeout(500);
}

// Count pixels that are not the backdrop. The renderer fills the whole canvas
// with #c2ccd3 first, so a raw alpha count measures the canvas size and reports
// success for a panel that drew nothing at all - which is how one earlier probe
// confidently declared an empty panel to be a book.
async function drawnPixels(page) {
  return page.evaluate(() => {
    const cv = document.getElementById('d3Canvas');
    if (!cv || !cv.width) return -1;
    const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] < 8) continue;
      if (Math.abs(d[i] - 194) < 6 && Math.abs(d[i + 1] - 204) < 6 && Math.abs(d[i + 2] - 211) < 6) continue;
      n++;
    }
    return n;
  });
}

const info = (page) => page.locator('#importInfo').textContent();
const applyDisabled = (page) => page.locator('#importApply').isDisabled();
const prevHidden = (page) => page.locator('#importPrev').evaluate((e) => e.hidden);

/* ---- A. a file that is not a picture ---- */
{
  const { page, errors } = await open('&item=tshirt');
  await page.click('#btnImport');
  await drop(page, 'notes.txt', 'text/plain', 10);
  const text = (await info(page)) || '';
  check('A: non-image refused with a plain-language reason', /not a picture/i.test(text), text);
  check('A: Apply stays disabled', (await applyDisabled(page)) === true);
  check('A: no preview opened', (await prevHidden(page)) === true);
  check('A: no page error', errors.length === 0, errors[0] || '');
  await page.close();
}

/* ---- B. a file that is too big to read here ---- */
{
  const { page, errors } = await open('&item=tshirt&importMaxMB=1');
  await page.click('#btnImport');
  await drop(page, 'huge.png', 'image/png', 2 * 1024 * 1024);
  const text = (await info(page)) || '';
  check('B: oversized file refused', /too big/i.test(text), text);
  check('B: no page error', errors.length === 0, errors[0] || '');
  await page.close();
}

/* ---- C. a picture too large in pixels ---- */
{
  const { page, errors } = await open('&item=tshirt&importMaxMP=0.5');
  await page.click('#btnImport');
  // 1200x800 = 0.96 MP, over the lowered cap, and small enough to encode fast.
  const b64 = await page.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 1200;
    c.height = 800;
    const x = c.getContext('2d');
    x.fillStyle = '#ff0000';
    x.fillRect(0, 0, 1200, 800);
    return c.toDataURL('image/png').split(',')[1];
  });
  await page.evaluate(async (data) => {
    const blob = await (await fetch(data)).blob();
    const file = new File([blob], 'big.png', { type: 'image/png' });
    const dt = new DataTransfer();
    dt.items.add(file);
    const input = document.getElementById('file');
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, `data:image/png;base64,${b64}`);
  await page.waitForTimeout(800);
  const text = (await info(page)) || '';
  check('C: oversized raster refused with its size', /crop it closer/i.test(text), text);
  check('C: no preview opened', (await prevHidden(page)) === true);
  check('C: no page error', errors.length === 0, errors[0] || '');
  await page.close();
}

/* ---- D. a file that claims to be a PNG and is not ---- */
{
  const { page, errors } = await open('&item=tshirt');
  await page.click('#btnImport');
  await page.evaluate(() => {
    const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5, 6])], 'broken.png', {
      type: 'image/png',
    });
    const dt = new DataTransfer();
    dt.items.add(file);
    const input = document.getElementById('file');
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForTimeout(1200);
  const text = (await info(page)) || '';
  check('D: undecodable image reported, not thrown', text.length > 0 && /could not read|not load|fail/i.test(text), text);
  check('D: Apply disabled after failure', (await applyDisabled(page)) === true);
  check('D: no page error', errors.length === 0, errors[0] || '');
  await page.close();
}

/* ---- E. a good image still imports (guards did not over-reach) ---- */
{
  const { page, errors } = await open('&item=tshirt');
  await page.click('#btnImport');
  const b64 = await page.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 120;
    c.height = 60;
    const x = c.getContext('2d');
    x.fillStyle = '#000000';
    x.fillRect(0, 0, 60, 60);
    x.fillStyle = '#ff0000';
    x.fillRect(60, 0, 60, 60);
    return c.toDataURL('image/png').split(',')[1];
  });
  await page.evaluate(async (data) => {
    const blob = await (await fetch(data)).blob();
    const file = new File([blob], 'good.png', { type: 'image/png' });
    const dt = new DataTransfer();
    dt.items.add(file);
    const input = document.getElementById('file');
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, `data:image/png;base64,${b64}`);
  await page.waitForTimeout(1200);
  check('E: a normal image is accepted', (await prevHidden(page)) === false);
  check('E: Apply enabled', (await applyDisabled(page)) === false);
  check('E: no page error', errors.length === 0, errors[0] || '');
  await page.close();
}

/* ---- F. the 3D geometry source throws -> flat fallback, out loud ---- */
{
  // Break the module that generates the book solid, so loadSolid() rejects for
  // real instead of in theory.
  const { page, errors } = await open('&item=book', [
    {
      pattern: '**/assets/js/game/book3d.js',
      handler: (route) =>
        route.fulfill({
          contentType: 'application/javascript',
          body:
            'export function hasProcedural(id) { return id === "book"; }\n' +
            'export function proceduralFor() { throw new Error("probe: forced solid failure"); }\n' +
            'export function bookMesh() { throw new Error("probe: forced solid failure"); }\n',
        }),
    },
  ]);
  await page.click('#btn3d');
  await page.waitForTimeout(900);
  const toasts = await page.locator('#toast .toast').allTextContents();
  const fellBack = toasts.some((t) => /fell back to the flat layout/i.test(t));
  check('F: flat fallback announced', fellBack, toasts.join(' | ') || 'no toast');
  check('F: fallback still drew an object', (await drawnPixels(page)) > 500, `${await drawnPixels(page)} px`);
  // The whole point of the catch: no unhandled rejection, which is what a
  // silently never-drawing panel came from.
  check('F: no uncaught error', errors.length === 0, errors[0] || '');
  await page.close();
}

/* ---- G. a throw inside the frame loop stops instead of flooding ---- */
{
  const { page, errors } = await open('&item=tshirt');
  await page.click('#btn3d');
  await page.waitForTimeout(700);
  // Now make rendering fail, on the 3D canvas only, so the 2D board keeps
  // working and the loop guard is the thing under test.
  await page.evaluate(() => {
    const proto = CanvasRenderingContext2D.prototype;
    // Keep the original on the object so it can be put back. `delete` would
    // remove the prototype's own method, not just the override, and every
    // later drawImage would fail for the wrong reason.
    proto.__realDrawImage = proto.drawImage;
    proto.drawImage = function (...a) {
      if (this.canvas && this.canvas.id === 'd3Canvas') throw new Error('probe: forced render failure');
      return proto.__realDrawImage.apply(this, a);
    };
  });
  await page.waitForTimeout(200);
  // An idle preview does not repaint at all - render() returns early unless
  // something marked it dirty - so "wait a second and see if it throws" tests
  // nothing. Orbit it, which is the one thing a user actually does while frames
  // are being drawn.
  const orbit = async () => {
    const box = await page.locator('#d3Canvas').boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    for (let i = 1; i <= 8; i++) await page.mouse.move(box.x + box.width / 2 + i * 8, box.y + box.height / 2);
    await page.mouse.up();
  };
  await orbit();
  await page.waitForTimeout(1500); // ~90 frames: enough for a flood to show up
  const later = await page.locator('#toast .toast').allTextContents();
  const stopped = later.filter((t) => /3D preview stopped/i.test(t));
  check('G: loop guard announced once', stopped.length === 1, `${stopped.length} x: ${stopped[0] || later.join(' | ')}`);
  check('G: panel closed after the throw', await page.locator('#d3Panel').evaluate((e) => e.hidden));
  check('G: no uncaught error flood', errors.length === 0, `${errors.length} errors: ${errors[0] || ''}`);
 // Orbiting again is not possible - the panel is closed, so its canvas has no
  // box - and waiting proves nothing either, because an idle loop deliberately
  // does not repaint. The user-facing question is whether they get 3D back, so
  // fix the fault and reopen it.
  await page.evaluate(() => {
    const proto = CanvasRenderingContext2D.prototype;
    proto.drawImage = proto.__realDrawImage;
  });
  await page.click('#btn3d');
  await page.waitForTimeout(800);
  const reopened = await page.locator('#d3Panel').evaluate((e) => !e.hidden);
  check('G: reopening 3D after a failure works', reopened);
  const px = await drawnPixels(page);
  check('G: reopened preview draws again', px > 500, `${px} px`);
  const after = (await page.locator('#toast .toast').allTextContents()).filter((t) => /3D preview stopped/i.test(t));
  check('G: still only one stop notice', after.length === 1, `${after.length}`);
  // And the board itself must survive: this failure was supposed to be local.
  await page.evaluate(async () => {
    const cv = document.getElementById('base');
    const r = cv.getBoundingClientRect();
    const at = (t, x, y) =>
      cv.dispatchEvent(new PointerEvent(t, { bubbles: true, clientX: x, clientY: y, pointerId: 1, isPrimary: true }));
    at('pointerdown', r.left + r.width * 0.5, r.top + r.height * 0.5);
    at('pointermove', r.left + r.width * 0.55, r.top + r.height * 0.52);
    at('pointerup', r.left + r.width * 0.55, r.top + r.height * 0.52);
    await new Promise((res) => setTimeout(res, 250));
  });
  check('G: board stroke raised no new error', errors.length === 0, errors[0] || '');
  await page.close();
}

await browser.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} failure-guard checks passed`);
process.exit(failed.length ? 1 : 0);
