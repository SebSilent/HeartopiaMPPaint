/*
 * Checks the SEO parts of index.html that are easy to get silently wrong:
 * the JSON-LD actually parses, the meta description is in the length Google
 * truncates around, every og:/twitter: URL is absolute, and the tags the share
 * cards depend on are present. Run with `node tools/check_seo.mjs`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

let bad = 0;
const fail = (m) => { bad++; console.log('FAIL ' + m); };
const ok = (m) => console.log('ok   ' + m);

const attr = (tag, name) => {
  const re = new RegExp(`<${tag}[^>]*?\\s${name}="([^"]*)"`, 'i');
  const m = html.match(re);
  return m ? m[1] : null;
};

// --- title ---------------------------------------------------------------
const title = html.match(/<title>([^<]*)<\/title>/)?.[1];
if (!title) fail('no <title>');
else if (title !== 'Heartopia Painting Tool | Multiplayer Pixel Art Editor') fail(`unexpected title: ${title}`);
else if (title.length > 60) fail(`title is ${title.length} chars, over the ~60 that fits a SERP`);
else ok(`title ${title.length} chars`);

// --- meta description ----------------------------------------------------
const desc = attr('meta name="description"', 'content')
  || html.match(/<meta name="description" content="([^"]*)"/)?.[1];
if (!desc) fail('no meta description');
else if (desc.length < 120 || desc.length > 158) fail(`meta description is ${desc.length} chars, want 120-158`);
else ok(`meta description ${desc.length} chars`);
for (const kw of ['Heartopia', '125-shade', '3D']) {
  if (!desc.includes(kw)) fail(`meta description does not mention "${kw}"`);
}

// --- required tags -------------------------------------------------------
const required = [
  'link rel="canonical"',
  'meta property="og:type"',
  'meta property="og:title"',
  'meta property="og:description"',
  'meta property="og:url"',
  'meta property="og:image"',
  'meta property="og:image:width"',
  'meta property="og:image:height"',
  'meta name="twitter:card"',
  'meta name="twitter:image"',
];
for (const r of required) {
  if (!html.includes(r)) fail(`missing <${r}>`);
}
ok(`${required.length} required tags present`);

// --- every URL absolute, and og:image points at a file that exists -------
const urls = [...html.matchAll(/content="(https?:\/\/[^"]+)"|href="(https?:\/\/[^"]+)"|url":\s*"(https?:\/\/[^"]+)"/g)]
  .map((m) => m[1] || m[2] || m[3]).filter(Boolean);
for (const u of urls) {
  if (u.includes(' ')) fail(`URL contains a space: ${u}`);
}
const ogImage = html.match(/property="og:image" content="([^"]+)"/)?.[1];
if (!ogImage) fail('no og:image');
else {
  const local = ogImage.replace('https://sebsilent.github.io/HeartopiaMPPaint/', '');
  const p = path.join(ROOT, local);
  if (!fs.existsSync(p)) fail(`og:image points at ${local}, which does not exist`);
  else {
    const png = fs.readFileSync(p);
    const w = png.readUInt32BE(16), h = png.readUInt32BE(20);
    if (w !== 1200 || h !== 630) fail(`og:image is ${w}x${h}, want 1200x630`);
    else ok(`og:image ${local} is ${w}x${h}, ${(png.length / 1024).toFixed(1)} KB`);
  }
}

// --- JSON-LD parses ------------------------------------------------------
const blocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
if (!blocks.length) fail('no JSON-LD block');
for (const [, body] of blocks) {
  try {
    const data = JSON.parse(body);
    const types = (data['@graph'] || [data]).map((n) => n['@type']).join(', ');
    ok(`JSON-LD parses: ${types}`);
  } catch (e) {
    fail('JSON-LD does not parse: ' + e.message);
  }
}

// --- the app still boots: config script and stylesheet survived ----------
for (const needle of ['window.HMP_CONFIG', './assets/css/style.css', 'id="app"', 'id="base"']) {
  if (!html.includes(needle)) fail(`index.html lost ${needle}`);
}
ok('app wiring intact');

// --- installable: manifest and icons -------------------------------------
// A manifest that points at a missing or wrongly-sized icon installs with a
// screenshot of the page instead, and nothing in the browser says why.
const pngSize = (p) => {
  const b = fs.readFileSync(p);
  if (b.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  return [b.readUInt32BE(16), b.readUInt32BE(20)];
};

const manifestHref = html.match(/<link rel="manifest" href="([^"]+)"/)?.[1];
if (!manifestHref) fail('no <link rel="manifest">');
else {
  const mPath = path.join(ROOT, manifestHref.replace(/^\.\//, ''));
  if (!fs.existsSync(mPath)) fail(`manifest ${manifestHref} does not exist`);
  else {
    const m = JSON.parse(fs.readFileSync(mPath, 'utf8'));
    for (const key of ['name', 'short_name', 'start_url', 'display', 'theme_color', 'background_color']) {
      if (!m[key]) fail(`manifest is missing "${key}"`);
    }
    // Absolute paths would 404 on GitHub Pages, where the site lives under
    // /HeartopiaMPPaint/ and not at the domain root.
    for (const key of ['start_url', 'scope']) {
      if (m[key] && m[key].startsWith('/') && !m[key].startsWith('/HeartopiaMPPaint')) {
        fail(`manifest ${key} "${m[key]}" is root-absolute and will break on GitHub Pages`);
      }
    }
    if (!m.icons?.length) fail('manifest lists no icons');
    for (const icon of m.icons || []) {
      const rel = icon.src.replace(/^\.\//, '');
      const p = path.join(ROOT, rel);
      if (!fs.existsSync(p)) { fail(`manifest icon ${icon.src} does not exist`); continue; }
      const [w, h] = pngSize(p);
      if (`${w}x${h}` !== icon.sizes) fail(`manifest icon ${icon.src} is ${w}x${h}, declares ${icon.sizes}`);
      else ok(`manifest icon ${rel} ${w}x${h} purpose=${icon.purpose}`);
      if (icon.purpose === 'maskable' && w < 512) fail(`maskable icon ${icon.src} is only ${w}px`);
    }
  }
}

const touch = html.match(/<link rel="apple-touch-icon" href="([^"]+)"/)?.[1];
if (!touch) fail('no apple-touch-icon (iOS falls back to a screenshot of the page)');
else {
  const p = path.join(ROOT, touch.replace(/^\.\//, ''));
  if (!fs.existsSync(p)) fail(`apple-touch-icon ${touch} does not exist`);
  else {
    const [w, h] = pngSize(p);
    if (w !== 180 || h !== 180) fail(`apple-touch-icon is ${w}x${h}, want 180x180`);
    else ok(`apple-touch-icon ${touch} 180x180`);
  }
}

console.log(bad ? `\n${bad} problem(s)` : '\nindex.html SEO checks pass');
process.exit(bad ? 1 : 0);
