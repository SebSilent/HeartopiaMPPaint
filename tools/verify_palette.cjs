// Verifies our shipped palette is value-identical to the reference site's color.svg.
// Usage: node tools/verify_palette.cjs [path/to/color.svg]
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const live = fs.readFileSync(process.argv[2] || '_research/color_live.svg', 'utf8');

const shades = {};
let m;
const shadeRe = /id="Color-(\d+)-(\d+)"[^>]*fill="([^"]+)"/g;
while ((m = shadeRe.exec(live))) {
  (shades[m[1]] = shades[m[1]] || Array(10).fill(null))[m[2] - 1] = m[3].toLowerCase();
}
const mains = {};
const mainRe = /<(?:rect|circle|ellipse)[^>]*id="Color-(\d+)"[^>]*fill="([^"]+)"/g;
while ((m = mainRe.exec(live))) mains[m[1]] = m[2].toLowerCase();

const ref = Object.keys(shades)
  .sort((a, b) => +a - +b)
  .map((g) => ({ group: +g, main: mains[g], colors: shades[g].filter(Boolean) }));

const json = JSON.parse(fs.readFileSync('assets/data/heartopia-palette.json', 'utf8'));
const ours = json.groups.map((g) => ({ group: g.group, main: g.mainColor, colors: g.colors }));

const norm = (rows) => JSON.stringify(rows.map((r) => [r.group, r.main, r.colors]));
const jsonOk = norm(ref) === norm(ours);

(async () => {
  const target = pathToFileURL(path.resolve(__dirname, '..', 'assets', 'js', 'data', 'heartopia-palette.js')).href;
  const mod = await import(target);
  const moduleOk = norm(ref) === norm(mod.HEARTOPIA_GROUPS.map((g) => ({ ...g, main: g.main })));
  const flatOk =
    mod.FLAT_COLORS.length === 1 + ref.reduce((n, g) => n + g.colors.length, 0) &&
    mod.FLAT_COLORS[0] === null &&
    mod.FLAT_COLORS.slice(1).join() === ref.flatMap((g) => g.colors).join();

  console.log('groups      reference / ours :', ref.length, '/', ours.length);
  console.log('shades      reference / ours :', ref.reduce((n, g) => n + g.colors.length, 0), '/',
    ours.reduce((n, g) => n + g.colors.length, 0));
  console.log('group order                  :', ref.map((g) => g.group).join(','));
  console.log('JSON matches reference       :', jsonOk);
  console.log('ES module matches reference  :', moduleOk);
  console.log('flat paint index matches     :', flatOk);
  process.exit(jsonOk && moduleOk && flatOk ? 0 : 1);
})();
