/**
 * The reference sheet: the board as a worksheet, not as a picture.
 *
 * Every design here ends the same way - someone keys it into Heartopia cell by
 * cell with the game's own pen. A PNG of the board does not help with that,
 * because you cannot read a colour off a screenshot and name it. What helps is
 * the board at a printable scale with a coordinate ruler on both edges, and a
 * legend of only the shades actually used with how many cells each one is, so
 * you can do all the dark green, then all the light green, and know when you
 * are finished.
 *
 * The layout and the legend are computed here as plain numbers and objects, so
 * they can be tested without a canvas. `drawSheet` is the only part that needs
 * one, and it reads nothing but the object `buildSheet` returns.
 */

import { FLAT_COLORS, COLOR_CODES } from '../data/heartopia-palette.js';

/** Everything about the sheet that is a number rather than a pixel. */
export const PAD = 16;
export const RULER = 20; // band along the top and left of a face, for the numbers
export const FACE_LABEL = 18; // room for the face's own name above its ruler
export const FACE_GAP = 22; // between stacked faces
export const LEGEND_W = 168;
export const LEGEND_ROW = 19;
export const LEGEND_HEAD = 26;

/**
 * The shades actually on this board, with how many cells each one fills.
 *
 * Empty is not a colour: index 0 is the absence of paint, and a legend that
 * lists it tells the person keying this in to paint cells the game leaves bare.
 * Sorted by count then by index, so the biggest job is at the top and a tie
 * still produces the same sheet from the same board.
 *
 * @param {{color:Uint8Array, n:number}} grid
 * @returns {Array<{idx:number,count:number,hex:string,code:string}>}
 */
