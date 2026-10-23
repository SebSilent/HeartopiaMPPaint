// Print the text around each block-size key, whatever quoting the bundle uses.
import { readFileSync, writeFileSync } from 'node:fs';
const src = readFileSync('_research/ap-bundle-main-CFbUDH7c.js', 'utf8');
const out = [];
for (const k of ['blockSizeEasy', 'blockSizeNormal', 'blockSizeFast', 'blockSizeRecommendation', 'blockSizeAdvancedDesc', 'blockSizeNormalDesc', 'blockSizeEasyDesc']) {
  let i = -1;
  let n = 0;
  while ((i = src.indexOf(k, i + 1)) >= 0 && n < 6) {
    const snip = src.slice(i, i + 260).replace(/\s+/g, ' ');
    if (/^[\x20-\x7E]+$/.test(snip)) {
      out.push(`${k} #${n}: ${snip}`);
      n++;
    }
  }
  out.push('');
}
writeFileSync('_blocks.txt', out.join('\n') + '\n');
console.log(out.join('\n').slice(0, 4000));
