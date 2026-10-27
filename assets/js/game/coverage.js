/**
 * Finding the backdrop that should not be there.
 *
 * A garment is a single cloth shell: art-pia's bake drops the lining, so the
 * mesh has real openings at the neck, the cuffs and the hem, and the renderer
 * draws both faces of it. That is the correct answer for a shell, and it leaves
 * a defect behind - small islands of backdrop trapped inside the silhouette,
 * where two panels do not quite meet or a crack runs down a seam. They move when
 * you orbit, which is what makes the preview read as "holes in the clothing" and,
 * at its worst, as seeing through the garment.
 *
 * Sealing them in the mesh data was tried and rejected: five view-independent
 * predicates - rim turn angle, warp, area, sliver count, triangle budget - each
 * one inverted on at least one garment, so any rule that caps a cuff also caps a
 * panel outline or shreds a hem. See PLAN.md.
 *
 * What is left is view-dependent, so it belongs in the renderer. The definition
 * is the one that separates a defect from a garment:
 *
 *   backdrop you can reach from outside the shape is AIR - an armpit, the gap
 *   under a raised sleeve, the neck opening. Leave it.
 *   backdrop you cannot reach is a HOLE. There is no garment behind it, so it is
 *   not a window onto anything, and it should read as the inside of the cloth.
 *
 * This module is pure: it takes a coverage array and returns arrays. That is not
 * a purity preference - it means the rule above is testable, which the render
 * pass that uses it is not.
 */

/** Uncovered (0) pixels reachable from the border. Air. */
function floodOutside(cov, w, h, outside) {
  const q = new Int32Array(w * h);
  let head = 0;
  let tail = 0;
  const push = (p) => {
    if (outside[p] || cov[p]) return;
    outside[p] = 1;
    q[tail++] = p;
  };
  for (let x = 0; x < w; x++) {
    push(x);
    push((h - 1) * w + x);
  }
  for (let y = 0; y < h; y++) {
    push(y * w);
    push(y * w + w - 1);
  }
  while (head < tail) {
    const p = q[head++];
    const x = p % w;
    const y = (p / w) | 0;
    if (x > 0) push(p - 1);
    if (x < w - 1) push(p + 1);
    if (y > 0) push(p - w);
    if (y < h - 1) push(p + w);
  }
}

/**
 * Every enclosed backdrop pixel that is small enough to be a hole rather than a
 * gap you are meant to see through, with its distance from the cloth and the
 * cloth pixel it is nearest to.
 *
 * @param {Uint8Array} cov  1 where the shell covers the frame, 0 where it does not
 * @param {number} maxFill  an enclosed region this many pixels or larger is left
 *   alone as real air. Measured in coverage pixels, which is a reduced resolution.
 * @returns {{fill: Uint8Array, dist: Uint16Array, src: Int32Array,
 *             holes: number, kept: number, px: number}}
 *   `fill` marks the pixels to paint; `dist` is how deep each one is from the
 *   cloth; `src` is the coverage index of the nearest cloth pixel, whose colour
 *   the caller shades and pastes. `holes` counts enclosed regions found, `kept`
 *   the ones small enough to fill.
 */
export function enclosedHoles(cov, w, h, maxFill = 48) {
  const n = Math.max(0, w * h);
  const fill = new Uint8Array(n);
  const dist = new Uint16Array(n);
  const src = new Int32Array(n).fill(-1);
  const empty = { fill, dist, src, holes: 0, kept: 0, px: 0 };
  if (n < 9 || !cov || cov.length < n) return empty;

  const outside = new Uint8Array(n);
  floodOutside(cov, w, h, outside);

  // Label the enclosed regions. 4-connected, so a diagonal thread of backdrop
  // between two panels counts as two pinholes and gets filled twice, which is
  // what you want: it is the crack that shows as a hairline.
  const label = new Int32Array(n).fill(0);
  const sizes = [0]; // label 1-based
  let next = 1;
  const q = new Int32Array(n);
  for (let p = 0; p < n; p++) {
    if (cov[p] || outside[p] || label[p]) continue;
    let head = 0;
    let tail = 0;
    label[p] = next;
    q[tail++] = p;
    let size = 0;
    while (head < tail) {
      const c = q[head++];
      size++;
      const x = c % w;
      const y = (c / w) | 0;
      const tryN = (np) => {
        if (cov[np] || outside[np] || label[np]) return;
        label[np] = next;
        q[tail++] = np;
      };
      if (x > 0) tryN(c - 1);
      if (x < w - 1) tryN(c + 1);
      if (y > 0) tryN(c - w);
      if (y < h - 1) tryN(c + w);
    }
    sizes[next] = size;
    next++;
  }
  const holes = next - 1;

  // Keep the small ones. A big enclosed region is the space under an arm or
  // inside a hood, and painting that is worse than the hole it replaces.
  // Indexed by label, because this is consulted inside a per-pixel loop and an
  // array scan there would make the pass quadratic in the number of islands.
  const keep = new Uint8Array(holes + 1);
  let kept = 0;
  for (let l = 1; l <= holes; l++) {
    if (sizes[l] > 0 && sizes[l] <= maxFill) {
      keep[l] = 1;
      kept++;
    }
  }

  // Multi-source BFS from every covered pixel that touches a kept region, so
  // each hole pixel learns how deep it is and which cloth pixel to borrow. This
  // is what keeps the fill a cavity: the rim is the garment's own colour and it
  // darkens going in, instead of a flat patch the size of a sleeve.
  const dq = new Int32Array(n);
  let head = 0;
  let tail = 0;
  for (let p = 0; p < n; p++) {
    if (!cov[p]) continue;
    const x = p % w;
    const y = (p / w) | 0;
    let touches = false;
    if (x > 0 && keep[label[p - 1]]) touches = true;
    else if (x < w - 1 && keep[label[p + 1]]) touches = true;
    else if (y > 0 && keep[label[p - w]]) touches = true;
    else if (y < h - 1 && keep[label[p + w]]) touches = true;
    if (!touches) continue;
    // Seed the hole pixels themselves, remembering the cloth they lean on.
    for (const np of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, y > 0 ? p - w : -1, y < h - 1 ? p + w : -1]) {
      if (np < 0 || cov[np] || !keep[label[np]] || dist[np]) continue;
      dist[np] = 1;
      src[np] = p;
      dq[tail++] = np;
    }
  }
  let px = 0;
  while (head < tail) {
    const c = dq[head++];
    px++;
    const x = c % w;
    const y = (c / w) | 0;
    for (const np of [x > 0 ? c - 1 : -1, x < w - 1 ? c + 1 : -1, y > 0 ? c - w : -1, y < h - 1 ? c + w : -1]) {
      if (np < 0 || cov[np] || !keep[label[np]] || dist[np]) continue;
      dist[np] = dist[c] + 1;
      src[np] = src[c];
      dq[tail++] = np;
    }
  }
  for (let p = 0; p < n; p++) if (dist[p] > 0) fill[p] = 1;

  return { fill, dist, src, holes, kept, px };
}

/**
 * How dark a hole pixel should read, given how deep it is from the cloth.
 *
 * The rim is the garment's own colour; the bottom of a cavity is in shadow. The
 * curve has to flatten out, because a hole that is 20 pixels deep is not twenty
 * times darker than one that is 1 deep - it is the inside of a sleeve, and the
 * inside of a sleeve has a limit to how dark it gets.
 */
export function cavityShade(d, floor = 0.42) {
  const k = Math.max(0, d | 0);
  const s = 1 / (1 + k * 0.34);
  return floor + (1 - floor) * s;
}
