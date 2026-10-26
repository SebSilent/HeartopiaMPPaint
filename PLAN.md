# PLAN

Where this thing goes next. The rule: **keep Heartopia's palette and export exact**, because that is
what makes a board usable in the game. Everything else is ours to improve, and MS Paint beat a much
bigger budget by being small and honest. No gradients, no "AI assist", no feature theatre.

Ordered. Each phase should be shippable on its own.

---

## Phase 0 - the boring stuff that hurts

Before adding anything, close the gaps people hit in the first minute.

- [x] **Smooth remote strokes.** Done in `net/display.js`. The grid is the room's truth and is
  updated the instant a packet lands, on every machine; the screen paints from a copy that releases
  remote bursts on room time (~90 ms behind, spread over ~55 ms). Your own pen skips the schedule.
  Because the picture copies *current* grid values when it reveals a cell, it can't strand a stale
  pixel, and host and guests now render identically. Tunables in `CONFIG.smooth`, as
  `?smoothDelay=` / `?smoothSpread=` / `?renderDelay=`. If it still stutters on a bad link, raise the
  delay before touching anything else.
- [x] **Undo / redo.** Done in `game/history.js` plus the `step()` path in `main.js`. One command per
  stroke: a stack of `{face, indices, from, to}` patches, captured by `newPatch` / `patchAdd` /
  `sealPatch` / `finishCapture`, where a cell touched twice in one stroke is recorded once against its
  pre-stroke value. An undo replays through the same `paintLocal` + `sendOp` path as a live stroke,
  with its own fresh lamport stamp, so it lands on every peer as ordinary paint - there is no second
  sync mechanism to get wrong. Covered three ways: unit (`test/input.test.js` - a multi-batch stroke
  is one entry and a fill is one step), peer (`test/relay.test.js` - an undo repaints the pre-stroke
  picture on every peer), and browser (`_research/behaviour.cjs` 5b - undo empties the board, redo
  restores it, and both buttons enable and spend correctly).
- [ ] **Reconnect without a flash.** Keep the board on screen while the transport re-hands, instead of
  locking it.
- [x] **Local board backup.** Done in `game/backup.js`, wired in `main.js`. The board is copied to
  `localStorage` 1.2 s after it stops changing - a stroke lands in batches, so saving on every `grid`
  event would re-stringify the whole board dozens of times a second to keep one copy - flushed again
  when the page hides, and offered back when you come to a room and find it empty. Keyed per room code,
  and per *garment* when offline, because every `?local=1` session is 'LOCAL' and one key would put
  every sandbox item in the same bucket. It is a rescue, not a second source of truth: it only lands on
  a board nothing has painted, an empty board never overwrites a picture worth rescuing (so **declining
  is safe** and does not delete the only copy), a deliberate clear forgets it, and rows that are
  half-written, older than two weeks, or from another garment read as nothing at all. Restore replays
  through `applyCellsToFace` instead of adopting the snapshot, so it leaves as ordinary paint under one
  fresh stamp and one undo step - `Design.applySnapshot` fills every cell's seq with the backup's
  stamps, which are older than a returning player's lamport clock, and last-writer-wins would then
  silently reject their next stroke. Covered by unit (`test/backup.test.js` - 17: quota, private mode,
  corrupt rows, pruning only its own keys, cross-room isolation, the blank-overwrite rule) and browser
  (`tools/probe_backup.mjs` - 27 checks: paint, reload, accept, and the colour is on the board again;
  and E2, the one that matters - with the backup deleted, a room that still has the picture restores it
  from the relay and offers nothing over it).
