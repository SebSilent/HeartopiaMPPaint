/*
 * Checks README.md for the things that are easy to get wrong and impossible to
 * notice by reading: a table-of-contents anchor that points at a heading that
 * was later renamed, a relative link to a file that does not exist, and a
 * markdown table whose rows disagree about how many columns they have.
 *
 *   node tools/check_readme_links.mjs          # local checks only
 *   node tools/check_readme_links.mjs --net    # also fetch every external URL
 *
 * External URLs are opt-in because a checker that fails when the network is down
 * gets switched off, and then it checks nothing.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILE = path.join(ROOT, 'README.md');
const md = fs.readFileSync(FILE, 'utf8');
const NET = process.argv.includes('--net');

let bad = 0;
let warned = 0;
const fail = (m) => { bad++; console.log('FAIL ' + m); };
const warn = (m) => { warned++; console.log('warn ' + m); };
const ok = (m) => console.log('ok   ' + m);

/* ------------------------------------------------------- heading anchors */

/**
 * GitHub's anchor rule: lowercase, drop punctuation other than - and _, then
 * spaces to hyphens. Getting this wrong is the whole failure mode - a TOC link
 * that looks right and jumps nowhere.
 */
function anchorOf(heading) {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-');
}

// Split on /\r?\n/, not '\n': this file has CRLF endings, and in JS `.` does not
// match \r while `$` without /m does not match before it - so a per-line
// /^(#{1,6})\s+(.*)$/ silently matches nothing at all on a Windows checkout.
const LINES = md.split(/\r?\n/);

// Headings only outside fenced code blocks. A bash comment is "# serve the site",
// which matches a heading regex perfectly and is not a heading at all.
const headings = [];
let fenced = false;
LINES.forEach((line) => {
  if (/^\s*```/.test(line)) { fenced = !fenced; return; }
  if (fenced) return;
  const m = line.match(/^(#{1,6})\s+(.*)$/);
  if (!m) return;
  const text = m[2].replace(/`/g, '').trim();
  headings.push({ level: m[1].length, text, anchor: anchorOf(text) });
});
const anchors = new Set(headings.map((h) => h.anchor));
ok(`${headings.length} headings, ${anchors.size} unique anchors`);

const dupes = headings.map((h) => h.anchor)
  .filter((a, i, all) => all.indexOf(a) !== i);
for (const d of new Set(dupes)) fail(`duplicate heading anchor "#${d}" - GitHub will suffix it, and the TOC link will miss`);

// Exactly one H1, and it is the first heading: the page title.
const h1s = headings.filter((h) => h.level === 1);
if (h1s.length !== 1) fail(`${h1s.length} H1 headings, want exactly 1`);
else if (headings[0] !== h1s[0]) fail('the H1 is not the first heading in the file');
else ok(`H1: ${h1s[0].text}`);

/* ------------------------------------------------------------- links */

const links = [...md.matchAll(/\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)].map((m) => m[1]);
let internal = 0, relative = 0, external = 0;

for (const target of links) {
  if (target.startsWith('#')) {
    internal++;
    if (!anchors.has(target.slice(1))) fail(`anchor ${target} matches no heading`);
    continue;
  }
  if (/^https?:\/\//.test(target)) { external++; continue; }
  if (/^mailto:/.test(target)) continue;
  relative++;
  const p = path.join(ROOT, target.replace(/^\.\//, '').split('#')[0]);
  if (!fs.existsSync(p)) fail(`relative link ${target} does not exist`);
}
ok(`${internal} anchors, ${relative} relative links, ${external} external URLs`);

// Every heading worth jumping to should be reachable from the TOC, or the TOC is
// decoration that has already drifted.
const tocAnchors = new Set(links.filter((l) => l.startsWith('#')).map((l) => l.slice(1)));
for (const a of tocAnchors) {
  if (!anchors.has(a)) fail(`TOC points at #${a}, which is not a heading`);
}
// The contents heading is not itself an entry in the contents.
const unreachable = headings.filter(
  (h) => h.level === 2 && !tocAnchors.has(h.anchor) && h.anchor !== 'table-of-contents'
);
for (const h of unreachable) warn(`H2 "${h.text}" is not in the table of contents`);

/* ------------------------------------------------------------ tables */

let table = null;
const flush = () => {
  if (!table) return;
  const counts = new Set(table.rows.map((r) => r.cells));
  if (counts.size !== 1) {
    fail(`table at line ${table.start} has rows with ${[...counts].join('/')} columns`);
  }
  if (table.rows.length < 2 || !table.rows[1].separator) {
    fail(`table at line ${table.start} has no |---| separator row`);
  }
  table = null;
};
LINES.forEach((line, i) => {
  const t = line.trim();
  if (t.startsWith('|') && t.endsWith('|')) {
    const cells = t.slice(1, -1).split('|').length;
    const separator = /^\|[\s:|-]+\|$/.test(t);
    if (!table) table = { start: i + 1, rows: [] };
    table.rows.push({ cells, separator });
  } else {
    flush();
  }
});
flush();
ok('markdown tables are rectangular');

/* ------------------------------------------------- external, opt-in */

if (NET) {
  for (const url of new Set(links.filter((l) => /^https?:\/\//.test(l)))) {
    try {
      const r = await fetch(url, { method: 'GET', redirect: 'follow', signal: AbortSignal.timeout(15000) });
      if (!r.ok) fail(`${url} -> HTTP ${r.status}`);
      else ok(`${url} -> ${r.status}`);
    } catch (e) {
      warn(`${url} could not be fetched: ${e.message}`);
    }
  }
} else if (external) {
  console.log(`     (${external} external URLs not fetched - pass --net to check them)`);
}

console.log(bad ? `\n${bad} problem(s), ${warned} warning(s)` : `\nREADME links and tables pass (${warned} warning(s))`);
process.exit(bad ? 1 : 0);
