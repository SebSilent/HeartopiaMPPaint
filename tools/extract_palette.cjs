// Parses the Heartopia color.svg into a structured JSON palette.
// Source: https://zerochansy.github.io/Heartopia-Painting-Tools/assets/color/color.svg
const fs = require('fs');

const svgText = fs.readFileSync(process.argv[2] || 'ref_color.svg', 'utf8');

// Individual shades: id="Color-<group>-<index>" fill="#xxxxxx"
const shades = {};
const shadeRe = /id="Color-(\d+)-(\d+)"[^>]*fill="([^"]+)"/g;
let m;
while ((m = shadeRe.exec(svgText)) !== null) {
  const g = Number(m[1]), i = Number(m[2]);
  (shades[g] ||= Array(10).fill(null))[i - 1] = m[3].toLowerCase();
}

// Group main colours: <rect id="Color-<n>" ... fill>
const mains = {};
const mainRe = /<(?:rect|circle|ellipse)[^>]*id="Color-(\d+)"[^>]*fill="([^"]+)"/g;
while ((m = mainRe.exec(svgText)) !== null) {
  mains[Number(m[1])] = m[2].toLowerCase();
}

const groups = Object.keys(shades)
  .map(Number)
  .sort((a, b) => a - b)
  .map((n) => ({
    group: n,
    mainColor: mains[n] || shades[n].filter(Boolean)[0],
    colors: shades[n].filter(Boolean),
  }));

const out = {
  source: 'https://zerochansy.github.io/Heartopia-Painting-Tools/assets/color/color.svg',
  totalGroups: groups.length,
  totalColors: groups.reduce((s, g) => s + g.colors.length, 0),
  groups,
};

fs.writeFileSync(
  process.argv[3] || 'assets/data/heartopia-palette.json',
  JSON.stringify(out, null, 2)
);
console.log('groups:', out.totalGroups, 'colors:', out.totalColors);
for (const g of groups) console.log(g.group, g.mainColor, g.colors.join(' '));