- [x] **Per-player colour legend.** Show which shade each player last used, next to their avatar.
  Done as a presence field, not a new message: `shade` rides on the `hello` and `profile` the room
  already exchanges (`room.js` `_identity()` is now the single shape both use, so they cannot drift),
  is held on the roster entry, and is seeded from `state.colorIdx` at join so nobody shows up blank
  until they click. It is presence, not truth - nothing here touches the grid, so a dropped packet
  costs a stale dot and cannot make two boards disagree. `ui.setPlayers` draws it as a square chip on
  the avatar (top-right, clear of the device icon) and puts the group code and hex in the title, so
  hovering reads "Adelaide - painting 05-2 #ee6f72". Covered by transport test (`test/relay.test.js`
  `SHADE` - travels, survives a newcomer joining, and index 0 is not read as "none";
  `test/peer-protocol.test.js` `P2P5` - the same over WebRTC) and by two real browsers
  (`tools/probe_legend.mjs`, 11 checks - exact chip colour, each player keeps their own, a late joiner
  is told what is already in use).
  Two traps on the way, both silent: **`server/relay.js` `roster()` is a field whitelist**, so a new
  roster field that is not added there is dropped from every ws room with no error anywhere - the peer
  path passes without it; and the relay only refreshes identity on `hello`, never mid-session, so
  `shade` had to be added to the `profile` case too. Also worth knowing: **palette index 0 is not
  selectable** - `showGroup` numbers swatches from `flat = 1` - so the falsy-zero case lives in the
  transport tests, not the browser one.
- [ ] **Touch targets.** Brush and swatch hit areas need padding on phones; some are 30px today.
- [x] **A real cursor dot on the board.** Shipped as something better than a dot: `drawPreview` in
  `input.js` outlines the *actual footprint* - the rim cells of a round, spray or imported-tip dab, or
  the brush box for a square one - so you see which cells a stroke will take, not just where the
  pointer is. Mirrored guides draw alongside it when mirror painting is on.

## Phase 1 - the classic Paint box

Geometry and fills. All of it works on the cell grid, all of it broadcasts as one op, all of it is
undoable as one step.

- [x] **Line** - Shift snaps it to 45 degrees (`snapAngle` in `game/shapes.js`, applied in `_shapePairs`
  only while Shift is held).
- [x] **Rectangle and ellipse**, outline and filled, from the Style chips. Shift also square-constrains a
  rectangle.
- [x] **Polygon** by clicks - **but it closes on Enter, on Escape to abort, or by clicking back within 2
  cells of the first vertex; there is no double-click handler anywhere in the app.** Two clicks is the
  fastest close a person reaches for, so this is the one honest gap left in the shape tools.
- [x] **Bucket fill, plus fill similar colour.** The similarity test is real CIE ΔE(2000) between shades
  (`shadeDeltaE`), not index distance - the palette is ordered by family, so index distance measures
  where a colour sits in a list. The table is built once per click, not per cell. Steps are named the way
  a person judges them: Exact / Close (6) / Broad (12). Empty is never a match, so a loose bucket cannot
  flood a blank face.
- [ ] **Colour picker** improvements: recent shades row, and Alt-drag to sample without switching tool
- [x] **Brush shapes.** Done in `game/shapes.js` plus the shape row in `ui.js`: square (the plain
  stroke), round past size 1, and the hard spray, which scatters a fresh random dab inside the round
  footprint with its own density control (`sprayOffsets`, `st.sprayDensity`). Covered by unit
  (`test/shapes.test.js` pins the per-dab share) and browser (`_research/behaviour.cjs` 5c - the spray
  paints and stays sparser than the solid brush at the same spot).
- [x] **Airbrush** - shipped as a *brush shape* rather than its own tool, because it is the same stroke
  with a tone ramp, and a separate tool would have meant a second stroke path to keep in sync.
  `fadeShade` in `color/science.js` walks a colour toward its own pale in four steps, snapping every
  step to a shade that actually ships: a Heartopia board has no alpha, so softness has to be paler
  paint. `_paintAir` in `input.js` tones each cell by distance from the nearest dab centre and sends
  one op per tone under the stroke's single lamport stamp, which is what keeps it one undo step and
  identical on every peer. Covered by unit (`test/input.test.js`, `test/science.test.js`) and browser
  (`tools/probe_air.mjs`, 14 checks).
