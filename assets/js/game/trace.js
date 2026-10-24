/*
 * Trace the edge of a paintable cell region into closed rings.
 *
 * The board needs an outline that means what it says: a cell inside the drawn line
 * is a cell you can paint, and a cell you can paint is inside the line. Neither of
 * the two shapes the game ships achieves that. Its catalog maskLines are a
 * simplification - the trousers front is two leg rectangles with the crotch between
 * them left out, even though the game lets you paint it - and its mesh header carries
 * one UV island where the canvas has two. Both were measured against the cells the
 * game actually blocks, and the disagreement ran to 16.8% of a face.
 *
 * So the outline is derived from the cell list itself, which is the one thing the
 * game enforces. The result follows the grid exactly: it steps by whole cells, and
 * that is honest, because the board *is* a grid of cells.
 */

/**
 * @param {Uint8Array} mask  1 where the cell can be painted
 * @param {number} w
 * @param {number} h
 * @returns {Array<Array<[number,number]>>} closed rings in cell coordinates,
 *   outer boundaries first and any holes after them, each ring wound so the
 *   paintable side is on the same edge for every segment.
 */
export function traceBoundary(mask, w, h) {
  if (!mask) return [];
  const on = (x, y) => x >= 0 && y >= 0 && x < w && y < h && mask[y * w + x] === 1;

  // One directed edge per exposed side, wound so the paintable region is always on
  // the right hand as you walk it. Edges live on the integer lattice, so stitching
  // is exact - there is no epsilon to get wrong.
  //
  // A vertex can own more than one outgoing edge: two cells that touch only at a
  // corner expose both of them. Keeping one would splice two lobes into one ring,
  // so this is a multimap and the walk resolves the tie by turning right, which is
  // the rule that keeps each lobe its own loop.
  const out = new Map();
  const add = (ax, ay, bx, by) => {
    const k = `${ax},${ay}`;
    const list = out.get(k);
    if (list) list.push([bx, by]);
    else out.set(k, [[bx, by]]);
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!on(x, y)) continue;
      if (!on(x, y - 1)) add(x, y, x + 1, y); // top, walked left to right
      if (!on(x + 1, y)) add(x + 1, y, x + 1, y + 1); // right, top to bottom
      if (!on(x, y + 1)) add(x + 1, y + 1, x, y + 1); // bottom, right to left
      if (!on(x - 1, y)) add(x, y + 1, x, y); // left, bottom to top
    }
  }

  const DIRS = [[1, 0], [0, 1], [-1, 0], [0, -1]]; // east, south, west, north
  const dirIndex = (d) => DIRS.findIndex((v) => v[0] === d[0] && v[1] === d[1]);
  const rings = [];
  for (const startKey of [...out.keys()]) {
    if (!out.has(startKey)) continue; // already consumed by a loop
    const ring = [];
    let cur = startKey;
    let cameFrom = null;
    let guard = 0;
    while (out.has(cur) && guard++ < 4 * w * h) {
      const edges = out.get(cur);
      // Prefer right, then straight, then left, then back: the walking order that
      // keeps the region on the right hand through a corner-only pinch.
      const [cx, cy] = cur.split(',').map(Number);
      const back = cameFrom ? dirIndex([cx - cameFrom[0], cy - cameFrom[1]]) : 0;
      const order = [(back + 1) % 4, back, (back + 3) % 4, (back + 2) % 4];
      let pickIdx = 0;
      for (const want of order) {
        const found = edges.findIndex((e) => dirIndex([e[0] - cx, e[1] - cy]) === want);
        if (found >= 0) {
          pickIdx = found;
          break;
        }
      }
      const [bx, by] = edges.splice(pickIdx, 1)[0];
      if (!edges.length) out.delete(cur);
      ring.push([bx, by]);
      cameFrom = [cx, cy];
      cur = `${bx},${by}`;
      if (cur === startKey) break;
    }
    if (ring.length >= 4) rings.push(dropCollinear(ring));
  }
  return rings.sort((a, b) => area(b) - area(a));
}

/** Remove vertices that do not turn, which is most of a long straight hem. */
function dropCollinear(ring) {
  const out = [];
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const p = ring[(i + n - 1) % n];
    const c = ring[i];
    const q = ring[(i + 1) % n];
    if ((c[0] - p[0]) * (q[1] - c[1]) !== (c[1] - p[1]) * (q[0] - c[0])) out.push(c);
  }
  return out.length >= 3 ? out : ring;
}

function area(ring) {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    a += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  }
  return Math.abs(a / 2);
}
