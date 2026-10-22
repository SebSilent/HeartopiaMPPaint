# Heartopia Multiplayer Paint

Paint on the same board as other people at the same time.

Live site: https://sebsilent.github.io/HeartopiaMPPaint/

You pick a nickname, you get a room code, you send the code to people. Everyone
who opens it with that code is on the same board, and everyone can see everyone
else's cursor while they draw.

## Using it

1. Type a nickname. Two characters minimum. Nothing else works until you do,
   because other players see that name on the board.
2. Copy the room code from the top bar and send it to people.
3. Pick a thing to paint on (a canvas, a garment, a piece of furniture, the
   book), pick a shade, draw.

`?local=1` opens a single-player board that never touches the network.

## What it does

* The real Heartopia palette: 13 groups, 125 shades. Index 0 is left empty so
  "no paint" stays distinguishable from white.
* Every paintable surface in the game: 11 clothing items, 10 furniture items and
  the book, 51 faces in total. A T-shirt is four separate boards and the app
  shows them as tabs, because that is what it is in the game.
* Live cursors for every player, drawn as a finger, a pen or a mouse depending on
  what they are actually using.
* Touch, Apple Pencil and mouse all work. Pinch zooms, two fingers pan, and a
  resting hand does not paint while the pen is down.
* Brush, eraser, eyedropper, bucket, line, rectangle, ellipse, triangle, star,
  heart, arrow, spray, polygon and select. Four brush sizes, square or round tip.
* Undo and redo, one step per stroke.
* Photo import, quantised to the palette and merged down until it is buildable.
* Screenshot import: give it a picture of the game's grid and it finds the grid,
  reads the colours out of it and puts them on your board.
* Blueprint mode: numbered blocks and a legend for what still needs keying in.
* 3D preview at the game's real proportions.
* PNG export at the board's exact pixel size, for copying back into the game.
* Phone, tablet and desktop. No install, no account.

## Board sizes

| Ratio | S | M | L | XL |
|---|---|---|---|---|
| 16:9 | 30x18 | 50x28 | 100x56 | 150x84 |
| 4:3 | 30x24 | 50x38 | 100x76 | 150x114 |
| 1:1 | 30x30 | 50x50 | 100x100 | 150x150 |
| 3:4 | 24x30 | 38x50 | 76x100 | 114x150 |
| 9:16 | 18x30 | 28x50 | 56x100 | 84x150 |

Garments and furniture have their own fixed sizes instead. A dress is 102x154,
76x154 and 168x102 across its three faces. The largest single face is the top of
a double bed's duvet, 256x128.

## Keys

| Key | Action |
|---|---|
| B | brush |
| E | eraser |
| I | eyedropper |
| F | bucket |
| L | line |
| R | rectangle |
| O | ellipse |
| V | select |
| `[` `]` | brush size |
| M | mirror |
| G | grid |
| `.` | tick a blueprint block |
| 0 | fit to screen |
| `+` `-` | zoom |
| Space, drag | pan |
| Ctrl+Z | undo |
| Ctrl+Y | redo |
| Ctrl+S | export |

## Running it

GitHub Pages serves plain files, so the site itself needs no build step.

```bash
npm install
npm run dev            # http://localhost:8080
npm test               # unit tests
```

The checks in `tools/` drive a real browser and need Playwright:

```bash
node tools/check.cjs         # boot, paint, zoom, panels, two players, touch
node tools/check-import.cjs  # photo and screenshot import, end to end
node tools/check-live.cjs    # the published site, three players, WebRTC
```

## How the networking works

By default there is no server to run. The first player in a room code claims that
code as a WebRTC peer and hosts it; anyone who finds it taken joins as a guest.
This is what makes the whole thing deployable as static files on GitHub Pages.

If you want a room that survives the host closing their tab, or a room bigger
than a few people, run the small relay instead and point the page at it:

```bash
npm run relay
```

Then open the site with `?relay=wss://your-host/`. `render.yaml` is there if you
want to put that relay on Render.

## Known limits

* The default setup uses the free public PeerJS broker. It is shared with
  everyone else on it. If rooms stop forming, the first thing to suspect is the
  broker, and the fix is to run the relay above.
* Only STUN is configured. Most home and mobile connections are fine with that.
  A player behind symmetric NAT may not connect, and would need a TURN server
  added to `assets/js/config.js`.
* On the serverless transport the room depends on one player's tab. When that tab
  closes, the others notice after about twelve seconds, race for the room id, and
  one of them takes over. It works, tested with three players, but anything drawn
  during those seconds is dropped, because there is momentarily nobody to receive
  it. The relay does not have this gap.
* Room codes are not passwords. Anyone who has the code can paint on it.

## Palette and sizes: where they came from

The colour groups, shade values and board dimensions are taken from Heartopia
itself, cross-checked against the community reference at
https://zerochansy.github.io/Heartopia-Painting-Tools/ so that a board built here
matches what the game will actually accept.