- [x] **Text.** `game/pixeltext.js` is a 5x7 bitmap font as *data* (59 glyphs), not `fillText`
  thresholded - a board has to be reproducible by hand in the game, so a letter cannot depend on which
  fonts a phone happens to have installed. The tool is `TOOLS.TEXT`: one tap commits the word through
  `_applyPairs`, which is the same single place every whole-region write goes through, so it is one op on
  the wire, one undo step, and it exports at the board's exact pixel size like anything else. The block is
  centred on the tap and then **slid back inside the face**, because a signature aimed at the edge would
  otherwise lose its last letters to a clip nobody asked for. Mirror applies. Four sizes (1-4 cells per
  pixel). The dock states what the string currently means - `11x7 cells`, and `no letter for X` naming
  every character the font has to drop - so a player finds out before the tap, not after a partly-painted
  word. `input.js` and `ui.js` share one anchor function (`_textPairs`) so the ghost you aim and the cells
  that commit cannot drift apart, which is the same rule `ui/importer.js` `fitRect()` follows for imports.
  Covered by unit (`test/input.test.js` - 10: cell-exact glyph counts, one op, one undo, the empty refusal,
  the dropped glyph, the 4x block, the edge slide, mirror) and by browser (`tools/probe_text.mjs` - 20
  checks on the real dock). Two probe bugs worth remembering: a translucent preview is stored
  **premultiplied**, so a half-alpha `#e95e2b` reads back as `#e95e2c` and an exact-RGB detector cannot
  see it at all; and the board has to be sampled by **cell interior**, not every 37th pixel, or fractional
  cell scaling reports edge blends as colours the tool invented.
- [ ] **Move / marquee selection** (see Phase 3)
- [x] **Mirror painting** on X, Y or both (`mirrorIndices` / `mirrored` in `game/shapes.js`), applied to
  strokes, shapes, polygon, bucket and text alike, with dashed guides on the board and a cycle key (`M`).
  It is one op either way: the mirror is computed before the region write, so a peer never has to know it
  happened.

## Phase 2 - import images, and make them Heartopia's

The headline feature. A photo goes in, a paintable board comes out, and it can only use the game's
125 shades.

- [x] **Drop or pick an image** anywhere onto the stage - the drop zone is the stage itself, and a file
  picked from the panel takes the same path.
- [x] **Auto-fit to the board**: `fitRect()` covers or contains into the face, then the rasteriser samples
  down to exactly `cols x rows` cells.
- [x] **Pixelate preview** before anything is committed, on the same numbers the commit will use.
- [x] **Dither modes**: `DITHER = ['none', 'bayer2', 'bayer4', 'bayer8', 'fs']` - one more ordered matrix
  than planned, because an 8x8 Bayer at board scale is the one that stops banding on a sky.
- [x] **Palette mapping by perceptual distance**: CIE ΔE(2000) through `PaletteIndex`, whose nearest-colour
  result is memoised in a `Map` over the 125 shades, so a whole import does not re-run deltaE2000 per
  pixel per candidate.
- [ ] **Controls** - mostly there: brightness, contrast, saturation and a posterise strength
  (`maxColors`, which reduces the palette by perceptual distance). **Sharpness is not implemented**, and
  nothing in `ui/importer.js` hints at it.
- [x] **Placement handles**: move, scale and rotate in 90 degree steps, and the preview is *draggable* -
  `fitRect(img, w, h, {fit, rot, zoom, ox, oy})` is the single source of that arithmetic, so the picture
  you drag and the cells you get are the same numbers. **Not snapped to cells**: `ox`/`oy` are continuous
  fractions, which is right for a photo and wrong for a board, where half a cell of drift moves every
  edge. Snapping is the remaining half of this one.
- [ ] **Import as a new layer**, never destructively, so it can be erased or lowered onto.
- [ ] **Quantise the live board**: run the same pipeline over what is already painted, to see how it
  will read in game. The parts all exist and are unused together - `reduceColors` over the live cells would
  do it. Destructive without layers to fall back on, so it wants a preview-and-confirm path, not a button.
- [ ] **Trace overlay**: a faint copy of the source image over the board while you paint by hand.
  **Do not confuse this with the Trace panel, which is a different thing and already shipped**:
  `ui/blueprint.js` is the game's keying-in aid (`off / block / colour` - the face split into 5/10/20-cell
  blocks you tick off, or one shade lit and everything else faded), and block progress is shared room state
  so two people never both do the same corner. The image ghost is still missing.

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

