// Old rim vs new rim, counted rather than argued about.
import { ellipseCells } from '../assets/js/game/shapes.js';

const key = (pairs) => new Set(pairs.map(([x, y]) => x + ',' + y));

/** A rim is whole when every cell touches the next: one 8-connected loop. */
function connectivity(pairs) {
  const set = key(pairs);
  const cells = [...set].map((s) => s.split(',').map(Number));
  let isolated = 0;
  let components = 0;
  const seen = new Set();
  for (const [x, y] of cells) {
    const k = x + ',' + y;
    let n = 0;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      if (set.has(x + dx + ',' + (y + dy))) n++;
    }
    if (n < 2) isolated++;
    if (seen.has(k)) continue;
    components++;
    const stack = [k];
    while (stack.length) {
      const cur = stack.pop();
      if (seen.has(cur)) continue;
      seen.add(cur);
      const [cx, cy] = cur.split(',').map(Number);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
        const nk = cx + dx + ',' + (cy + dy);
        if (set.has(nk) && !seen.has(nk)) stack.push(nk);
      }
    }
  }
  return { cells: cells.length, isolated, components };
}

/** The rim as it was drawn before: first and last cell of every scan row. */
function oldRim(x0, y0, x1, y1) {
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const rx = Math.abs(x1 - x0) / 2;
  const ry = Math.abs(y1 - y0) / 2;
  const out = [];
  const inside = (x, y) => {
    const nx = rx > 0 ? (x - cx) / rx : 0;
    const ny = ry > 0 ? (y - cy) / ry : 0;
    return nx * nx + ny * ny <= 1.02;
  };
  for (let y = Math.floor(Math.min(y0, y1)); y <= Math.ceil(Math.max(y0, y1)); y++) {
    let first = -1;
    let last = -1;
    for (let x = Math.floor(Math.min(x0, x1)); x <= Math.ceil(Math.max(x0, x1)); x++) {
      if (!inside(x, y)) continue;
      if (first < 0) first = x;
      last = x;
    }
    if (first < 0) continue;
    out.push([first, y]);
    if (last !== first) out.push([last, y]);
  }
  return out;
}

for (const box of [[0, 0, 19, 19], [10, 10, 40, 20], [0, 0, 9, 9], [5, 5, 60, 55]]) {
  const rim = ellipseCells(...box, false);
  console.log(
    JSON.stringify(box).padEnd(18),
    'old', JSON.stringify(connectivity(oldRim(...box))),
    ' new', JSON.stringify(connectivity(rim))
  );
}
