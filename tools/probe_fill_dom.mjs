// Exploratory: dump the palette panel and tool buttons so the fill probe can
// target real selectors instead of guessed ones.
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://localhost:8099';
const b = await chromium.launch();
const page = await b.newPage({ viewport: { width: 1280, height: 900 } });
page.on('pageerror', (e) => console.log('PAGEERROR', String(e)));
await page.goto(`${BASE}/?local=1&renderDelay=0`, { waitUntil: 'load' });
await page.waitForFunction(() => !document.getElementById('app').classList.contains('locked'), { timeout: 20000 });
await page.waitForTimeout(1200);

console.log('--- tool buttons ---');
console.log(await page.evaluate(() => {
  const out = [];
  for (const el of document.querySelectorAll('#tools button, .tools button, [id*=tool] button')) {
    out.push(`${el.id || ''}|${el.className}|${el.dataset?.act || ''}|${el.dataset?.tool || ''}|${(el.title || '').slice(0, 40)}|${(el.textContent || '').trim().slice(0, 20)}`);
  }
  return out.join('\n') || 'none found';
}));

console.log('--- palette panel structure (chip row 0) ---');
console.log(await page.evaluate(() => {
  const pal = document.getElementById('palette');
  if (!pal) return 'no #palette';
  const rows = [...pal.children].map((c) => `${c.tagName}#${c.id}.${c.className} (${c.children.length})`);
  const firstRow = pal.querySelector('.chip-row');
  const chips = firstRow ? [...firstRow.children].slice(0, 6).map((c) => `${c.dataset?.v}|${c.textContent.trim()}|${c.className}`) : [];
  return `rows:\n  ${rows.join('\n  ')}\nfirst chip row:\n  ${chips.join('\n  ')}`;
}));

console.log('--- anything mentioning Matches/bucket/broad ---');
console.log(await page.evaluate(() => {
  const hits = [];
  for (const el of document.querySelectorAll('*')) {
    const t = (el.textContent || '').trim();
    if (el.children.length === 0 && /Matches|bucket|Broad|Close|Exact/i.test(t) && t.length < 120) {
      hits.push(`${el.tagName}#${el.id}.${el.className}: ${t}`);
    }
  }
  return hits.slice(0, 20).join('\n') || 'none';
}));

await b.close();