- [x] **Export as the game reads it**: `exportPNG` writes each face from `fillRGBA` into an offscreen
  canvas at exactly one pixel per cell, then scales it up with `imageSmoothingEnabled = false` - Heartopia
  boards are pixel art, and a smoothed export is a board of colours that exist on no palette. Multi-face
  garments go on one sheet, each face labelled with its own size, under a filename carrying the board,
  the room code and the date.
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
- **Playwright works here; the built-in browser tool does not.** `npx playwright install chromium`
  once, then `PORT=8099 node tools/serve.cjs` and run `_research/layout.cjs` / `_research/behaviour.cjs`.
  They measure squareness, clipping, dock overlap, board height across six viewports, and click a real
  category then drag a real stroke. That harness found the `auto 1fr` squeeze, the grid-stretch
  rectangles, a landscape phone left with 54px of board, and a test stub mis-parsing `title` text -
  all of which I had otherwise been guessing about.
- Counting non-transparent pixels on `#base` does **not** measure paint: `drawBase` lays opaque paper
  and checkerboard over the whole board first, so the count is the board area and never moves. Count
  pixels matching the picked shade's hex instead - `countStroke` in `_research/behaviour.cjs`.
- Port **8080 on this machine belongs to an unrelated app** that answers on both `localhost` and
  `127.0.0.1`, and will happily serve you a page that is not ours. Use 8099, and make probes assert
  the page contains `id="app"` before measuring anything.
- **`server/relay.js` `roster()` is a field whitelist.** Add a roster field in `room.js` and forget the
  relay, and it works in peer rooms, works in unit tests, and is silently absent in every ws room.
  The relay also only refreshes identity on `hello`, so a presence change needs the `profile` case too.
- `page.waitForFunction(fn, opts)` is **wrong** - options are the third parameter. Passed second they
  are treated as the argument, and every wait quietly falls back to the 30 s default, so a probe that
  looks like it has timeouts configured has none.
- `?local=1` never shows the gate, but `#join` is still in the DOM. A probe that clicks it whenever it
  measures visible swaps the offline sandbox for a random room, which changes the backup key and turns
  every "nothing was offered" assertion into a lie that passes.
- Room codes are **8 characters, `A-Z0-9`** - `normalizeRoomCode` slices to 8. A probe that plants a
  backup under a 9-character key tests nothing at all.
- `#swatches` holds **only the open group**, so a shade in another group is not in the DOM: walk
  `#groups button[data-group]` until it is. And `showGroup` numbers swatches from `flat = 1`, so
  palette index 0 cannot be clicked - which is why the falsy-zero case is a transport test.
- Two pages in **one browser context share the stored profile**, so the room sees one player, not two.
  A two-client test needs two contexts.
- **Do not try to close the garment openings in the mesh data.** The 3D clothes are single sheets, so from
  some angles you see the page through them (bucket hat: 3,256 trapped backdrop px, islands of 444, 368 and
  213). Five view-independent predicates were measured across all 11 clothing meshes and every one inverted
  on at least one garment: closed-vs-open topology shrink-wrapped `shorts` (+84% surface area) and
  `trousers` (+88%) because for them the only closed cycles *are* the panel outlines; projected cloth
  coverage called every opening 96-100% filled; cloth-within-a-reach put the hat's real hole at 61% filled
  and the sweater's panel outline at 37%; rim-lift scored the hat 0.33 against the trousers' 0.83; and
  planarity gave the trousers' outline a warp of 0.125, *flatter* than a real tshirt cuff at 0.193. There is
  no line to draw between the two populations. The builder and the measurements are kept, unused by the app,
  in `tools/meshopenings.mjs` + `tools/solidcheck.mjs` + `tools/meshopenings.txt` - re-run them before
  believing any new sixth idea. Boundary welding was also tried and A/B'd to zero visible change
  (the harness is gone, its numbers were: trapped backdrop pixels unchanged on all six garments, `0% closed`
  on every one), so that is not it either. `tools/meshholes.mjs` is the probe that counts trapped backdrop
  pixels per garment and still measures the defect. The fix, if it happens, belongs in the renderer: fill
  only the pixels the shell leaves uncovered, which is inherently view-dependent.
