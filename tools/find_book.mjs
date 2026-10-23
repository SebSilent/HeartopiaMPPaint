// The catalog is grouped by item: one group, one set of canvases, one canvas
// per paint face, in order. Print it that way so faces can be matched by their
// group instead of by size alone - which is how the book and the bucket crown
// were silently lost.
import { readFileSync, writeFileSync } from 'node:fs';

const d = JSON.parse(readFileSync('_scrape/catalog/ls-heartopia_presets_cache.json', 'utf8'));
const groups = Array.isArray(d) ? d : Object.values(d)[0];
const out = [];
for (const x of groups || []) {
  const cs = x.canvases || [];
  const parts = cs.map((c) => {
    const lv = (c.levels || []).map((l) => `${l.w}x${l.h}`).join('/');
    return `${c.name || '?'}[${lv}]${c.levels && c.levels[0] && c.levels[0].maskLines ? '' : ' Noring'}`;
  });
  out.push(`${x.id}\n   ${parts.join('\n   ')}`);
}
writeFileSync('_groups.txt', out.join('\n') + '\n');
console.log('groups', out.length);
