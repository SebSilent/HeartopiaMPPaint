/**
 * Canvas sizes taken straight from Heartopia's in-game painting grid, as
 * catalogued by https://zerochansy.github.io/Heartopia-Painting-Tools/
 * (app.js -> gridDimensions). Ratio x precision level -> [cellsWide, cellsTall].
 */

export const RATIOS = ['16:9', '4:3', '1:1', '3:4', '9:16'];

export const LEVELS = [
  { id: 0, tag: 'S', name: 'Small', hint: 'quick sketch' },
  { id: 1, tag: 'M', name: 'Medium', hint: 'everyday board' },
  { id: 2, tag: 'L', name: 'Large', hint: 'detail work' },
  { id: 3, tag: 'XL', name: 'Extra large', hint: 'masterpiece' },
];

export const GRID_DIMENSIONS = {
  '16:9': [[30, 18], [50, 28], [100, 56], [150, 84]],
  '4:3': [[30, 24], [50, 38], [100, 76], [150, 114]],
  '1:1': [[30, 30], [50, 50], [100, 100], [150, 150]],
  '3:4': [[24, 30], [38, 50], [76, 100], [114, 150]],
  '9:16': [[18, 30], [28, 50], [56, 100], [84, 150]],
};

export function dimsFor(ratio, level) {
  const row = GRID_DIMENSIONS[ratio] || GRID_DIMENSIONS['1:1'];
  const d = row[clampLevel(level)];
  return { w: d[0], h: d[1] };
}

export function clampLevel(level) {
  return Math.max(0, Math.min(LEVELS.length - 1, level | 0));
}

export function isValidRatio(ratio) {
  return RATIOS.includes(ratio);
}

/** Brush sizes, in cells. 1 cell is exactly one Heartopia paint tap. */
export const BRUSH_SIZES = [1, 2, 3, 5];

export const DEFAULTS = { ratio: '1:1', level: 1 };
