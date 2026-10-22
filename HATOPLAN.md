# HATOPLAN

Where this thing goes next. The rule: **keep Heartopia's palette and export exact**, because that is
what makes a board usable in the game. Everything else is ours to improve, and MS Paint beat a much
bigger budget by being small and honest. No gradients, no "AI assist", no feature theatre.

Ordered. Each phase should be shippable on its own.

---

## Phase 0 - the boring stuff that hurts

Before adding anything, close the gaps people hit in the first minute.

- [x] **Smooth remote strokes.** Done in `net/pacer.js`: remote bursts replay on room time
  (~90 ms behind, painted in over ~55 ms) while local input stays instant. Tunables are in
  `CONFIG.smooth`, exposed as `?smoothDelay=` / `?smoothSpread=` for testing. If it still stutters on
  a bad link, raise `delayMs` before touching anything else.
- [ ] **Undo / redo.** One command per stroke, so it is just a stack of `{cells, from, to}` patches.
  This is the single most missing thing, and it is the reason the rest is safe to try.
- [ ] **Reconnect without a flash.** Keep the board on screen while the transport re-hands, instead of
  locking it.
- [ ] **Local board backup.** Save to `localStorage` per room code, so a crash does not cost a picture.
- [ ] **Per-player colour legend.** Show which shade each player last used, next to their avatar.
- [ ] **Touch targets.** Brush and swatch hit areas need padding on phones; some are 30px today.
- [ ] **A real cursor dot on the board** for desktop, so you can see exactly which cell you are on.

## Phase 1 - the classic Paint box

Geometry and fills. All of it works on the cell grid, all of it broadcasts as one op, all of it is
undoable as one step.

- [ ] **Line** (shift constrains to 45 degrees)
- [ ] **Rectangle** and **ellipse**, outline and filled
- [ ] **Polygon** with clicks, double-click or Enter to close
- [ ] **Bucket fill**, plus **fill similar colour** (the Paint option everyone actually uses)
- [ ] **Colour picker** improvements: recent shades row, and Alt-drag to sample without switching tool
- [ ] **Brush shapes**: round, square, and a hard spray, with size and (for spray) density
- [ ] **Airbrush** as its own tool, soft falloff in palette shades rather than alpha
- [ ] **Text** with the pixel font, drawn into cells so it exports and syncs like anything else
- [ ] **Move / marquee selection** (see Phase 3)
- [ ] **Mirror painting** on X and Y. Cheap, and it makes symmetric Heartopia boards far less tedious.

## Phase 2 - import images, and make them Heartopia's

The headline feature. A photo goes in, a paintable board comes out, and it can only use the game's
125 shades.

- [ ] **Drop or pick an image** anywhere onto the stage.
- [ ] **Auto-fit to the board**: cover-crop to the room's aspect, then downsample to exactly
  `w x h` cells.
- [ ] **Pixelate preview** before anything is committed.
- [ ] **Dither modes**: none, ordered Bayer 2x2 / 4x4, and Floyd-Steinberg. This is what turns a
  flat posterisation into something that reads as a painting.
- [ ] **Palette mapping by perceptual distance**, not RGB. RGB distance will happily pick a muddy
  brown where a grey was meant. Use OKLab / CIEDE2000 and cache the lookup table for all 125 shades.
- [ ] **Controls**: brightness, contrast, saturation, sharpness, and a "posterise" strength.
- [ ] **Placement handles**: move, scale, rotate in 90 degree steps, all snapped to cells.
- [ ] **Import as a new layer**, never destructively, so it can be erased or lowered onto.
- [ ] **Quantise the live board**: run the same pipeline over what is already painted, to see how it
  will read in game.
- [ ] **Trace overlay**: a faint copy of the source image over the board while you paint by hand.

## Phase 3 - layers and selection

The difference between "a paint app" and "a tool you can actually finish a picture with".

- [ ] **Layers**: add, delete, rename, reorder, hide, lock, opacity. Per-layer cell buffers, composited
  bottom-up into the render.
- [ ] **Merge down** and **flatten**.
- [ ] **Selection**: rectangle, freeform lasso, magic wand (contiguous, with tolerance), and invert.
- [ ] **Selected-area transforms**: move, nudge by one cell, flip H/V, rotate 90.
- [ ] **Float layer** while a selection is being moved, so it previews where it will land.
- [ ] **Sync design**: broadcast selections as a region op, and layer edits as
  `{layer, cells, value, seq, slot}`. The existing last-writer-wins stamp still works; it just gains a
  layer axis.

## Phase 4 - Heartopia export

The part that has to be exactly right.

- [ ] **Export as the game reads it**: a clean cell grid, one colour per cell, no anti-aliasing,
  no tint, no alpha.
- [ ] **Copy-to-clipboard grid** of palette indices and of hex values, for pasting into other tools.
- [ ] **Reference sheet PNG**: the board at scale with a coordinate ruler and a numbered shade legend
  of only the colours used, so a big board is reproducible in game without guessing.
- [ ] **Grid overlay toggle on export** for printing/trace use.
- [ ] **Import a Heartopia board back in** (JSON/PNG of the same shape), so a picture can be edited
  again instead of restarted.
- [ ] **Presets worth keeping**: a room's board size and palette subset, saved to a URL.

## Phase 5 - playing together

- [ ] **Follow a player**: jump the camera to someone and ride along.
- [ ] **Chat**, small and out of the way, with the same clock as the strokes.
- [ ] **Replay**: record ops and play the picture building back. The op log is already there.
- [ ] **Gallery**: save a finished board to a link anyone can open read-only.
- [ ] **Sessions that survive everyone leaving**, which needs the relay to persist state.
- [ ] **Symmetry across layers**, and a shared "colour of the moment" so a group can paint one
  section in sync.

## Phase 6 - finish it properly

- [ ] **PWA**: manifest, offline shell, install icon. Painting on a phone in the game's room is the
  main use case, and it should feel like an app.
- [ ] **Keyboard-only operation** and screen-reader labels on every swatch and tool.
- [ ] **Reduced-motion path** for the cursor interpolation.
- [ ] **Two devices, one room** as a standing manual test. Every sync bug so far came from being
  verified on one machine.
- [ ] **A TURN server** so strict networks can make peer rooms at all.
- [ ] **Room moderation**: kick, reset board, lock to invite-only.

---

## Things deliberately not on this list

- No AI generation. The point is you painting.
- No infinite canvas. A Heartopia board is a fixed grid, and that constraint is the product.
- No RGB picker or free colour. The 125 shades stay closed, or export stops matching the game.
- No login, no accounts, no profile system. A nickname is enough.

## Notes for whoever picks this up

- `assets/js/game/grid.js` is the shared truth. It is DOM-free on purpose and reused by
  `server/relay.js`. Keep it that way or the two implementations will drift.
- Strokes carry **one lamport stamp per stroke**, reused across every batch. Anything new (fills,
  layers, geometry) should follow that rule, not invent its own.
- Anything that touches the canvas needs a transport test. `test/relay.test.js` and
  `test/peer-protocol.test.js` are the pattern; `test/input.test.js` shows how to drive input without
  a browser.
- Run `npx impeccable detect index.html` before shipping UI. It caught the cream wash, the 10px
  labels and a contrast failure on wood, all of which had already shipped past me once.
