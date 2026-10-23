// Did the deployed site actually get the book and layout changes?
import https from 'node:https';

const BASE = 'https://sebsilent.github.io/HeartopiaMPPaint';
const get = (p) =>
  new Promise((r) => {
    https
      .get(BASE + p + '?v=' + Date.now(), (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => r({ status: res.statusCode, body: d }));
      })
      .on('error', (e) => r({ status: 0, body: 'ERR ' + e.message }));
  });

const faces = await get('/assets/js/data/heartopia-faces.js');
const css = await get('/assets/css/style.css');
const html = await get('/index.html');
const slots = await get('/assets/js/game/slots.js');

console.log('faces.js', faces.status, '| book still has the 4:3 face:', /"book":\{"wide"/.test(faces.body), '| has the 16:9 face:', /"book":\{"tall"/.test(faces.body));
const m = /"book":\{"tall":\{[^}]*"rings":(\[\[.*?\]\])/.exec(faces.body);
console.log('book rings live:', m ? m[1].slice(0, 120) : 'not found');
console.log('style.css', css.status, '| .opts claims its own grid area:', /\.opts\s*\{[^}]*grid-area:\s*opts/.test(css.body.replace(/\/\*[\s\S]*?\*\//g, '')));
console.log('index.html', html.status, '| toolOpts class:', /id="toolOpts" class="([^"]*)"/.exec(html.body)?.[1]);
console.log('slots.js', slots.status, '| one book face:', /faces:\s*\[\{\s*id:\s*'tall'/.test(slots.body), '| no wide face:', !/id:\s*'wide'/.test(slots.body));
