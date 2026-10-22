const fs = require('fs');
const s = fs.readFileSync('index.html', 'utf8');
const out = [];
for (const m of s.matchAll(/class="fine[^"]*"[^>]*>([^<]{15,})/g)) out.push(m[1].trim());
for (const m of s.matchAll(/<p class="fineprint"[^>]*>([^<]{15,})/g)) out.push(m[1].trim());
for (const m of s.matchAll(/class="panel-note"[^>]*>([^<]{3,})/g)) out.push('NOTE: ' + m[1].trim());
console.log(out.map((t, i) => i + 1 + '. ' + t).join('\n'));