export function usedShades(grid) {
  const counts = new Map();
  for (let i = 0; i < grid.n; i++) {
    const c = grid.color[i];
    if (!c) continue;
    counts.set(c, (counts.get(c) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([idx, count]) => ({ idx, count, hex: FLAT_COLORS[idx] || '#000000', code: COLOR_CODES[idx] || String(idx) }))
    .sort((a, b) => (b.count === a.count ? a.idx - b.idx : b.count - a.count));
}

/**
 * Where the ruler numbers go along an axis of `n` cells.
 *
 * A tick on every cell, a number only every few: labelling all 154 rows of a
 * dress front produces grey noise nobody can read, and every-ten on a 12-cell
 * collar produces two numbers on an axis you can count. So the step follows the
 * printed size of a cell, not the cell count.
 *
 * @param {number} n  cells along the axis
 * @param {number} cell  pixels per cell on the sheet
 * @returns {{step:number, marks:Array<{cell:number, at:number}>}} `cell` is
 *   1-based, because the person reading this counts cells with a finger.
 */
export function rulerMarks(n, cell) {
  const step = cell >= 10 ? 5 : cell >= 5 ? 10 : 20;
  const marks = [];
  for (let i = step; i <= n; i += step) marks.push({ cell: i, at: i * cell });
  return { step, marks };
}

/**
 * The whole sheet's geometry: where each face's board goes, and where its
 * rulers and its legend are, in canvas pixels.
 *
 * Faces stack downward, each with its own rulers, because a 102x154 dress front
 * beside a 64x80 sleeve does not share a useful axis. The legend sits to the
 * right of the widest face, top aligned, listing every shade used anywhere on
 * the design.
 *
 * @param {Array<{w:number,h:number,label:string}>} faces
 * @param {number} shadeCount
 * @param {number} [target]  widest the sheet should get, before cells shrink
 * @returns {{cell:number, width:number, height:number,
 *            boards:Array<{x:number,y:number,w:number,h:number,label:string,
 *                          rx:number,ry:number,top:Object,left:Object}>,
 *            legend:{x:number,y:number,w:number,h:number}}}
 */
export function sheetLayout(faces, shadeCount, target = 1180) {
  const maxW = Math.max(1, ...faces.map((f) => f.w));
  const maxH = Math.max(1, ...faces.map((f) => f.h));
  // One cell size for the whole sheet, so a person can hold the page up to the
  // game and the squares mean the same thing on every face.
  let cell = Math.floor((target - PAD * 2 - RULER - LEGEND_W) / maxW);
  cell = Math.max(2, Math.min(16, cell));

  const boards = [];
  let y = PAD;
  for (const f of faces) {
    // Each face gets its own label line, then the ruler, then the board.
    const top = y;
    y += FACE_LABEL;
    const boardY = y + RULER;
    const boardX = PAD + RULER;
    const { marks: topMarks } = rulerMarks(f.w, cell);
    const { marks: leftMarks } = rulerMarks(f.h, cell);
    boards.push({
      x: boardX,
      y: boardY,
      w: f.w * cell,
      h: f.h * cell,
      label: f.label,
      rx: { at: boardY - RULER, marks: topMarks, span: f.w * cell },
      ry: { at: boardX - RULER, marks: leftMarks, span: f.h * cell },
      top,
      left: PAD,
    });
    y = boardY + f.h * cell + FACE_GAP;
  }

  const legend = {
    x: PAD + RULER + maxW * cell + PAD,
    y: PAD,
    w: LEGEND_W,
    h: LEGEND_HEAD + Math.max(1, shadeCount) * LEGEND_ROW,
  };
  return {
    cell,
    boards,
    legend,
    width: Math.max(PAD + RULER + maxW * cell + PAD + LEGEND_W + PAD, legend.x + legend.w + PAD),
    height: Math.max(y - FACE_GAP + PAD, legend.y + legend.h + PAD),
  };
}

/**
 * Everything `drawSheet` needs, assembled from a design.
 *
 * @param {Array<{w:number,h:number,grid:{color:Uint8Array,n:number}}>} faces
 * @param {Array<{label:string}>} meta  face labels, index-aligned with faces
 */
export function buildSheet(faces, meta, opts = {}) {
  const shades = [];
  const seen = new Map();
  for (const f of faces) {
    for (const s of usedShades(f.grid)) {
      seen.set(s.idx, (seen.get(s.idx) || 0) + s.count);
    }
  }
  for (const [idx, count] of seen) {
    shades.push({ idx, count, hex: FLAT_COLORS[idx] || '#000000', code: COLOR_CODES[idx] || String(idx) });
  }
  shades.sort((a, b) => (b.count === a.count ? a.idx - b.idx : b.count - a.count));

  const layout = sheetLayout(
    faces.map((f, i) => ({ w: f.w, h: f.h, label: (meta[i] && meta[i].label) || f.id || `face ${i + 1}` })),
    shades.length,
    opts.target
  );
  return { layout, shades, faces, meta, grid: !!opts.grid };
}

/**
 * Cell grid, stronger every ten cells. Printing a worksheet without the lines
 * means counting squares on a blank field; with them, a row is a row.
 *
 * This is the one copy on purpose - the PNG export used to carry its own. The
 * half-pixel offsets and the rounding are what keep a 1px line on a pixel
 * boundary instead of smeared across two.
 */
export function cellGrid(ctx, x, y, cols, rows, cell) {
  const x0 = Math.round(x);
  const y0 = Math.round(y);
  const wpx = cols * cell;
  const hpx = rows * cell;
  ctx.save();
  ctx.lineWidth = 1;
  for (let i = 0; i <= cols; i++) {
    ctx.strokeStyle = i % 10 === 0 ? 'rgba(0,0,0,0.5)' : 'rgba(0,0,0,0.18)';
    ctx.beginPath();
    ctx.moveTo(x0 + i * cell + 0.5, y0 + 0.5);
    ctx.lineTo(x0 + i * cell + 0.5, y0 + hpx + 0.5);
    ctx.stroke();
  }
  for (let j = 0; j <= rows; j++) {
    ctx.strokeStyle = j % 10 === 0 ? 'rgba(0,0,0,0.5)' : 'rgba(0,0,0,0.18)';
    ctx.beginPath();
    ctx.moveTo(x0 + 0.5, y0 + j * cell + 0.5);
    ctx.lineTo(x0 + wpx + 0.5, y0 + j * cell + 0.5);
    ctx.stroke();
  }
  ctx.restore();
}

/**
 * Paint the sheet. Takes a 2D context and the object from `buildSheet`, nothing
 * else - no room, no DOM - so it can be pointed at an offscreen canvas or a
 * print canvas without the app being awake.
 */
export function drawSheet(ctx, sheet) {
  const { layout, shades } = sheet;
  ctx.save();
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, layout.width, layout.height);
  ctx.imageSmoothingEnabled = false; // Heartopia boards are pixel art

  const font = Math.max(10, Math.min(14, layout.cell * 3));
  ctx.font = `${font}px "Baloo 2", system-ui, sans-serif`;
  ctx.fillStyle = '#3a2a1c';
  ctx.textBaseline = 'alphabetic';

  for (const b of layout.boards) {
    ctx.fillStyle = '#3a2a1c';
    ctx.fillText(`${b.label}  ${b.w / layout.cell}×${b.h / layout.cell}`, b.x, b.top + FACE_LABEL - 4);

    // Rulers: ticks along both edges, numbers every `step` cells.
    ctx.strokeStyle = '#8a7a68';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const m of b.rx.marks) {
      ctx.moveTo(b.x + m.at + 0.5, b.rx.at + RULER - 6);
      ctx.lineTo(b.x + m.at + 0.5, b.rx.at + RULER);
    }
    for (const m of b.ry.marks) {
      ctx.moveTo(b.ry.at + RULER - 6, b.y + m.at + 0.5);
      ctx.lineTo(b.ry.at + RULER, b.y + m.at + 0.5);
    }
    ctx.stroke();

    ctx.fillStyle = '#6a5a4a';
    ctx.textAlign = 'center';
    for (const m of b.rx.marks) ctx.fillText(String(m.cell), b.x + m.at, b.rx.at + RULER - 9);
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (const m of b.ry.marks) ctx.fillText(String(m.cell), b.ry.at + RULER - 9, b.y + m.at);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';

    // The board itself, one pixel per cell at layout.cell.
    const face = sheet.faces[layout.boards.indexOf(b)];
    if (face && face.grid) {
      const off = document.createElement('canvas');
      off.width = face.w;
      off.height = face.h;
      const octx = off.getContext('2d');
      const img = octx.createImageData(face.w, face.h);
      face.grid.fillRGBA(new Uint32Array(img.data.buffer));
      octx.putImageData(img, 0, 0);
      ctx.drawImage(off, b.x, b.y, b.w, b.h);
      if (sheet.grid) cellGrid(ctx, b.x, b.y, face.w, face.h, layout.cell);
    }
    ctx.strokeStyle = '#3a2a1c';
    ctx.lineWidth = 1;
    ctx.strokeRect(b.x - 0.5, b.y - 0.5, b.w + 1, b.h + 1);
  }

  // Legend: only the shades that are on the board, with the game's own code,
  // the hex, and how many cells to fill. A sheet that lists 125 shades for a
  // board that uses four is a sheet nobody reads.
  const L = layout.legend;
  ctx.fillStyle = '#3a2a1c';
  ctx.font = `${Math.max(11, font)}px "Baloo 2", system-ui, sans-serif`;
  ctx.fillText('Shades in use', L.x, L.y + 15);
  ctx.font = `${font}px "Baloo 2", system-ui, sans-serif`;
  let ly = L.y + LEGEND_HEAD;
  if (!shades.length) {
    ctx.fillStyle = '#8a7a68';
    ctx.fillText('nothing painted yet', L.x, ly + 12);
  }
  shades.forEach((s, i) => {
    const rowY = ly + i * LEGEND_ROW;
    ctx.fillStyle = s.hex;
    ctx.fillRect(L.x, rowY, 15, 15);
    ctx.strokeStyle = '#3a2a1c';
    ctx.lineWidth = 1;
    ctx.strokeRect(L.x + 0.5, rowY + 0.5, 15, 15);
    ctx.fillStyle = '#3a2a1c';
    ctx.fillText(`${s.code}  ${s.hex}`, L.x + 22, rowY + 12);
    ctx.fillStyle = '#6a5a4a';
    ctx.fillText(`${s.count}`, L.x + LEGEND_W - 34, rowY + 12);
  });

  ctx.restore();
}
