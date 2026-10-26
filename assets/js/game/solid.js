/*
 * What a 3D preview can actually be built from, and therefore where the 3D
 * button should be live.
 *
 * There are three ways to have a 3D look, and they are not equally good:
 *
 *   mesh       a real garment surface, baked from the game's own geometry
 *   solid      a procedural solid for an item whose face folds up (the book)
 *   panels     a flat schematic per face, which is honest but is a diagram
 *
 * An item with none of the three has nothing to show, and a 3D button that opens
 * an empty panel is worse than no button. `solidFor` answers the whole question
 * in one place so the button, the panel and the renderer cannot disagree about
 * what "has 3D" means.
 */

import { CLOTHING } from './slots.js';
import { panelsFor } from './model3d.js';
import { proceduralFor, hasProcedural } from './book3d.js';

// Garments with a baked mesh. loadMesh() still resolves to null if the generated
// module is missing, so having a mesh here is necessary but checked at load.
const MESHED = new Set(CLOTHING.map((c) => c.id));

/**
 * @param {string} itemId
 * @returns {'mesh'|'solid'|'panels'|null} the best 3D source this item claims
 */
export function sourceFor(itemId) {
  if (MESHED.has(itemId)) return 'mesh';
  if (hasProcedural(itemId)) return 'solid';
  if (panelsFor(itemId)) return 'panels';
  return null;
}

/** Anything to show at all. Drives whether the 3D control is enabled. */
export function has3d(itemId) {
  return sourceFor(itemId) !== null;
}

// Generated once per item and kept. The mesh is immutable, and rebuilding a
// thousand triangles every time rebuild3d() runs would cost a frame on every
// orbit tick for nothing.
const solids = new Map();

/**
 * The procedural solid for an item, if it has one. Awaited for symmetry with
 * loadMesh(), which fetches a module; nothing here is async today, but the call
 * sites should not have to change if that stops being true.
 */
export async function loadSolid(itemId) {
  if (MESHED.has(itemId)) return null;
  if (!hasProcedural(itemId)) return null;
  if (!solids.has(itemId)) solids.set(itemId, proceduralFor(itemId));
  return solids.get(itemId);
}
