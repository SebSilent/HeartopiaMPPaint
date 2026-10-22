/*
 * Every place your own design can appear in Heartopia.
 *
 * Three families, from the game's own slot layout:
 *   canvas     - the painting board. Ratio x precision, both chosen by you.
 *   clothing   - 11 items, built from several faces of *different* sizes.
 *   furniture  - 10 items, ditto, and much larger than the canvas boards.
 *   book       - two faces, each split into front cover / spine / back cover.
 *
 * A garment is not one board. A T-shirt is four faces - front and back are
 * 64x80 while each sleeve is 64x48 - so 32 pixels of front artwork hang off
 * the bottom of a sleeve if you treat them as one picture. That is why the
 * unit of everything in this app is a FACE, not a canvas: a design is a list
 * of faces, each with its own grid, and you switch between them.
 *
 * Face sizes are the game's numbers. Where the game does not publish a number
 * (the book's zone split), nothing is invented - it is an adjustable guide.
 *
 * `native` is the wording the game itself uses for that slot, so a player can
 * match our picker against what Heartopia shows them.
 */

import { RATIOS, LEVELS, GRID_DIMENSIONS } from '../presets.js';

/** @typedef {{id:string,label:string,native?:string,w:number,h:number,zone?:boolean}} Face */

/**
 * @param {string} id
 * @param {string} name
 * @param {string} native
 * @param {Array<[string,string,string,number,number]>} faces  [face id, label, native, w, h]
 */
function item(id, name, native, faces) {
  return {
    id,
    name,
    native,
    family: '',
    faces: faces.map(([fid, label, faceNative, w, h]) => ({ id: fid, label, native: faceNative, w, h })),
  };
}

export const CLOTHING = [
  item('tshirt', 'T-shirt', 'Tシャツ', [
    ['front', 'Front', 'フロント', 64, 80],
    ['back', 'Back', 'バック', 64, 80],
    ['sleeveL', 'Left sleeve', '左袖', 64, 48],
    ['sleeveR', 'Right sleeve', '右袖', 64, 48],
  ]),
  item('tank', 'Tank top', 'タンクトップ', [
    ['front', 'Front', 'フロント', 64, 64],
    ['back', 'Back', 'バック', 64, 64],
  ]),
  item('sweat', 'Sweatshirt', 'スウェット', [
    ['front', 'Front', 'フロント', 80, 88],
    ['back', 'Back', 'バック', 80, 88],
    ['sleeve', 'Sleeve', '袖', 130, 70],
  ]),
  item('dress', 'Dress', 'ワンピース', [
    ['front', 'Front', 'フロント', 102, 154],
    ['back', 'Back', 'バック', 76, 154],
    ['inner', 'Inner', 'インナー', 168, 102],
  ]),
  item('skirt', 'Mini skirt', 'ミニスカート', [
    ['front', 'Front', 'フロント', 128, 64],
    ['back', 'Back', 'バック', 128, 64],
  ]),
  item('shorts', 'Shorts', 'ハーフパンツ', [
    ['front', 'Front', 'フロント', 102, 64],
    ['back', 'Back', 'バック', 102, 64],
  ]),
  item('trousers', 'Trousers', 'パンツ', [
    ['front', 'Front', 'フロント', 80, 116],
    ['back', 'Back', 'バック', 80, 116],
  ]),
  item('bucket', 'Bucket hat', 'バケットハット', [
    ['brimF', 'Front brim', '前つば', 126, 78],
    ['brimB', 'Rear brim', '後ろつば', 126, 78],
    ['crown', 'Crown', '帽子の上部', 100, 100],
  ]),
  item('cap', 'Cap', 'キャップ', [
    ['front', 'Front', 'フロント', 54, 60],
    ['rear', 'Back + sides', 'バック+サイド', 128, 62],
    ['brim', 'Brim', '帽子のつば', 62, 52],
  ]),
  item('shoes', 'Shoes', '靴', [
    ['upper', 'Upper', 'アッパー', 100, 90],
    ['toe', 'Toe & laces', '靴先・靴紐', 120, 60],
    ['sole', 'Sole', 'ソール', 60, 60],
  ]),
  item('maryjanes', 'Mary Janes', 'メリージェーン', [
    ['upper', 'Upper', 'アッパー', 78, 64],
    ['sole', 'Sole', 'ソール', 108, 64],
  ]),
];

