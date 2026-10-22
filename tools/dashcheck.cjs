/* Em dash check. findstr cannot be trusted with UTF-8 in this console. */
const fs = require('fs');
const files = ['README.md', 'index.html'];
for (const f of files) {
  const t = fs.readFileSync(f, 'utf8');
  const hits = [];
  for (const [name, ch] of [['U+2014 em dash', '\u2014'], ['U+2013 en dash', '\u2013']]) {
    const n = t.split(ch).length - 1;
    if (n) hits.push(`${name} x${n}`);
  }
  console.log(`${f}: ${hits.length ? hits.join(', ') : 'clean'} (${t.split(/\r?\n/).length} lines)`);
}
