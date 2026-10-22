/*
 * Undo / redo.
 *
 * One command per stroke, per shape, per fill - which is only possible because
 * everything in this app already funnels through the same "here are the cells,
 * here is the colour" op. A patch is that list plus the values the cells had
 * before, so undo is not a rewind of the whole board, it is a small ordinary
 * paint op in the other direction.
 *
 * That matters for the room: an undo broadcasts exactly like a stroke, gets its
 * own lamport stamp, and lands on everyone else's board the same way. There is
 * no second sync mechanism to get wrong.
 */

export class History {
  constructor(limit = 80) {
    this.limit = limit;
    this.past = [];
    this.future = [];
  }

  get canUndo() {
    return this.past.length > 0;
  }

  get canRedo() {
    return this.future.length > 0;
  }

  /** @param {{face:number,indices:number[],from:Uint8Array,to:Uint8Array,label:string}} patch */
  push(patch) {
    if (!patch.indices || !patch.indices.length) return;
    this.past.push(patch);
    if (this.past.length > this.limit) this.past.shift();
    this.future.length = 0;
  }

  /** @returns {{face:number,indices:number[],values:Uint8Array}|null} what to paint, in the room's order */
  undo() {
    const p = this.past.pop();
    if (!p) return null;
    this.future.push(p);
    return { face: p.face, indices: p.indices, values: p.from, label: p.label };
  }

  redo() {
    const p = this.future.pop();
    if (!p) return null;
    this.past.push(p);
    return { face: p.face, indices: p.indices, values: p.to, label: p.label };
  }

  clear() {
    this.past.length = 0;
    this.future.length = 0;
  }
}

/**
 * Snapshot what a set of cells holds right now, so a write can be reversed.
 * Call this BEFORE the write. Indices are the grid's own flat indices, which
 * is what a stroke already produces - converting to pairs and back would cost
 * a division per cell per batch.
 *
 * @param {{faces:Array<{color:Uint8Array}>}} design
 * @param {number[]} indices
 */
export function captureIndices(design, faceIdx, indices) {
  const g = design.faceAt(faceIdx);
  const from = new Uint8Array(indices.length);
  for (let i = 0; i < indices.length; i++) from[i] = g.color[indices[i]];
  return { face: faceIdx, indices, from };
}

/**
 * Read the values a patch ended on, after the write.
 *
 * The grid is looked up once, not per cell: a patch can be 22,500 indices on a
 * maximum canvas, and re-resolving the face each time is the difference between
 * a stroke ending promptly and the tab hitching on every undoable action.
 */
export function finishCapture(design, patch) {
  const g = design.faceAt(patch.face);
  const to = new Uint8Array(patch.indices.length);
  if (!g) {
    patch.to = to;
    return patch;
  }
  for (let i = 0; i < patch.indices.length; i++) to[i] = g.color[patch.indices[i]];
  patch.to = to;
  return patch;
}

/**
 * Grow a patch as a stroke goes on, keeping each cell's original value. A cell
 * touched twice in one stroke is recorded once - undo should return it to what
 * it was before the stroke, not to what the middle of the stroke left there.
 */
export function patchAdd(patch, design, indices) {
  const g = design.faceAt(patch.face);
  if (!g) return patch;
  for (const i of indices) {
    if (patch.seen.has(i)) continue;
    patch.seen.add(i);
    patch.indices.push(i);
    patch.before.push(g.color[i]);
  }
  return patch;
}

export function newPatch(faceIdx) {
  return { face: faceIdx, indices: [], before: [], seen: new Set() };
}

/**
 * Freeze a growing patch into the stored form.
 *
 * This returns a *new* object and leaves the patch alone: a stroke keeps
 * painting into it after the first batch goes out, and mutating it here used to
 * delete the dedupe set the next batch still needed.
 */
export function sealPatch(patch) {
  return { face: patch.face, indices: patch.indices, from: Uint8Array.from(patch.before) };
}

/**
 * Apply a recorded patch as a fresh op.
 * @returns {{indices:number[],values:Uint8Array}}
 */
export function patchWrite(entry) {
  const indices = [];
  const values = new Uint8Array(entry.indices.length);
  for (let i = 0; i < entry.indices.length; i++) {
    indices.push(entry.indices[i]);
    values[i] = entry.values[i];
  }
  return { indices, values };
}
