/*
 * Schematic 3D models for every design slot.
 *
 * This is NOT the game's mesh and it does not pretend to be: Heartopia's real
 * garments and furniture are shaded 3D assets we do not have. What this is, is
 * the honest thing you actually need from a 3D view - each face of the item
 * placed on a rough solid in the position and at the size it will appear, so
 * you can orbit it and see whether the pattern you put on a sleeve runs off
 * the end of it.
 *
 * A panel is one face. Its width and height come straight from the face's cell
 * count, so the proportions on screen are the proportions in the game.
 */

/**
 * @typedef {Object} Panel
 * @property {string} face  face id from slots.js
 * @property {number[]} pos  [x,y,z] of the panel centre, in cell units
 * @property {number} [yaw]  degrees about Y
 * @property {number} [pitch] degrees about X
 * @property {number} [roll]  degrees about Z
 * @property {number} [scale] multiplier on the face's own cell size
 */

const P = (face, pos, o = {}) => ({ face, pos, yaw: o.yaw || 0, pitch: o.pitch || 0, roll: o.roll || 0, scale: o.scale || 1 });

export const MODELS = {
  // ---- canvas: the board itself, standing up ----
  'canvas-16:9-0': [P('main', [0, 0, 0])],
  book: [
    P('wide', [-38, 0, 0], { yaw: 28 }),
    P('tall', [38, -8, 0], { yaw: -28 }),
  ],

  // ---- clothing. Bodies are a front/back pair with sleeves angled off ----
  tshirt: [
    P('front', [0, 0, 12], { yaw: 0 }),
    P('back', [0, 0, -12], { yaw: 180 }),
    P('sleeveL', [-46, 8, 0], { yaw: 96, roll: -18 }),
    P('sleeveR', [46, 8, 0], { yaw: -96, roll: 18 }),
  ],
  tank: [
    P('front', [0, 0, 10]),
    P('back', [0, 0, -10], { yaw: 180 }),
  ],
  sweat: [
    P('front', [0, 0, 13]),
    P('back', [0, 0, -13], { yaw: 180 }),
    P('sleeve', [0, 46, 0], { pitch: 90, scale: 0.6 }),
  ],
  dress: [
    P('front', [0, 0, 15]),
    P('back', [0, 0, -15], { yaw: 180 }),
    P('inner', [0, -60, 0], { pitch: 90, scale: 0.5 }),
  ],
  skirt: [
    P('front', [0, 0, 12]),
    P('back', [0, 0, -12], { yaw: 180 }),
  ],
  shorts: [
    P('front', [0, 0, 10]),
    P('back', [0, 0, -10], { yaw: 180 }),
  ],
  trousers: [
    P('front', [0, 0, 11]),
    P('back', [0, 0, -11], { yaw: 180 }),
  ],
  bucket: [
    P('crown', [0, 12, 0], { pitch: 74, scale: 0.62 }),
    P('brimF', [-34, -14, 0], { yaw: 62 }),
    P('brimB', [34, -14, 0], { yaw: -62 }),
  ],
  cap: [
    P('front', [0, 4, 20], { pitch: -18 }),
    P('rear', [0, 0, -14], { pitch: 74, scale: 0.55 }),
    P('brim', [0, -22, 26], { pitch: 84 }),
  ],
  shoes: [
    P('upper', [0, 10, 0], { pitch: 78, scale: 0.55 }),
    P('toe', [0, -14, 26], { pitch: 88, scale: 0.5 }),
    P('sole', [0, -26, 0], { pitch: -90, scale: 0.6 }),
  ],
  maryjanes: [
    P('upper', [0, 10, 0], { pitch: 78, scale: 0.6 }),
    P('sole', [0, -24, 0], { pitch: -90, scale: 0.55 }),
  ],

  // ---- furniture. Beds and sofas are boxes; the big faces go on top. ----
  bed1: [
    P('duvet', [0, 26, 0], { pitch: 90, scale: 0.52 }),
    P('frame', [0, 0, 34], { scale: 0.52 }),
  ],
  bed2: [
    P('duvet', [0, 30, 0], { pitch: 90, scale: 0.5 }),
    P('frame', [0, 0, 40], { scale: 0.5 }),
  ],
  sofa2: [
    P('back', [0, 22, -24], { scale: 0.42 }),
    P('seat', [0, -14, 14], { pitch: 96, scale: 0.42 }),
  ],
  sofa1: [
    P('back', [0, 16, -16], { scale: 0.7 }),
    P('seat', [0, -12, 8], { pitch: 96, scale: 0.7 }),
  ],
  wardrobe: [P('door', [0, 0, 20], { scale: 0.5 })],
  nightstand: [P('surface', [0, 22, 0], { pitch: 90, scale: 0.6 })],
  lowtable: [P('top', [0, 18, 0], { pitch: 90, scale: 0.6 })],
  chair: [
    P('backF', [0, 26, -12], { scale: 0.9 }),
    P('backR', [0, 26, -20], { yaw: 180, scale: 0.9 }),
    P('seat', [0, -6, 4], { pitch: 92, scale: 0.9 }),
  ],
  tablelamp: [
    P('shadeF', [0, 26, 10], { scale: 0.8 }),
    P('shadeR', [0, 26, -10], { yaw: 180, scale: 0.8 }),
    P('rim', [0, -18, 0], { pitch: 90, scale: 0.5 }),
  ],
  floorlamp: [
    P('shadeF', [0, 44, 11], { scale: 0.8 }),
    P('shadeR', [0, 44, -11], { yaw: 180, scale: 0.8 }),
    P('rim', [0, -40, 0], { pitch: 90, scale: 0.55 }),
  ],
};

/** Canvas boards of any ratio/level are just the one face, standing up. */
export function panelsFor(itemId) {
  if (MODELS[itemId]) return MODELS[itemId];
  const key = itemId.startsWith('book') ? 'book' : itemId;
  if (MODELS[key]) return MODELS[key];
  if (itemId.startsWith('canvas-')) return [P('main', [0, 0, 0])];
  // Unknown item: lay its faces out in a row rather than showing nothing.
  return null;
}

export function modelKey(itemId) {
  if (MODELS[itemId]) return itemId;
  if (itemId.startsWith('canvas-')) return 'canvas';
  return itemId;
}
