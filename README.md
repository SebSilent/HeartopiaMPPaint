# Heartopia Painting Tool - Multiplayer Pixel Art Studio

**A free, open-source heartopia custom design tool for painting canvases, clothing and furniture
together in the browser - on the game's real grids, with the game's real 125 shades, and a 3D
preview of the garment you are painting.**

**→ Open the tool: <https://sebsilent.github.io/HeartopiaMPPaint/>**

[![license: MIT](./assets/img/badge-license.svg)](./LICENSE)
[![build: none](./assets/img/badge-build.svg)](#run-it-locally)
[![platform: any browser](./assets/img/badge-platform.svg)](#works-on-everything)
[![palette: 125 shades](./assets/img/badge-palette.svg)](#the-heartopia-125-shade-color-palette)

*The badges are committed SVG, generated from the game's own palette by
`tools/build_badges.mjs` - not a third-party image service, so they cannot break
when someone else's CDN is down, and every one of them passes WCAG AA contrast.*

Pick a nickname, get a room code, send it to people. Everyone paints the same board at once, live.
No install, no account, no download, nothing to sign up for - it is a web page that behaves like a
pixel editor and exports exactly what Heartopia will accept.

---

## Table of contents

- [Why choose this tool over alternatives?](#why-choose-this-tool-over-alternatives)
- [What it does](#what-it-does)
- [The Heartopia 125-shade color palette](#the-heartopia-125-shade-color-palette)
- [Every board size the game allows](#every-board-size-the-game-allows)
- [Heartopia clothing grid helper](#heartopia-clothing-grid-helper)
- [Heartopia furniture texture editor](#heartopia-furniture-texture-editor)
- [3D garment preview](#3d-garment-preview)
- [Painting together](#painting-together)
- [Import a photo, export a board](#import-a-photo-export-a-board)
- [Keyboard shortcuts](#keyboard-shortcuts)
- [How it works under the hood](#how-it-works-under-the-hood)
- [Works on everything](#works-on-everything)
- [Run it locally](#run-it-locally)
- [Deploy your own copy](#deploy-your-own-copy)
- [Project layout](#project-layout)
- [FAQ](#faq)
- [Data sources and attribution](#data-sources-and-attribution)
- [License](#license)

---

## Why choose this tool over alternatives?

There are a few good Heartopia painting references out there, and this one is built differently.
These are the differences you can verify in the first two minutes of use:

| | **Heartopia Painting Tool (this repo)** | Typical single-player grid helper |
|---|---|---|
| **Multiplayer** | A live shared board. Everyone in the room paints the same design at the same time, with real-time cursors, per-player colour chips and one undo history. | One person, one browser tab. |
| **Open source** | MIT licensed, whole app on GitHub. No accounts, no analytics, no paywall, no feature gated behind a login. Read the code, fork it, host it. | Closed site. |
| **Input lag** | **Zero lag on your own pen.** Local strokes are never queued, throttled or interpolated - they land the instant you draw them. Only *remote* players' ink is time-smoothed (~90 ms) so a burst of packets reads as a stroke instead of a flicker. | Varies; canvas redraws on every mousemove. |
| **3D garment viewport** | The garment's own fabric mesh, rendered live in the browser. Orbit by drag, zoom by wheel, and every stroke repaints the 3D model immediately - so you see the sleeve wrap, not just a flat rectangle. | Flat faces only. |
| **Real game geometry** | Exact in-game canvas dimensions (all 20 boards) and the real face sizes of 22 items - 50 faces in total, up to 256×128 cells on a double bed. | Approximate or single-item grids. |
| **Enforced silhouettes** | The cells Heartopia refuses to paint are unpaintable for everyone in the room, and the outline you see is traced from exactly those cells - the guide line and the brush cannot disagree. | Overlay you have to eyeball. |
| **Closed palette** | Only the game's 125 shades, mapped by perceptual colour distance (CIE ΔE2000). There is no RGB picker to tempt you into a colour that does not exist in game. | Free colour picker, then guess. |
| **Dependency-free** | No build step, no framework, no bundler. Plain ES modules and a canvas. The published site is static files on GitHub Pages. | Bundled SPA. |

**In one line:** it is the only heartopia pixel editor where two people can paint the same T-shirt at
the same time, spin it in 3D, and export a PNG the game will actually match.

---

## What it does

- **The real Heartopia palette**, 13 groups and 125 shades: black, grey, white, brown, red, orange,
  yellow, green, cyan, blue, purple, pink, special
- **Every board size the game allows**
- **Everyone's cursor on the board**, drawn as a touch, a pen or a mouse, moving in real time
- **A chip on every avatar showing the shade that player is holding**, with the group code and hex on
  hover, so a room painting in four blues can tell who is who
- **Your board is kept on your device**, and if the room comes back empty it asks before it touches
  anything - decline and your picture is still there next time
- **Pinch to zoom, two fingers to pan**, so you can rest your hand on the screen
- **Apple Pencil aware**: touches stop painting while the pen is down
- **Eyedropper, eraser, five brush sizes** (1, 2, 5, 10, 20 - the last three are the game's own
  block modes), and four brush shapes: square, round, the hard spray, and a soft **airbrush** that
  fades through real palette shades, because a Heartopia board has no alpha
- **Fill, fill-similar, line, rectangle, ellipse, polygon, mirror painting** - each one a single undo
  step, each one broadcast as one op
- **A 5×7 bitmap text tool**, so a signature is made of cells you could reproduce by hand in the game
- **Undo and redo** across the whole room, one command per stroke, however many cells it touched
- **PNG export at the board's exact pixel size**, ready to copy into the game
- **The game's own items**, clothing, furniture and the book, on their real faces at their real sizes
- **Game silhouettes enforced**, the cells Heartopia refuses to paint stay unpaintable for everyone in
  the room, and the outline you see is traced from exactly those cells, so the line and the brush
  cannot disagree
- **The garment's own 3D shape**, the fabric mesh the game wears, orbit by drag, zoom by wheel,
  repainted on every stroke
- **Phone, tablet, desktop. Nothing to install.**

---

## The Heartopia 125-shade color palette

The heartopia 125-shade color palette is closed on purpose. Every swatch in this tool is a shade that
exists in the game, organised into the game's own 13 groups:

| Group | Main shade | Shades |
|---|---|---|
| 1 | `#000000` black / grey / white | 5 |
| 2 | `#ea696d` red | 10 |
| 3 | `#f77f54` orange | 10 |
| 4 | `#fdab34` amber | 10 |
| 5 | `#f7d230` yellow | 10 |
| 6 | `#b5c728` yellow-green | 10 |
| 7 | `#40b678` green | 10 |
| 8 | `#01aa9f` teal | 10 |
| 9 | `#0094b5` cyan | 10 |
| 10 | `#2981c0` blue | 10 |
| 11 | `#7474bb` indigo | 10 |
| 12 | `#a164a7` purple | 10 |
| 13 | `#cd638b` pink | 10 |
| | | **125** |

There is deliberately **no RGB picker and no free colour**. A design that uses a shade Heartopia does
not have cannot be recreated in the game, so the tool refuses to offer one.

What that constraint costs in freedom, it makes up for in accuracy:

- **Nearest-shade mapping by perceptual distance.** Imported artwork is quantised with CIE ΔE(2000),
  not by index or by naive RGB distance, so a photo lands on the shade a person would pick.
- **Fill-similar uses the same metric.** The bucket's Exact / Close / Broad steps are real ΔE
  thresholds (6 and 12), not "how far apart two list positions are".
- **The airbrush fades through real shades.** A Heartopia board has no alpha channel, so softness is
  painted as progressively paler paint - four steps toward the shade's own pale, each one snapped to
  a colour that ships.
- **Codes you can read off beside the game.** Any face copies to the clipboard as the game's own
  `06-1` group-shade codes, as palette indices, or as hex - tab-separated, one token per cell, with a
  dot for an unpainted cell.

---

## Every board size the game allows

Canvas dimensions are the game's numbers, not an approximation. Five ratios at four precision levels:

| Ratio | S | M | L | XL |
|---|---|---|---|---|
| 16:9 | 30×18 | 50×28 | 100×56 | 150×84 |
| 4:3 | 30×24 | 50×38 | 100×76 | 150×114 |
| 1:1 | 30×30 | 50×50 | 100×100 | 150×150 |
| 3:4 | 24×30 | 38×50 | 76×100 | 114×150 |
| 9:16 | 18×30 | 28×50 | 56×100 | 84×150 |

That is 20 boards. The book cover is the 16:9 XL board (150×84) painted as a cover laid flat - front
cover, an eighteen-cell spine, back cover.

Brush sizes 5, 10 and 20 are the game's own block-work modes (guide square, normal block, fast
block), so a board painted here can be blocked in at the same granularity in game. Size 1 is a single
tap, the atom of the whole thing; size 2 is ours, because outlines need something between a tap and a
sixth of the board.

---

## Heartopia clothing grid helper

A garment is **not one board**. A T-shirt is four faces - front and back at 64×80, each sleeve at
64×48 - so 32 pixels of front artwork hang off the bottom of a sleeve if you treat them as one
picture. This heartopia clothing grid helper keeps every face separate, at its real size, and switches
between them with one tap or the `Tab` key.

All 11 clothing items, on their real faces:

| Item | Faces | Cells |
|---|---|---|
| T-shirt | Front 64×80 · Back 64×80 · Left sleeve 64×48 · Right sleeve 64×48 | 16,384 |
| Tank top | Front 64×64 · Back 64×64 | 8,192 |
| Sweatshirt | Front 80×88 · Back 80×88 · Sleeve 130×70 | 23,180 |
| Dress | Front 102×154 · Back 76×154 · Inner 168×102 | 44,548 |
| Mini skirt | Front 128×64 · Back 128×64 | 16,384 |
| Shorts | Front 102×64 · Back 102×64 | 13,056 |
| Trousers | Front 80×116 · Back 80×116 | 18,560 |
| Bucket hat | Front brim 126×78 · Rear brim 126×78 · Crown 100×100 | 29,656 |
| Cap | Front 54×60 · Back + sides 128×62 · Brim 62×52 | 14,400 |
| Shoes | Upper 100×90 · Toe & laces 120×60 · Sole 60×60 | 19,800 |
| Mary Janes | Upper 78×64 · Sole 108×64 | 11,904 |

On top of the real sizes:

- **Enforced silhouettes.** The cells the game will not take paint are locked for everyone in the room.
- **An outline traced from those same cells**, so the guide you follow is the boundary you cannot cross.
- **Blueprint mode** for keying a design into the game by hand: the face split into 5, 10 or 20-cell
  blocks you tick off, or one shade lit and everything else faded. Block progress is shared room
  state, so two people never both do the same corner.

---

## Heartopia furniture texture editor

Furniture faces are much larger than canvas boards, which is exactly where a shared room earns its
keep. This heartopia furniture texture editor covers all 10 items:

| Item | Faces |
|---|---|
| Single bed | Duvet top 200×130 · Frame 200×98 |
| Double bed | Duvet top 256×128 · Bed frame 256×110 |
| Two-seat sofa | Backrest 200×110 · Seat 200×110 |
| Armchair sofa | Backrest 60×60 · Seat 60×70 |
| Wardrobe | Cabinet door 128×128 |
| Nightstand | Cabinet surface 128×128 |
| Low table | Table top 128×128 |
| Chair | Backrest front 54×28 · Backrest rear 54×28 · Seat 54×54 |
| Table lamp | Shade front 80×46 · Shade rear 80×46 · Base rim 128×28 |
| Floor lamp | Shade front 80×52 · Shade rear 80×52 · Base rim 128×16 |

The double bed's duvet top is **256×128 - 32,768 cells**, the largest single face in the game, and the
whole double bed is 60,928 cells. Split across four people in a room, that is an evening instead of a
week.

Plus **the book**: one 150×84 board painted as a cover laid flat, with the front cover, spine and back
cover drawn by the face's own outline.

---

## 3D garment preview

Every one of the 11 clothing items carries its own fabric mesh - the shape the game actually wears.
Press **3D** and the faces you have painted are wrapped onto it:

- **Orbit by drag, zoom by wheel.** No fixed turntable; look at the sleeve seam from the inside.
- **Repainted on every stroke.** The model is not a snapshot, it is the live board, so what you see is
  what you are painting right now.
- **Real silhouette clipping.** The face outline rides along as a polygon in model space, so paint does
  not bleed past the edge of the cloth.
- **Seam and cavity gap-filling** computed from geometry, never from colour - a garment's own shading
  passes through the same greys a colour test would mistake for a hole.

This is the fastest way to catch the mistake every flat editor hides: a motif that looks centred on the
front face and lands under the player's arm in game.

---

## Painting together

The multiplayer board is the reason this exists.

- **Serverless by default.** The first player in a room hosts it over WebRTC and relays to everyone
  else. There is no server to keep alive, which is how a static GitHub Pages site runs a multiplayer
  game.
- **Room codes are the invite.** Eight characters, `A-Z0-9`. The code in the top bar copies a link
  that drops the other person straight into the room.
- **Live cursors as the device made them** - a touch ring, a pen nib or a mouse arrow - so you can see
  who is working on which corner.
- **A colour chip on every avatar** showing the shade that player is holding, with the group code and
  hex on hover.
- **Last-writer-wins with a Lamport stamp per stroke.** One stamp for the whole stroke, reused across
  every batch, so a fill and a freehand line resolve the same way.
- **Repair, not faith.** A state checksum is compared every 8 s and a diverged peer is re-synced, so a
  dropped packet costs a moment, not a permanently different picture.
- **Local backup as a rescue.** The board is copied to your device 1.2 s after it stops changing and
  offered back if you return to an empty room. It never overwrites a painted board, and declining is
  safe - your picture is still there next time.
- **Optional relay server** (`server/relay.js`) for rooms that outlive everyone leaving, rooms bigger
  than one laptop can relay, or a fixed server-side clock.

---

## Import a photo, export a board

**In:** drop or pick an image anywhere onto the board.

- Auto-fit to the face, then sampled down to exactly `cols × rows` cells
- Pixelate preview before anything is committed, on the same numbers the commit will use
- Dithering: none, Bayer 2×2, 4×4, 8×8, and Floyd-Steinberg
- Brightness, contrast, saturation, posterise strength and an unsharp-mask **Sharpen** slider applied
  after the downsample, because the downsample is what introduced the softness
- Placement handles: move, scale and rotate in 90° steps, all snapped to whole cells, and the preview
  itself is draggable

**Out:**

- **PNG at the board's exact pixel size** - one pixel per cell, scaled with smoothing off, because a
  smoothed export is a board of colours that exist on no palette. Multi-face garments go on one sheet,
  each face labelled with its own size.
- **Optional cell grid baked into the export**, for printing a face and tracing it.
- **Copy-to-clipboard grid** in three formats: the game's own `06-1` codes, palette indices, or hex.

---

## Keyboard shortcuts

`B` brush · `E` eraser · `I` eyedropper · `F` bucket · `L` line · `R` rectangle · `O` ellipse · `P` polygon
`G` grid · `[` `]` brush size · `+` `−` zoom · `0` fit · `Space`-drag pan · `Ctrl+S` export

Also bound:

| Key | Action |
|---|---|
| `T` | Text tool (5×7 bitmap font, four sizes) |
| `M` | Cycle mirror painting: off → X → Y → both |
| `V` | Blueprint / trace panel |
| `.` | Tick the block you last painted in (block mode only) |
| `Tab` | Next face of the current design |
| `Ctrl+Z` / `Ctrl+Shift+Z` | Undo / redo (also `Ctrl+Y`) |
| `Shift` while drawing | Snap a line to 45°, square-constrain a rectangle |
| `Enter` / `Escape` | Close / abort a polygon |
| Double-tap the first vertex | Close a polygon |
| `Alt`-drag | Sample the shade under the pointer without switching tool |

`?local=1` opens a board that never touches the network.

---

## How it works under the hood

- **No build step and no runtime dependencies.** The published site is plain ES modules, one CSS file
  and a canvas. `npm install` is only for the optional relay (`ws`) and the dev-only Playwright probes.
- **The grid is the truth, the screen is a copy.** `assets/js/game/grid.js` is DOM-free on purpose and
  is imported by the relay server too, so the browser and the server cannot drift.
- **Remote strokes are scheduled, local ones are not.** The grid updates the instant a packet lands on
  every machine; the screen paints from a copy that releases remote bursts on room time (~90 ms behind,
  spread over ~55 ms). Your own pen skips the schedule entirely - that is where the "no lag" claim comes
  from, and it is a deliberate asymmetry.
- **One op per stroke, one undo step per stroke.** A stroke is a stack of `{face, indices, from, to}`
  patches; a cell touched twice in one stroke is recorded once against its pre-stroke value. Undo
  replays through the same `paintLocal` + `sendOp` path as a live stroke, so there is no second sync
  mechanism to get wrong.
- **Everything is a face.** A design is a list of faces, each with its own grid. That is what lets a
  T-shirt be four different sizes at once without 32 pixels of artwork falling off a sleeve.
- **Memoised colour science.** ΔE(2000) nearest-shade lookups are cached over the 125 shades, so a
  40-megapixel import does not re-run the metric per pixel per candidate.
- **Tested where it matters.** Unit tests under `test/` (`npm test`) cover the grid, shapes, colour
  science, undo, backup, clipboard formats and the import fit arithmetic; transport tests drive two real
  peers; Playwright probes under `tools/` click the actual UI in a real browser.

---

## Works on everything

Phone, tablet, desktop - the same page.

- Pinch to zoom, two fingers to pan, so you can rest your hand on the screen
- Apple Pencil aware: touches stop painting while the pen is down
- The brush preview outlines the **actual footprint** - the rim cells of a round, spray or airbrush dab,
  or the brush box for a square one - so you see which cells a stroke will take, not just where the
  pointer is. Mirrored guides draw alongside it.
- **Installable**: a web manifest and generated icons, so "Add to Home Screen" opens a standalone
  window with its own icon. There is no service worker, so an installed copy is not an offline one

---

## Run it locally

Nothing to build. Serve the folder and open it.

```bash
git clone https://github.com/SebSilent/HeartopiaMPPaint.git
cd HeartopiaMPPaint

# serve the site (static, zero dependencies)
npm run dev            # -> http://localhost:8080/
npm run dev -- 8099    # or pick a port: node tools/serve.cjs 8099
```

Open the page, pick a nickname, and you are painting. Multiplayer rooms work straight away over
serverless WebRTC - no server needed.

Useful extras:

```bash
npm install            # only needed for the relay server and the dev probes
npm test               # unit + transport tests (node --test)
npm run relay          # optional WebSocket relay on :8787
npm run assets         # regenerate the share card, install icons and README badges
npm run check:seo      # verify the head tags, the generated images, and every number and link in this file
```

Then point the site at it with `?relay=ws://localhost:8787`, or set it permanently in `index.html`:

```html
<script>
  window.HMP_CONFIG = { relayUrl: 'ws://localhost:8787' };
</script>
```

Other query parameters: `?local=1` (offline sandbox) · `?room=ABCDEFG` (join a room directly) ·
`?transport=peer` (force serverless) · `?gapFill=0` (skip the 3D gap-fill pass).

---

## Deploy your own copy

### 1. The site - GitHub Pages (free, no build)

1. Fork this repository.
2. **Settings → Pages → Build and deployment → Source: Deploy from a branch.**
3. Branch `main`, folder `/ (root)`, Save.
4. Your copy is live at `https://<your-username>.github.io/HeartopiaMPPaint/`.

That is the whole deployment. There is no build command, no output directory and no environment
variable - it is static files, and peer-to-peer rooms work with nothing else running.

Any other static host works identically (Netlify, Cloudflare Pages, `nginx`, an S3 bucket): publish
the repository root.

### 2. Optional - the relay server

Only needed if you want rooms that stay up after every player leaves, rooms bigger than one laptop can
relay, or a fixed server-side clock. A `render.yaml` blueprint is included:

1. <https://render.com/dashboard> → **New → Blueprint** → pick your fork.
2. It creates a free Node web service running `node server/relay.js` with a `/health` check.
3. Copy the `wss://` URL it gives you.
4. Put it in `index.html` as `window.HMP_CONFIG.relayUrl`, or append `?relay=wss://…` to a link.

Environment variables: `PORT` (default 8787), `MAX_MEMBERS` (default 24). The relay must be started
from the repository root - it imports the shared canvas model from `assets/js/`.

### 3. Point the app at your relay without editing code

```
https://<your-username>.github.io/HeartopiaMPPaint/?relay=wss://my-relay.onrender.com
```

---

## Project layout

```
index.html                 the whole UI - no templating, no framework
assets/css/style.css       one stylesheet
assets/js/
  config.js                runtime config, every setting overridable by query string
  main.js                  wiring, keyboard, export
  input.js                 pointer/pen/touch, strokes, shapes, the brush footprint preview
  ui.js                    panels, palette, dock
  game/                    grid.js (shared truth) · design.js · history.js · shapes.js
                           slots.js (every item and face size) · backup.js · gridtext.js
                           pixeltext.js (5x7 bitmap font) · render3d.js · coverage.js
  color/science.js         ΔE(2000), shade fading, unsharp mask, posterise
  net/                     room.js · transport-peer.js (WebRTC) · display.js (smoothing)
  ui/importer.js           image import, fit, dither, placement
assets/data/               palette, faces, outlines and 3D meshes, as JSON
assets/img/                generated: share card, install icons, README badges
server/relay.js            optional WebSocket relay, imports the same grid module
test/                      node --test: unit and two-peer transport tests
tools/                     dev server, probes, asset generators and their checkers
site.webmanifest           install metadata - name, icons, standalone display
robots.txt, sitemap.xml    crawler hints for the GitHub Pages deployment
```

---

## FAQ

**Is this tool free?**
Yes. No account, no login, no ads, no paid tier. MIT licensed.

**Do I need to install anything?**
No. It is a web page. On a phone, "Add to Home Screen" makes it feel like an app.

**Does it work offline?**
`?local=1` opens a board that never touches the network, and your work is backed up to your device, so
a dropped connection does not cost you the picture.

**Will my design actually match in game?**
That is the entire point. Only the game's 125 shades are selectable, every board and face is the game's
real size, the cells the game refuses to paint are locked, and the PNG exports at one pixel per cell
with smoothing off.

**How many people can paint at once?**
Peer rooms are limited by the host's uplink; the optional relay defaults to `MAX_MEMBERS=24` per room.

**Can I paint furniture and clothing, or only canvases?**
All of them: 20 canvas boards, 11 clothing items, 10 furniture items and the book - 50 faces in total.

**Is it affiliated with Heartopia?**
No. This is an independent fan-made tool.

---

## Data sources and attribution

This tool stands on data other players catalogued first, and it is credited where it is used:

- **Palette and canvas dimensions** - the 125 shades and the ratio × precision grid table were
  catalogued by [zerochansy's Heartopia Painting Tools](https://zerochansy.github.io/Heartopia-Painting-Tools/).
  The source URL is recorded in `assets/data/heartopia-palette.json` and `assets/js/presets.js`.
- **Garment mesh format** - the 3D clothing patterns were reverse-engineered from
  [art-pia](https://art-pia.com/), and the game's own preset codes in
  `assets/data/heartopia-game-palette.json` come from the same catalogue.

The comparison table above is about what this implementation does, not about the quality of those
projects - both were the reference this one was measured against, and neither is a multiplayer editor.

Heartopia and its assets belong to their respective owners. This repository is an unofficial,
fan-made tool.

---

## License

MIT © [SebSilent](https://github.com/SebSilent) and contributors. See [LICENSE](./LICENSE).

Game data (palette shades, canvas dimensions, item face sizes, garment meshes) is reproduced for
compatibility with a game the player owns; attribution is in the section above and in the data files
themselves.

**Found a bug or a wrong dimension?** Open an issue - a face size that disagrees with the game is
treated as a bug in this tool, not as a preference.
