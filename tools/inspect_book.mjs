// One-off: print the book face's outline rings so the 3D model can match zones.
import { readFileSync } from 'node:fs';
const src = readFileSync('assets/js/data/heartopia-faces.js', 'utf8');
const start = src.indexOf('{');
const end = src.lastIndexOf('}') + 1;
const j = JSON.parse(src.slice(start, end));
const t = j.book.tall;
console.log('w', t.w, 'h', t.h);
console.log('rings', JSON.stringify(t.rings));
if (t.off) console.log('off rows', t.off.split(';').length, 'first', t.off.split(';')[0]);