export const FURNITURE = [
  item('bed1', 'Single bed', 'シングルベッド', [
    ['duvet', 'Duvet top', '布団の表', 200, 130],
    ['frame', 'Frame', 'フレーム', 200, 98],
  ]),
  item('bed2', 'Double bed', 'ダブルベッド', [
    ['duvet', 'Duvet top', '布団の表', 256, 128],
    ['frame', 'Bed frame', 'ベッドフレーム', 256, 110],
  ]),
  item('sofa2', 'Two-seat sofa', 'ダブルソファ', [
    ['back', 'Backrest', '背もたれ', 200, 110],
    ['seat', 'Seat', '座面', 200, 110],
  ]),
  item('sofa1', 'Armchair sofa', 'シングルソファ', [
    ['back', 'Backrest', '背もたれ', 60, 60],
    ['seat', 'Seat', '座面', 60, 70],
  ]),
  item('wardrobe', 'Wardrobe', 'クローゼット', [['door', 'Cabinet door', 'キャビネットドア', 128, 128]]),
  item('nightstand', 'Nightstand', 'ナイトテーブル', [['surface', 'Cabinet surface', 'キャビネット表面', 128, 128]]),
  item('lowtable', 'Low table', 'ローテーブル', [['top', 'Table top', 'テーブルの台面', 128, 128]]),
  item('chair', 'Chair', 'チェア', [
    ['backF', 'Backrest, front', '背もたれ・前', 54, 28],
    ['backR', 'Backrest, rear', '背もたれ・後ろ', 54, 28],
    ['seat', 'Seat', '座面', 54, 54],
  ]),
  item('tablelamp', 'Table lamp', 'テーブルランプ', [
    ['shadeF', 'Shade front', 'ランプシェード前', 80, 46],
    ['shadeR', 'Shade rear', 'ランプシェード後', 80, 46],
    ['rim', 'Base rim', '土台の縁', 128, 28],
  ]),
  item('floorlamp', 'Floor lamp', 'フロアランプ', [
    ['shadeF', 'Shade front', 'ランプシェード前', 80, 52],
    ['shadeR', 'Shade rear', 'ランプシェード後', 80, 52],
    ['rim', 'Base rim', '土台の縁', 128, 16],
  ]),
];

/**
 * The book. Two faces, and each face carries three zones delimited by guide
 * lines - front cover, spine, back cover. The game does not publish where
 * those lines fall, so they are draggable rather than guessed.
 */
export const BOOK = {
  id: 'book',
  name: 'Book',
  native: '本',
  faces: [
    { id: 'wide', label: 'Face 4:3', native: '(4:3)', w: 150, h: 114, zone: true },
    { id: 'tall', label: 'Face 16:9', native: '(16:9)', w: 150, h: 84, zone: true },
  ],
  zones: ['Front cover', 'Spine', 'Back cover'],
};

export const FAMILY = {
  canvas: { name: 'Canvas', blurb: 'Paintings on the wall. You pick the ratio and how fine.' },
  clothing: { name: 'Clothing', blurb: 'Garments. Each face is its own picture.' },
  furniture: { name: 'Furniture', blurb: 'Beds, sofas, lamps. Bigger faces than clothes.' },
  book: { name: 'Book', blurb: 'Two faces, each with cover / spine / back zones.' },
};

/** Canvas items are generated from the ratio x level table, not repeated here. */
export function canvasItem(ratio, level) {
  const [w, h] = GRID_DIMENSIONS[ratio][level];
  return {
    id: `canvas-${ratio}-${level}`,
    name: `Canvas ${ratio}`,
    family: 'canvas',
    faces: [{ id: 'main', label: `${LEVELS[level].name}`, w, h }],
  };
}

export const CATALOG = {
  // A canvas card is a *family* of boards, not one item: it has no level until
  // you pick one. Level 0 (Small) is the representative, and `ratio` is what the
  // picker uses to re-expand it. Without `faces` here, anything that renders
  // "N faces · WxH" for every catalogue entry crashed on the canvas row.
  canvas: RATIOS.map((r) => ({ ...canvasItem(r, 0), ratio: r })),
  clothing: CLOTHING.map((i) => ({ ...i, family: 'clothing' })),
  furniture: FURNITURE.map((i) => ({ ...i, family: 'furniture' })),
  book: [{ ...BOOK, family: 'book' }],
};

export const FAMILIES = ['canvas', 'clothing', 'furniture', 'book'];

export function findItem(id) {
  if (!id) return null;
  if (id.startsWith('canvas-')) {
    const rest = id.slice(7);
    // canvas-16:9-2  /  canvas-1:1-0
    const cut = rest.lastIndexOf('-');
    const ratio = rest.slice(0, cut);
    const level = Math.max(0, Math.min(LEVELS.length - 1, Number(rest.slice(cut + 1)) || 0));
    if (!RATIOS.includes(ratio)) return null;
    return canvasItem(ratio, level);
  }
  for (const fam of ['clothing', 'furniture', 'book']) {
    const hit = CATALOG[fam].find((i) => i.id === id);
    if (hit) return hit;
  }
  return null;
}

/** Legacy rooms carried {ratio, level}; map that onto the new item ids. */
export function itemIdForBoard(ratio, level) {
  return `canvas-${RATIOS.includes(ratio) ? ratio : '1:1'}-${Math.max(0, Math.min(3, level | 0))}`;
}

export function boardForItem(id) {
  const it = findItem(id);
  if (it && it.family === 'canvas') {
    const rest = it.id.slice(7);
    const cut = rest.lastIndexOf('-');
    return { ratio: rest.slice(0, cut), level: Number(rest.slice(cut + 1)) || 0 };
  }
  return null;
}

/** Total cells in a design, for the "how long is this going take" readout. */
export function cellTotal(item) {
  return item.faces.reduce((n, f) => n + f.w * f.h, 0);
}
